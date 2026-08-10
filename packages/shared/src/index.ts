export const dibaoVersion = "0.3.1";

export type DibaoSentryConfig = {
  dsn: string;
  org: string;
  project: string;
  tracesSampleRate: number;
  devTracesSampleRate: number;
  replaysSessionSampleRate: number;
  replaysOnErrorSampleRate: number;
};

declare const __DIBAO_SENTRY_CONFIG__: Partial<DibaoSentryConfig> | undefined;

export const defaultDibaoSentryConfig: DibaoSentryConfig = {
  dsn: "",
  org: "",
  project: "",
  tracesSampleRate: 0.1,
  devTracesSampleRate: 1.0,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0
} as const;

export const dibaoSentryConfig = normalizeDibaoSentryConfig(readInjectedDibaoSentryConfig());

export function normalizeDibaoSentryConfig(
  input: Partial<DibaoSentryConfig> | undefined
): DibaoSentryConfig {
  return {
    dsn: stringValue(input?.dsn, defaultDibaoSentryConfig.dsn),
    org: stringValue(input?.org, defaultDibaoSentryConfig.org),
    project: stringValue(input?.project, defaultDibaoSentryConfig.project),
    tracesSampleRate: sampleRateValue(
      input?.tracesSampleRate,
      defaultDibaoSentryConfig.tracesSampleRate
    ),
    devTracesSampleRate: sampleRateValue(
      input?.devTracesSampleRate,
      defaultDibaoSentryConfig.devTracesSampleRate
    ),
    replaysSessionSampleRate: sampleRateValue(
      input?.replaysSessionSampleRate,
      defaultDibaoSentryConfig.replaysSessionSampleRate
    ),
    replaysOnErrorSampleRate: sampleRateValue(
      input?.replaysOnErrorSampleRate,
      defaultDibaoSentryConfig.replaysOnErrorSampleRate
    )
  };
}

export function hasDibaoSentryDsn(config = dibaoSentryConfig): boolean {
  return config.dsn.length > 0;
}

export function hasDibaoSentrySourceMapProject(config = dibaoSentryConfig): boolean {
  return config.org.length > 0 && config.project.length > 0;
}

function readInjectedDibaoSentryConfig(): Partial<DibaoSentryConfig> | undefined {
  return typeof __DIBAO_SENTRY_CONFIG__ === "undefined" ? undefined : __DIBAO_SENTRY_CONFIG__;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function sampleRateValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

export type ApiSuccess<T> = {
  data: T;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ArticleInteractionStatus = "unseen" | "ignored" | "opened" | "reading" | "read";

export type ArticleState = {
  read: boolean;
  favorited: boolean;
  liked: boolean;
  readLater: boolean;
  hidden: boolean;
  notInterested: boolean;
  readingProgress: number;
  interactionStatus: ArticleInteractionStatus;
  openedAt: number | null;
  ignoredAt: number | null;
};

export type RankReasonImpact = "positive" | "negative" | "neutral";

export type RankReason = {
  type:
    | "positive_cluster"
    | "negative_cluster"
    | "source"
    | "freshness"
    | "duplicate"
    | "state"
    | "fallback";
  label: string;
  impact: RankReasonImpact;
};
