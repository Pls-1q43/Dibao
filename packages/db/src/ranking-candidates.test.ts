import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "./connection.js";
import { SqliteRankingRepository } from "./repositories/ranking.js";

describe("ranking candidate batch query plans", () => {
  it.each([false, true])("early-stops ID-ordered pages across 400 feeds and skewed events (analyzed=%s)", (analyzed) => {
    const db = openDatabase(":memory:", { migrate: true });
    try {
      const id = (i: number) => `a${String(i).padStart(6, "0")}`;
      const feedOf = (i: number) => (i * 73) % 400;
      const feeds = db.prepare(`insert into feeds(id,title,feed_url,enabled,deleted_at,created_at,updated_at)
        values(?,'synthetic',?,?,?,0,0)`);
      const articles = db.prepare(`insert into articles
        (id,feed_id,url,title,discovered_at,dedupe_key,status,deleted_at,created_at,updated_at)
        values(?,?,?,'synthetic',0,?,?,?,0,0)`);
      const states = db.prepare(`insert into article_states
        (article_id,read_at,hidden_at,not_interested_at,reading_progress,liked_at,updated_at)
        values(?,?,?,?,?,?,0)`);
      const events = db.prepare(`insert into behavior_events
        (id,article_id,event_type,event_weight,created_at) values(?,?,'impression',?,?)`);
      const negative = new Set<number>();
      db.transaction(() => {
        for (let f = 0; f < 400; f++) {
          feeds.run(`f${f}`, `https://example.invalid/feed/${f}`, f % 5 === 0 ? 0 : 1, f % 11 === 0 ? 1 : null);
        }
        // Reverse insertion keeps physical row order distinct from the ID cursor.
        for (let i = 46_832; i >= 0; i--) {
          articles.run(id(i), `f${feedOf(i)}`, `https://example.invalid/${i}`, id(i),
            i % 31 === 0 ? "deleted" : "active", i % 29 === 0 ? 1 : null);
          if ([7, 13, 17, 19, 23].some((divisor) => i % divisor === 0)) {
            states.run(id(i), i % 13 === 0 ? 1 : null, i % 17 === 0 ? 1 : null,
              i % 19 === 0 ? 1 : null, i % 23 === 0 ? 0.95 : 0, i % 7 === 0 ? 1 : null);
          }
        }
        for (let e = 0; e < 120_000; e++) {
          const i = e < 108_000 ? e % 1_000 : 1_000 + (e * 37) % 45_833;
          const weight = i % 11 === 0 ? -1 : 0;
          if (weight < 0) negative.add(i);
          events.run(`e${e}`, id(i), weight, e);
        }
      })();
      if (analyzed) db.exec("ANALYZE");
      const expected = Array.from({ length: 46_833 }, (_, i) => i).filter((i) =>
        feedOf(i) % 5 !== 0 && feedOf(i) % 11 !== 0 && i % 31 !== 0 && i % 29 !== 0 &&
        i % 13 !== 0 && i % 17 !== 0 && i % 19 !== 0 && i % 23 !== 0 &&
        (!negative.has(i) || i % 7 === 0)
      ).map(id);
      const rankings = new SqliteRankingRepository(db);
      const prepare = db.prepare.bind(db);
      let visited = 0;
      db.function("count_article_visit", (_articleId: string) => { visited++; return 1; });
      for (const cursor of [null, expected[49]!, id(45_000)]) {
        const spy = vi.spyOn(db, "prepare");
        const rows = rankings.listCandidates({ limit: 50, afterArticleId: cursor });
        const sql = spy.mock.calls.at(-1)![0];
        spy.mockRestore();
        const wanted = expected.filter((value) => cursor === null || value > cursor).slice(0, 50);
        expect(rows.map((row) => row.articleId)).toEqual(wanted);
        expect(rankings.listCandidates({ articleIds: wanted })).toEqual(rows);
        const params = cursor === null ? [50, "", ""] : [cursor, 50, "", ""];
        const plan = prepare(`explain query plan ${sql}`).all(...params) as Array<{ id: number; parent: number; detail: string }>;
        const eligible = plan.find((row) => row.detail === "MATERIALIZE eligible_articles")!;
        const selection = plan.filter((row) => row.parent === eligible.id).map((row) => row.detail);
        expect(selection[0]).toMatch(cursor === null
          ? /SCAN a USING INDEX sqlite_autoindex_articles_1/
          : /SEARCH a USING INDEX sqlite_autoindex_articles_1 \(id>\?\)/);
        expect(selection.some((line) => /TEMP B-TREE|SCAN f/.test(line))).toBe(false);
        const outer = plan.filter((row) => row.parent === 0).map((row) => row.detail);
        expect(outer).toContain("SCAN ea");
        expect(outer).toContain("SEARCH a USING INDEX sqlite_autoindex_articles_1 (id=?)");
        expect(outer.some((line) => /^SCAN [af]\b/.test(line))).toBe(false);
        // Count real SQLite predicate evaluations; do not use wall-clock gates.
        visited = 0;
        prepare(sql.replace("where a.deleted_at is null", "where count_article_visit(a.id) and a.deleted_at is null"))
          .all(...params);
        expect(visited).toBeGreaterThanOrEqual(50);
        expect(visited).toBeLessThan(200);
      }
      const traversed: string[] = [];
      let cursor: string | null = null;
      while (true) {
        const batch = rankings.listCandidates({ limit: 50, afterArticleId: cursor });
        if (batch.length === 0) break;
        traversed.push(...batch.map((row) => row.articleId));
        cursor = batch.at(-1)!.articleId;
      }
      expect(traversed).toEqual(expected);
    } finally { db.close(); }
  }, 20_000);

  it("uses article-indexed event probes at NAS scale without planner statistics", () => {
    const db = openDatabase(":memory:", { migrate: true });
    try {
      db.exec(`insert into feeds(id,title,feed_url,created_at,updated_at)
        values('f','synthetic','https://example.invalid/feed',0,0)`);
      const insertArticle = db.prepare(`insert into articles
        (id,feed_id,url,title,discovered_at,dedupe_key,created_at,updated_at)
        values(?,'f',?,'synthetic',0,?,0,0)`);
      const insertEvent = db.prepare(`insert into behavior_events
        (id,article_id,event_type,event_weight,created_at) values(?,?,'impression',0,0)`);
      const id = (i: number) => `a${String(i).padStart(6, "0")}`;
      db.transaction(() => {
        for (let i = 0; i < 46_833; i++) {
          insertArticle.run(id(i), `https://example.invalid/${i}`, id(i));
        }
        for (let i = 0; i < 14_745; i++) {
          insertEvent.run(`e${i}`, id(i));
        }
      })();
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare");
      const rankings = new SqliteRankingRepository(db);
      const first = rankings.listCandidates({ limit: 50 });
      expect(first.map((row) => row.articleId)).toEqual(Array.from({ length: 50 }, (_, i) => id(i)));
      expect(first.every((row) => row.behaviorEventCount === 1)).toBe(true);
      const firstSql = spy.mock.calls.at(-1)![0];
      const second = rankings.listCandidates({ afterArticleId: first.at(-1)!.articleId, limit: 50 });
      expect(second.map((row) => row.articleId)).toEqual(Array.from({ length: 50 }, (_, i) => id(i + 50)));
      const secondSql = spy.mock.calls.at(-1)![0];
      expect(rankings.listCandidates({ articleIds: first.map((row) => row.articleId) })).toEqual(first);
      const explicitSql = spy.mock.calls.at(-1)![0];
      spy.mockRestore();

      for (const [sql, params] of [
        [firstSql, [50, "", ""]],
        [secondSql, [id(49), 50, "", ""]],
        [explicitSql, [...first.map((row) => row.articleId), "", ""]]
      ] as Array<[string, Array<string | number>]>) {
        const plan = prepare(`explain query plan ${sql}`).all(...params) as Array<{ detail: string }>;
        const details = plan.map((row) => row.detail);
        expect(details.some((line) => /SEARCH ignored USING INDEX idx_behavior_events_article_id/.test(line))).toBe(true);
        expect(details.some((line) => /SCAN be\b|idx_behavior_events_event_type/.test(line))).toBe(false);
        expect(details.some((line) => /SEARCH be USING INDEX idx_behavior_events_article_id/.test(line))).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("keeps filtering, event projections and complete keyset traversal unchanged", () => {
    const db = openDatabase(":memory:", { migrate: true });
    try {
      db.exec(`insert into feeds(id,title,feed_url,created_at,updated_at)
        values('f','synthetic','https://example.invalid/feed',0,0)`);
      const insert = db.prepare(`insert into articles
        (id,feed_id,url,title,discovered_at,dedupe_key,created_at,updated_at)
        values(?,'f',?,'synthetic',0,?,0,0)`);
      const ids = Array.from({ length: 123 }, (_, i) => `a${String(i).padStart(3, "0")}`);
      db.transaction(() => {
        for (const id of ids) insert.run(id, `https://example.invalid/${id}`, id);
      })();
      db.exec(`
        insert into behavior_events(id,article_id,event_type,event_weight,created_at) values
          ('e1','a000','impression',-1,10),
          ('e2','a001','impression',-1,20),
          ('e3','a001','favorite',1,30),
          ('e4','a001','open',1,40);
        insert into article_states(article_id,favorited_at,updated_at) values('a001',30,30);
        insert into article_states(article_id,read_at,updated_at) values('a002',30,30);
        insert into article_states(article_id,hidden_at,updated_at) values('a003',30,30);
        update articles set deleted_at=30 where id='a004';
      `);
      const rankings = new SqliteRankingRepository(db);
      const all = rankings.listCandidates();
      expect(all.map((row) => row.articleId)).toEqual(ids.filter((id) => !["a000", "a002", "a003", "a004"].includes(id)));
      expect(all[0]).toMatchObject({
        articleId: "a001", behaviorEventCount: 3, behaviorProjectionScore: 0.125,
        stateRowExists: true, state: { favorited: true, ignoredAt: null, interactionStatus: "saved" }
      });
      const paged = [];
      let cursor: string | null = null;
      while (true) {
        const batch = rankings.listCandidates({ afterArticleId: cursor, limit: 50 });
        if (!batch.length) break;
        expect(batch.length).toBeLessThanOrEqual(50);
        paged.push(...batch);
        cursor = batch.at(-1)!.articleId;
      }
      expect(paged).toEqual(all);
      expect(rankings.listCandidates({ articleIds: ids })).toEqual(all);
    } finally {
      db.close();
    }
  });
});
