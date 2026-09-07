import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dibaoVersion } from "@dibao/shared";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
  start: vi.fn(),
  stop: vi.fn()
}));

vi.mock("@sentry/react", () => ({
  init: sentry.init,
  browserTracingIntegration: sentry.browserTracingIntegration,
  replayIntegration: sentry.replayIntegration,
  getReplay: () => ({ start: sentry.start, stop: sentry.stop })
}));

vi.mock("@dibao/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dibao/shared")>();
  return {
    ...actual,
    normalizeDibaoSentryConfig: () => actual.normalizeDibaoSentryConfig({
      dsn: "https://public@example.invalid/1",
      tracesSampleRate: 0.23,
      devTracesSampleRate: 0.47,
      replaysSessionSampleRate: 0.19,
      replaysOnErrorSampleRate: 0.83
    })
  };
});

type SentryOptions = NonNullable<Parameters<typeof import("@sentry/react").init>[0]>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("DEV", false);
  vi.stubEnv("MODE", "production");
  const stored = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:8080" },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function initializeTelemetry() {
  const telemetry = await import("./telemetry.js");
  telemetry.configureClientTelemetry(true);
  await vi.dynamicImportSettled();
  expect(sentry.init).toHaveBeenCalledTimes(1);
  return { telemetry, options: sentry.init.mock.calls[0]![0] as SentryOptions };
}

describe("client telemetry", () => {
  it.each([false, true])("disables the Replay worker while retaining privacy and sampling (dev=%s)", async (development) => {
    vi.stubEnv("DEV", development);
    const { options } = await initializeTelemetry();

    expect(sentry.replayIntegration).toHaveBeenCalledExactlyOnceWith({
      useCompression: false,
      maskAllText: true,
      blockAllMedia: true
    });
    expect(sentry.browserTracingIntegration).toHaveBeenCalledTimes(1);
    expect(options).toMatchObject({
      enabled: true,
      release: `dibao@${dibaoVersion}`,
      sendDefaultPii: false,
      replaysSessionSampleRate: 0.19,
      replaysOnErrorSampleRate: 0.83
    });
    expect(options.tracesSampler!({ name: "test", inheritOrSampleWith: (rate) => rate })).toBe(development ? 0.47 : 0.23);
  });

  it("does not initialize the SDK when the stored preference is disabled", async () => {
    window.localStorage.setItem("dibao.telemetry.enabled", "false");
    const telemetry = await import("./telemetry.js");
    telemetry.configureClientTelemetry(telemetry.readStoredTelemetryPreference());
    await vi.dynamicImportSettled();

    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.replayIntegration).not.toHaveBeenCalled();
  });

  it("stops replay and suppresses errors and transactions on opt-out without changing configured rates", async () => {
    const { telemetry, options } = await initializeTelemetry();
    const error = { type: undefined, message: "Synthetic telemetry test" };
    const transaction = { type: "transaction" as const, transaction: "Synthetic transaction" };
    const sampling = { name: "test", inheritOrSampleWith: (rate: number) => rate };
    expect(options.beforeSend!(error, {})).toEqual(error);
    expect(options.beforeSendTransaction!(transaction, {})).toEqual(transaction);

    telemetry.configureClientTelemetry(false);
    expect(sentry.stop).toHaveBeenCalledTimes(1);
    expect(telemetry.readStoredTelemetryPreference()).toBe(false);
    expect(options.beforeSend!(error, {})).toBeNull();
    expect(options.beforeSendTransaction!(transaction, {})).toBeNull();
    expect(options.tracesSampler!(sampling)).toBe(0);

    telemetry.configureClientTelemetry(true);
    expect(sentry.start).toHaveBeenCalledTimes(1);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(options.beforeSend!(error, {})).toEqual(error);
    expect(options.tracesSampler!(sampling)).toBe(0.23);
    expect(options.replaysSessionSampleRate).toBe(0.19);
    expect(options.replaysOnErrorSampleRate).toBe(0.83);
  });

  it("honors opt-out while the lazy SDK import is pending", async () => {
    const telemetry = await import("./telemetry.js");
    telemetry.configureClientTelemetry(true);
    telemetry.configureClientTelemetry(false);
    await vi.dynamicImportSettled();

    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.replayIntegration).not.toHaveBeenCalled();
    expect(telemetry.readStoredTelemetryPreference()).toBe(false);
  });
});
