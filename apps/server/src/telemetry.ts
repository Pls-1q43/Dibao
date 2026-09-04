import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";
import {
  dibaoSentryConfig,
  dibaoVersion,
  hasDibaoSentryDsn,
  normalizeDibaoSentryConfig,
  sanitizeTelemetryEvent,
  type DibaoSentryConfig
} from "@dibao/shared";

type TelemetryOptions = {
  enabled: boolean;
};

let telemetryEnabled = false;
let sentryInitialized = false;
const fastifyAppsWithErrorHandler = new WeakSet<FastifyInstance>();
const serverDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(serverDir, "../../..");

export function configureServerTelemetry(options: TelemetryOptions): void {
  telemetryEnabled = options.enabled;
  const sentryConfig = readServerSentryConfig();

  if (!sentryInitialized && telemetryEnabled && hasDibaoSentryDsn(sentryConfig)) {
    const tracesSampleRate =
      process.env.NODE_ENV === "production"
        ? sentryConfig.tracesSampleRate
        : sentryConfig.devTracesSampleRate;

    Sentry.init({
      dsn: sentryConfig.dsn,
      enabled: true,
      environment: process.env.NODE_ENV ?? "development",
      release: `dibao@${dibaoVersion}`,
      sendDefaultPii: false,
      tracesSampler: () => (telemetryEnabled ? tracesSampleRate : 0),
      beforeSend: (event) => (telemetryEnabled ? sanitizeTelemetryEvent(event) : null),
      beforeSendTransaction: (event) =>
        telemetryEnabled ? sanitizeTelemetryEvent(event) : null,
      integrations: [
        Sentry.fastifyIntegration({
          shouldHandleError: (_error, _request, reply) =>
            telemetryEnabled && reply.statusCode >= 500
        })
      ]
    });
    sentryInitialized = true;
  }
}

export function attachServerTelemetryErrorHandler(app: FastifyInstance): void {
  if (fastifyAppsWithErrorHandler.has(app)) {
    return;
  }

  Sentry.setupFastifyErrorHandler(app, {
    shouldHandleError: (_error, _request, reply) =>
      telemetryEnabled && reply.statusCode >= 500
  });
  fastifyAppsWithErrorHandler.add(app);
}

function readServerSentryConfig(): DibaoSentryConfig {
  const configPaths = [
    process.env.DIBAO_SENTRY_CONFIG
      ? resolveConfigPath(process.env.DIBAO_SENTRY_CONFIG)
      : undefined,
    resolve(repoRoot, ".dibao/sentry.json"),
    resolve(process.cwd(), ".dibao/sentry.json"),
    resolve(repoRoot, "config/sentry.json"),
    resolve(process.cwd(), "config/sentry.json")
  ].filter((path): path is string => Boolean(path));

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) {
      continue;
    }

    const input = JSON.parse(readFileSync(configPath, "utf8")) as Partial<DibaoSentryConfig>;
    return normalizeDibaoSentryConfig({
      ...input,
      dsn: process.env.DIBAO_SENTRY_DSN ?? input.dsn,
      org: process.env.SENTRY_ORG ?? process.env.DIBAO_SENTRY_ORG ?? input.org,
      project: process.env.SENTRY_PROJECT ?? process.env.DIBAO_SENTRY_PROJECT ?? input.project
    });
  }

  return normalizeDibaoSentryConfig({
    ...dibaoSentryConfig,
    dsn: process.env.DIBAO_SENTRY_DSN ?? dibaoSentryConfig.dsn,
    org: process.env.SENTRY_ORG ?? process.env.DIBAO_SENTRY_ORG ?? dibaoSentryConfig.org,
    project: process.env.SENTRY_PROJECT ?? process.env.DIBAO_SENTRY_PROJECT ?? dibaoSentryConfig.project
  });
}

function resolveConfigPath(configPath: string): string {
  return isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
}
