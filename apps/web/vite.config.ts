import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { dibaoVersion } from "@dibao/shared";
import { defineConfig } from "vite";

const webConfigDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(webConfigDir, "../..");

type SentryBuildConfig = {
  dsn: string;
  org: string;
  project: string;
  authToken: string;
  tracesSampleRate: number;
  devTracesSampleRate: number;
  replaysSessionSampleRate: number;
  replaysOnErrorSampleRate: number;
};

const defaultSentryConfig: SentryBuildConfig = {
  dsn: "",
  org: "",
  project: "",
  authToken: "",
  tracesSampleRate: 0.1,
  devTracesSampleRate: 1,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1
};

function readSentryAuthToken(): string | undefined {
  const envToken = process.env.SENTRY_AUTH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  for (const envFile of [
    resolve(repoRoot, ".env.sentry-build-plugin"),
    resolve(webConfigDir, ".env.sentry-build-plugin")
  ]) {
    if (!existsSync(envFile)) {
      continue;
    }

    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (key !== "SENTRY_AUTH_TOKEN") {
        continue;
      }

      const value = trimmed.slice(separatorIndex + 1).trim();
      return value.replace(/^['"]|['"]$/g, "") || undefined;
    }
  }

  return undefined;
}

function readSentryConfig(): SentryBuildConfig {
  const configPath = process.env.DIBAO_SENTRY_CONFIG
    ? resolve(repoRoot, process.env.DIBAO_SENTRY_CONFIG)
    : resolve(repoRoot, "config/sentry.json");

  let fileConfig: Partial<SentryBuildConfig> = {};
  if (existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, "utf8")) as Partial<SentryBuildConfig>;
  }

  return {
    dsn: stringValue(process.env.DIBAO_SENTRY_DSN ?? fileConfig.dsn, defaultSentryConfig.dsn),
    org: stringValue(
      process.env.SENTRY_ORG ?? process.env.DIBAO_SENTRY_ORG ?? fileConfig.org,
      defaultSentryConfig.org
    ),
    project: stringValue(
      process.env.SENTRY_PROJECT ?? process.env.DIBAO_SENTRY_PROJECT ?? fileConfig.project,
      defaultSentryConfig.project
    ),
    authToken: stringValue(fileConfig.authToken, defaultSentryConfig.authToken),
    tracesSampleRate: sampleRateValue(fileConfig.tracesSampleRate, defaultSentryConfig.tracesSampleRate),
    devTracesSampleRate: sampleRateValue(
      fileConfig.devTracesSampleRate,
      defaultSentryConfig.devTracesSampleRate
    ),
    replaysSessionSampleRate: sampleRateValue(
      fileConfig.replaysSessionSampleRate,
      defaultSentryConfig.replaysSessionSampleRate
    ),
    replaysOnErrorSampleRate: sampleRateValue(
      fileConfig.replaysOnErrorSampleRate,
      defaultSentryConfig.replaysOnErrorSampleRate
    )
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function sampleRateValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

const sentryConfig = readSentryConfig();
const sentryAuthToken = (readSentryAuthToken() ?? sentryConfig.authToken) || undefined;
const dibaoSentryRelease = `dibao@${dibaoVersion}`;
const sentrySourceMapUploadRequested = process.env.DIBAO_SENTRY_UPLOAD_SOURCEMAPS === "1";
const sentrySourceMapsEnabled = Boolean(
  sentrySourceMapUploadRequested && sentryAuthToken && sentryConfig.org && sentryConfig.project
);

export default defineConfig({
  define: {
    __DIBAO_SENTRY_CONFIG__: JSON.stringify({
      dsn: sentryConfig.dsn,
      org: sentryConfig.org,
      project: sentryConfig.project,
      tracesSampleRate: sentryConfig.tracesSampleRate,
      devTracesSampleRate: sentryConfig.devTracesSampleRate,
      replaysSessionSampleRate: sentryConfig.replaysSessionSampleRate,
      replaysOnErrorSampleRate: sentryConfig.replaysOnErrorSampleRate
    })
  },
  build: {
    sourcemap: sentrySourceMapsEnabled
  },
  plugins: [
    react(),
    {
      name: "dibao-offline-build-assets",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler(_html, { bundle }) {
          // The worker also needs lazy settings and shared chunks on a cold start.
          return Object.values(bundle ?? {})
            .filter((asset) => /\.(?:js|css|woff2?)$/.test(asset.fileName))
            .map((asset) => ({
              tag: "link",
              attrs: { rel: "dibao-offline", href: `/${asset.fileName}` },
              injectTo: "head" as const
            }));
        }
      }
    },
    ...(sentrySourceMapsEnabled
      ? [
          sentryVitePlugin({
            org: sentryConfig.org,
            project: sentryConfig.project,
            authToken: sentryAuthToken,
            release: {
              name: dibaoSentryRelease,
              setCommits: false
            },
            telemetry: false,
            errorHandler(error) {
              throw error;
            },
            sourcemaps: {
              filesToDeleteAfterUpload: ["dist/**/*.map"]
            },
            silent: false
          })
        ]
      : [])
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_DIBAO_API_PROXY ?? "http://127.0.0.1:8080",
        changeOrigin: true
      }
    }
  }
});
