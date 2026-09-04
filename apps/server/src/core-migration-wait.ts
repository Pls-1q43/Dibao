import { existsSync } from "node:fs";
import {
  getAppliedMigrations,
  loadDefaultMigrations,
  openDatabase,
  SqliteVecVectorStore,
  type AppliedMigration
} from "@dibao/db";

export const DEFAULT_WORKER_CORE_MIGRATION_WAIT_MS = 15 * 60_000;
export const DEFAULT_WORKER_CORE_MIGRATION_POLL_MS = 1_000;

export type CoreMigrationReadiness = {
  databasePath: string;
  databaseExists: boolean;
  migrationTablePresent: boolean;
  expectedVersion: string | null;
  latestApplied: Pick<AppliedMigration, "version" | "name" | "appliedAt"> | null;
  vectorIndexesPending: string[];
  ready: boolean;
  error: string | null;
};

export type WaitForCoreMigrationsReadyOptions = {
  databasePath: string;
  expectedVersion?: string | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (readiness: CoreMigrationReadiness) => void;
  onReady?: (readiness: CoreMigrationReadiness) => void;
};

export class WorkerCoreMigrationWaitTimeoutError extends Error {
  readonly reason = "core_migration_not_completed_before_worker_timeout";

  constructor(
    readonly details: {
      timeoutMs: number;
      pollIntervalMs: number;
      readiness: CoreMigrationReadiness;
    }
  ) {
    super(
      `Worker waited ${details.timeoutMs}ms for core migrations, but schema ${details.readiness.expectedVersion ?? "unknown"} was not ready`
    );
    this.name = "WorkerCoreMigrationWaitTimeoutError";
  }
}

export async function waitForCoreMigrationsReady(
  options: WaitForCoreMigrationsReadyOptions
): Promise<CoreMigrationReadiness> {
  const expectedVersion = options.expectedVersion ?? latestCoreMigrationVersion();
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? DEFAULT_WORKER_CORE_MIGRATION_WAIT_MS));
  const pollIntervalMs = Math.max(100, Math.floor(options.pollIntervalMs ?? DEFAULT_WORKER_CORE_MIGRATION_POLL_MS));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + timeoutMs;
  let waitLogged = false;
  let readiness = readCoreMigrationReadiness(options.databasePath, expectedVersion);

  while (!readiness.ready && now() < deadline) {
    if (!waitLogged) {
      waitLogged = true;
      options.onWait?.(readiness);
    }
    await sleep(Math.min(pollIntervalMs, Math.max(100, deadline - now())));
    readiness = readCoreMigrationReadiness(options.databasePath, expectedVersion);
  }

  if (readiness.ready) {
    if (waitLogged) {
      options.onReady?.(readiness);
    }
    return readiness;
  }

  throw new WorkerCoreMigrationWaitTimeoutError({
    timeoutMs,
    pollIntervalMs,
    readiness
  });
}

export function readCoreMigrationReadiness(
  databasePath: string,
  expectedVersion: string | null = latestCoreMigrationVersion()
): CoreMigrationReadiness {
  if (!existsSync(databasePath)) {
    return {
      databasePath,
      databaseExists: false,
      migrationTablePresent: false,
      expectedVersion,
      latestApplied: null,
      vectorIndexesPending: [],
      ready: false,
      error: null
    };
  }

  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(databasePath, {
      migrate: false
    });
    const table = db
      .prepare(
        `
          select 1 as ok
          from sqlite_master
          where type = 'table'
            and name = 'schema_migrations'
        `
      )
      .get() as { ok: number } | undefined;
    if (!table) {
      return {
        databasePath,
        databaseExists: true,
        migrationTablePresent: false,
        expectedVersion,
        latestApplied: null,
        vectorIndexesPending: [],
        ready: false,
        error: null
      };
    }

    const latest = getAppliedMigrations(db).at(-1) ?? null;
    const vectorIndexesPending = new SqliteVecVectorStore(db)
      .listCosineUpgradePlans()
      .map((plan) => plan.embeddingIndexId);
    return {
      databasePath,
      databaseExists: true,
      migrationTablePresent: true,
      expectedVersion,
      latestApplied: latest
        ? {
            version: latest.version,
            name: latest.name,
            appliedAt: latest.appliedAt
          }
        : null,
      vectorIndexesPending,
      ready:
        expectedVersion !== null &&
        latest?.version === expectedVersion &&
        vectorIndexesPending.length === 0,
      error: null
    };
  } catch (error) {
    return {
      databasePath,
      databaseExists: true,
      migrationTablePresent: false,
      expectedVersion,
      latestApplied: null,
      vectorIndexesPending: [],
      ready: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    db?.close();
  }
}

function latestCoreMigrationVersion(): string | null {
  return loadDefaultMigrations().at(-1)?.version ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
