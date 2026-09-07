// Sent over stdin to Node inside isolated release-test containers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

let probeStage = "initialize";

export function embeddingSnapshot(db) {
  const hash = createHash("sha256");
  const rows = db.prepare(`select article_id, embedding_index_id, vector_blob, content_hash,
    created_at, updated_at from article_embeddings order by article_id, embedding_index_id`).all();
  for (const { vector_blob, ...metadata } of rows) {
    hash.update(JSON.stringify(metadata));
    hash.update(vector_blob);
  }
  return { count: rows.length, digest: hash.digest("hex") };
}

export function seedFixture(db) {
  db.exec(`
    insert or replace into app_settings(key,value_json,updated_at) values('telemetry','{"enabled":false}',1000);
    insert into feeds(id,title,feed_url,created_at,updated_at) values('release-feed','Release fixture','https://example.invalid/rss',1000,1000);
    insert into embedding_providers(id,type,name,base_url,model,dimension,enabled,created_at,updated_at)
      values('release-provider','openai_compatible','Fixture','https://example.invalid','fixture',2,1,1000,1000);
    insert into embedding_indexes(id,provider_id,model,dimension,table_name,status,created_at,updated_at)
      values('release-index','release-provider','fixture',2,'vec_articles_release_fixture','active',1000,1000);
    create virtual table vec_articles_release_fixture using vec0(embedding float[2]);
  `);
  const article = db.prepare(`insert into articles(id,feed_id,url,title,content_hash,dedupe_key,discovered_at,created_at,updated_at)
    values(?,'release-feed',?,'Release fixture',?,?,1000,1000,1000)`);
  const embedding = db.prepare("insert into article_embeddings values(?,'release-index',?,?,1000,1000)");
  const vector = db.prepare("insert into vec_articles_release_fixture(embedding) values(?)");
  const mapping = db.prepare("insert into article_vector_rows values(?,'release-index',?,1000)");
  const content = db.prepare("insert into article_contents(article_id,content_text,extraction_status,updated_at) values(?,'Release fixture text','success',1000)");
  db.transaction(() => {
    for (let i = 0; i < 65; i++) {
      const id = `release-article-${String(i).padStart(3, "0")}`;
      const blob = Buffer.from(new Float32Array([1, i / 100]).buffer);
      article.run(id, `https://example.invalid/${id}`, id, id);
      content.run(id);
      embedding.run(id, blob, id);
      mapping.run(id, vector.run(blob).lastInsertRowid);
    }
    db.exec(`
      insert into article_states(article_id,favorited_at,updated_at) values('release-article-000',2000,2000);
      insert into article_states(article_id,read_at,updated_at) values('release-article-001',2000,2000);
      insert into behavior_events(id,article_id,event_type,event_weight,created_at) values
        ('release-event-0','release-article-000','favorite',1,2000),
        ('release-event-1','release-article-001','read_complete',1,2000),
        ('release-event-2','release-article-002','impression',-1,2000);
      insert into article_rank_scores(article_id,rank_context,score,calculated_at)
        values('release-article-003','obsolete-release-context',1,1000);
    `);
  })();
  return embeddingSnapshot(db);
}

export function assertUpgradeStatus(status, seeded) {
  assert(status && status.blocking === false, "Derived upgrade is still blocking or absent");
  assert.equal(status.state, seeded ? "completed" : "not_required", "Unexpected derived upgrade terminal state");
  assert.equal(status.error, null, "Derived upgrade reported an error");
}

export function assertImageArchitecture(expectedArch, runtimeArch = process.arch) {
  const nodeArch = expectedArch === "amd64" ? "x64" : expectedArch === "arm64" ? "arm64" : null;
  assert(nodeArch, "Unsupported release image architecture");
  assert.equal(runtimeArch, nodeArch, "Image runtime architecture mismatch");
}

export function sentryReport(runtime, bundle) {
  const report = {};
  for (const key of ["dsn", "org", "project"]) {
    const value = typeof runtime[key] === "string" ? runtime[key].trim() : "";
    report[`runtime_${key}`] = value.length > 0;
    report[`browser_${key}`] = value.length > 0 && bundle.includes(value);
  }
  // Require an injected debug-ID assignment, not just an SDK reference to the map.
  report.browser_debug_ids = /_sentryDebugIds\[[^\]\r\n]+\]\s*=\s*["'`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["'`]/i.test(bundle);
  assert(Object.values(report).every(Boolean), "Image lacks required runtime/browser Sentry configuration");
  assert(!runtime.authToken, "Runtime Sentry config contains an auth token");
  return report;
}

async function main(mode) {
  const expected = process.env.EXPECTED_VERSION;
  if (mode === "assets") {
    probeStage = "runtime_browser_sentry_and_version";
    const runtime = JSON.parse(readFileSync("/app/.dibao/sentry.json", "utf8"));
    const assets = "/app/apps/web/dist/assets";
    const files = readdirSync(assets);
    assert(!files.some((file) => file.endsWith(".map")), "Published browser source maps were not removed");
    const bundle = files.filter((file) => file.endsWith(".js")).map((file) => readFileSync(`${assets}/${file}`, "utf8")).join("\n");
    assert.equal(JSON.parse(readFileSync("/app/package.json", "utf8")).version, expected);
    const { dibaoVersion } = await import("@dibao/shared");
    assert.equal(dibaoVersion, expected, "Image runtime version mismatch");
    assertImageArchitecture(process.env.EXPECTED_ARCH);
    return { arch: process.arch, version: dibaoVersion, sentry: sentryReport(runtime, bundle) };
  }
  if (mode === "seed") {
    probeStage = "historical_image_version";
    assert.equal(JSON.parse(readFileSync("/app/package.json", "utf8")).version, expected, "Historical image version mismatch");
    const { openDatabase } = await import("@dibao/db");
    probeStage = "historical_migrations_and_fixture_seed";
    const db = openDatabase("/data/dibao.sqlite", { migrate: true });
    try { return seedFixture(db); } finally { db.close(); }
  }
  const { default: Database } = await import("better-sqlite3");
  probeStage = "open_database_readonly";
  const db = new Database("/data/dibao.sqlite", { readonly: true, fileMustExist: true });
  db.pragma("query_only=ON");
  try {
    const status = JSON.parse(db.prepare("select value_json from app_settings where key=?")
      .get("upgrade.derivedData.recommendation-contract")?.value_json ?? "null");
    if (mode === "status") return { state: status?.state ?? null, blocking: status?.blocking ?? true };
    assert.equal(mode, "verify");
    const seeded = process.env.SEEDED === "true";
    probeStage = "derived_upgrade_terminal_state";
    assertUpgradeStatus(status, seeded);
    const { loadDefaultMigrations, SqliteVecVectorStore, SqliteRankingRepository } = await import("@dibao/db");
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    const applied = db.prepare("select version,name,checksum from schema_migrations order by version").all();
    probeStage = "migration_checksums_and_foreign_keys";
    const expectedMigrations = loadDefaultMigrations().map((m) => ({ version: m.version, name: m.name,
      checksum: m.checksum ?? createHash("sha256").update(m.sql).digest("hex") }));
    assert.deepEqual(applied, expectedMigrations, "Pending/changed SQL migrations");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    const vectors = new SqliteVecVectorStore(db);
    probeStage = "vector_conversion_and_provider_usage";
    assert.equal(vectors.listCosineUpgradePlans().length, 0, "Pending vector conversion");
    assert.equal(db.prepare("select count(*) n from embedding_usage_events").get().n, 0, "Upgrade invoked an embedding provider");
    assert.equal(db.prepare("select count(*) n from jobs where type='embedding_generate' and attempts>0").get().n, 0, "Upgrade attempted embedding generation");
    const { RECOMMENDATION_ALGORITHM_VERSION, RECOMMENDATION_FEATURE_SCHEMA_VERSION } = await import("/app/apps/server/dist/ranking-service.js");
    probeStage = "full_rank_contract_and_obsolete_context_cleanup";
    assert.equal(status.algorithmVersion, RECOMMENDATION_ALGORITHM_VERSION);
    assert.equal(status.featureSchemaVersion, RECOMMENDATION_FEATURE_SCHEMA_VERSION);
    let ranked = 0;
    if (seeded) {
      const candidates = new SqliteRankingRepository(db).listCandidates();
      assert.equal(candidates.length, 63, "Fixture filtering changed");
      const score = db.prepare("select algorithm_version,feature_schema_version from article_rank_scores where article_id=? and rank_context=?");
      for (const row of candidates) {
        const value = score.get(row.articleId, row.stateRowExists ? "base" : status.rankContext);
        assert(value, "Missing current-contract score");
        if (!row.stateRowExists) {
          assert.equal(value.algorithm_version, RECOMMENDATION_ALGORITHM_VERSION);
          assert.equal(value.feature_schema_version, RECOMMENDATION_FEATURE_SCHEMA_VERSION);
        }
        ranked++;
      }
      for (const table of ["article_rank_scores", "article_rank_explanations", "rank_contexts"]) {
        const column = table === "rank_contexts" ? "id" : "rank_context";
        assert.equal(db.prepare(`select count(*) n from ${table} where ${column} not in (?, 'base')`).get(status.rankContext).n, 0, "Obsolete rank context retained");
      }
      assert.equal(db.prepare("select count(*) n from article_vector_rows").get().n, 65);
      assert(vectors.searchSimilarArticles({ embeddingIndexId: "release-index", vector: [1, 0], limit: 1 }).length > 0);
    }
    const healthResponse = await fetch("http://127.0.0.1:8080/api/system/health");
    probeStage = "http_health_and_upgrade_status";
    assert.equal(healthResponse.status, 200);
    const health = (await healthResponse.json()).data;
    assert.equal(health.ok, true);
    assert.equal(health.version, expected);
    const upgradeResponse = await fetch("http://127.0.0.1:8080/api/system/upgrade/status");
    assert.equal(upgradeResponse.status, 200);
    assertUpgradeStatus((await upgradeResponse.json()).data, seeded);
    return { state: status.state, ranked, migrations: applied.length, embeddings: embeddingSnapshot(db), providerCalls: 0 };
  } finally { db.close(); }
}

if (process.argv[1] === "-") {
  try { console.log(JSON.stringify(await main(process.argv[2]))); }
  catch { console.error(JSON.stringify({ releaseProbeFailed: true, stage: probeStage })); process.exitCode = 1; }
}
