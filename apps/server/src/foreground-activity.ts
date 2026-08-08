import type { AppSettingsRepository } from "@dibao/db";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const FOREGROUND_ACTIVITY_SETTING_KEY = "runtime.foregroundActivity";
export const DEFAULT_FOREGROUND_QUIET_WINDOW_MS = 30_000;
export const DEFAULT_FOREGROUND_ACTIVITY_WRITE_THROTTLE_MS = 2_000;
const FOREGROUND_ACTIVITY_SIGNAL_FILE = "foreground-activity.json";

export type ForegroundActivityState = {
  lastAt: number;
  route: string | null;
  method: string | null;
};

export function markForegroundActivity(
  settings: Pick<AppSettingsRepository, "setJson">,
  input: {
    now: number;
    route?: string | null;
    method?: string | null;
  }
): void {
  settings.setJson(
    FOREGROUND_ACTIVITY_SETTING_KEY,
    {
      lastAt: input.now,
      route: input.route ?? null,
      method: input.method ?? null
    } satisfies ForegroundActivityState,
    input.now
  );
}

export function foregroundActivitySignalPath(databasePath: string | undefined): string | null {
  if (!databasePath || databasePath === ":memory:") {
    return null;
  }

  return runtimeSignalPath(databasePath, FOREGROUND_ACTIVITY_SIGNAL_FILE);
}

function runtimeSignalPath(databasePath: string, filename: string): string {
  // The two processes only need a short-lived coordination signal. In Docker
  // /dev/shm avoids turning every foreground request into a NAS disk write.
  if (process.platform === "linux" && existsSync("/dev/shm")) {
    const key = createHash("sha256").update(resolve(databasePath)).digest("hex").slice(0, 16);
    return join("/dev/shm", `dibao-${key}-${filename}`);
  }
  return join(dirname(databasePath), filename);
}

export function writeForegroundActivitySignal(
  signalPath: string,
  input: {
    now: number;
    route?: string | null;
    method?: string | null;
  },
  onError?: (error: unknown) => void
): void {
  const state = {
    lastAt: input.now,
    route: input.route ?? null,
    method: input.method ?? null
  } satisfies ForegroundActivityState;

  try {
    writeFileSync(signalPath, JSON.stringify(state));
  } catch (error) {
    onError?.(error);
  }
}

export function foregroundQuietUntil(
  settings: Pick<AppSettingsRepository, "getJson">,
  input: {
    now: number;
    quietWindowMs: number;
    signalPath?: string | null;
  }
): number | null {
  if (input.quietWindowMs <= 0) {
    return null;
  }

  const fileState = input.signalPath ? readForegroundActivitySignal(input.signalPath) : null;
  const state = fileState ?? settings.getJson<unknown>(FOREGROUND_ACTIVITY_SETTING_KEY);
  if (!isForegroundActivityState(state)) {
    return null;
  }

  const quietUntil = state.lastAt + input.quietWindowMs;
  return quietUntil > input.now ? quietUntil : null;
}

function readForegroundActivitySignal(signalPath: string): ForegroundActivityState | null {
  try {
    const parsed = JSON.parse(readFileSync(signalPath, "utf8")) as unknown;
    return isForegroundActivityState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isForegroundActivityState(value: unknown): value is ForegroundActivityState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { lastAt?: unknown }).lastAt === "number" &&
    Number.isFinite((value as { lastAt: number }).lastAt)
  );
}
