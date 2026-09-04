import {
  dibaoVersion,
  hasDibaoSentryDsn,
  normalizeDibaoSentryConfig,
  sanitizeTelemetryEvent,
  type DibaoSentryConfig
} from "@dibao/shared";

const telemetryPreferenceKey = "dibao.telemetry.enabled";

type SentryReact = typeof import("@sentry/react");

declare const __DIBAO_SENTRY_CONFIG__: Partial<DibaoSentryConfig> | undefined;

let telemetryEnabled = true;
let sentrySdk: SentryReact | null = null;
let sentryLoadPromise: Promise<SentryReact> | null = null;
let sentryInitialized = false;
let sentryInitializing = false;
const clientSentryConfig = normalizeDibaoSentryConfig(readInjectedClientSentryConfig());

export function readStoredTelemetryPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(telemetryPreferenceKey);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function storeTelemetryPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(telemetryPreferenceKey, String(enabled));
  } catch {
    // Storage may be unavailable in hardened browser contexts.
  }
}

export function configureClientTelemetry(enabled: boolean): void {
  telemetryEnabled = enabled;
  storeTelemetryPreference(enabled);

  if (!telemetryEnabled) {
    void sentrySdk?.getReplay()?.stop();
  } else if (sentryInitialized) {
    sentrySdk?.getReplay()?.start();
  }

  if (!sentryInitialized && !sentryInitializing && telemetryEnabled && hasDibaoSentryDsn(clientSentryConfig)) {
    const tracesSampleRate = import.meta.env.DEV
      ? clientSentryConfig.devTracesSampleRate
      : clientSentryConfig.tracesSampleRate;

    sentryInitializing = true;
    void loadSentry().then((Sentry) => {
      sentryInitializing = false;
      if (!telemetryEnabled || sentryInitialized) {
        return;
      }

      Sentry.init({
        dsn: clientSentryConfig.dsn,
        enabled: true,
        environment: import.meta.env.MODE,
        release: `dibao@${dibaoVersion}`,
        sendDefaultPii: false,
        integrations: [
          Sentry.browserTracingIntegration(),
          Sentry.replayIntegration({
            maskAllText: true,
            blockAllMedia: true
          })
        ],
        tracesSampler: () => (telemetryEnabled ? tracesSampleRate : 0),
        replaysSessionSampleRate: clientSentryConfig.replaysSessionSampleRate,
        replaysOnErrorSampleRate: clientSentryConfig.replaysOnErrorSampleRate,
        tracePropagationTargets: [/^\/api\//, window.location.origin],
        beforeSend: (event) => (telemetryEnabled ? sanitizeTelemetryEvent(event) : null),
        beforeSendTransaction: (event) =>
          telemetryEnabled ? sanitizeTelemetryEvent(event) : null
      });
      sentryInitialized = true;
    }).catch(() => {
      sentryInitializing = false;
      sentryLoadPromise = null;
    });
  }
}

function loadSentry(): Promise<SentryReact> {
  if (!sentryLoadPromise) {
    sentryLoadPromise = import("@sentry/react").then((module) => {
      sentrySdk = module;
      return module;
    });
  }

  return sentryLoadPromise;
}

function readInjectedClientSentryConfig(): Partial<DibaoSentryConfig> | undefined {
  return typeof __DIBAO_SENTRY_CONFIG__ === "undefined" ? undefined : __DIBAO_SENTRY_CONFIG__;
}
