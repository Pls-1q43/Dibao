// node --import tsx scripts/smoke/ranking-batch-profile.ts [--baseline=e295403] [--all] [--skewed]
// Synthetic in-memory data only. Never opens a deployment database or a provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import {
  openDatabase, SqliteRankingRepository, SqliteEmbeddingRepository, SqliteProfileRepository,
  type DibaoDatabase
} from "../../packages/db/src/index.js";
import { RecommendationRankingService } from "../../apps/server/src/ranking-service.js";

const articles = 46_833;
const skewed = process.argv.includes("--skewed");
const feedCount = skewed ? 400 : 1;
const events = skewed ? 120_000 : 14_745;
const embeddings = 35_653;
const dimension = 1_024;
const now = 1_800_000_000_000;
const db = openDatabase(":memory:", { migrate: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Provider/network calls are forbidden in this benchmark"); };
const timings = new Map<string, number>();
const measuredDb = new Proxy(db, {
  get(target, property) {
    if (property === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      const category = sql.includes("with eligible_articles")
        ? (sql.includes("and a.id in (") ? "inner_candidates" : "outer_candidates")
        : sql.includes("bm25(article_fts") ? "fts"
        : sql.includes("interest_cluster_evidence") ? "cluster_support" : "other_sql";
      return new Proxy(statement, {
        get(stmt, key) {
          const value = Reflect.get(stmt, key);
          if (typeof value !== "function") return value;
          if (!["all", "get", "run"].includes(String(key))) return value.bind(stmt);
          return (...args: unknown[]) => {
            const start = performance.now();
            try { return Reflect.apply(value, stmt, args); }
            finally { timings.set(category, (timings.get(category) ?? 0) + performance.now() - start); }
          };
        }
      });
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  }
}) as DibaoDatabase;
const id = (i: number) => `a${String(i).padStart(6, "0")}`;
const terms = Array.from({ length: 24 }, (_, i) => `topic${i}`);
const body = terms.join(" ").repeat(25);
const vector = Buffer.from(Float32Array.from({ length: dimension }, (_, i) => i === 0 ? 1 : 0).buffer);
const embeddingDigest = () => {
  const hash = createHash("sha256");
  for (const row of db.prepare(`select article_id, embedding_index_id, vector_blob, content_hash,
    created_at, updated_at from article_embeddings order by article_id, embedding_index_id`).iterate() as Iterable<{
      article_id: string; embedding_index_id: string; vector_blob: Buffer;
      content_hash: string; created_at: number; updated_at: number;
    }>) {
    hash.update(JSON.stringify([row.article_id, row.embedding_index_id, row.content_hash, row.created_at, row.updated_at]));
    hash.update(row.vector_blob);
  }
  return hash.digest("hex");
};

try {
  db.exec(`
    insert into embedding_providers(id,type,name,model,dimension,enabled,created_at,updated_at)
      values('p','embedded_local','synthetic','synthetic',${dimension},1,0,0);
    insert into embedding_indexes(id,provider_id,model,dimension,table_name,status,created_at,updated_at)
      values('i','p','synthetic',${dimension},'unused_synthetic_vectors','active',0,0);
  `);
  const feed = db.prepare(`insert into feeds(id,title,feed_url,created_at,updated_at)
    values(?,'synthetic',?,0,0)`);
  const article = db.prepare(`insert into articles(id,feed_id,url,title,summary,discovered_at,content_hash,dedupe_key,created_at,updated_at)
    values(?,?,?,?,?,?,'synthetic',?,0,0)`);
  const content = db.prepare("insert into article_contents(article_id,content_text,updated_at) values(?,?,0)");
  const fts = db.prepare("insert into article_fts(article_id,title,summary,content_text) values(?,?,?,?)");
  const embedding = db.prepare("insert into article_embeddings values(?,'i',?,'synthetic',0,0)");
  const event = db.prepare(`insert into behavior_events(id,article_id,event_type,event_weight,created_at)
    values(?,?,'impression',0,?)`);
  const evidence = db.prepare(`insert into interest_cluster_evidence
    (id,cluster_id,article_id,evidence_source,created_at) values(?,?,?,'reconstructed',0)`);
  const cluster = db.prepare(`insert into interest_clusters
    (id,embedding_index_id,polarity,centroid_vector_blob,weight,sample_count,created_at,updated_at)
    values(?,'i','positive',?,4,50,?,?)`);
  const term = db.prepare(`insert into profile_terms(term,polarity,scope,weight,updated_at)
    values(?,'positive',?,5,?)`);
  db.transaction(() => {
    for (let f = 0; f < feedCount; f++) feed.run(`f${f}`, `https://example.invalid/rss/${f}`);
    for (let i = 0; i < 32; i++) cluster.run(`c${i}`, vector, now, now);
    for (const scope of ["long", "recent"]) for (const value of terms) term.run(value, scope, now);
    for (let i = 0; i < articles; i++) {
      article.run(id(i), `f${(i * 73) % feedCount}`, `https://example.invalid/${i}`, `synthetic ${terms[i % 24]}`, terms.join(" "), now, id(i));
      content.run(id(i), body);
      fts.run(id(i), `synthetic ${terms[i % 24]}`, terms.join(" "), body);
      if (i < embeddings) embedding.run(id(i), vector);
    }
    for (let i = 0; i < events; i++) {
      const articleId = id(skewed ? (i < 108_000 ? i % 1_000 : 1_000 + (i * 37) % 34_653) : i + 10_000);
      event.run(`e${i}`, articleId, now);
      if (i < 14_745) evidence.run(`ev${i}`, `c${i % 32}`, articleId);
    }
  })();
  console.log(JSON.stringify({ phase: "seed", articles, feeds: feedCount, events, embeddings, dimension, clusters: 32, skewed }));
  const before = embeddingDigest();
  const rankings = new SqliteRankingRepository(measuredDb);
  const first = rankings.listCandidates({ limit: 50 });
  const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice("--baseline=".length);
  if (baseline) {
    // Compile the actual historical repository, not a hand-written query imitation.
    const source = execFileSync("git", ["show", `${baseline}:packages/db/src/repositories/ranking.ts`], { encoding: "utf8" });
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    assert(!/^import\b/m.test(js), "Historical repository must have no runtime imports");
    const historical = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
    console.log(JSON.stringify({ phase: "baseline_start", baseline }));
    const start = performance.now();
    const oldRows = new historical.SqliteRankingRepository(db).listCandidates({ limit: 50 });
    assert.deepEqual(oldRows, first);
    console.log(JSON.stringify({ phase: "baseline_candidates", baseline, ms: performance.now() - start, count: oldRows.length, identicalRows: true }));
  }
  const ranking = new RecommendationRankingService({
    db: measuredDb, rankings, embeddings: new SqliteEmbeddingRepository(measuredDb),
    profiles: new SqliteProfileRepository(measuredDb), now: () => now
  });
  let cursor: string | null = null;
  let processed = 0;
  const batchLimit = process.argv.includes("--all") ? Infinity : 3;
  for (let batch = 0; batch < batchLimit; batch++) {
    timings.clear();
    const start = performance.now();
    const candidates = rankings.listCandidates({ afterArticleId: cursor, limit: 50 });
    if (!candidates.length) break;
    assert(candidates.length <= 50);
    const ids = candidates.map((candidate) => candidate.articleId);
    assert.equal(ranking.recalculateArticles(ids), ids.length);
    const scores = db.prepare(`select article_id from article_rank_scores
      where rank_context=? and article_id in (${ids.map(() => "?").join(",")})`).all(ranking.getActiveRankContext(), ...ids);
    assert.equal(scores.length, ids.length);
    cursor = ids.at(-1)!;
    processed += ids.length;
    console.log(JSON.stringify({ phase: "ranking_batch", batch, count: ids.length, processed,
      ms: performance.now() - start, sqlMs: Object.fromEntries(timings) }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (batchLimit === Infinity) assert.equal(processed, articles);
  assert.equal(embeddingDigest(), before);
  console.log(JSON.stringify({ phase: "verified", processed, embeddingsUnchanged: true, providerCalls: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  db.close();
}
