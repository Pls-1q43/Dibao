import { buildServer } from "./app.js";
import {
  DEFAULT_WORKER_CORE_MIGRATION_WAIT_MS,
  waitForCoreMigrationsReady,
  WorkerCoreMigrationWaitTimeoutError
} from "./core-migration-wait.js";
import { DEFAULT_FOREGROUND_QUIET_WINDOW_MS } from "./foreground-activity.js";

try {
  await waitForWorkerCoreMigrationsReady();
} catch (error) {
  if (error instanceof WorkerCoreMigrationWaitTimeoutError) {
    console.error(
      "[dibao] worker failed waiting for core migrations",
      JSON.stringify(
        {
          reason: error.reason,
          message: error.message,
          timeoutMs: error.details.timeoutMs,
          pollIntervalMs: error.details.pollIntervalMs,
          readiness: error.details.readiness,
          issueHint:
            "Core database migration did not finish before the worker timeout. Please attach this log and /api/system/upgrade/status output when filing an issue."
        },
        null,
        2
      )
    );
  } else {
    console.error("[dibao] worker failed before startup", error);
  }
  process.exit(1);
}

const server = buildServer({
  backgroundJobs: true,
  recordForegroundActivity: false,
  webDistDir: false,
  feedRefreshIntervalMs: parseOptionalPositiveInteger(process.env.DIBAO_FEED_REFRESH_INTERVAL_MS),
  retentionCleanupIntervalMs: parseOptionalPositiveInteger(
    process.env.DIBAO_RETENTION_CLEANUP_INTERVAL_MS
  ),
  jobHistoryCleanupIntervalMs: parseOptionalPositiveInteger(
    process.env.DIBAO_JOB_HISTORY_CLEANUP_INTERVAL_MS
  ),
  jobHistoryRetentionDays: parseOptionalPositiveInteger(
    process.env.DIBAO_JOB_HISTORY_RETENTION_DAYS
  ),
  profileDecayIntervalMs: parseOptionalPositiveInteger(process.env.DIBAO_PROFILE_DECAY_INTERVAL_MS),
  recommendationMaintenanceIntervalMs: parseOptionalPositiveInteger(
    process.env.DIBAO_RECOMMENDATION_MAINTENANCE_INTERVAL_MS
  ),
  jobRunnerIntervalMs: parseOptionalPositiveInteger(process.env.DIBAO_JOB_RUNNER_INTERVAL_MS),
  jobRunnerMaxJobsPerDrain:
    parseOptionalPositiveInteger(process.env.DIBAO_JOB_RUNNER_MAX_JOBS_PER_DRAIN) ?? 5,
  foregroundQuietWindowMs:
    parseOptionalPositiveInteger(process.env.DIBAO_FOREGROUND_QUIET_WINDOW_MS) ??
    DEFAULT_FOREGROUND_QUIET_WINDOW_MS,
  backgroundStartupDelayMs:
    parseOptionalPositiveInteger(process.env.DIBAO_BACKGROUND_STARTUP_DELAY_MS) ??
    parseOptionalPositiveInteger(process.env.DIBAO_FOREGROUND_QUIET_WINDOW_MS) ??
    DEFAULT_FOREGROUND_QUIET_WINDOW_MS,
  rankingTargetChunkMs: parseOptionalPositiveInteger(process.env.DIBAO_RANKING_TARGET_CHUNK_MS)
});

let closing = false;
// The worker has no listening socket. Keep its event loop alive without
// polling SQLite; JobRunner's own interval and wake signal perform drains.
const keepAlive = setInterval(() => undefined, 60_000);

try {
  await server.ready();
  server.log.info(
    {
      processRole: "worker",
      foregroundQuietWindowMs:
        parseOptionalPositiveInteger(process.env.DIBAO_FOREGROUND_QUIET_WINDOW_MS) ??
        DEFAULT_FOREGROUND_QUIET_WINDOW_MS,
      backgroundStartupDelayMs:
        parseOptionalPositiveInteger(process.env.DIBAO_BACKGROUND_STARTUP_DELAY_MS) ??
        parseOptionalPositiveInteger(process.env.DIBAO_FOREGROUND_QUIET_WINDOW_MS) ??
        DEFAULT_FOREGROUND_QUIET_WINDOW_MS
    },
    "background worker ready"
  );
} catch (error) {
  server.log.error(error);
  clearInterval(keepAlive);
  process.exit(1);
}

process.on("SIGTERM", () => {
  void closeAndExit(0);
});

process.on("SIGINT", () => {
  void closeAndExit(0);
});

async function closeAndExit(code: number): Promise<void> {
  if (closing) {
    return;
  }

  closing = true;
  clearInterval(keepAlive);
  try {
    await server.close();
  } catch (error) {
    server.log.error(error);
    process.exit(code === 0 ? 1 : code);
  }
  process.exit(code);
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function waitForWorkerCoreMigrationsReady(): Promise<void> {
  const databasePath = process.env.DIBAO_DATABASE_PATH ?? "/data/dibao.sqlite";
  if (databasePath === ":memory:") {
    return;
  }

  await waitForCoreMigrationsReady({
    databasePath,
    timeoutMs:
      parseOptionalPositiveInteger(process.env.DIBAO_WORKER_CORE_MIGRATION_WAIT_MS) ??
      DEFAULT_WORKER_CORE_MIGRATION_WAIT_MS,
    onWait: (readiness) => {
      console.info(
        "[dibao] worker waiting for core migrations before starting background jobs",
        JSON.stringify(readiness)
      );
    },
    onReady: (readiness) => {
      console.info(
        "[dibao] worker observed completed core migrations",
        JSON.stringify(readiness)
      );
    }
  });
}
