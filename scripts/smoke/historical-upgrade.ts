// Run from the repository root: node --import tsx scripts/smoke/historical-upgrade.ts
// Uses only in-memory synthetic databases and local Git objects; no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  openDatabase, runMigrations, loadDefaultMigrations, getAppliedMigrations,
  SqliteVecVectorStore, type Migration
} from "../../packages/db/src/index.js";

const tags = ["v0.1.0", "v0.1.1", "v0.1.2", "v0.1.3", "v0.2.0", "v0.2.1", "v0.3.0", "v0.3.1"];
const current = loadDefaultMigrations();
const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" });

for (const tag of ["fresh", ...tags]) {
  const db = openDatabase(":memory:");
  db.pragma("temp_store = MEMORY");
  try {
    const historical: Migration[] = tag === "fresh" ? current : git(["ls-tree", "-r", "--name-only", tag, "packages/db/migrations"])
      .trim().split("\n").map((path) => {
        const match = /\/(\d+)_(.+)\.sql$/.exec(path);
        assert(match, path);
        return { version: match[1], name: match[2], sql: git(["show", `${tag}:${path}`]) };
      });
    for (const old of historical) {
      const live = current.find((migration) => migration.version === old.version);
      assert(live, `${tag}: shipped migration ${old.version} was removed`);
      assert.equal(live.name, old.name);
      assert.equal(live.sql, old.sql, `${tag}: shipped migration ${old.version} was changed`);
    }
    runMigrations(db, historical, () => 1000);
    db.exec(`
      insert into feeds(id,title,feed_url,created_at,updated_at) values('f','fixture','https://example.invalid/rss',1000,1000);
      insert into articles(id,feed_id,url,title,discovered_at,content_hash,dedupe_key,created_at,updated_at)
        values('a','f','https://example.invalid/a','fixture',1000,'hash','a',1000,1000);
      insert into embedding_providers(id,type,name,model,dimension,enabled,created_at,updated_at)
        values('p','embedded_local','fixture','fixture',2,1,1000,1000);
      insert into embedding_indexes(id,provider_id,model,dimension,table_name,status,created_at,updated_at)
        values('i','p','fixture',2,'vec_articles_i','active',1000,1000);
      create virtual table vec_articles_i using vec0(embedding float[2]);
    `);
    const blob = Buffer.from(new Float32Array([1, 0]).buffer);
    db.prepare("insert into article_embeddings values('a','i',?,'hash',1000,1000)").run(blob);
    const rowid = db.prepare("insert into vec_articles_i(embedding) values(?)").run(blob).lastInsertRowid;
    db.prepare("insert into article_vector_rows values('a','i',?,1000)").run(rowid);
    const snapshot = () => db.prepare("select article_id, embedding_index_id, hex(vector_blob), content_hash, created_at, updated_at from article_embeddings").all();
    const before = snapshot();
    const applied = runMigrations(db, current, () => 2000);
    const vectors = new SqliteVecVectorStore(db);
    assert.equal(vectors.listCosineUpgradePlans().length, 1);
    const converted = vectors.upgradeIndexesToCosine();
    assert.deepEqual(snapshot(), before);
    assert.equal(vectors.listCosineUpgradePlans().length, 0);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(getAppliedMigrations(db).at(-1)?.version, current.at(-1)?.version);
    assert.deepEqual(runMigrations(db), []);
    assert.deepEqual(vectors.upgradeIndexesToCosine(), []);
    assert.equal(vectors.searchSimilarArticles({ embeddingIndexId: "i", vector: [1, 0], limit: 1 })[0]?.articleId, "a");
    console.log(JSON.stringify({ tag, applied: applied.map((migration) => migration.version), converted,
      embeddingUnchanged: true, pending: 0, foreignKeyErrors: 0, idempotent: true }));
  } finally { db.close(); }
}
