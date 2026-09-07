import { buildServer } from "./app.js";
import { DEFAULT_FOREGROUND_QUIET_WINDOW_MS } from "./foreground-activity.js";

const host = process.env.DIBAO_HOST ?? "0.0.0.0";
const port = Number(process.env.DIBAO_PORT ?? 8080);

const server = buildServer({
  backgroundJobs: process.env.DIBAO_BACKGROUND_JOBS === "true",
  derivedUpgradeRunner: process.env.DIBAO_PROCESS_ROLE !== "http",
  recordForegroundActivity: process.env.DIBAO_RECORD_FOREGROUND_ACTIVITY !== "false",
  foregroundActivityWriteThrottleMs: parseOptionalPositiveInteger(
    process.env.DIBAO_FOREGROUND_ACTIVITY_WRITE_THROTTLE_MS
  ),
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
  jobRunnerIntervalMs: parseOptionalPositiveInteger(process.env.DIBAO_JOB_RUNNER_INTERVAL_MS),
  jobRunnerMaxJobsPerDrain:
    parseOptionalPositiveInteger(process.env.DIBAO_JOB_RUNNER_MAX_JOBS_PER_DRAIN) ?? 5,
  foregroundQuietWindowMs:
    parseOptionalPositiveInteger(process.env.DIBAO_FOREGROUND_QUIET_WINDOW_MS) ??
    DEFAULT_FOREGROUND_QUIET_WINDOW_MS
});

try {
  await server.listen({ host, port });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
