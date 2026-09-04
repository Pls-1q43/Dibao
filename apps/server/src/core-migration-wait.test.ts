import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadDefaultMigrations,
  openDatabase,
  runMigrations,
  SqliteEmbeddingRepository,
  SqliteVecVectorStore
} from "@dibao/db";
import {
  readCoreMigrationReadiness,
  waitForCoreMigrationsReady
} from "./core-migration-wait.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("worker core migration wait", () => {
  it("returns immediately when the latest core migration has been applied", async () => {
    const dbPath = tempDatabasePath();
    const db = openDatabase(dbPath, { migrate: false });
    const migrations = loadDefaultMigrations();
    const latestVersion = migrations.at(-1)?.version;
    if (!latestVersion) {
      throw new Error("Expected at least one migration");
    }

    try {
      runMigrations(db, migrations, () => 1000);
      const readiness = await waitForCoreMigrationsReady({
        databasePath: dbPath,
        timeoutMs: 15 * 60_000,
        now: () => 2000,
        sleep: async () => {
          throw new Error("sleep should not be called");
        }
      });

      expect(readiness).toMatchObject({
        databaseExists: true,
        migrationTablePresent: true,
        expectedVersion: latestVersion,
        latestApplied: {
          version: latestVersion
        },
        ready: true,
        error: null
      });
    } finally {
      db.close();
    }
  });

  it("fails with diagnostic state when core migrations do not finish before timeout", async () => {
    const dbPath = tempDatabasePath();
    const db = openDatabase(dbPath, { migrate: false });
    const migrations = loadDefaultMigrations();
    const latestVersion = migrations.at(-1)?.version;
    const previousVersion = migrations.at(-2)?.version;
    if (!latestVersion || !previousVersion) {
      throw new Error("Expected at least two migrations");
    }
    let now = 0;

    try {
      runMigrations(db, migrations.slice(0, -1), () => 1000);
      await expect(
        waitForCoreMigrationsReady({
          databasePath: dbPath,
          timeoutMs: 2500,
          pollIntervalMs: 1000,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          }
        })
      ).rejects.toMatchObject({
        name: "WorkerCoreMigrationWaitTimeoutError",
        reason: "core_migration_not_completed_before_worker_timeout",
        details: {
          timeoutMs: 2500,
          pollIntervalMs: 1000,
          readiness: {
            databasePath: dbPath,
            databaseExists: true,
            migrationTablePresent: true,
            expectedVersion: latestVersion,
            latestApplied: {
              version: previousVersion
            },
            ready: false,
            error: null
          }
        }
      });
    } finally {
      db.close();
    }
  });

  it("keeps the worker paused while a legacy vector index still needs conversion", () => {
    const dbPath = tempDatabasePath();
    const db = openDatabase(dbPath, { migrate: false });
    try {
      runMigrations(db);
      const embeddings = new SqliteEmbeddingRepository(db);
      embeddings.upsertProvider({
        id: "provider_wait",
        type: "embedded_local",
        name: "Wait provider",
        model: "wait-2d",
        dimension: 2,
        enabled: true,
        now: 1000
      });
      embeddings.createIndex({
        id: "index_wait",
        providerId: "provider_wait",
        model: "wait-2d",
        dimension: 2,
        now: 1000
      });
      db.exec("create virtual table vec_articles_index_wait using vec0(embedding float[2])");

      expect(readCoreMigrationReadiness(dbPath)).toMatchObject({
        ready: false,
        vectorIndexesPending: ["index_wait"]
      });

      new SqliteVecVectorStore(db).upgradeIndexesToCosine();
      expect(readCoreMigrationReadiness(dbPath)).toMatchObject({
        ready: true,
        vectorIndexesPending: []
      });
    } finally {
      db.close();
    }
  });
});

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dibao-core-migration-wait-"));
  tempDirs.push(dir);
  return join(dir, "dibao.sqlite");
}
