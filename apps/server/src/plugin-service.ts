import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { verifyPluginPackageSignature, type DibaoPluginSignature } from "@dibao/plugin-sdk";
import type {
  ArticleInteractionStatus,
  ArticleStateSnapshot,
  DibaoDatabase,
  JobRepository,
  JobRow,
  PluginDeliveryMethod,
  PluginDeliveryRow,
  PluginDeliveryStatus,
  PluginInstallRow,
  PluginRepository,
  PluginSecretMetadata,
  PluginScheduleRow
} from "@dibao/db";
import {
  controlledFetchText,
  type ControlledFetcher,
  type HostnameResolver
} from "./controlled-fetch.js";
import type {
  FullContentPluginExtractionInput,
  FullContentPluginExtractionResult
} from "./full-content-extraction-service.js";
import { DeferredJobRun, PermanentJobFailure, type JobHandler } from "./job-runner.js";

export const PLUGIN_CAPABILITIES = [
  "articles:read",
  "articles:write",
  "feeds:read",
  "feeds:write",
  "ranking:read",
  "ranking:write",
  "settings:plugin",
  "settings:core:read",
  "settings:core:write",
  "jobs:read",
  "jobs:write",
  "database:plugin",
  "network:outbound",
  "secrets:plugin",
  "deliveries:read",
  "deliveries:write",
  "files:plugin-data",
  "telemetry:emit"
] as const;

const PLUGIN_CAPABILITY_SET = new Set<string>(PLUGIN_CAPABILITIES);
export const PLUGIN_EVENT_CATALOG = [
  "article.created",
  "article.updated",
  "article.actionRecorded",
  "feed.refreshCompleted",
  "ranking.afterRanked",
  "settings.afterUpdated",
  "plugin.taskSucceeded",
  "plugin.taskFailed",
  "maintenance.tick",
  "dailyBrief.generated"
] as const;
const PLUGIN_EVENT_SET = new Set<string>(PLUGIN_EVENT_CATALOG);
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const PLUGIN_SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PLUGIN_HOOK_TIMEOUT_MS = 2_000;
const PLUGIN_FULL_CONTENT_EXTRACTOR_TIMEOUT_MS = 2_000;
const PLUGIN_ACTIVATION_TIMEOUT_MS = 10_000;
const PLUGIN_API_TIMEOUT_MS = 30_000;
const PLUGIN_TASK_PAUSED_RETRY_MS = 6 * 60 * 60 * 1000;
const PLUGIN_TRANSIENT_RETRY_MS = 60_000;
const PLUGIN_RUNTIME_STOP_GRACE_MS = 2_000;
const PLUGIN_DELIVERY_TASK_ID = "__delivery";
const PLUGIN_RUNTIME_LAST_ERROR_KEY = "runtime:lastError";
const PLUGIN_OUTBOUND_TIMEOUT_MS = 10_000;
const PLUGIN_OUTBOUND_MAX_REQUEST_BYTES = 256 * 1024;
const PLUGIN_OUTBOUND_MAX_RESPONSE_BYTES = 512 * 1024;
const PLUGIN_OUTBOUND_MAX_REDIRECTS = 3;
const PLUGIN_PACKAGE_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const PLUGIN_UPDATE_METADATA_MAX_BYTES = 512 * 1024;
const PLUGIN_DELIVERY_FLUSH_TIMEOUT_MS = 15_000;
const PLUGIN_DELIVERY_FLUSH_POLL_MS = 250;
const PLUGIN_DELIVERY_FLUSH_RETRY_DELAY_MS = 60_000;

export type PluginManifest = {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  publisher: string;
  dibao: {
    minVersion: string;
    maxVersion: string;
  };
  entry?: {
    server?: string;
    web?: string;
  };
  capabilities: string[];
  migrations?: PluginMigrationContribution[];
  contributes?: {
    settingsTabs?: PluginPanelContribution[];
    tabs?: PluginPanelContribution[];
    routes?: PluginRouteContribution[];
    actions?: PluginActionContribution[];
    hooks?: string[];
    events?: string[];
    fullContentExtractors?: PluginFullContentExtractorContribution[];
    tasks?: PluginTaskContribution[];
    setupSteps?: PluginSetupStepContribution[];
  };
};

export type PluginPanelContribution = {
  id: string;
  title: string;
  slot: string;
  order?: number;
  icon?: string;
  route?: string;
  primaryNav?: boolean;
  primaryMobile?: boolean;
};

export type PluginRouteContribution = {
  id: string;
  path: string;
  title: string;
  panel: string;
  order?: number;
  icon?: string;
  primaryNav?: boolean;
  primaryMobile?: boolean;
};

export type PluginActionContribution = {
  id: string;
  title: string;
  slot: string;
  icon?: string;
  command: string;
  order?: number;
};

export type PluginFullContentExtractorContribution = {
  id: string;
  title: string;
  order?: number;
};

export type PluginTaskContribution = {
  id: string;
  kind: "foreground" | "background";
  schedule?: "manual" | "interval" | "daily" | "weekly";
  defaultEnabled?: boolean;
};

export type PluginSetupStepContribution = {
  id: string;
  title: string;
  body?: string;
  order?: number;
  defaultEnabled?: boolean;
};

export type PluginMigrationContribution = {
  version: string;
  name: string;
  path: string;
  checksum?: string;
};

type PluginPackage = {
  manifest?: unknown;
  files?: Record<string, string>;
  updateUrl?: string;
  signature?: DibaoPluginSignature;
};

type PluginUpdateMetadata = {
  pluginId?: unknown;
  latestVersion?: unknown;
  updateUrl?: unknown;
  packageUrl?: unknown;
  sha256?: unknown;
  checksum?: unknown;
  manifest?: unknown;
  files?: Record<string, string>;
};

export type PluginListItem = {
  id: string;
  name: string;
  version: string;
  publisher: string;
  status: PluginInstallRow["status"];
  sourceType: PluginInstallRow["sourceType"];
  sourceUrl: string | null;
  updateUrl: string | null;
  official: boolean;
  bundled: boolean;
  trustLevel: PluginInstallRow["trustLevel"];
  capabilities: string[];
  grantedCapabilities: string[];
  apiStability: PluginApiStabilitySummary;
  contributes: PluginManifest["contributes"];
  contributions: PluginRuntimeContributions;
  installedAt: string;
  updatedAt: string;
  enabledAt: string | null;
  disabledAt: string | null;
  lastError: string | null;
};

export type PluginContributionListItem = PluginListItem & {
  webEntryUrl: string | null;
};

export type RankedWinner = {
  articleId: string;
  feedId: string;
  feedTitle: string;
  title: string;
  url: string;
  summary: string | null;
  publishedAt: number | null;
  discoveredAt: number;
  score: number | null;
  calculatedAt: number | null;
  familyId: string;
  familyLabel: string;
  clusterId: string | null;
  clusterLabel: string | null;
  reason: string | null;
  state?: ArticleStateSnapshot;
};

export type PluginTopicTargets = {
  families: Array<{
    id: string;
    label: string;
    polarity: "positive" | "negative";
    clusterCount: number;
    supportArticleCount: number;
  }>;
  clusters: Array<{
    id: string;
    label: string;
    familyId: string;
    polarity: "positive" | "negative";
  }>;
};

export class PluginServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "PluginServiceError";
  }
}

export type PluginServiceOptions = {
  db: DibaoDatabase;
  plugins: PluginRepository;
  jobs: JobRepository;
  dibaoVersion: string;
  getActiveRankContext: () => string;
  officialPluginsDir?: string;
  pluginDataDir?: string;
  fetcher?: ControlledFetcher;
  resolveHostname?: HostnameResolver;
  enableUserPluginInstall?: boolean;
  trustedPublicKeys?: Record<string, string>;
  secretKey?: string;
  now?: () => number;
  drainDueJobs?: () => Promise<number>;
  logPerformance?: (record: {
    route: string;
    pluginId: string;
    method: "GET" | "POST";
    durationMs: number;
    briefCount?: number;
    familyCount?: number;
    clusterCount?: number;
  }) => void;
};

type PluginRuntime = {
  pluginId: string;
  child: ChildProcess | null;
  disposed: boolean;
  hooks: Set<string>;
  fullContentExtractors: Set<string>;
  tasks: Set<string>;
  apiGet: Set<string>;
  apiPost: Set<string>;
  pending: Map<string, PluginRuntimePending>;
  invoke: (
    kind: "hook" | "task" | "api" | "fullContentExtractor",
    name: string,
    input: unknown,
    timeoutMs?: number
  ) => Promise<unknown>;
  dispose: () => Promise<void>;
};

type PluginApiInput = {
  params: Record<string, string>;
  body: unknown;
};

type PluginApiRouteMatch = {
  route: string;
  params: Record<string, string>;
};

type PluginRuntimePending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PluginHostSerializedError = {
  message?: unknown;
  statusCode?: unknown;
  code?: unknown;
  details?: unknown;
};

type PluginHostCommand = {
  command: string;
  args: string[];
};

type PluginApiStabilitySummary = {
  stable: string[];
  beta: string[];
};

type PluginRuntimeContributions = {
  routes: Array<{ id: string; title: string; path: string }>;
  primaryNav: Array<{ label: string; route: string; icon?: string; order?: number }>;
  primaryMobile: Array<{ label: string; route: string; icon?: string; order?: number }>;
  settingsTabs: Array<{ id: string; label: string; route: string; order?: number }>;
  tabs: Array<{ id: string; label: string; slot: string; route: string; icon?: string; order?: number }>;
  actions: Array<{
    id: string;
    label: string;
    slot: string;
    icon?: string;
    command: string;
    order?: number;
  }>;
  setupSteps: Array<{
    id: string;
    title: string;
    body: string;
    enableLabel?: string;
    skipLabel?: string;
    recommended?: boolean;
  }>;
};

export type PluginSecretMetadataItem = Omit<PluginSecretMetadata, "pluginId" | "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export type PluginDeliveryListItem = Omit<PluginDeliveryRow, "requestJson" | "responseJson" | "createdAt" | "updatedAt" | "finishedAt"> & {
  request: unknown;
  response: unknown;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

type PluginOutboundFetchInput = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

type PluginDeliveryEnqueueInput = PluginOutboundFetchInput & {
  idempotencyKey?: string | null;
  maxAttempts?: number;
  secretHeaders?: Record<string, { key: string; prefix?: string }>;
};

type PluginDeliveryStoredRequest = {
  method: PluginDeliveryMethod;
  url: string;
  headers: Record<string, string>;
  secretHeaders: Record<string, { key: string; prefix?: string }>;
  body: unknown;
  timeoutMs: number;
};

type PluginTableColumnType = "text" | "integer" | "real" | "boolean" | "json";

type PluginTableColumnDefinition = {
  name: string;
  type: PluginTableColumnType;
  nullable?: boolean;
  unique?: boolean;
  default?: string | number | boolean | null;
};

type PluginTableIndexDefinition = {
  name: string;
  columns: string[];
  unique?: boolean;
};

type PluginTableDefinition = {
  name: string;
  columns: PluginTableColumnDefinition[];
  indexes?: PluginTableIndexDefinition[];
};

type PluginTableListInput = {
  where?: Record<string, unknown>;
  limit?: number;
  orderBy?: string;
  direction?: "asc" | "desc";
};

type PluginArticleStateDbRow = {
  read: 0 | 1;
  favorited: 0 | 1;
  liked: 0 | 1;
  readLater: 0 | 1;
  hidden: 0 | 1;
  notInterested: 0 | 1;
  readingProgress: number;
  lastOpenedAt: number | null;
  lastIgnoredAt: number | null;
  lastActionAt: number | null;
  notInterestedAt: number | null;
};

export class PluginService {
  private readonly now: () => number;
  private readonly fetcher: ControlledFetcher | undefined;
  private readonly enableUserPluginInstall: boolean;
  private readonly trustedPublicKeys: Record<string, string>;
  private readonly secretCodec: PluginSecretCodec;
  private readonly secretKeyStatus: { source: "environment" | "fallback_file" | "ephemeral"; persistent: boolean };
  private readonly runtimes = new Map<string, Promise<PluginRuntime>>();
  private readonly disposingRuntimes = new Map<string, Promise<void>>();
  readonly officialPluginsDir: string;
  readonly pluginDataDir: string;
  readonly installedPluginsDir: string;
  readonly pluginRuntimeDataDir: string;

  constructor(private readonly options: PluginServiceOptions) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher;
    this.enableUserPluginInstall =
      options.enableUserPluginInstall ??
      readBooleanEnv("DIBAO_ENABLE_UNTRUSTED_PLUGINS") ??
      false;
    this.trustedPublicKeys =
      options.trustedPublicKeys ?? readTrustedPublicKeysEnv("DIBAO_PLUGIN_TRUSTED_KEYS_JSON");
    this.officialPluginsDir = resolvePluginPath(
      options.officialPluginsDir ??
        process.env.DIBAO_OFFICIAL_PLUGINS_DIR ??
        defaultOfficialPluginsDir()
    );
    this.pluginDataDir = resolvePluginPath(
      options.pluginDataDir ?? process.env.DIBAO_PLUGIN_DATA_DIR ?? "/data/plugins"
    );
    this.installedPluginsDir = join(this.pluginDataDir, "installed");
    this.pluginRuntimeDataDir = join(this.pluginDataDir, "data");
    const resolvedSecretKey = resolvePluginSecretKey({
      secretKey: options.secretKey,
      pluginDataDir: this.pluginDataDir
    });
    this.secretCodec = new PluginSecretCodec(resolvedSecretKey.key);
    this.secretKeyStatus = {
      source: resolvedSecretKey.source,
      persistent: resolvedSecretKey.persistent
    };
  }

  dispose(): void {
    for (const pluginId of [...this.runtimes.keys()]) {
      this.disposeRuntime(pluginId);
    }
  }

  async checkUpdate(pluginId: string): Promise<PluginListItem> {
    const install = this.requireInstall(pluginId);
    if (!install.updateUrl) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin has no update URL");
    }
    const metadata = await this.fetchUpdateMetadata(install.updateUrl);
    this.options.plugins.upsertUpdateCheck({
      pluginId,
      latestVersion: stringOrNull(metadata.latestVersion),
      updateUrl: stringOrNull(metadata.updateUrl) ?? install.updateUrl,
      packageUrl: stringOrNull(metadata.packageUrl),
      checksum: stringOrNull(metadata.sha256) ?? stringOrNull(metadata.checksum),
      metadataJson: JSON.stringify(metadata),
      now: this.now()
    });

    if (typeof metadata.packageUrl === "string") {
      const updated = await this.installFromUrl(metadata.packageUrl, {
        expectedId: pluginId,
        expectedSha256: stringOrNull(metadata.sha256) ?? stringOrNull(metadata.checksum),
        previousStatus: install.status
      });
      return install.status === "enabled" ? await this.enable(pluginId) : updated;
    }

    return this.requireListItem(pluginId);
  }

  disable(pluginId: string): PluginListItem {
    this.requireInstall(pluginId);
    this.options.plugins.setStatus(pluginId, "disabled", null, this.now());
    this.disposeRuntime(pluginId);
    this.options.jobs.cancelOpenByTypePrefix?.(
      `plugin:${pluginId}:`,
      "Plugin disabled",
      this.now()
    );
    return this.requireListItem(pluginId);
  }

  async enable(pluginId: string): Promise<PluginListItem> {
    const install = this.requireInstall(pluginId);
    const manifest = parseStoredManifest(install);
    const compatibility = isDibaoVersionCompatible(this.options.dibaoVersion, manifest.dibao);
    if (!compatibility.ok) {
      this.options.plugins.setStatus(pluginId, "incompatible", compatibility.reason, this.now());
      return this.requireListItem(pluginId);
    }
    try {
      this.disposeRuntime(pluginId);
      this.applyPluginMigrations(pluginId, manifest);
      this.seedDefaultSchedules(pluginId, manifest);
      this.options.plugins.grantCapabilities(pluginId, manifest.capabilities, this.now());
      this.options.plugins.setStatus(pluginId, "enabled", null, this.now());
      await this.ensureRuntime(this.requireInstall(pluginId));
      return this.requireListItem(pluginId);
    } catch (error) {
      const message = errorMessage(error);
      if (install.official && isTransientPluginRuntimeError(message)) {
        this.recordOfficialPluginRuntimeError(pluginId, "enable", message);
        this.disposeRuntime(pluginId);
        return this.requireListItem(pluginId);
      }
      this.options.plugins.setStatus(pluginId, "failed", message, this.now());
      this.disposeRuntime(pluginId);
      throw error;
    }
  }

  async emitHook(hook: string, payload: unknown): Promise<void> {
    const installs = this.enabledInstallsForHook(hook);
    for (const install of installs) {
      try {
        const runtime = await this.ensureRuntime(install);
        if (!runtime.hooks.has(hook)) {
          continue;
        }
        await runtime.invoke("hook", hook, payload, PLUGIN_HOOK_TIMEOUT_MS);
        this.options.plugins.setKv(
          install.id,
          `hook:${hook}:last`,
          { hook, receivedAt: this.now(), payload },
          this.now()
        );
      } catch (error) {
        const message = errorMessage(error);
        if (install.official && isTransientPluginRuntimeError(message)) {
          const failedAt = this.now();
          this.options.plugins.setKv(
            install.id,
            `hook:${hook}:lastError`,
            { hook, failedAt, error: redactText(message) },
            failedAt
          );
          this.recordOfficialPluginRuntimeError(install.id, `hook:${hook}`, message, failedAt);
          this.disposeRuntime(install.id);
          continue;
        }
        this.options.plugins.setStatus(install.id, "failed", message, this.now());
        this.disposeRuntime(install.id);
      }
    }
  }

  async extractFullContent(
    input: FullContentPluginExtractionInput
  ): Promise<FullContentPluginExtractionResult | null> {
    for (const candidate of this.enabledFullContentExtractors()) {
      try {
        const runtime = await this.ensureRuntime(candidate.install);
        if (!runtime.fullContentExtractors.has(candidate.extractor.id)) {
          continue;
        }
        const result = await runtime.invoke(
          "fullContentExtractor",
          candidate.extractor.id,
          input,
          PLUGIN_FULL_CONTENT_EXTRACTOR_TIMEOUT_MS
        );
        const normalized = normalizeFullContentPluginResult(result);
        if (!normalized) {
          continue;
        }
        this.options.plugins.setKv(
          candidate.install.id,
          `fullContentExtractor:${candidate.extractor.id}:last`,
          {
            articleUrl: input.articleUrl,
            extractedAt: this.now(),
            textLength: normalized.contentText.length
          },
          this.now()
        );
        return normalized;
      } catch (error) {
        const message = errorMessage(error);
        if (candidate.install.official && isTransientPluginRuntimeError(message)) {
          const failedAt = this.now();
          this.options.plugins.setKv(
            candidate.install.id,
            `fullContentExtractor:${candidate.extractor.id}:lastError`,
            { articleUrl: input.articleUrl, failedAt, error: redactText(message) },
            failedAt
          );
          this.recordOfficialPluginRuntimeError(
            candidate.install.id,
            `fullContentExtractor:${candidate.extractor.id}`,
            message,
            failedAt
          );
          this.disposeRuntime(candidate.install.id);
          continue;
        }
        this.options.plugins.setStatus(candidate.install.id, "failed", message, this.now());
        this.disposeRuntime(candidate.install.id);
      }
    }
    return null;
  }

  async enqueueDueSchedules(): Promise<JobRow[]> {
    const enqueued: JobRow[] = [];
    for (const schedule of this.options.plugins.listDueSchedules(this.now())) {
      const install = this.options.plugins.findInstall(schedule.pluginId);
      if (!install || install.status !== "enabled") {
        continue;
      }
      const manifest = parseStoredManifest(install);
      const task = manifest.contributes?.tasks?.find((candidate) => candidate.id === schedule.taskId);
      if (!task) {
        continue;
      }
      const job = this.startTask(schedule.pluginId, schedule.taskId, {
        scheduledAt: this.now(),
        schedule
      });
      enqueued.push(job);
      this.options.plugins.upsertSchedule({
        ...schedule,
        lastRunAt: this.now(),
        lastJobId: job.id,
        nextRunAt: nextRunForSchedule(schedule, this.now()),
        now: this.now()
      });
    }
    return enqueued;
  }

  getHealth(pluginId: string): Record<string, unknown> {
    const install = this.requireInstall(pluginId);
    const manifest = parseStoredManifest(install);
    const runtimeLastError = this.options.plugins.getKv<Record<string, unknown>>(
      pluginId,
      PLUGIN_RUNTIME_LAST_ERROR_KEY
    );
    return {
      pluginId,
      status: install.status,
      compatible: isDibaoVersionCompatible(this.options.dibaoVersion, manifest.dibao).ok,
      lastError: install.lastError,
      runtimeStatus: runtimeLastError ? "degraded" : "ok",
      runtimeLastError: stringValueOrNull(runtimeLastError?.error) ?? null,
      runtimeLastErrorAt: numberValueOrNull(runtimeLastError?.failedAt),
      capabilities: manifest.capabilities,
      secretKey: this.secretKeyStatus,
      schedules: this.options.plugins.listSchedules(pluginId),
      tasks: manifest.contributes?.tasks ?? []
    };
  }

  getSettings(pluginId: string): Record<string, unknown> {
    this.requireInstall(pluginId);
    return this.options.plugins.listSettings(pluginId);
  }

  listSecretMetadata(pluginId: string): PluginSecretMetadataItem[] {
    this.requireCapability(pluginId, "secrets:plugin");
    return this.options.plugins.listSecrets(pluginId).map(mapPluginSecretMetadataItem);
  }

  setSecret(pluginId: string, key: string, value: unknown, hint?: string | null): PluginSecretMetadataItem {
    this.requireCapability(pluginId, "secrets:plugin");
    const normalizedKey = normalizeSecretKey(key);
    const plaintext = typeof value === "string" ? value : "";
    if (!plaintext) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin secret value is required");
    }
    const metadata = this.options.plugins.upsertSecret({
      pluginId,
      key: normalizedKey,
      ciphertext: this.secretCodec.encrypt(plaintext),
      hint: stringOrNull(hint),
      now: this.now()
    });
    return mapPluginSecretMetadataItem(metadata);
  }

  deleteSecret(pluginId: string, key: string): void {
    this.requireCapability(pluginId, "secrets:plugin");
    this.options.plugins.deleteSecret(pluginId, normalizeSecretKey(key));
  }

  listDeliveries(pluginId: string, input: { status?: PluginDeliveryStatus; limit?: number } = {}): PluginDeliveryListItem[] {
    this.requireCapability(pluginId, "deliveries:read");
    return this.options.plugins
      .listDeliveries({ pluginId, status: input.status, limit: input.limit })
      .map(mapPluginDeliveryListItem);
  }

  getDelivery(pluginId: string, deliveryId: string): PluginDeliveryListItem {
    this.requireCapability(pluginId, "deliveries:read");
    const delivery = this.options.plugins.findDelivery(deliveryId);
    if (!delivery || delivery.pluginId !== pluginId) {
      throw new PluginServiceError(404, "NOT_FOUND", "Plugin delivery not found");
    }
    return mapPluginDeliveryListItem(delivery);
  }

  handlePluginJob: JobHandler = async (job: JobRow) => {
    const parsed = parsePluginJobType(job.type);
    if (!parsed) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Invalid plugin job type");
    }
    const install = this.requireInstall(parsed.pluginId);
    if (install.status !== "enabled") {
      throw new DeferredJobRun(
        `Plugin paused: ${parsed.pluginId} is ${install.status}`,
        this.now() + PLUGIN_TASK_PAUSED_RETRY_MS
      );
    }
    if (parsed.taskId === PLUGIN_DELIVERY_TASK_ID) {
      await this.handleDeliveryJob(parsed.pluginId, job);
      return;
    }
    let runtime: PluginRuntime;
    try {
      runtime = await this.ensureRuntime(install);
    } catch (error) {
      const message = errorMessage(error);
      if (install.official && isTransientPluginRuntimeError(message)) {
        this.recordOfficialPluginRuntimeError(parsed.pluginId, `task:${parsed.taskId}`, message);
        this.disposeRuntime(parsed.pluginId);
        throw new DeferredJobRun(
          `Plugin runtime unavailable: ${redactText(message)}`,
          this.now() + PLUGIN_TRANSIENT_RETRY_MS
        );
      }
      this.options.plugins.setStatus(parsed.pluginId, "failed", message, this.now());
      this.disposeRuntime(parsed.pluginId);
      throw new DeferredJobRun(
        `Plugin runtime unavailable: ${redactText(message)}`,
        this.now() + PLUGIN_TASK_PAUSED_RETRY_MS
      );
    }
    if (!runtime.tasks.has(parsed.taskId)) {
      throw new DeferredJobRun(
        `Plugin task paused: ${parsed.taskId} is not registered`,
        this.now() + PLUGIN_TASK_PAUSED_RETRY_MS
      );
    }
    try {
      await runtime.invoke("task", parsed.taskId, job);
      void this.emitHook("plugin.taskSucceeded", {
        pluginId: parsed.pluginId,
        taskId: parsed.taskId,
        jobId: job.id,
        finishedAt: this.now()
      });
    } catch (error) {
      const message = errorMessage(error);
      if (install.official && isTransientPluginRuntimeError(message)) {
        this.recordOfficialPluginRuntimeError(parsed.pluginId, `task:${parsed.taskId}`, message);
        this.disposeRuntime(parsed.pluginId);
        throw new DeferredJobRun(
          `Plugin runtime unavailable: ${redactText(message)}`,
          this.now() + PLUGIN_TRANSIENT_RETRY_MS
        );
      }
      void this.emitHook("plugin.taskFailed", {
        pluginId: parsed.pluginId,
        taskId: parsed.taskId,
        jobId: job.id,
        failedAt: this.now(),
        error: redactText(errorMessage(error))
      });
      throw error;
    }
  };

  async installFromPackageContent(
    packageContent: string,
    input: {
      sourceType: "local_file" | "url" | "github_release" | "registry";
      sourceUrl?: string | null;
      updateUrl?: string | null;
      expectedId?: string;
      expectedSha256?: string | null;
      previousStatus?: PluginInstallRow["status"];
    }
  ): Promise<PluginListItem> {
    this.assertUserPluginInstallEnabled();
    if (input.expectedSha256) {
      const actual = createHash("sha256").update(packageContent).digest("hex");
      if (actual !== input.expectedSha256) {
        throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin package checksum mismatch");
      }
    }
    const parsed = parsePluginPackage(packageContent);
    const signatureResult = verifyPluginPackageSignature({
      pluginPackage: {
        manifest: parsed.manifest,
        files: parsed.files,
        updateUrl: parsed.updateUrl,
        signature: parsed.signature
      },
      trustedPublicKeys: this.trustedPublicKeys
    });
    if (!signatureResult.ok) {
      throw new PluginServiceError(
        400,
        "VALIDATION_ERROR",
        signatureResult.errors.join("; ")
      );
    }
    const manifest = parsePluginManifest(parsed.manifest);
    if (input.expectedId && manifest.id !== input.expectedId) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin package ID mismatch");
    }
    return this.writeInstalledPackage(manifest, parsed.files ?? {}, {
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl ?? null,
      updateUrl: input.updateUrl ?? parsed.updateUrl ?? input.sourceUrl ?? null,
      previousStatus: input.previousStatus
    });
  }

  async installFromUrl(
    url: string,
    options: {
      expectedId?: string;
      expectedSha256?: string | null;
      previousStatus?: PluginInstallRow["status"];
    } = {}
  ): Promise<PluginListItem> {
    this.assertUserPluginInstallEnabled();
    const content = await this.fetchPluginText(url, PLUGIN_PACKAGE_FETCH_MAX_BYTES);
    const metadata = parsePluginUpdateMetadataContent(content);
    const packageUrl = stringOrNull(metadata?.packageUrl);
    if (metadata && packageUrl) {
      const packageContent = await this.fetchPluginText(packageUrl, PLUGIN_PACKAGE_FETCH_MAX_BYTES);
      return this.installFromPackageContent(packageContent, {
        sourceType: isGitHubUrl(url) ? "github_release" : "url",
        sourceUrl: packageUrl,
        updateUrl: stringOrNull(metadata.updateUrl) ?? url,
        expectedId: options.expectedId ?? stringOrNull(metadata.pluginId) ?? undefined,
        expectedSha256:
          options.expectedSha256 ??
          stringOrNull(metadata.sha256) ??
          stringOrNull(metadata.checksum),
        previousStatus: options.previousStatus
      });
    }
    return this.installFromPackageContent(content, {
      sourceType: isGitHubUrl(url) ? "github_release" : "url",
      sourceUrl: url,
      updateUrl: url,
      expectedId: options.expectedId,
      expectedSha256: options.expectedSha256 ?? null,
      previousStatus: options.previousStatus
    });
  }

  list(): PluginListItem[] {
    this.reconcileOfficialPlugins();
    return this.options.plugins.listInstalls().map((install) => this.toListItem(install));
  }

  listContributions(): PluginContributionListItem[] {
    this.reconcileOfficialPlugins();
    return this.options.plugins
      .listInstalls()
      .filter((install) => install.status === "enabled")
      .map((install) => ({
        ...this.toListItem(install),
        webEntryUrl: this.webEntryUrl(install)
      }));
  }

  listSetupSteps(): PluginContributionListItem[] {
    this.reconcileOfficialPlugins();
    return this.options.plugins
      .listInstalls()
      .filter((install) => {
        const manifest = parseStoredManifest(install);
        return Boolean(manifest.contributes?.setupSteps?.length);
      })
      .map((install) => ({
        ...this.toListItem(install),
        webEntryUrl: this.webEntryUrl(install)
      }));
  }

  listCatalog(): PluginListItem[] {
    this.reconcileOfficialPlugins();
    return this.list().filter((plugin) => plugin.official);
  }

  reconcileOfficialPlugins(): void {
    if (!existsSync(this.officialPluginsDir)) {
      return;
    }
    for (const entry of readdirSync(this.officialPluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packagePath = join(this.officialPluginsDir, entry.name);
      const manifestPath = join(packagePath, "plugin.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      try {
        const manifest = parsePluginManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
        const compatibility = isDibaoVersionCompatible(this.options.dibaoVersion, manifest.dibao);
        const existing = this.options.plugins.findInstall(manifest.id);
        const existingTransientFailed =
          existing?.status === "failed" &&
          typeof existing.lastError === "string" &&
          isTransientPluginRuntimeError(existing.lastError);
        const status = compatibility.ok
          ? existingTransientFailed
            ? "enabled"
            : existing?.status === "enabled" || existing?.status === "disabled" || existing?.status === "failed"
            ? existing.status
            : "installed"
          : "incompatible";
        const install = this.options.plugins.upsertInstall({
          id: manifest.id,
          version: manifest.version,
          sourceType: "official",
          packagePath,
          dataPath: join(this.pluginRuntimeDataDir, manifest.id),
          manifestJson: JSON.stringify(manifest),
          status,
          official: true,
          bundled: true,
          trustLevel: "official",
          lastError: compatibility.ok ? (status === "failed" ? existing?.lastError ?? null : null) : compatibility.reason,
          now: this.now()
        });
        this.options.plugins.grantCapabilities(manifest.id, manifest.capabilities, this.now());
        if (existingTransientFailed && typeof existing.lastError === "string") {
          this.recordOfficialPluginRuntimeError(manifest.id, "catalog:reconcile", existing.lastError);
        }
        if (status === "enabled") {
          this.recoverPausedOfficialPluginJobs(manifest.id);
        }
      } catch {
        // A broken official plugin must not prevent the app from booting.
      }
    }
  }

  remove(pluginId: string, deleteData = false): void {
    const install = this.requireInstall(pluginId);
    if (install.official) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Official plugins cannot be uninstalled");
    }
    if (install.packagePath && existsSync(install.packagePath)) {
      rmSync(install.packagePath, { recursive: true, force: true });
    }
    if (deleteData && install.dataPath && existsSync(install.dataPath)) {
      rmSync(install.dataPath, { recursive: true, force: true });
    }
    this.options.plugins.deleteInstall(pluginId);
    this.runtimes.delete(pluginId);
  }

  resolveAssetPath(pluginId: string, assetPath: string): string | null {
    const install = this.requireInstall(pluginId);
    if (!install.packagePath) {
      return null;
    }
    const normalizedAssetPath = normalize(assetPath).replace(/^(\.\.(?:\/|\\|$))+/, "");
    const root = resolve(install.packagePath);
    const candidate = resolve(root, normalizedAssetPath);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      return null;
    }
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      return null;
    }
    return candidate;
  }

  startTask(pluginId: string, taskId: string, extraPayload: Record<string, unknown> = {}): JobRow {
    const install = this.requireInstall(pluginId);
    if (install.status !== "enabled") {
      throw new PluginServiceError(409, "CONFLICT", "Plugin is not enabled");
    }
    const manifest = parseStoredManifest(install);
    const task = manifest.contributes?.tasks?.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new PluginServiceError(404, "NOT_FOUND", "Plugin task not found");
    }
    return this.options.jobs.enqueue({
      id: `plugin_${pluginId.replace(/[^a-z0-9]+/gi, "_")}_${taskId.replace(/[^a-z0-9]+/gi, "_")}_${randomBytes(6).toString("hex")}`,
      type: `plugin:${pluginId}:${taskId}`,
      payloadJson: JSON.stringify({ pluginId, taskId, requestedAt: this.now(), ...extraPayload }),
      now: this.now()
    });
  }

  async dispatchApi(pluginId: string, method: "GET" | "POST", path: string, body: unknown): Promise<unknown> {
    const startedAt = performance.now();
    let normalizedPath = "/";
    const install = this.requireInstall(pluginId);
    if (install.status !== "enabled") {
      throw new PluginServiceError(409, "CONFLICT", "Plugin is not enabled");
    }
    const runtime = await this.ensureRuntime(install);
    normalizedPath = normalizeApiPath(path);
    const match = matchPluginApiRoute(method === "GET" ? runtime.apiGet : runtime.apiPost, normalizedPath);
    if (!match) {
      throw new PluginServiceError(404, "NOT_FOUND", "Plugin API route not found");
    }
    try {
      const result = await runtime.invoke(
        "api",
        `${method} ${match.route}`,
        { params: match.params, body },
        PLUGIN_API_TIMEOUT_MS
      );
      this.logApiPerformance({
        route: normalizedPath,
        pluginId,
        method,
        durationMs: roundDuration(performance.now() - startedAt),
        ...summarizePluginApiResult(result)
      });
      return result;
    } catch (error) {
      this.logApiPerformance({
        route: normalizedPath,
        pluginId,
        method,
        durationMs: roundDuration(performance.now() - startedAt)
      });
      throw error;
    }
  }

  private logApiPerformance(record: {
    route: string;
    pluginId: string;
    method: "GET" | "POST";
    durationMs: number;
    briefCount?: number;
    familyCount?: number;
    clusterCount?: number;
  }) {
    this.options.logPerformance?.(record);
  }

  updateSettings(pluginId: string, body: unknown): Record<string, unknown> {
    this.requireInstall(pluginId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin settings body must be an object");
    }
    for (const [key, value] of Object.entries(body)) {
      this.options.plugins.setSetting(pluginId, key, value, this.now());
    }
    return this.getSettings(pluginId);
  }

  private async ensureRuntime(install: PluginInstallRow): Promise<PluginRuntime> {
    const existing = this.runtimes.get(install.id);
    if (existing) {
      return existing;
    }
    const disposing = this.disposingRuntimes.get(install.id);
    if (disposing) {
      await disposing.catch(() => undefined);
      const afterDispose = this.runtimes.get(install.id);
      if (afterDispose) {
        return afterDispose;
      }
    }
    const runtimePromise = this.activateRuntime(install);
    this.runtimes.set(install.id, runtimePromise);
    return runtimePromise;
  }

  private async activateRuntime(install: PluginInstallRow): Promise<PluginRuntime> {
    const manifest = parseStoredManifest(install);
    let child: ChildProcess | null = null;
    let invokeSequence = 0;
    const pending = new Map<string, PluginRuntimePending>();
    const runtime: PluginRuntime = {
      pluginId: install.id,
      child: null,
      disposed: false,
      hooks: new Set(),
      fullContentExtractors: new Set(),
      tasks: new Set(),
      apiGet: new Set(),
      apiPost: new Set(),
      pending,
      invoke: (kind, name, input, timeoutMs = PLUGIN_API_TIMEOUT_MS) => {
        if (!child || !child.connected) {
          return Promise.reject(new PluginServiceError(503, "PLUGIN_RUNTIME_UNAVAILABLE", "Plugin host is not running"));
        }
        const id = `plugin_${install.id}_${++invokeSequence}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new PluginServiceError(504, "PLUGIN_TIMEOUT", `Plugin ${kind} timed out: ${name}`));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          const sent = sendPluginChildMessage(child, { type: "plugin.invoke", id, kind, name, input }, (error) => {
            const pendingCall = pending.get(id);
            if (!pendingCall) {
              return;
            }
            pending.delete(id);
            clearTimeout(pendingCall.timer);
            pendingCall.reject(
              new PluginServiceError(
                503,
                "PLUGIN_RUNTIME_UNAVAILABLE",
                `Plugin host is not accepting messages: ${error.message}`
              )
            );
          });
          if (!sent) {
            pending.delete(id);
            clearTimeout(timer);
            reject(new PluginServiceError(503, "PLUGIN_RUNTIME_UNAVAILABLE", "Plugin host is not running"));
          }
        });
      },
      dispose: async () => {
        runtime.disposed = true;
        const error = new PluginServiceError(503, "PLUGIN_RUNTIME_UNAVAILABLE", "Plugin host stopped");
        rejectPendingPluginCalls(pending, error);
        if (child && !child.killed) {
          await terminatePluginChild(child);
        }
      }
    };
    if (!install.packagePath || !manifest.entry?.server) {
      return runtime;
    }
    const entryPath = this.resolveAssetPath(install.id, manifest.entry.server);
    if (!entryPath) {
      throw new PluginServiceError(500, "PLUGIN_ENTRY_MISSING", "Plugin server entry was not found");
    }

    const host = resolvePluginHostCommand();
    const hostConfig = Buffer.from(JSON.stringify({
      pluginId: install.id,
      manifest,
      entryPath
    }), "utf8").toString("base64url");
    child = spawn(host.command, host.args, {
      env: {
        ...process.env,
        DIBAO_PLUGIN_HOST_CONFIG: hostConfig
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    runtime.child = child;

    return await new Promise<PluginRuntime>((resolveRuntime, rejectRuntime) => {
      let settled = false;
      let stderr = "";
      const activationTimer = setTimeout(() => {
        rejectActivation(new PluginServiceError(504, "PLUGIN_TIMEOUT", "Plugin activation timed out"));
      }, PLUGIN_ACTIVATION_TIMEOUT_MS);

      const rejectActivation = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(activationTimer);
        runtime.dispose();
        rejectRuntime(error);
      };

      const resolveActivation = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(activationTimer);
        resolveRuntime(runtime);
      };

      child?.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
      });

      child?.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") {
          return;
        }
        const record = message as Record<string, unknown>;
        if (record.type === "plugin.ready") {
          resolveActivation();
          return;
        }
        if (record.type === "plugin.failed") {
          rejectActivation(errorFromPluginHost(record.error as PluginHostSerializedError | undefined));
          return;
        }
        if (record.type === "plugin.register") {
          try {
            this.registerPluginContribution(runtime, manifest, record.kind, record.name);
          } catch (error) {
            rejectActivation(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        if (record.type === "plugin.response") {
          settlePluginInvocation(runtime, record);
          return;
        }
        if (record.type === "host.call") {
          const id = typeof record.id === "string" ? record.id : "";
          const method = typeof record.method === "string" ? record.method : "";
          void this.handleHostCall(install, method, record.args)
            .then((result) => sendHostResponse(child, id, { ok: true, result }))
            .catch((error) => sendHostResponse(child, id, { ok: false, error: serializePluginHostError(error) }));
        }
      });

      child?.once("exit", (code, signal) => {
        const suffix = stderr ? `: ${redactText(stderr.trim())}` : "";
        const error = new PluginServiceError(
          503,
          "PLUGIN_RUNTIME_EXITED",
          `Plugin host exited (${signal ?? code ?? "unknown"})${suffix}`
        );
        rejectPendingPluginCalls(pending, error);
        if (!settled) {
          rejectActivation(error);
          return;
        }
        this.runtimes.delete(install.id);
        if (runtime.disposed) {
          return;
        }
        const current = this.options.plugins.findInstall(install.id);
        if (current?.status === "enabled") {
          if (install.official && isTransientPluginRuntimeError(error.message)) {
            this.recordOfficialPluginRuntimeError(install.id, "runtime:exit", error.message);
            return;
          }
          this.options.plugins.setStatus(install.id, "failed", error.message, this.now());
        }
      });
    });
  }

  private disposeRuntime(pluginId: string): void {
    const existing = this.runtimes.get(pluginId);
    this.runtimes.delete(pluginId);
    if (!existing) {
      return;
    }
    const disposing = existing
      .then((runtime) => runtime.dispose())
      .catch(() => {
        // Activation failures already clean up their child process.
      })
      .finally(() => {
        if (this.disposingRuntimes.get(pluginId) === disposing) {
          this.disposingRuntimes.delete(pluginId);
        }
      });
    this.disposingRuntimes.set(pluginId, disposing);
  }

  private recordOfficialPluginRuntimeError(
    pluginId: string,
    scope: string,
    message: string,
    failedAt = this.now()
  ): void {
    this.options.plugins.setKv(
      pluginId,
      PLUGIN_RUNTIME_LAST_ERROR_KEY,
      {
        scope,
        failedAt,
        error: redactText(message)
      },
      failedAt
    );
  }

  private recoverPausedOfficialPluginJobs(pluginId: string): void {
    for (const job of this.options.jobs.listOpenByTypePrefix(`plugin:${pluginId}:`)) {
      if (job.error?.includes(`Plugin paused: ${pluginId} is failed`)) {
        this.options.jobs.defer(job.id, "Official plugin recovered from transient runtime failure", this.now(), this.now());
      }
    }
  }

  private registerPluginContribution(
    runtime: PluginRuntime,
    manifest: PluginManifest,
    kind: unknown,
    name: unknown
  ): void {
    if (typeof name !== "string" || !name.trim()) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin registered an invalid contribution");
    }
    if (kind === "hook") {
      if (!PLUGIN_EVENT_SET.has(name)) {
        throw new PluginServiceError(400, "VALIDATION_ERROR", `Unknown plugin event: ${name}`);
      }
      if (!(manifest.contributes?.hooks?.includes(name) ?? false)) {
        throw new PluginServiceError(403, "FORBIDDEN", `Plugin hook is not declared: ${name}`);
      }
      runtime.hooks.add(name);
      return;
    }
    if (kind === "task") {
      if (!(manifest.contributes?.tasks?.some((task) => task.id === name) ?? false)) {
        throw new PluginServiceError(403, "FORBIDDEN", `Plugin task is not declared: ${name}`);
      }
      runtime.tasks.add(name);
      return;
    }
    if (kind === "fullContentExtractor") {
      if (!(manifest.contributes?.fullContentExtractors?.some((extractor) => extractor.id === name) ?? false)) {
        throw new PluginServiceError(403, "FORBIDDEN", `Plugin full content extractor is not declared: ${name}`);
      }
      runtime.fullContentExtractors.add(name);
      return;
    }
    if (kind === "api:get") {
      runtime.apiGet.add(normalizeApiPath(name));
      return;
    }
    if (kind === "api:post") {
      runtime.apiPost.add(normalizeApiPath(name));
      return;
    }
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin registered an unsupported contribution");
  }

  private async handleHostCall(install: PluginInstallRow, method: string, args: unknown): Promise<unknown> {
    const pluginId = install.id;
    const manifest = parseStoredManifest(install);
    const requireCapability = (capability: string) => {
      if (!manifest.capabilities.includes(capability)) {
        throw new PluginServiceError(403, "FORBIDDEN", `Plugin capability required: ${capability}`);
      }
    };
    const record = parseJsonObject(args) ?? {};
    switch (method) {
      case "now":
        return this.now();
      case "events.catalog":
        return [...PLUGIN_EVENT_CATALOG];
      case "events.emit": {
        const event = stringValue(record.event);
        if (!(manifest.contributes?.events?.includes(event) ?? false)) {
          throw new PluginServiceError(403, "FORBIDDEN", `Plugin event is not declared: ${event}`);
        }
        await this.emitHook(event, {
          pluginId,
          emittedAt: this.now(),
          payload: record.payload
        });
        return { ok: true };
      }
      case "tasks.start": {
        requireCapability("jobs:write");
        const taskId = stringValue(record.taskId);
        return this.startTask(pluginId, taskId, objectValue(record.payload));
      }
      case "storage.get":
        requireCapability("files:plugin-data");
        return this.options.plugins.getKv(pluginId, stringValue(record.key));
      case "storage.set":
        requireCapability("files:plugin-data");
        this.options.plugins.setKv(pluginId, stringValue(record.key), record.value, this.now());
        return { ok: true };
      case "storage.listByPrefix":
        requireCapability("files:plugin-data");
        return this.options.plugins.listKvByPrefix(pluginId, stringValue(record.prefix));
      case "storage.delete":
        requireCapability("files:plugin-data");
        this.options.plugins.deleteKv(pluginId, stringValue(record.key));
        return { ok: true };
      case "settings.get":
        requireCapability("settings:plugin");
        return this.options.plugins.getSetting(pluginId, stringValue(record.key));
      case "settings.set":
        requireCapability("settings:plugin");
        this.options.plugins.setSetting(pluginId, stringValue(record.key), record.value, this.now());
        return { ok: true };
      case "settings.list":
        requireCapability("settings:plugin");
        return this.options.plugins.listSettings(pluginId);
      case "secrets.list":
        requireCapability("secrets:plugin");
        return this.listSecretMetadata(pluginId);
      case "secrets.get":
        requireCapability("secrets:plugin");
        return this.readSecret(pluginId, stringValue(record.key));
      case "secrets.set":
        requireCapability("secrets:plugin");
        return this.setSecret(pluginId, stringValue(record.key), typeof record.value === "string" ? record.value : "", stringOrNull(record.hint));
      case "secrets.delete":
        requireCapability("secrets:plugin");
        this.deleteSecret(pluginId, stringValue(record.key));
        return { ok: true };
      case "network.fetch":
        requireCapability("network:outbound");
        return await this.pluginFetch(args as PluginOutboundFetchInput);
      case "deliveries.enqueue":
        requireCapability("deliveries:write");
        return this.enqueueDelivery(pluginId, args as PluginDeliveryEnqueueInput);
      case "deliveries.get":
        requireCapability("deliveries:read");
        return this.getDelivery(pluginId, stringValue(record.deliveryId));
      case "deliveries.list":
        requireCapability("deliveries:read");
        return this.listDeliveries(pluginId, {
          status: isPluginDeliveryStatus(record.status) ? record.status : undefined,
          limit: typeof record.limit === "number" ? record.limit : undefined
        });
      case "deliveries.cancel":
        requireCapability("deliveries:write");
        return this.cancelDelivery(pluginId, stringValue(record.deliveryId));
      case "deliveries.flush":
        requireCapability("deliveries:write");
        return await this.flushDelivery(pluginId, stringValue(record.deliveryId));
      case "database.defineTable":
        requireCapability("database:plugin");
        this.definePluginTable(pluginId, args as PluginTableDefinition);
        return { ok: true };
      case "database.insert":
        requireCapability("database:plugin");
        return this.insertPluginRow(pluginId, stringValue(record.tableName), objectValue(record.record));
      case "database.get":
        requireCapability("database:plugin");
        return this.getPluginRow(pluginId, stringValue(record.tableName), Number(record.rowId));
      case "database.list":
        requireCapability("database:plugin");
        return this.listPluginRows(pluginId, stringValue(record.tableName), objectValue(record.input) as PluginTableListInput);
      case "database.delete":
        requireCapability("database:plugin");
        this.deletePluginRow(pluginId, stringValue(record.tableName), Number(record.rowId));
        return { ok: true };
      case "scheduler.configureDaily": {
        requireCapability("jobs:write");
        const input = objectValue(record.input);
        const localTime = stringValue(input.localTime);
        const timezone = stringOrNull(input.timezone) ?? "UTC";
        this.options.plugins.upsertSchedule({
          pluginId,
          taskId: stringValue(record.taskId),
          enabled: input.enabled === true,
          schedule: "daily",
          localTime,
          timezone,
          nextRunAt: nextDailyRunAt(this.now(), localTime, timezone),
          now: this.now()
        });
        return { ok: true };
      }
      case "ranking.listRankedWinners":
        requireCapability("ranking:read");
        return this.listRankedWinners({
          windowMs: typeof record.windowMs === "number" ? record.windowMs : 60_000,
          limit: typeof record.limit === "number" ? record.limit : 50
        });
      case "ranking.listTopicTargets":
        requireCapability("ranking:read");
        return this.listTopicTargets();
      case "articles.countDiscovered":
        requireCapability("articles:read");
        return this.countDiscoveredArticles({
          startAt: typeof record.startAt === "number" ? record.startAt : 0,
          endAt: typeof record.endAt === "number" ? record.endAt : this.now()
        });
      case "articles.openableSummary":
        requireCapability("articles:read");
        return this.openableArticleSummary(stringValue(record.articleId));
      case "articles.snapshot":
        requireCapability("articles:read");
        return this.articleSnapshot(stringValue(record.articleId), objectValue(record.input) as { includeContent?: boolean });
      default:
        throw new PluginServiceError(404, "NOT_FOUND", `Unsupported plugin host API: ${method}`);
    }
  }

  private readSecret(pluginId: string, key: string): string | null {
    const row = this.options.plugins.getSecret(pluginId, normalizeSecretKey(key));
    return row ? this.secretCodec.decrypt(row.ciphertext) : null;
  }

  private async pluginFetch(input: PluginOutboundFetchInput) {
    return await performPluginFetch({
      input: normalizeOutboundFetchInput(input),
      fetcher: this.fetcher,
      resolveHostname: this.options.resolveHostname
    });
  }

  private enqueueDelivery(pluginId: string, input: PluginDeliveryEnqueueInput): PluginDeliveryListItem {
    const request = normalizeDeliveryRequest(input);
    if (input.idempotencyKey) {
      const existing = this.options.plugins.findDeliveryByIdempotencyKey(pluginId, input.idempotencyKey);
      if (existing) {
        return mapPluginDeliveryListItem(existing);
      }
    }

    const deliveryId = `delivery_${pluginId.replace(/[^a-z0-9]+/gi, "_")}_${randomBytes(6).toString("hex")}`;
    this.options.plugins.upsertDelivery({
      id: deliveryId,
      pluginId,
      status: "queued",
      method: request.method,
      url: request.url,
      requestJson: JSON.stringify(request),
      idempotencyKey: input.idempotencyKey ?? null,
      now: this.now()
    });
    const job = this.options.jobs.enqueue({
      id: `plugin_delivery_${pluginId.replace(/[^a-z0-9]+/gi, "_")}_${randomBytes(6).toString("hex")}`,
      type: `plugin:${pluginId}:${PLUGIN_DELIVERY_TASK_ID}`,
      payloadJson: JSON.stringify({ deliveryId }),
      maxAttempts: Math.min(Math.max(Math.trunc(input.maxAttempts ?? 5), 1), 10),
      now: this.now()
    });
    const delivery = this.options.plugins.updateDeliveryStatus(deliveryId, {
      status: "queued",
      jobId: job.id,
      now: this.now()
    });
    if (!delivery) {
      throw new PluginServiceError(500, "INTERNAL_ERROR", "Failed to create plugin delivery");
    }
    return mapPluginDeliveryListItem(delivery);
  }

  private cancelDelivery(pluginId: string, deliveryId: string): PluginDeliveryListItem {
    const delivery = this.options.plugins.findDelivery(deliveryId);
    if (!delivery || delivery.pluginId !== pluginId) {
      throw new PluginServiceError(404, "NOT_FOUND", "Plugin delivery not found");
    }
    if (delivery.jobId) {
      this.options.jobs.cancel(delivery.jobId, "Cancelled by plugin", this.now());
    }
    const updated = this.options.plugins.updateDeliveryStatus(deliveryId, {
      status: "cancelled",
      error: "Cancelled by plugin",
      finishedAt: this.now(),
      now: this.now()
    });
    return mapPluginDeliveryListItem(updated ?? delivery);
  }

  private async flushDelivery(pluginId: string, deliveryId: string): Promise<PluginDeliveryListItem> {
    let delivery = this.options.plugins.findDelivery(deliveryId);
    if (!delivery || delivery.pluginId !== pluginId) {
      throw new PluginServiceError(404, "NOT_FOUND", "Plugin delivery not found");
    }
    if (!delivery.jobId || isTerminalDeliveryStatus(delivery.status)) {
      return mapPluginDeliveryListItem(delivery);
    }
    await this.options.drainDueJobs?.();
    delivery = this.options.plugins.findDelivery(deliveryId);
    if (!delivery || delivery.pluginId !== pluginId) {
      throw new PluginServiceError(404, "NOT_FOUND", "Plugin delivery not found");
    }
    if (isTerminalDeliveryStatus(delivery.status)) {
      return mapPluginDeliveryListItem(delivery);
    }

    const job = delivery.jobId ? this.options.jobs.claimById(delivery.jobId, this.now()) : null;
    if (job) {
      try {
        await this.handleDeliveryJob(pluginId, job);
        this.options.jobs.markSucceeded(job.id, this.now());
      } catch (error) {
        const message = errorMessage(error);
        if (error instanceof PermanentJobFailure) {
          this.options.jobs.markFailed(job.id, message, this.now());
        } else {
          this.options.jobs.markFailedOrRetry(job.id, message, this.now(), PLUGIN_DELIVERY_FLUSH_RETRY_DELAY_MS);
        }
      }
      return this.getDelivery(pluginId, deliveryId);
    }

    return await this.waitForDeliveryTerminal(pluginId, deliveryId, PLUGIN_DELIVERY_FLUSH_TIMEOUT_MS);
  }

  private async waitForDeliveryTerminal(pluginId: string, deliveryId: string, timeoutMs: number): Promise<PluginDeliveryListItem> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const delivery = this.options.plugins.findDelivery(deliveryId);
      if (!delivery || delivery.pluginId !== pluginId) {
        throw new PluginServiceError(404, "NOT_FOUND", "Plugin delivery not found");
      }
      if (isTerminalDeliveryStatus(delivery.status)) {
        return mapPluginDeliveryListItem(delivery);
      }
      await sleep(PLUGIN_DELIVERY_FLUSH_POLL_MS);
    }
    return this.getDelivery(pluginId, deliveryId);
  }

  private async handleDeliveryJob(pluginId: string, job: JobRow): Promise<void> {
    const payload = parseJsonObject(job.payloadJson);
    const deliveryId = stringOrNull(payload?.deliveryId);
    if (!deliveryId) {
      throw new PermanentJobFailure("Invalid plugin delivery job payload");
    }
    const delivery = this.options.plugins.findDelivery(deliveryId);
    if (!delivery || delivery.pluginId !== pluginId) {
      throw new PermanentJobFailure("Plugin delivery not found");
    }
    if (delivery.status === "cancelled" || delivery.status === "succeeded") {
      return;
    }
    const request = parseDeliveryStoredRequest(delivery.requestJson);
    this.options.plugins.updateDeliveryStatus(delivery.id, { status: "running", now: this.now() });

    const startedAt = this.now();
    let attemptRecorded = false;
    try {
      const headers = { ...request.headers };
      for (const [headerName, secretRef] of Object.entries(request.secretHeaders)) {
        const secret = this.readSecret(pluginId, secretRef.key);
        if (!secret) {
          throw new PermanentJobFailure(`Plugin secret not found: ${secretRef.key}`);
        }
        headers[headerName] = `${secretRef.prefix ?? ""}${secret}`;
      }
      const response = await performPluginFetch({
        input: {
          method: request.method,
          url: request.url,
          headers,
          body: request.body,
          timeoutMs: request.timeoutMs
        },
        fetcher: this.fetcher,
        resolveHostname: this.options.resolveHostname
      });
      const durationMs = Math.max(this.now() - startedAt, 0);
      const responseJson = JSON.stringify(redactedFetchResponse(response));
      const requestJson = JSON.stringify(redactedDeliveryRequest(request));
      const ok = response.status >= 200 && response.status < 300;
      this.options.plugins.insertDeliveryAttempt({
        id: `attempt_${delivery.id}_${job.attempts}`,
        deliveryId: delivery.id,
        attempt: job.attempts,
        status: ok ? "succeeded" : "failed",
        statusCode: response.status,
        durationMs,
        requestJson,
        responseJson,
        error: ok ? null : `HTTP ${response.status}`,
        now: this.now()
      });
      attemptRecorded = true;
      if (ok) {
        this.options.plugins.updateDeliveryStatus(delivery.id, {
          status: "succeeded",
          responseJson,
          error: null,
          finishedAt: this.now(),
          now: this.now()
        });
        return;
      }
      const finalAttempt = job.attempts >= job.maxAttempts || (response.status >= 400 && response.status < 500);
      this.options.plugins.updateDeliveryStatus(delivery.id, {
        status: finalAttempt ? "failed" : "queued",
        responseJson,
        error: `HTTP ${response.status}`,
        finishedAt: finalAttempt ? this.now() : null,
        now: this.now()
      });
      if (finalAttempt) {
        throw new PermanentJobFailure(`Plugin delivery failed: HTTP ${response.status}`);
      }
      throw new Error(`Plugin delivery failed: HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof PermanentJobFailure) {
        this.options.plugins.updateDeliveryStatus(delivery.id, {
          status: "failed",
          error: redactText(error.message),
          finishedAt: this.now(),
          now: this.now()
        });
        throw error;
      }
      const finalAttempt = job.attempts >= job.maxAttempts;
      if (!attemptRecorded) {
        this.options.plugins.insertDeliveryAttempt({
          id: `attempt_${delivery.id}_${job.attempts}`,
          deliveryId: delivery.id,
          attempt: job.attempts,
          status: "failed",
          durationMs: Math.max(this.now() - startedAt, 0),
          requestJson: JSON.stringify(redactedDeliveryRequest(request)),
          error: redactText(errorMessage(error)),
          now: this.now()
        });
      }
      this.options.plugins.updateDeliveryStatus(delivery.id, {
        status: finalAttempt ? "failed" : "queued",
        error: redactText(errorMessage(error)),
        finishedAt: finalAttempt ? this.now() : null,
        now: this.now()
      });
      throw error;
    }
  }

  private listRankedWinners(input: { windowMs: number; limit: number }): RankedWinner[] {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 250);
    const since = this.now() - Math.max(input.windowMs, 60_000);
    const rankContext = this.options.getActiveRankContext();
    const rows = this.options.db
      .prepare(
        `
          select
            a.id as articleId,
            a.feed_id as feedId,
            f.title as feedTitle,
            a.title,
            a.url,
            a.summary,
            a.published_at as publishedAt,
            a.discovered_at as discoveredAt,
            coalesce(rs.score, base_rs.score) as score,
            coalesce(rs.calculated_at, base_rs.calculated_at) as calculatedAt,
            coalesce(ex.payload_json, base_ex.payload_json) as payloadJson,
            case when s.read_at is not null then 1 else 0 end as read,
            case when s.favorited_at is not null then 1 else 0 end as favorited,
            case when s.liked_at is not null then 1 else 0 end as liked,
            case when s.read_later_at is not null then 1 else 0 end as readLater,
            case when s.hidden_at is not null then 1 else 0 end as hidden,
            case when s.not_interested_at is not null then 1 else 0 end as notInterested,
            coalesce(s.reading_progress, 0) as readingProgress,
            s.last_opened_at as lastOpenedAt,
            s.last_ignored_at as lastIgnoredAt,
            s.last_action_at as lastActionAt,
            s.not_interested_at as notInterestedAt
          from articles a
          join feeds f on f.id = a.feed_id
          left join article_states s on s.article_id = a.id
          left join article_rank_scores rs
            on rs.article_id = a.id
            and rs.rank_context = ?
          left join article_rank_scores base_rs
            on base_rs.article_id = a.id
            and base_rs.rank_context = ?
          left join article_rank_explanations ex
            on ex.article_id = a.id
            and ex.rank_context = ?
          left join article_rank_explanations base_ex
            on base_ex.article_id = a.id
            and base_ex.rank_context = ?
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and s.hidden_at is null
            and s.not_interested_at is null
            and coalesce(a.published_at, a.discovered_at) >= ?
          order by
            case when rs.rerank_position is null then 1 else 0 end,
            rs.rerank_position asc,
            coalesce(rs.score, base_rs.score) desc,
            coalesce(a.published_at, a.discovered_at) desc,
            a.id desc
          limit ?
        `
      )
      .all(rankContext, "base", rankContext, "base", since, limit) as Array<RankedWinner & PluginArticleStateDbRow & { payloadJson: string | null }>;

    const parsedRows = rows.map((row) => {
      const payload = parseJsonObject(row.payloadJson);
      const components = parseJsonObject(payload?.components);
      const familyId = stringOrNull(components?.primaryFamilyId) ?? `source:${row.feedId}`;
      const familyLabel = stringOrNull(components?.primaryFamilyLabel) ?? row.feedTitle;
      const clusterId = stringOrNull(components?.primaryClusterId);
      const clusterLabel = stringOrNull(components?.primaryClusterLabel);
      return { row, familyId, familyLabel, clusterId, clusterLabel };
    });
    const familyLabels = this.familyLabelsById(
      Array.from(new Set(parsedRows.map((item) => item.familyId).filter((id) => !id.startsWith("source:"))))
    );
    const clusterLabels = this.clusterLabelsById(
      Array.from(new Set(parsedRows.map((item) => item.clusterId).filter((id): id is string => Boolean(id))))
    );

    return parsedRows.map(({ row, familyId, familyLabel, clusterId, clusterLabel }) => {
      return {
        articleId: row.articleId,
        feedId: row.feedId,
        feedTitle: row.feedTitle,
        title: row.title,
        url: row.url,
        summary: row.summary,
        publishedAt: row.publishedAt,
        discoveredAt: row.discoveredAt,
        score: row.score,
        calculatedAt: row.calculatedAt,
        familyId,
        familyLabel: familyLabels.get(familyId) ?? familyLabel,
        clusterId,
        clusterLabel: clusterId ? clusterLabels.get(clusterId) ?? clusterLabel : clusterLabel,
        reason: familyId.startsWith("source:") ? "source" : "interest-family",
        state: mapPluginArticleState(row)
      };
    });
  }

  private countDiscoveredArticles(input: { startAt: number; endAt: number }): number {
    const startAt = Number.isFinite(input.startAt) ? input.startAt : 0;
    const endAt = Number.isFinite(input.endAt) ? input.endAt : this.now();
    const row = this.options.db
      .prepare(
        `
          select count(*) as count
          from articles a
          join feeds f on f.id = a.feed_id
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and a.discovered_at >= ?
            and a.discovered_at <= ?
        `
      )
      .get(Math.min(startAt, endAt), Math.max(startAt, endAt)) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private familyLabelsById(familyIds: string[]): Map<string, string> {
    if (familyIds.length === 0) {
      return new Map();
    }
    const rows = this.options.db
      .prepare(
        `
          select
            f.id,
            coalesce(nullif(fl.manual_label, ''), f.display_label) as label
          from interest_families f
          left join interest_family_labels fl on fl.family_id = f.id
          where f.id in (${familyIds.map(() => "?").join(", ")})
        `
      )
      .all(...familyIds) as Array<{ id: string; label: string }>;
    return new Map(rows.map((row) => [row.id, row.label]));
  }

  private clusterLabelsById(clusterIds: string[]): Map<string, string> {
    if (clusterIds.length === 0) {
      return new Map();
    }
    const rows = this.options.db
      .prepare(
        `
          select
            c.id,
            coalesce(nullif(l.manual_label, ''), nullif(l.auto_label, ''), nullif(c.label, ''), c.id) as label
          from interest_clusters c
          left join interest_cluster_labels l on l.cluster_id = c.id
          where c.id in (${clusterIds.map(() => "?").join(", ")})
        `
      )
      .all(...clusterIds) as Array<{ id: string; label: string }>;
    return new Map(rows.map((row) => [row.id, row.label]));
  }

  private listTopicTargets(): PluginTopicTargets {
    const activeIndex = this.options.db
      .prepare(
        `
          select id
          from embedding_indexes
          where status = 'active'
          order by updated_at desc, id
          limit 1
        `
      )
      .get() as { id: string } | undefined;
    if (!activeIndex) {
      return { families: [], clusters: [] };
    }

    const familyRows = this.options.db
      .prepare(
        `
          select
            f.id,
            coalesce(nullif(fl.manual_label, ''), f.display_label) as label,
            f.polarity,
            f.cluster_count as clusterCount,
            f.support_article_count as supportArticleCount
          from interest_families f
          left join interest_family_labels fl on fl.family_id = f.id
          where f.embedding_index_id = ?
            and f.polarity = 'positive'
          order by f.weight desc, f.support_article_count desc, label collate nocase
        `
      )
      .all(activeIndex.id) as PluginTopicTargets["families"];

    const clusters = this.options.db
      .prepare(
        `
          select
            c.id,
            coalesce(nullif(l.manual_label, ''), nullif(l.auto_label, ''), nullif(c.label, ''), c.id) as label,
            coalesce(m.family_id, c.id) as familyId,
            c.polarity
          from interest_clusters c
          left join interest_cluster_labels l on l.cluster_id = c.id
          left join interest_cluster_family_members m on m.cluster_id = c.id
          where c.embedding_index_id = ?
            and c.polarity = 'positive'
          order by c.weight desc, c.updated_at desc, c.id
        `
      )
      .all(activeIndex.id) as PluginTopicTargets["clusters"];

    const families = [...familyRows];
    const familyIds = new Set(families.map((family) => family.id));
    for (const cluster of clusters) {
      if (!familyIds.has(cluster.familyId)) {
        families.push({
          id: cluster.familyId,
          label: cluster.label,
          polarity: cluster.polarity,
          clusterCount: 1,
          supportArticleCount: 0
        });
        familyIds.add(cluster.familyId);
      }
    }

    return { families, clusters };
  }

  private openableArticleSummary(articleId: string): RankedWinner | null {
    const rows = this.listRankedWinners({ windowMs: 365 * 24 * 60 * 60 * 1000, limit: 250 });
    return rows.find((row) => row.articleId === articleId) ?? null;
  }

  private articleSnapshot(articleId: string, input: { includeContent?: boolean } = {}): Record<string, unknown> | null {
    const row = this.options.db
      .prepare(
        `
          select
            a.id as articleId,
            a.feed_id as feedId,
            f.title as feedTitle,
            a.guid,
            a.url,
            a.canonical_url as canonicalUrl,
            a.title,
            a.author,
            a.summary,
            a.published_at as publishedAt,
            a.discovered_at as discoveredAt,
            a.updated_at as updatedAt,
            ac.content_html as contentHtml,
            ac.content_text as contentText,
            coalesce(ac.extraction_status, 'pending') as extractionStatus,
            ac.extraction_error as extractionError,
            case when s.read_at is not null then 1 else 0 end as read,
            case when s.favorited_at is not null then 1 else 0 end as favorited,
            case when s.liked_at is not null then 1 else 0 end as liked,
            case when s.read_later_at is not null then 1 else 0 end as readLater,
            case when s.hidden_at is not null then 1 else 0 end as hidden,
            case when s.not_interested_at is not null then 1 else 0 end as notInterested,
            coalesce(s.reading_progress, 0) as readingProgress,
            s.last_opened_at as lastOpenedAt,
            s.last_ignored_at as lastIgnoredAt,
            s.last_action_at as lastActionAt,
            s.not_interested_at as notInterestedAt
          from articles a
          join feeds f on f.id = a.feed_id
          left join article_states s on s.article_id = a.id
          left join article_contents ac on ac.article_id = a.id
          where a.id = ?
            and a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
        `
      )
      .get(articleId) as ({
        articleId: string;
        feedId: string;
        feedTitle: string;
        guid: string | null;
        url: string;
        canonicalUrl: string | null;
        title: string;
        author: string | null;
        summary: string | null;
        publishedAt: number | null;
        discoveredAt: number;
        updatedAt: number;
        contentHtml: string | null;
        contentText: string | null;
        extractionStatus: string;
        extractionError: string | null;
      } & PluginArticleStateDbRow) | undefined;

    if (!row) {
      return null;
    }
    const snapshot: Record<string, unknown> = {
      articleId: row.articleId,
      feedId: row.feedId,
      feedTitle: row.feedTitle,
      guid: row.guid,
      url: row.url,
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      author: row.author,
      summary: row.summary,
      publishedAt: row.publishedAt,
      discoveredAt: row.discoveredAt,
      updatedAt: row.updatedAt,
      feed: {
        id: row.feedId,
        title: row.feedTitle
      },
      state: mapPluginArticleState(row)
    };
    if (input.includeContent === true) {
      snapshot.contentHtml = row.contentHtml;
      snapshot.contentText = row.contentText;
      snapshot.extractionStatus = row.extractionStatus;
      snapshot.extractionError = row.extractionError;
    }
    return snapshot;
  }

  private requireCapability(pluginId: string, capability: string): PluginInstallRow {
    const install = this.requireInstall(pluginId);
    const manifest = parseStoredManifest(install);
    if (!manifest.capabilities.includes(capability)) {
      throw new PluginServiceError(403, "FORBIDDEN", `Plugin capability required: ${capability}`);
    }
    return install;
  }

  private enabledInstallsForHook(hook: string): PluginInstallRow[] {
    return this.options.plugins
      .listInstalls()
      .filter((install) => {
        if (install.status !== "enabled") {
          return false;
        }
        const manifest = parseStoredManifest(install);
        return manifest.contributes?.hooks?.includes(hook) ?? false;
      });
  }

  private enabledFullContentExtractors(): Array<{
    install: PluginInstallRow;
    extractor: PluginFullContentExtractorContribution;
  }> {
    const candidates: Array<{
      install: PluginInstallRow;
      extractor: PluginFullContentExtractorContribution;
    }> = [];
    for (const install of this.options.plugins.listInstalls()) {
      if (install.status !== "enabled") {
        continue;
      }
      const manifest = parseStoredManifest(install);
      for (const extractor of manifest.contributes?.fullContentExtractors ?? []) {
        candidates.push({ install, extractor });
      }
    }
    return candidates.sort((left, right) =>
      (left.extractor.order ?? 100) - (right.extractor.order ?? 100) ||
      left.install.id.localeCompare(right.install.id) ||
      left.extractor.id.localeCompare(right.extractor.id)
    );
  }

  private async fetchUpdateMetadata(url: string): Promise<PluginUpdateMetadata> {
    this.assertUserPluginInstallEnabled();
    const body = await this.fetchPluginText(url, PLUGIN_UPDATE_METADATA_MAX_BYTES);
    return JSON.parse(body) as PluginUpdateMetadata;
  }

  private async fetchPluginText(url: string, maxBytes: number): Promise<string> {
    try {
      const result = await controlledFetchText(url, {
        fetcher: this.fetcher,
        headers: { accept: "application/json, application/octet-stream, */*;q=0.8" },
        maxBytes,
        timeoutMs: PLUGIN_OUTBOUND_TIMEOUT_MS,
        resolveHostname: this.options.resolveHostname
      });
      if (!result.response.ok) {
        throw new PluginServiceError(
          400,
          "PROVIDER_ERROR",
          `Plugin package fetch failed: ${result.response.status}`
        );
      }
      return result.body;
    } catch (error) {
      if (error instanceof PluginServiceError) {
        throw error;
      }
      throw new PluginServiceError(400, "PROVIDER_ERROR", redactText(errorMessage(error)));
    }
  }

  private assertUserPluginInstallEnabled(): void {
    if (!this.enableUserPluginInstall) {
      throw new PluginServiceError(
        403,
        "FORBIDDEN",
        "User-installed plugins are disabled"
      );
    }
  }

  private requireInstall(pluginId: string): PluginInstallRow {
    const install = this.options.plugins.findInstall(pluginId);
    if (!install) {
      throw new PluginServiceError(404, "NOT_FOUND", "Plugin not found");
    }
    return install;
  }

  private requireListItem(pluginId: string): PluginListItem {
    return this.toListItem(this.requireInstall(pluginId));
  }

  private toListItem(install: PluginInstallRow): PluginListItem {
    const manifest = parseStoredManifest(install);
    return {
      id: install.id,
      name: manifest.name,
      version: install.version,
      publisher: manifest.publisher,
      status: install.status,
      sourceType: install.sourceType,
      sourceUrl: install.sourceUrl,
      updateUrl: install.updateUrl,
      official: install.official,
      bundled: install.bundled,
      trustLevel: install.trustLevel,
      capabilities: manifest.capabilities,
      grantedCapabilities: this.options.plugins.listCapabilityGrants(install.id),
      apiStability: pluginApiStability(manifest),
      contributes: manifest.contributes ?? {},
      contributions: runtimeContributions(manifest.contributes),
      installedAt: new Date(install.installedAt).toISOString(),
      updatedAt: new Date(install.updatedAt).toISOString(),
      enabledAt: install.enabledAt ? new Date(install.enabledAt).toISOString() : null,
      disabledAt: install.disabledAt ? new Date(install.disabledAt).toISOString() : null,
      lastError: install.lastError
    };
  }

  private webEntryUrl(install: PluginInstallRow): string | null {
    const manifest = parseStoredManifest(install);
    return manifest.entry?.web ? `/api/plugins/${encodeURIComponent(install.id)}/assets/${manifest.entry.web}` : null;
  }

  private seedDefaultSchedules(pluginId: string, manifest: PluginManifest): void {
    for (const task of manifest.contributes?.tasks ?? []) {
      if (!task.defaultEnabled || task.schedule !== "daily") {
        continue;
      }
      const existing = this.options.plugins
        .listSchedules(pluginId)
        .find((schedule) => schedule.taskId === task.id);
      if (existing) {
        continue;
      }
      this.options.plugins.upsertSchedule({
        pluginId,
        taskId: task.id,
        enabled: true,
        schedule: "daily",
        localTime: "08:00",
        timezone: "UTC",
        nextRunAt: nextDailyRunAt(this.now(), "08:00", "UTC"),
        now: this.now()
      });
    }
  }

  private applyPluginMigrations(pluginId: string, manifest: PluginManifest): void {
    const migrations = manifest.migrations ?? [];
    if (migrations.length === 0) {
      return;
    }
    this.options.db.transaction(() => {
      for (const migration of migrations) {
        const sqlPath = this.resolveAssetPath(pluginId, migration.path);
        if (!sqlPath) {
          throw new PluginServiceError(400, "VALIDATION_ERROR", `Plugin migration file not found: ${migration.path}`);
        }
        const sql = readFileSync(sqlPath, "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        if (migration.checksum && migration.checksum !== checksum) {
          throw new PluginServiceError(409, "CONFLICT", `Plugin migration checksum mismatch: ${migration.version}`);
        }
        const existing = this.options.db
          .prepare(
            `
              select name, checksum
              from plugin_migrations
              where plugin_id = ?
                and version = ?
            `
          )
          .get(pluginId, migration.version) as { name: string; checksum: string | null } | undefined;
        if (existing) {
          if (existing.name !== migration.name || existing.checksum !== checksum) {
            throw new PluginServiceError(409, "CONFLICT", `Plugin migration changed after apply: ${migration.version}`);
          }
          continue;
        }
        this.options.db.exec(sql);
        this.options.db
          .prepare(
            `
              insert into plugin_migrations (plugin_id, version, name, checksum, applied_at)
              values (?, ?, ?, ?, ?)
            `
          )
          .run(pluginId, migration.version, migration.name, checksum, this.now());
      }
    })();
  }

  private definePluginTable(pluginId: string, definition: PluginTableDefinition): void {
    const normalized = normalizePluginTableDefinition(definition);
    const physicalTable = pluginTableName(pluginId, normalized.name);
    const checksum = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");
    const version = `schema:${normalized.name}`;
    const existing = this.options.db
      .prepare(
        `
          select name, checksum
          from plugin_migrations
          where plugin_id = ?
            and version = ?
        `
      )
      .get(pluginId, version) as { name: string; checksum: string | null } | undefined;

    if (existing) {
      if (existing.name !== normalized.name || existing.checksum !== checksum) {
        throw new PluginServiceError(
          409,
          "CONFLICT",
          `Plugin table schema changed after creation: ${normalized.name}`
        );
      }
      return;
    }

    const columnSql = normalized.columns.map(pluginColumnSql).join(",\n            ");
    const uniqueSql = normalized.columns
      .filter((column) => column.unique)
      .map((column) => `unique (${quoteIdentifier(column.name)})`);
    const constraints = uniqueSql.length > 0 ? `,\n            ${uniqueSql.join(",\n            ")}` : "";

    this.options.db.transaction(() => {
      this.options.db.exec(
        `
          create table if not exists ${quoteIdentifier(physicalTable)} (
            id integer primary key autoincrement,
            ${columnSql},
            created_at integer not null,
            updated_at integer not null${constraints}
          )
        `
      );
      for (const index of normalized.indexes ?? []) {
        const physicalIndex = pluginIndexName(pluginId, normalized.name, index.name);
        const columns = index.columns.map(quoteIdentifier).join(", ");
        this.options.db.exec(
          `create ${index.unique ? "unique " : ""}index if not exists ${quoteIdentifier(physicalIndex)}
           on ${quoteIdentifier(physicalTable)} (${columns})`
        );
      }
      this.options.db
        .prepare(
          `
            insert into plugin_migrations (plugin_id, version, name, checksum, applied_at)
            values (?, ?, ?, ?, ?)
          `
        )
        .run(pluginId, version, normalized.name, checksum, this.now());
      this.options.plugins.setKv(pluginId, `schema:${normalized.name}`, normalized, this.now());
    })();
  }

  private insertPluginRow(
    pluginId: string,
    tableName: string,
    record: Record<string, unknown>
  ): { id: number } {
    const schema = this.requirePluginTableSchema(pluginId, tableName);
    const columns = schema.columns.filter((column) => Object.hasOwn(record, column.name));
    if (columns.length === 0) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin row has no known columns");
    }
    const now = this.now();
    const names = [...columns.map((column) => column.name), "created_at", "updated_at"];
    const placeholders = names.map(() => "?").join(", ");
    const values = [
      ...columns.map((column) => pluginColumnValue(column, record[column.name])),
      now,
      now
    ];
    const result = this.options.db
      .prepare(
        `
          insert into ${quoteIdentifier(pluginTableName(pluginId, schema.name))}
            (${names.map(quoteIdentifier).join(", ")})
          values (${placeholders})
        `
      )
      .run(...values);
    return { id: Number(result.lastInsertRowid) };
  }

  private getPluginRow(pluginId: string, tableName: string, rowId: number): Record<string, unknown> | null {
    const schema = this.requirePluginTableSchema(pluginId, tableName);
    const row = this.options.db
      .prepare(
        `
          select *
          from ${quoteIdentifier(pluginTableName(pluginId, schema.name))}
          where id = ?
        `
      )
      .get(rowId) as Record<string, unknown> | undefined;
    return row ? decodePluginRow(schema, row) : null;
  }

  private listPluginRows(
    pluginId: string,
    tableName: string,
    input: PluginTableListInput
  ): Array<Record<string, unknown>> {
    const schema = this.requirePluginTableSchema(pluginId, tableName);
    const physicalTable = pluginTableName(pluginId, schema.name);
    const columns = new Map(schema.columns.map((column) => [column.name, column]));
    const where = input.where ?? {};
    const whereSql: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(where)) {
      const column = columns.get(key);
      if (!column) {
        throw new PluginServiceError(400, "VALIDATION_ERROR", `Unknown plugin table column: ${key}`);
      }
      whereSql.push(`${quoteIdentifier(key)} = ?`);
      values.push(pluginColumnValue(column, value));
    }
    const orderBy =
      input.orderBy && (columns.has(input.orderBy) || input.orderBy === "created_at" || input.orderBy === "updated_at")
        ? input.orderBy
        : "id";
    const direction = input.direction === "asc" ? "asc" : "desc";
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
    const rows = this.options.db
      .prepare(
        `
          select *
          from ${quoteIdentifier(physicalTable)}
          ${whereSql.length > 0 ? `where ${whereSql.join(" and ")}` : ""}
          order by ${quoteIdentifier(orderBy)} ${direction}
          limit ?
        `
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => decodePluginRow(schema, row));
  }

  private deletePluginRow(pluginId: string, tableName: string, rowId: number): void {
    const schema = this.requirePluginTableSchema(pluginId, tableName);
    this.options.db
      .prepare(
        `
          delete from ${quoteIdentifier(pluginTableName(pluginId, schema.name))}
          where id = ?
        `
      )
      .run(rowId);
  }

  private requirePluginTableSchema(pluginId: string, tableName: string): PluginTableDefinition {
    const normalizedName = normalizePluginName(tableName, "table");
    const row = this.options.db
      .prepare(
        `
          select checksum
          from plugin_migrations
          where plugin_id = ?
            and version = ?
        `
      )
      .get(pluginId, `schema:${normalizedName}`) as { checksum: string } | undefined;
    if (!row) {
      throw new PluginServiceError(404, "NOT_FOUND", "Plugin table is not defined");
    }
    const schema = this.options.plugins.getKv<PluginTableDefinition>(
      pluginId,
      `schema:${normalizedName}`
    );
    if (!schema) {
      throw new PluginServiceError(500, "INTERNAL_ERROR", "Plugin table schema metadata is missing");
    }
    return schema;
  }

  private writeInstalledPackage(
    manifest: PluginManifest,
    files: Record<string, string>,
    input: {
      sourceType: "local_file" | "url" | "github_release" | "registry";
      sourceUrl: string | null;
      updateUrl: string | null;
      previousStatus?: PluginInstallRow["status"];
    }
  ): PluginListItem {
    const compatibility = isDibaoVersionCompatible(this.options.dibaoVersion, manifest.dibao);
    const packagePath = join(this.installedPluginsDir, manifest.id);
    const stagingPath = `${packagePath}.staging-${randomBytes(4).toString("hex")}`;
    const backupPath = `${packagePath}.backup-${randomBytes(4).toString("hex")}`;
    mkdirSync(stagingPath, { recursive: true });
    writeFileSync(join(stagingPath, "plugin.json"), JSON.stringify(manifest, null, 2));
    for (const [filePath, content] of Object.entries(files)) {
      const normalizedPath = normalize(filePath).replace(/^(\.\.(?:\/|\\|$))+/, "");
      const targetPath = resolve(stagingPath, normalizedPath);
      if (!targetPath.startsWith(`${resolve(stagingPath)}${sep}`)) {
        continue;
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content);
    }
    mkdirSync(dirname(packagePath), { recursive: true });
    try {
      if (existsSync(packagePath)) {
        renameSync(packagePath, backupPath);
      }
      renameSync(stagingPath, packagePath);
      rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      rmSync(packagePath, { recursive: true, force: true });
      if (existsSync(backupPath)) {
        renameSync(backupPath, packagePath);
      }
      rmSync(stagingPath, { recursive: true, force: true });
      throw new PluginServiceError(500, "INTERNAL_ERROR", "Plugin package install failed", error);
    }
    this.disposeRuntime(manifest.id);

    const dataPath = join(this.pluginRuntimeDataDir, manifest.id);
    mkdirSync(dataPath, { recursive: true });
    const status = compatibility.ok
      ? input.previousStatus === "enabled"
        ? "enabled"
        : "installed"
      : "incompatible";
    const install = this.options.plugins.upsertInstall({
      id: manifest.id,
      version: manifest.version,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      updateUrl: input.updateUrl,
      packagePath,
      dataPath,
      manifestJson: JSON.stringify(manifest),
      status,
      official: false,
      bundled: false,
      trustLevel: "trusted",
      lastError: compatibility.ok ? null : compatibility.reason,
      now: this.now()
    });
    this.options.plugins.grantCapabilities(manifest.id, manifest.capabilities, this.now());
    return this.toListItem(install);
  }
}

export function parsePluginJobType(type: string): { pluginId: string; taskId: string } | null {
  if (!type.startsWith("plugin:")) {
    return null;
  }
  const rest = type.slice("plugin:".length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }
  return {
    pluginId: rest.slice(0, separator),
    taskId: rest.slice(separator + 1)
  };
}

function parsePluginPackage(content: string): PluginPackage {
  try {
    const parsed = JSON.parse(content) as PluginPackage;
    if (parsed && typeof parsed === "object" && Object.hasOwn(parsed, "manifest")) {
      return parsed;
    }
    return { manifest: parsed };
  } catch {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin package must be JSON");
  }
}

function parsePluginUpdateMetadataContent(content: string): PluginUpdateMetadata | null {
  try {
    const parsed = JSON.parse(content) as PluginUpdateMetadata & { manifest?: unknown };
    if (
      parsed &&
      typeof parsed === "object" &&
      !Object.hasOwn(parsed, "manifest") &&
      typeof parsed.packageUrl === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function parsePluginManifest(input: unknown): PluginManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin manifest must be an object");
  }
  const manifest = input as Partial<PluginManifest>;
  if (manifest.manifestVersion !== 1) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin manifestVersion must be 1");
  }
  const id = stringValue(manifest.id);
  if (!id || !PLUGIN_ID_PATTERN.test(id)) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin id is invalid");
  }
  const name = stringValue(manifest.name);
  const version = stringValue(manifest.version);
  const publisher = stringValue(manifest.publisher);
  if (!name || !version || !publisher) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin name, version, and publisher are required");
  }
  const dibao = manifest.dibao;
  if (!dibao || typeof dibao !== "object" || !stringValue(dibao.minVersion) || !stringValue(dibao.maxVersion)) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin Dibao compatibility range is required");
  }
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !PLUGIN_CAPABILITY_SET.has(capability)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Unsupported plugin capability: ${String(capability)}`);
    }
  }
  const contributes = normalizeContributions(manifest.contributes);
  const migrations = normalizePluginMigrations(manifest.migrations);
  for (const hook of contributes.hooks ?? []) {
    if (!PLUGIN_EVENT_SET.has(hook)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Unsupported plugin hook: ${hook}`);
    }
  }
  for (const event of contributes.events ?? []) {
    if (!PLUGIN_EVENT_SET.has(event)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Unsupported plugin event: ${event}`);
    }
  }
  for (const extractor of contributes.fullContentExtractors ?? []) {
    if (!extractor.id || !extractor.title) {
      throw new PluginServiceError(
        400,
        "VALIDATION_ERROR",
        "Plugin full content extractors require id and title"
      );
    }
  }
  return {
    manifestVersion: 1,
    id,
    name,
    version,
    publisher,
    dibao: {
      minVersion: dibao.minVersion,
      maxVersion: dibao.maxVersion
    },
    entry: manifest.entry,
    capabilities,
    migrations,
    contributes
  };
}

function normalizePluginMigrations(input: unknown): PluginMigrationContribution[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  return input.map((item) => {
    const record = parseJsonObject(item);
    const version = stringValue(record?.version);
    const name = stringValue(record?.name);
    const path = stringValue(record?.path);
    const checksum = stringOrNull(record?.checksum) ?? undefined;
    if (!version || !name || !path) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin migrations require version, name, and path");
    }
    if (seen.has(version)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Duplicate plugin migration version: ${version}`);
    }
    seen.add(version);
    return { version, name, path, checksum };
  });
}

function normalizeContributions(
  contributes: PluginManifest["contributes"]
): NonNullable<PluginManifest["contributes"]> {
  if (!contributes || typeof contributes !== "object") {
    return {};
  }
  return {
    settingsTabs: Array.isArray(contributes.settingsTabs) ? contributes.settingsTabs : [],
    tabs: Array.isArray(contributes.tabs) ? contributes.tabs : [],
    routes: Array.isArray(contributes.routes) ? contributes.routes : [],
    actions: Array.isArray(contributes.actions) ? contributes.actions : [],
    hooks: Array.isArray(contributes.hooks)
      ? contributes.hooks.filter((hook): hook is string => typeof hook === "string")
      : [],
    events: Array.isArray(contributes.events)
      ? contributes.events.filter((event): event is string => typeof event === "string")
      : [],
    fullContentExtractors: normalizeFullContentExtractorContributions(contributes.fullContentExtractors),
    tasks: Array.isArray(contributes.tasks) ? contributes.tasks : [],
    setupSteps: Array.isArray(contributes.setupSteps) ? contributes.setupSteps : []
  };
}

function normalizeFullContentExtractorContributions(
  input: unknown
): PluginFullContentExtractorContribution[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const ids = new Set<string>();
  return input.map((item) => {
    const record = parseJsonObject(item);
    const id = stringValue(record?.id);
    const title = stringValue(record?.title);
    const order = record?.order;
    if (!id || !title) {
      throw new PluginServiceError(
        400,
        "VALIDATION_ERROR",
        "Plugin full content extractors require id and title"
      );
    }
    if (ids.has(id)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Duplicate plugin full content extractor id: ${id}`);
    }
    if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) {
      throw new PluginServiceError(
        400,
        "VALIDATION_ERROR",
        `Plugin full content extractor order must be a number: ${id}`
      );
    }
    ids.add(id);
    return { id, title, order: typeof order === "number" ? order : undefined };
  });
}

function runtimeContributions(contributes: PluginManifest["contributes"]): PluginRuntimeContributions {
  const normalized = normalizeContributions(contributes);
  const routes = (normalized.routes ?? []).map((route) => ({
    id: route.id,
    title: route.title,
    path: route.path
  }));
  const primaryNav = dedupePluginNav([
    ...(normalized.tabs ?? [])
      .filter((tab) => tab.primaryNav)
      .map((tab) => ({
        label: tab.title,
        route: tab.route ?? tab.id,
        icon: tab.icon,
        order: tab.order
      })),
    ...(normalized.routes ?? [])
      .filter((route) => route.primaryNav)
      .map((route) => ({
        label: route.title,
        route: route.id,
        icon: route.icon,
        order: route.order
      }))
  ]).sort(sortContributionByOrder);
  const primaryMobile = dedupePluginNav([
    ...(normalized.tabs ?? [])
      .filter((tab) => tab.primaryMobile)
      .map((tab) => ({
        label: tab.title,
        route: tab.route ?? tab.id,
        icon: tab.icon,
        order: tab.order
      })),
    ...(normalized.routes ?? [])
      .filter((route) => route.primaryMobile)
      .map((route) => ({
        label: route.title,
        route: route.id,
        icon: route.icon,
        order: route.order
      }))
  ]).sort(sortContributionByOrder);
  return {
    routes,
    primaryNav,
    primaryMobile,
    tabs: (normalized.tabs ?? [])
      .map((tab) => ({
        id: tab.id,
        label: tab.title,
        slot: tab.slot,
        route: tab.route ?? tab.id,
        icon: tab.icon,
        order: tab.order
      }))
      .sort(sortContributionByOrder),
    actions: (normalized.actions ?? [])
      .map((action) => ({
        id: action.id,
        label: action.title,
        slot: action.slot,
        icon: action.icon,
        command: action.command,
        order: action.order
      }))
      .sort(sortContributionByOrder),
    settingsTabs: (normalized.settingsTabs ?? [])
      .map((tab) => ({
        id: tab.id,
        label: tab.title,
        route: tab.route ?? tab.id,
        order: tab.order
      }))
      .sort(sortContributionByOrder),
    setupSteps: (normalized.setupSteps ?? [])
      .map((step) => ({
        id: step.id,
        title: step.title,
        body: step.body ?? "",
        recommended: step.defaultEnabled
      }))
      .sort(sortContributionByOrder)
  };
}

function sortContributionByOrder(
  left: { order?: number; label?: string; title?: string },
  right: { order?: number; label?: string; title?: string }
): number {
  return (left.order ?? 100) - (right.order ?? 100) ||
    (left.label ?? left.title ?? "").localeCompare(right.label ?? right.title ?? "");
}

function dedupePluginNav<T extends { route: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.route)) {
      return false;
    }
    seen.add(item.route);
    return true;
  });
}

function parseStoredManifest(install: PluginInstallRow): PluginManifest {
  return parsePluginManifest(JSON.parse(install.manifestJson));
}

function isDibaoVersionCompatible(
  version: string,
  range: { minVersion: string; maxVersion: string }
): { ok: true } | { ok: false; reason: string } {
  if (compareVersions(version, range.minVersion) < 0) {
    return { ok: false, reason: `Requires Dibao >= ${range.minVersion}` };
  }
  const maxVersion = range.maxVersion.trim();
  if (maxVersion.startsWith("<") && compareVersions(version, maxVersion.slice(1).trim()) >= 0) {
    return { ok: false, reason: `Requires Dibao ${maxVersion}` };
  }
  return { ok: true };
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function resolvePluginPath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function defaultOfficialPluginsDir(): string {
  const candidates = [
    resolve(process.cwd(), "plugins/official"),
    process.env.INIT_CWD ? resolve(process.env.INIT_CWD, "plugins/official") : null,
    resolve(process.cwd(), "../../plugins/official")
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringOrNull(value: unknown): string | null {
  const normalized = stringValue(value);
  return normalized ? normalized : null;
}

function stringValueOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValueOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isGitHubUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith("github.com");
  } catch {
    return false;
  }
}

function normalizePluginTableDefinition(definition: PluginTableDefinition): PluginTableDefinition {
  const name = normalizePluginName(definition.name, "table");
  if (!Array.isArray(definition.columns) || definition.columns.length === 0) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin table needs columns");
  }
  const seenColumns = new Set<string>();
  const columns = definition.columns.map((column) => {
    const columnName = normalizePluginName(column.name, "column");
    if (columnName === "id" || columnName === "created_at" || columnName === "updated_at") {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Reserved plugin column: ${columnName}`);
    }
    if (seenColumns.has(columnName)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Duplicate plugin column: ${columnName}`);
    }
    seenColumns.add(columnName);
    if (!["text", "integer", "real", "boolean", "json"].includes(column.type)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Unsupported plugin column type: ${String(column.type)}`);
    }
    return {
      name: columnName,
      type: column.type,
      nullable: column.nullable === true,
      unique: column.unique === true,
      default: normalizePluginDefault(column)
    };
  });
  const indexes = Array.isArray(definition.indexes)
    ? definition.indexes.map((index) => {
        const indexName = normalizePluginName(index.name, "index");
        const indexColumns = Array.isArray(index.columns)
          ? index.columns.map((columnName) => normalizePluginName(columnName, "column"))
          : [];
        if (indexColumns.length === 0 || indexColumns.some((columnName) => !seenColumns.has(columnName))) {
          throw new PluginServiceError(400, "VALIDATION_ERROR", `Invalid plugin index columns: ${indexName}`);
        }
        return {
          name: indexName,
          columns: indexColumns,
          unique: index.unique === true
        };
      })
    : [];
  return { name, columns, indexes };
}

function normalizePluginName(value: unknown, label: string): string {
  const normalized = stringValue(value);
  if (!PLUGIN_SCHEMA_NAME_PATTERN.test(normalized)) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", `Invalid plugin ${label} name`);
  }
  return normalized;
}

function normalizePluginDefault(column: PluginTableColumnDefinition): string | number | boolean | null | undefined {
  if (!Object.hasOwn(column, "default")) {
    return undefined;
  }
  if (column.default === null) {
    return null;
  }
  if (column.type === "text" && typeof column.default === "string") {
    return column.default;
  }
  if ((column.type === "integer" || column.type === "real") && typeof column.default === "number") {
    return column.default;
  }
  if (column.type === "boolean" && typeof column.default === "boolean") {
    return column.default;
  }
  throw new PluginServiceError(400, "VALIDATION_ERROR", `Invalid default for plugin column: ${column.name}`);
}

function pluginTableName(pluginId: string, tableName: string): string {
  const scope = createHash("sha256").update(pluginId).digest("hex").slice(0, 12);
  return `plugin_${scope}_${tableName}`;
}

function pluginIndexName(pluginId: string, tableName: string, indexName: string): string {
  const scope = createHash("sha256").update(`${pluginId}:${tableName}:${indexName}`).digest("hex").slice(0, 16);
  return `idx_plugin_${scope}`;
}

function pluginColumnSql(column: PluginTableColumnDefinition): string {
  const type = column.type === "json" || column.type === "boolean" ? "text" : column.type;
  const notNull = column.nullable ? "" : " not null";
  const defaultSql = Object.hasOwn(column, "default")
    ? ` default ${pluginDefaultSql(column.default)}`
    : "";
  return `${quoteIdentifier(column.name)} ${type}${notNull}${defaultSql}`;
}

function pluginDefaultSql(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "'true'" : "'false'";
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function pluginColumnValue(column: PluginTableColumnDefinition, value: unknown): unknown {
  if (value === null || value === undefined) {
    if (!column.nullable) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Plugin column is required: ${column.name}`);
    }
    return null;
  }
  if (column.type === "text") {
    if (typeof value !== "string") {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Plugin column must be text: ${column.name}`);
    }
    return value;
  }
  if (column.type === "integer") {
    if (!Number.isInteger(value)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Plugin column must be integer: ${column.name}`);
    }
    return value;
  }
  if (column.type === "real") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Plugin column must be real: ${column.name}`);
    }
    return value;
  }
  if (column.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new PluginServiceError(400, "VALIDATION_ERROR", `Plugin column must be boolean: ${column.name}`);
    }
    return value ? "true" : "false";
  }
  return JSON.stringify(value);
}

function decodePluginRow(
  schema: PluginTableDefinition,
  row: Record<string, unknown>
): Record<string, unknown> {
  const decoded: Record<string, unknown> = {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  for (const column of schema.columns) {
    const value = row[column.name];
    decoded[column.name] =
      column.type === "json"
        ? parseJsonObject(value)
        : column.type === "boolean"
          ? value === "true"
          : value;
  }
  return decoded;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return parseJsonObject(value) ?? {};
}

function normalizeApiPath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolvePluginHostCommand(): PluginHostCommand {
  const jsPath = fileURLToPath(new URL("./plugin-host-process.js", import.meta.url));
  if (existsSync(jsPath)) {
    return { command: process.execPath, args: [jsPath] };
  }
  const tsPath = fileURLToPath(new URL("./plugin-host-process.ts", import.meta.url));
  if (!existsSync(tsPath)) {
    throw new PluginServiceError(500, "INTERNAL_ERROR", "Plugin host process entry was not found");
  }
  const tsxCliPath = findUpFrom(process.cwd(), "node_modules/tsx/dist/cli.mjs") ??
    findUpFrom(dirname(tsPath), "node_modules/tsx/dist/cli.mjs");
  if (!tsxCliPath) {
    throw new PluginServiceError(500, "INTERNAL_ERROR", "Plugin host TypeScript runner was not found");
  }
  return { command: process.execPath, args: [tsxCliPath, tsPath] };
}

function findUpFrom(startDir: string, relativePath: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function settlePluginInvocation(runtime: PluginRuntime, record: Record<string, unknown>): void {
  const id = typeof record.id === "string" ? record.id : "";
  const pending = runtime.pending.get(id);
  if (!pending) {
    return;
  }
  runtime.pending.delete(id);
  clearTimeout(pending.timer);
  if (record.ok === true) {
    pending.resolve(record.result);
    return;
  }
  pending.reject(errorFromPluginHost(record.error as PluginHostSerializedError | undefined));
}

function rejectPendingPluginCalls(pending: Map<string, PluginRuntimePending>, error: Error): void {
  for (const [id, item] of pending.entries()) {
    clearTimeout(item.timer);
    item.reject(error);
    pending.delete(id);
  }
}

function sendHostResponse(
  child: ChildProcess | null,
  id: string,
  response: { ok: true; result: unknown } | { ok: false; error: PluginHostSerializedError }
): void {
  if (!id) {
    return;
  }
  sendPluginChildMessage(child, { type: "host.response", id, ...response });
}

function sendPluginChildMessage(
  child: ChildProcess | null,
  message: Record<string, unknown>,
  onError?: (error: Error) => void
): boolean {
  if (!child || !child.connected) {
    return false;
  }
  try {
    child.send(message, (error: Error | null) => {
      if (error) {
        onError?.(error);
      }
    });
    return true;
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

function serializePluginHostError(error: unknown): PluginHostSerializedError {
  if (error instanceof PluginServiceError) {
    return {
      message: error.message,
      statusCode: error.statusCode,
      code: error.code,
      details: error.details
    };
  }
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    message: errorMessage(error),
    ...(typeof record.statusCode === "number" ? { statusCode: record.statusCode } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(Object.hasOwn(record, "details") ? { details: record.details } : {})
  };
}

function errorFromPluginHost(error: PluginHostSerializedError | undefined): Error {
  const message = typeof error?.message === "string" ? error.message : "Plugin host call failed";
  const statusCode = typeof error?.statusCode === "number" ? error.statusCode : 500;
  const code = typeof error?.code === "string" ? error.code : "PLUGIN_HOST_ERROR";
  return new PluginServiceError(statusCode, code, message, error?.details);
}

function isPluginDeliveryStatus(value: unknown): value is PluginDeliveryStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function pluginApiStability(manifest: PluginManifest): PluginApiStabilitySummary {
  const stable = new Set<string>([
    "manifest.v1",
    "lifecycle.installEnableDisableUpdate",
    "settings",
    "storage",
    "tasks",
    "hooks.basic",
    "events.catalog",
    "iframe.bridge"
  ]);
  const beta = new Set<string>();
  if ((manifest.migrations ?? []).length > 0) {
    stable.add("database.migrations");
  }
  if (manifest.capabilities.includes("secrets:plugin")) {
    stable.add("secrets");
  }
  if (manifest.capabilities.includes("deliveries:read") || manifest.capabilities.includes("deliveries:write")) {
    stable.add("deliveries");
  }
  if (manifest.capabilities.includes("network:outbound")) {
    stable.add("network.outbound");
  }
  if (manifest.capabilities.includes("database:plugin")) {
    stable.add("database.migrations");
    beta.add("database.defineTable");
  }
  if (manifest.capabilities.includes("ranking:read") || manifest.capabilities.includes("ranking:write")) {
    beta.add("ranking");
  }
  if (manifest.capabilities.includes("articles:read") || manifest.capabilities.includes("articles:write")) {
    beta.add("articles.snapshot");
  }
  if ((manifest.contributes?.fullContentExtractors ?? []).length > 0) {
    beta.add("fullContent.extractor");
  }
  return {
    stable: [...stable].sort(),
    beta: [...beta].sort()
  };
}

function normalizeFullContentPluginResult(result: unknown): FullContentPluginExtractionResult | null {
  const record = parseJsonObject(result);
  const contentHtml = stringValue(record?.contentHtml);
  const contentText = stringValue(record?.contentText);
  if (!contentHtml || !contentText) {
    return null;
  }
  return {
    title: stringOrNull(record?.title),
    contentHtml,
    contentText,
    excerpt: stringOrNull(record?.excerpt)
  };
}

function matchPluginApiRoute(
  routes: Set<string>,
  path: string
): PluginApiRouteMatch | null {
  if (routes.has(path)) {
    return { route: path, params: {} };
  }
  const pathParts = splitApiPath(path);
  for (const pattern of routes.values()) {
    const patternParts = splitApiPath(pattern);
    if (patternParts.length !== pathParts.length || !patternParts.some((part) => part.startsWith(":"))) {
      continue;
    }
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < patternParts.length; index += 1) {
      const patternPart = patternParts[index]!;
      const pathPart = pathParts[index]!;
      if (patternPart.startsWith(":")) {
        const paramName = patternPart.slice(1);
        if (!paramName || params[paramName] !== undefined) {
          matched = false;
          break;
        }
        params[paramName] = decodeURIComponent(pathPart);
      } else if (patternPart !== pathPart) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { route: pattern, params };
    }
  }
  return null;
}

function splitApiPath(path: string): string[] {
  return normalizeApiPath(path).split("/").filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PluginSecretCodec {
  constructor(private readonly key: Buffer) {}

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `aes-256-gcm:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
  }

  decrypt(value: string): string {
    const [, version, ivText, tagText, encryptedText] = value.split(":");
    if (version !== "v1" || !ivText || !tagText || !encryptedText) {
      throw new PluginServiceError(500, "INTERNAL_ERROR", "Plugin secret ciphertext is invalid");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }
}

function resolvePluginSecretKey(input: {
  secretKey?: string;
  pluginDataDir: string;
}): { key: Buffer; source: "environment" | "fallback_file" | "ephemeral"; persistent: boolean } {
  const configured = input.secretKey ?? process.env.DIBAO_PLUGIN_SECRET_KEY;
  if (configured) {
    return { key: createHash("sha256").update(configured).digest(), source: "environment", persistent: true };
  }

  const keyDir = join(input.pluginDataDir, "secrets");
  const keyPath = join(keyDir, "plugin-secret.key");
  if (existsSync(keyPath)) {
    return { key: createHash("sha256").update(readFileSync(keyPath, "utf8").trim()).digest(), source: "fallback_file", persistent: true };
  }
  const generated = randomBytes(32).toString("base64url");
  try {
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(keyPath, `${generated}\n`, { mode: 0o600 });
    return { key: createHash("sha256").update(generated).digest(), source: "fallback_file", persistent: true };
  } catch {
    // Read-only deployments and tests can still boot; configured env keys remain preferred for durable secrets.
  }
  return { key: createHash("sha256").update(generated).digest(), source: "ephemeral", persistent: false };
}

function normalizeSecretKey(key: string): string {
  const normalized = key.trim();
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/u.test(normalized)) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin secret key is invalid");
  }
  return normalized;
}

function normalizeOutboundFetchInput(input: PluginOutboundFetchInput): Required<PluginOutboundFetchInput> {
  if (!input || typeof input !== "object") {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin network request is required");
  }
  const method = normalizeDeliveryMethod(input.method ?? "GET");
  const url = normalizePluginOutboundUrl(input.url);
  const headers = normalizeHeaders(input.headers ?? {});
  const timeoutMs = Math.min(Math.max(Math.trunc(input.timeoutMs ?? PLUGIN_OUTBOUND_TIMEOUT_MS), 500), 30_000);
  return { method, url, headers, body: input.body ?? null, timeoutMs };
}

function normalizeDeliveryRequest(input: PluginDeliveryEnqueueInput): PluginDeliveryStoredRequest {
  const normalized = normalizeOutboundFetchInput(input);
  for (const headerName of Object.keys(normalized.headers)) {
    if (isSensitiveHeader(headerName)) {
      throw new PluginServiceError(400, "VALIDATION_ERROR", "Sensitive delivery headers must reference plugin secrets");
    }
  }
  const secretHeaders: Record<string, { key: string; prefix?: string }> = {};
  for (const [headerName, value] of Object.entries(input.secretHeaders ?? {})) {
    const normalizedHeaderName = normalizeHeaderName(headerName);
    secretHeaders[normalizedHeaderName] = {
      key: normalizeSecretKey(value.key),
      prefix: typeof value.prefix === "string" ? value.prefix : undefined
    };
  }
  return {
    method: normalized.method as PluginDeliveryMethod,
    url: normalized.url,
    headers: normalized.headers,
    secretHeaders,
    body: normalized.body,
    timeoutMs: normalized.timeoutMs
  };
}

function normalizeDeliveryMethod(method: string): PluginDeliveryMethod {
  const normalized = method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized)) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin request method is unsupported");
  }
  return normalized as PluginDeliveryMethod;
}

function normalizePluginOutboundUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin request URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin request URL must use HTTP or HTTPS");
  }
  return url.toString();
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[normalizeHeaderName(name)] = String(value);
  }
  return normalized;
}

function normalizeHeaderName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(normalized)) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin request header name is invalid");
  }
  return normalized;
}

async function performPluginFetch(input: {
  input: Required<PluginOutboundFetchInput>;
  fetcher?: ControlledFetcher;
  resolveHostname?: HostnameResolver;
}): Promise<{ ok: boolean; status: number; headers: Record<string, string>; bodyText: string }> {
  const body = encodePluginRequestBody(input.input.body);
  if (body && Buffer.byteLength(body, "utf8") > PLUGIN_OUTBOUND_MAX_REQUEST_BYTES) {
    throw new PluginServiceError(400, "VALIDATION_ERROR", "Plugin request body is too large");
  }
  try {
    const result = await controlledFetchText(input.input.url, {
      fetcher: input.fetcher,
      method: input.input.method,
      headers: {
        ...input.input.headers,
        ...(body ? { "content-type": input.input.headers["content-type"] ?? "application/json" } : {})
      },
      body: body ?? undefined,
      maxBytes: PLUGIN_OUTBOUND_MAX_RESPONSE_BYTES,
      timeoutMs: input.input.timeoutMs,
      maxRedirects: PLUGIN_OUTBOUND_MAX_REDIRECTS,
      resolveHostname: input.resolveHostname
    });
    return {
      ok: result.response.ok,
      status: result.response.status,
      headers: redactHeaders(Object.fromEntries(result.response.headers.entries())),
      bodyText: result.body
    };
  } catch (error) {
    if (error instanceof PluginServiceError) {
      throw error;
    }
    throw new PluginServiceError(502, "PROVIDER_ERROR", redactText(errorMessage(error)));
  }
}

function encodePluginRequestBody(body: unknown): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

function parseDeliveryStoredRequest(value: string): PluginDeliveryStoredRequest {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    throw new PermanentJobFailure("Plugin delivery request is invalid");
  }
  return normalizeDeliveryRequest(parsed as PluginDeliveryEnqueueInput);
}

function redactedDeliveryRequest(request: PluginDeliveryStoredRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url,
    headers: redactHeaders(request.headers),
    secretHeaders: Object.fromEntries(Object.keys(request.secretHeaders).map((header) => [header, { hasValue: true }])),
    bodyBytes: Buffer.byteLength(encodePluginRequestBody(request.body) ?? "", "utf8"),
    timeoutMs: request.timeoutMs
  };
}

function redactedFetchResponse(response: { ok: boolean; status: number; headers: Record<string, string>; bodyText: string }): Record<string, unknown> {
  return {
    ok: response.ok,
    status: response.status,
    headers: redactHeaders(response.headers),
    bodyPreview: redactText(response.bodyText).slice(0, 2048),
    bodyBytes: Buffer.byteLength(response.bodyText, "utf8")
  };
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, isSensitiveHeader(name) ? "[redacted]" : redactText(value)])
  );
}

function isSensitiveHeader(name: string): boolean {
  return /authorization|cookie|api[-_]?key|token|secret|signature/iu.test(name);
}

function redactText(value: string): string {
  return value.replace(/(authorization|api[-_]?key|token|secret|signature)(["'\s:=]+)([^"',\s]+)/giu, "$1$2[redacted]");
}

function isTransientPluginRuntimeError(message: string): boolean {
  return (
    /\bPlugin (?:hook|host call) timed out\b/u.test(message) ||
    message === "Plugin activation timed out" ||
    message.startsWith("Plugin host exited") ||
    message === "Plugin host stopped" ||
    message === "Plugin host is not running" ||
    message.startsWith("Plugin host is not accepting messages:")
  );
}

function readBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function readTrustedPublicKeysEnv(name: string): Record<string, string> {
  const value = process.env[name];
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const keys: Record<string, string> = {};
    for (const [keyId, publicKeyPem] of Object.entries(parsed)) {
      if (typeof keyId === "string" && typeof publicKeyPem === "string" && publicKeyPem.trim()) {
        keys[keyId] = publicKeyPem;
      }
    }
    return keys;
  } catch {
    return {};
  }
}

function mapPluginSecretMetadataItem(metadata: PluginSecretMetadata): PluginSecretMetadataItem {
  return {
    key: metadata.key,
    hasValue: metadata.hasValue,
    hint: metadata.hint,
    createdAt: new Date(metadata.createdAt).toISOString(),
    updatedAt: new Date(metadata.updatedAt).toISOString()
  };
}

function mapPluginDeliveryListItem(delivery: PluginDeliveryRow): PluginDeliveryListItem {
  return {
    id: delivery.id,
    pluginId: delivery.pluginId,
    status: delivery.status,
    method: delivery.method,
    url: delivery.url,
    request: safeParseJson(delivery.requestJson),
    response: safeParseJson(delivery.responseJson),
    error: delivery.error,
    idempotencyKey: delivery.idempotencyKey,
    jobId: delivery.jobId,
    createdAt: new Date(delivery.createdAt).toISOString(),
    updatedAt: new Date(delivery.updatedAt).toISOString(),
    finishedAt: delivery.finishedAt ? new Date(delivery.finishedAt).toISOString() : null
  };
}

function safeParseJson(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Plugin hook timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      }
    );
  });
}

function nextRunForSchedule(schedule: PluginScheduleRow, now: number): number | null {
  if (schedule.schedule === "daily" && schedule.localTime) {
    return nextDailyRunAt(now + 1_000, schedule.localTime, schedule.timezone ?? "UTC");
  }
  if (schedule.schedule === "interval" && schedule.intervalMs) {
    return now + schedule.intervalMs;
  }
  return null;
}

function nextDailyRunAt(now: number, localTime: string, timezone: string): number {
  const [hourText, minuteText] = localTime.split(":");
  const hour = clampInteger(Number.parseInt(hourText ?? "", 10), 0, 23, 8);
  const minute = clampInteger(Number.parseInt(minuteText ?? "", 10), 0, 59, 0);
  const parts = zonedParts(now, timezone);
  let candidate = zonedTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute,
    timezone
  });
  if (candidate <= now) {
    const nextDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    candidate = zonedTimeToUtc({
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth() + 1,
      day: nextDate.getUTCDate(),
      hour,
      minute,
      timezone
    });
  }
  return candidate;
}

function zonedParts(value: number, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  return {
    year: Number(parts.find((part) => part.type === "year")?.value ?? "1970"),
    month: Number(parts.find((part) => part.type === "month")?.value ?? "1"),
    day: Number(parts.find((part) => part.type === "day")?.value ?? "1")
  };
}

function zonedTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}): number {
  const utcGuess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
  const offset = timeZoneOffsetMs(utcGuess, input.timezone);
  return utcGuess - offset;
}

function timeZoneOffsetMs(value: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(value));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - value;
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function roundDuration(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function summarizePluginApiResult(result: unknown): {
  briefCount?: number;
  familyCount?: number;
  clusterCount?: number;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }
  const record = result as {
    briefs?: unknown;
    targets?: {
      families?: unknown;
      clusters?: unknown;
    };
  };
  return {
    ...(Array.isArray(record.briefs) ? { briefCount: record.briefs.length } : {}),
    ...(Array.isArray(record.targets?.families) ? { familyCount: record.targets.families.length } : {}),
    ...(Array.isArray(record.targets?.clusters) ? { clusterCount: record.targets.clusters.length } : {})
  };
}

function mapPluginArticleState(row: PluginArticleStateDbRow): ArticleStateSnapshot {
  return {
    read: row.read === 1,
    favorited: row.favorited === 1,
    liked: row.liked === 1,
    readLater: row.readLater === 1,
    hidden: row.hidden === 1,
    notInterested: row.notInterested === 1,
    readingProgress: row.readingProgress,
    interactionStatus: pluginInteractionStatusForState(row),
    openedAt: row.lastOpenedAt,
    ignoredAt: pluginIgnoredAtForState(row)
  };
}

function pluginInteractionStatusForState(row: PluginArticleStateDbRow): ArticleInteractionStatus {
  if (row.notInterested === 1) {
    return "ignored";
  }
  if (row.read === 1 || row.readingProgress >= 0.9) {
    return "read";
  }
  if (row.readingProgress >= 0.25) {
    return "reading";
  }
  if (row.lastOpenedAt !== null) {
    return "opened";
  }
  if (row.favorited === 1 || row.liked === 1 || row.readLater === 1) {
    return "saved";
  }
  if (row.lastIgnoredAt !== null) {
    return "ignored";
  }
  if (row.lastActionAt !== null) {
    return "seen";
  }
  return "unseen";
}

function pluginIgnoredAtForState(row: PluginArticleStateDbRow): number | null {
  if (row.notInterestedAt !== null) {
    return row.notInterestedAt;
  }

  if (
    row.read === 1 ||
    row.readingProgress > 0 ||
    row.lastOpenedAt !== null ||
    row.favorited === 1 ||
    row.liked === 1 ||
    row.readLater === 1
  ) {
    return null;
  }

  return row.lastIgnoredAt !== null &&
    (row.lastOpenedAt === null || row.lastIgnoredAt > row.lastOpenedAt)
    ? row.lastIgnoredAt
    : null;
}

function isTerminalDeliveryStatus(status: PluginDeliveryStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

async function terminatePluginChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      finish();
    }, PLUGIN_RUNTIME_STOP_GRACE_MS);
    child.once("exit", finish);
    child.kill();
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
