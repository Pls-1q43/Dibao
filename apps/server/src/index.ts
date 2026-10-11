import { buildServer } from "./app.js";
import { DEFAULT_FOREGROUND_QUIET_WINDOW_MS } from "./foreground-activity.js";
import { claimDesktopProcessOwnership } from "./desktop-process-ownership.js";

claimDesktopProcessOwnership("http");
let stopRequested = false;
if (process.send && process.env.DIBAO_DESKTOP_RUNTIME_TOKEN) {
  process.on("message", message => {
    if (typeof message === "object" && message !== null && "type" in message && message.type === "dibao-stop") stopRequested = true;
  });
  process.once("disconnect", () => { stopRequested = true; });
}

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
  if (process.send && process.env.DIBAO_DESKTOP_RUNTIME_TOKEN) {
    const address = server.server.address();
    if (address && typeof address !== "string") process.send({ type: "dibao-ready", port: address.port });
  }
} catch (error) {
  server.log.error(error);
  process.exit(1);
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await server.close(); process.exit(0); }
  catch (error) { server.log.error(error); process.exit(1); }
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
if (process.send && process.env.DIBAO_DESKTOP_RUNTIME_TOKEN) {
  process.on("message", message => {
    if (typeof message === "object" && message !== null && "type" in message && message.type === "dibao-stop") void shutdown();
  });
  process.once("disconnect", () => void shutdown());
  if (stopRequested || !process.connected) void shutdown();
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
