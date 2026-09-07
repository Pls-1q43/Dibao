import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openDatabase, SqliteAppSettingsRepository, SqliteArticleRepository,
  SqliteEmbeddingRepository, SqliteFeedRepository, SqliteProfileRepository,
  SqliteRankingRepository, SqliteVecVectorStore, type DibaoDatabase
} from "@dibao/db";
import { DerivedDataUpgradeService, DERIVED_DATA_UPGRADE_SETTING_KEY } from "./derived-data-upgrade-service.js";
import { ProfileRebuildService } from "./profile-rebuild-service.js";
import { ProfileService } from "./profile-service.js";
import { RecommendationRankingService } from "./ranking-service.js";
import { buildServer } from "./app.js";
import { SettingsService } from "./settings-service.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(count = 2) {
  const dir = mkdtempSync(join(tmpdir(), "dibao-derived-upgrade-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const db = openDatabase(path, { migrate: true });
  const articles = new SqliteArticleRepository(db);
  const vectors = new SqliteVecVectorStore(db);
  new SqliteFeedRepository(db).upsert({ id: "f", title: "Fixture", feedUrl: "https://example.invalid/rss", now: 1000 });
  const embeddings = new SqliteEmbeddingRepository(db);
  embeddings.upsertProvider({ id: "p", type: "openai_compatible", name: "Fixture", model: "fixture", baseUrl: "https://example.invalid", dimension: 2, enabled: true, now: 1000 });
  embeddings.createIndex({ id: "i", providerId: "p", model: "fixture", dimension: 2, now: 1000 });
  for (let n = 0; n < count; n++) {
    const id = `a${String(n).padStart(5, "0")}`;
    articles.upsert({ id, feedId: "f", title: "Fixture", url: `https://example.invalid/${id}`, dedupeKey: id, contentHash: id, now: 1000 });
    vectors.upsertArticleVector({ articleId: id, embeddingIndexId: "i", vector: [1, 0], contentHash: id, now: 1000 });
    db.prepare("insert into article_rank_scores(article_id,rank_context,score,calculated_at) values(?, 'legacy:schema_3', 0.5, 1000)").run(id);
  }
  new SqliteAppSettingsRepository(db).setJson("upgrade.derivedData.v0.1.1-interest-profile-calibration-rebuild", { state: "completed", blocking: false });
  return { db, path };
}

function service(db: DibaoDatabase, targetVersion = "0.4.0") {
  const embeddings = new SqliteEmbeddingRepository(db);
  const profiles = new SqliteProfileRepository(db);
  const ranking = new RecommendationRankingService({ db, embeddings, profiles, rankings: new SqliteRankingRepository(db), now: () => 5000 });
  const rebuild = new ProfileRebuildService({ db, profile: new ProfileService({ embeddings, profiles }), ranking });
  const upgrade = new DerivedDataUpgradeService({ db, settings: new SqliteAppSettingsRepository(db), profileRebuild: rebuild, targetVersion });
  return { upgrade, rebuild, ranking };
}

function snapshot(db: DibaoDatabase) {
  return db.prepare("select article_id, hex(vector_blob) as vector, content_hash, created_at, updated_at from article_embeddings order by article_id").all();
}

describe("real derived-data upgrade service", () => {
  it("upgrades a standalone Docker HTTP process with background jobs disabled and no seeded marker", async () => {
    vi.stubEnv("DIBAO_BACKGROUND_JOBS", "false");
    vi.stubEnv("DIBAO_PROCESS_ROLE", "standalone");
    const { db } = fixture(3);
    const before = snapshot(db);
    new SettingsService({ settings: new SqliteAppSettingsRepository(db) }).updateSettings({ telemetry: { enabled: false } });
    const forbidden = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    const app = buildServer({ db, backgroundJobs: false, derivedUpgradeRunner: true, authRequired: false, logger: false, webDistDir: false });
    try {
      await app.ready();
      await vi.waitFor(() => expect(new SqliteAppSettingsRepository(db).getJson<{ state: string }>(DERIVED_DATA_UPGRADE_SETTING_KEY)?.state).toBe("completed"));
      expect(snapshot(db)).toEqual(before);
      expect(db.prepare("select count(*) as n from jobs where type='feed_refresh'").get()).toEqual({ n: 0 });
      expect(forbidden).not.toHaveBeenCalled();
    } finally { await app.close(); db.close(); }
  });

  it("resumes the real worker scheduler after an HTTP retry without restarting", async () => {
    const { db, path } = fixture();
    const peer = openDatabase(path);
    new SettingsService({ settings: new SqliteAppSettingsRepository(db) }).updateSettings({
      telemetry: { enabled: false }, recommendationMaintenance: { maintenanceEnabled: false }
    });
    const rebuild = vi.spyOn(ProfileRebuildService.prototype, "rebuildAllRankingsAsync").mockRejectedValueOnce(new Error("Injected startup failure"));
    const forbiddenFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const worker = buildServer({
      db, authRequired: false, logger: false, webDistDir: false, backgroundJobs: true,
      feedRefreshIntervalMs: 20, jobRunnerIntervalMs: 20,
      retentionCleanupIntervalMs: 0, jobHistoryCleanupIntervalMs: 0, profileDecayIntervalMs: 0,
      feedFetcher: async () => new Response('<rss version="2.0"><channel><title>Fixture</title><link>https://example.invalid</link></channel></rss>', { headers: { "Content-Type": "application/rss+xml" } }),
      fetchResolveHostname: async () => ["93.184.216.34"]
    });
    const http = buildServer({ db: peer, authRequired: false, logger: false, webDistDir: false, backgroundJobs: false });
    try {
      await worker.ready();
      await http.ready();
      await vi.waitFor(() => expect(new SqliteAppSettingsRepository(db).getJson<{ state: string }>(DERIVED_DATA_UPGRADE_SETTING_KEY)?.state).toBe("failed"));
      expect(db.prepare("select last_fetched_at as fetched from feeds where id='f'").get()).toEqual({ fetched: null });
      const retry = await http.inject({ method: "POST", url: "/api/system/upgrade/retry", headers: { origin: "http://localhost" } });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().data.state).toBe("pending");
      await vi.waitFor(() => {
        expect(db.prepare("select count(*) as n from jobs where type='feed_refresh' and status='succeeded'").get()).toEqual({ n: 1 });
      }, { timeout: 4000 });
      expect(rebuild).toHaveBeenCalledTimes(2);
      expect(forbiddenFetch).not.toHaveBeenCalled();
    } finally { await worker.close(); await http.close(); peer.close(); db.close(); }
  });

  it("serializes two database connections, with read-only status and no early unlock", async () => {
    const { db, path } = fixture(115);
    const peer = openDatabase(path);
    const a = service(db), b = service(peer);
    const otherRebuild = vi.spyOn(b.rebuild, "rebuildActiveIndexProfileAsync");
    try {
      const running = a.upgrade.startIfRequired();
      const stored = new SqliteAppSettingsRepository(db).getJson(DERIVED_DATA_UPGRADE_SETTING_KEY);
      expect(b.upgrade.getStatus()).toMatchObject({ state: "running", blocking: true });
      expect(new SqliteAppSettingsRepository(db).getJson(DERIVED_DATA_UPGRADE_SETTING_KEY)).toEqual(stored);
      expect(await b.upgrade.startIfRequired()).toMatchObject({ state: "running", blocking: true });
      expect(otherRebuild).not.toHaveBeenCalled();
      expect(await running).toMatchObject({ state: "completed", blocking: false, result: { rebuilt: { rankingRows: 115 } } });
      expect(b.upgrade.getStatus().state).toBe("completed");
    } finally { await a.upgrade.stop(); await b.upgrade.stop(); peer.close(); db.close(); }
  });

  it("upgrades beyond the ordinary ranking window, preserves vectors, and cleans only after full success", async () => {
    const { db } = fixture(620);
    const { upgrade, ranking } = service(db);
    const before = snapshot(db);
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden during upgrade"));
    const original = ranking.recalculateArticles.bind(ranking);
    let batches = 0;
    const spy = vi.spyOn(ranking, "recalculateArticles").mockImplementation((ids) => {
      expect(db.prepare("select count(*) as n from article_rank_scores where rank_context = 'legacy:schema_3'").get()).toEqual({ n: 620 });
      if (++batches === 2) throw new Error("Injected batch failure");
      return original(ids);
    });
    try {
      await expect(upgrade.startIfRequired()).rejects.toThrow("Injected batch failure");
      expect(upgrade.getStatus()).toMatchObject({ state: "failed", blocking: true });
      expect(snapshot(db)).toEqual(before);
      spy.mockRestore();
      expect(await upgrade.retry()).toMatchObject({ state: "completed", result: { rebuilt: { rankingRows: 620 } } });
      expect(db.prepare("select count(*) as n from article_rank_scores where rank_context = 'legacy:schema_3'").get()).toEqual({ n: 0 });
      expect(db.prepare("select count(*) as n from article_rank_scores where rank_context = ?").get(ranking.getActiveRankContext())).toEqual({ n: 620 });
      expect(snapshot(db)).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
      expect(service(db).upgrade.getStatus().blocking).toBe(false);
      expect(service(db, "0.5.0").upgrade.getStatus().blocking).toBe(false);
      db.prepare("update embedding_indexes set status='retired' where id='i'").run();
      new SqliteEmbeddingRepository(db).createIndex({ id: "new-empty-index", providerId: "p", model: "fixture", dimension: 2, now: 9000 });
      expect(service(db).upgrade.getStatus().blocking).toBe(false);
      expect(snapshot(db)).toEqual(before);
      const changed = service(db);
      vi.spyOn(changed.ranking, "getActiveRankContext").mockReturnValue(ranking.getActiveRankContext().replace("cocoon_5", "cocoon_8"));
      expect(changed.upgrade.getStatus().blocking).toBe(false);
      const writesBefore = db.prepare("select total_changes() as n").get();
      await changed.upgrade.startIfRequired();
      await changed.upgrade.startIfRequired();
      expect(db.prepare("select total_changes() as n").get()).toEqual(writesBefore);
      const contract = changed.rebuild.getRankContract();
      vi.spyOn(changed.rebuild, "getRankContract").mockReturnValue({ ...contract, featureSchemaVersion: contract.featureSchemaVersion + 1 });
      expect(changed.upgrade.getStatus().blocking).toBe(true);
    } finally { await upgrade.stop(); db.close(); }
  });

  it("does not expire a live local owner, and recovers a genuinely dead process", async () => {
    const { db } = fixture();
    const { upgrade } = service(db);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const settings = new SqliteAppSettingsRepository(db);
    try {
      settings.setJson(DERIVED_DATA_UPGRADE_SETTING_KEY, {
        ...upgrade.getStatus(), state: "running", owner: { token: "dead-owner", pid: child.pid!, host: hostname(), startTicks: null, heartbeatAt: 0 }
      });
      expect(upgrade.getStatus().state).toBe("running");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      expect(upgrade.getStatus().state).toBe("pending");
      expect(await upgrade.startIfRequired()).toMatchObject({ state: "completed", blocking: false });
    } finally { child.kill(); await upgrade.stop(); db.close(); }
  });
});
