import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  getAppliedMigrations,
  loadDefaultMigrations,
  openDatabase,
  runMigrations,
  SqliteArticleRepository,
  SqliteEmbeddingRepository,
  SqliteFeedRepository,
  SqliteVecVectorStore,
  toVectorBlob
} from "@dibao/db";
import { CoreDatabaseMigrationService } from "./core-database-migration-service.js";

describe("CoreDatabaseMigrationService", () => {
  it("upgrades every historical migration prefix to the latest schema", async () => {
    const migrations = loadDefaultMigrations();
    const latestVersion = migrations.at(-1)?.version;

    for (let prefixLength = 0; prefixLength <= migrations.length; prefixLength += 1) {
      const db = openDatabase(":memory:");
      try {
        if (prefixLength > 0) {
          runMigrations(db, migrations.slice(0, prefixLength), () => 1000 + prefixLength);
        }

        const service = new CoreDatabaseMigrationService({
          db,
          migrations,
          deferMs: 0,
          now: () => 2000 + prefixLength
        });
        const initial = service.getStatus();
        expect(initial.blocking).toBe(prefixLength < migrations.length);

        const result = await service.startIfRequired();
        expect(result.blocking).toBe(false);
        expect(result.state === "completed" || result.state === "not_required").toBe(true);
        expect(getAppliedMigrations(db).at(-1)?.version).toBe(latestVersion);
        expect(result.result?.appliedNow.length ?? 0).toBe(migrations.length - prefixLength);
      } finally {
        db.close();
      }
    }
  }, 30_000);

  it("keeps migration status responsive while child-process migrations run", async () => {
    const db = openDatabase(":memory:");
    const fakeChild = createFakeChildProcess();
    const service = new CoreDatabaseMigrationService({
      db,
      databasePath: "/tmp/dibao-test.sqlite",
      migrations: [
        {
          version: "001",
          name: "one",
          sql: "create table one (id text primary key);"
        }
      ],
      deferMs: 0,
      now: () => 3000,
      spawnMigrationProcess: () => fakeChild
    });

    try {
      expect(service.getStatus()).toMatchObject({
        state: "pending",
        blocking: true
      });

      const running = service.startIfRequired();
      await Promise.resolve();

      expect(service.getStatus()).toMatchObject({
        state: "running",
        blocking: true,
        progress: {
          current: 0,
          total: 1
        }
      });

      fakeChild.stdout.write(
        `${JSON.stringify({ type: "migration_applied", index: 1, total: 1 })}\n`
      );
      fakeChild.stdout.write(`${JSON.stringify({ type: "completed", appliedNow: [] })}\n`);
      fakeChild.emit("exit", 0, null);

      await expect(running).resolves.toMatchObject({
        state: "completed",
        blocking: false,
        progress: {
          current: 1,
          total: 1,
          percent: 1
        }
      });
    } finally {
      db.close();
    }
  });

  it("blocks ordinary startup until legacy vector indexes are upgraded without new embeddings", async () => {
    const db = openDatabase(":memory:");
    try {
      runMigrations(db);
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const embeddings = new SqliteEmbeddingRepository(db);
      feeds.upsert({
        id: "feed_upgrade",
        title: "Upgrade",
        feedUrl: "https://example.com/upgrade.xml",
        now: 1000
      });
      articles.upsert({
        id: "article_upgrade",
        feedId: "feed_upgrade",
        url: "https://example.com/upgrade",
        title: "Upgrade fixture",
        dedupeKey: "upgrade",
        now: 1000
      });
      embeddings.upsertProvider({
        id: "provider_upgrade",
        type: "embedded_local",
        name: "Upgrade provider",
        model: "upgrade-2d",
        dimension: 2,
        enabled: true,
        now: 1000
      });
      embeddings.createIndex({
        id: "index_upgrade",
        providerId: "provider_upgrade",
        model: "upgrade-2d",
        dimension: 2,
        now: 1000
      });
      db.exec("create virtual table vec_articles_index_upgrade using vec0(embedding float[2])");
      const vectorBlob = toVectorBlob([1, 0]);
      db.prepare(
        `
          insert into article_embeddings (
            article_id,
            embedding_index_id,
            vector_blob,
            content_hash,
            created_at,
            updated_at
          ) values ('article_upgrade', 'index_upgrade', ?, 'hash', 1000, 1000)
        `
      ).run(vectorBlob);
      const vecRowid = Number(
        db.prepare("insert into vec_articles_index_upgrade (embedding) values (?)")
          .run(vectorBlob).lastInsertRowid
      );
      db.prepare(
        `
          insert into article_vector_rows (
            article_id,
            embedding_index_id,
            vec_rowid,
            created_at
          ) values ('article_upgrade', 'index_upgrade', ?, 1000)
        `
      ).run(vecRowid);

      const service = new CoreDatabaseMigrationService({
        db,
        deferMs: 0,
        now: () => 2000
      });
      expect(service.getStatus()).toMatchObject({
        state: "pending",
        blocking: true,
        step: "detecting",
        progress: { current: 0, total: 1 }
      });

      await expect(service.startIfRequired()).resolves.toMatchObject({
        state: "completed",
        blocking: false,
        step: "completed",
        result: {
          appliedNow: [],
          vectorIndexesUpgraded: [
            { embeddingIndexId: "index_upgrade", articlesReindexed: 1 }
          ]
        }
      });
      expect(new SqliteVecVectorStore(db).listCosineUpgradePlans()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function createFakeChildProcess(): ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const child = new EventEmitter() as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}
