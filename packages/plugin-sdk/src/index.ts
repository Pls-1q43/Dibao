import { createHash, sign as signPayload, verify as verifyPayload } from "node:crypto";

export type DibaoPluginSignature = {
  algorithm: "ed25519";
  publicKeyPem?: string;
  keyId?: string;
  signedAt?: string;
  signature: string;
};

export type DibaoPluginPackage = {
  manifest: unknown;
  files?: Record<string, string>;
  updateUrl?: string;
  signature?: DibaoPluginSignature;
};

export type DibaoPluginManifest = {
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
  capabilities: DibaoPluginCapability[];
  migrations?: DibaoPluginMigration[];
  contributes?: {
    settingsTabs?: DibaoPluginPanelContribution[];
    tabs?: DibaoPluginPanelContribution[];
    routes?: DibaoPluginRouteContribution[];
    actions?: DibaoPluginActionContribution[];
    hooks?: DibaoPluginEvent[];
    events?: DibaoPluginEvent[];
    fullContentExtractors?: DibaoPluginFullContentExtractorContribution[];
    tasks?: DibaoPluginTaskContribution[];
    setupSteps?: DibaoPluginSetupStepContribution[];
  };
};

export type DibaoPluginMigration = {
  version: string;
  name: string;
  path: string;
  checksum?: string;
};

export type DibaoPluginPanelContribution = {
  id: string;
  title: string;
  slot: DibaoPluginSlot | string;
  order?: number;
  icon?: string;
  route?: string;
  primaryNav?: boolean;
  primaryMobile?: boolean;
};

export type DibaoPluginRouteContribution = {
  id: string;
  path: string;
  title: string;
  panel: string;
  order?: number;
  icon?: string;
  primaryNav?: boolean;
  primaryMobile?: boolean;
};

export type DibaoPluginActionContribution = {
  id: string;
  title: string;
  slot: DibaoPluginSlot | string;
  icon?: string;
  command: string;
  order?: number;
};

export type DibaoPluginFullContentExtractorContribution = {
  id: string;
  title: string;
  order?: number;
};

export type DibaoPluginTaskContribution = {
  id: string;
  kind: "foreground" | "background";
  schedule?: "manual" | "interval" | "daily" | "weekly";
  defaultEnabled?: boolean;
};

export type DibaoPluginSetupStepContribution = {
  id: string;
  title: string;
  body?: string;
  order?: number;
  defaultEnabled?: boolean;
};

export const dibaoPluginCapabilities = [
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

export type DibaoPluginCapability = typeof dibaoPluginCapabilities[number];

export const dibaoPluginEvents = [
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

export type DibaoPluginEvent = typeof dibaoPluginEvents[number];

export const dibaoPluginSlots = [
  "app.main.nav.items",
  "app.main.tabs",
  "article.list.item.actions.end",
  "article.list.toolbar.end",
  "article.reader.bottomSheet.actions",
  "settings.tabs",
  "algorithm.jobs.actions"
] as const;

export type DibaoPluginSlot = typeof dibaoPluginSlots[number];

export const dibaoPluginStableApis = [
  "manifest.v1",
  "lifecycle.installEnableDisableUpdate",
  "settings",
  "storage",
  "secrets",
  "deliveries",
  "tasks",
  "hooks.basic",
  "events.catalog",
  "iframe.bridge",
  "database.migrations",
  "network.outbound"
] as const;

export const dibaoPluginBetaApis = [
  "database.defineTable",
  "ranking",
  "articles.snapshot",
  "fullContent.extractor",
  "diagnostics"
] as const;

export type DibaoPluginStableApi = typeof dibaoPluginStableApis[number];
export type DibaoPluginBetaApi = typeof dibaoPluginBetaApis[number];

export type DibaoPluginContext = {
  pluginId: string;
  manifest: DibaoPluginManifest;
  now: () => Promise<number>;
  hooks: {
    on: (hook: DibaoPluginEvent, handler: (payload: unknown) => Promise<void> | void) => void;
  };
  fullContent: {
    register: (
      extractorId: string,
      handler: (
        input: DibaoFullContentExtractionInput
      ) => Promise<DibaoFullContentExtractionResult | null> | DibaoFullContentExtractionResult | null
    ) => void;
  };
  events: {
    catalog: () => Promise<DibaoPluginEvent[]>;
    emit: (event: DibaoPluginEvent, payload: unknown) => Promise<unknown>;
  };
  tasks: {
    register: (taskId: string, handler: (job: unknown) => Promise<void> | void) => void;
    start: (taskId: string, payload?: Record<string, unknown>) => Promise<unknown>;
  };
  api: {
    get: (path: string, handler: (input: { params: Record<string, string>; body: unknown }) => Promise<unknown> | unknown) => void;
    post: (path: string, handler: (input: { params: Record<string, string>; body: unknown }) => Promise<unknown> | unknown) => void;
  };
  storage: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<unknown>;
    listByPrefix: <T = unknown>(prefix: string) => Promise<Array<{ key: string; value: T; updatedAt: number }>>;
    delete: (key: string) => Promise<unknown>;
  };
  settings: {
    get: <T = unknown>(key: string) => Promise<T | null>;
    set: (key: string, value: unknown) => Promise<unknown>;
    list: () => Promise<Record<string, unknown>>;
  };
  secrets: {
    list: () => Promise<DibaoPluginSecretMetadata[]>;
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, hint?: string | null) => Promise<DibaoPluginSecretMetadata>;
    delete: (key: string) => Promise<unknown>;
  };
  deliveries: {
    enqueue: (input: unknown) => Promise<DibaoPluginDelivery>;
    get: (deliveryId: string) => Promise<DibaoPluginDelivery>;
    list: (input?: { status?: DibaoPluginDeliveryStatus; limit?: number }) => Promise<DibaoPluginDelivery[]>;
    cancel: (deliveryId: string) => Promise<DibaoPluginDelivery>;
    flush: (deliveryId: string) => Promise<DibaoPluginDelivery>;
  };
  network: {
    fetch: (input: unknown) => Promise<unknown>;
  };
  database: {
    defineTable: (definition: unknown) => Promise<unknown>;
    insert: (tableName: string, record: Record<string, unknown>) => Promise<{ id: number }>;
    get: (tableName: string, rowId: number) => Promise<Record<string, unknown> | null>;
    list: (tableName: string, input?: unknown) => Promise<Array<Record<string, unknown>>>;
    delete: (tableName: string, rowId: number) => Promise<unknown>;
  };
  scheduler: {
    configureDaily: (taskId: string, input: { enabled: boolean; localTime: string; timezone?: string | null }) => Promise<unknown>;
  };
  ranking: {
    listRankedWinners: (input: { windowMs: number; limit: number }) => Promise<unknown[]>;
    listTopicTargets: () => Promise<unknown>;
  };
  articles: {
    countDiscovered: (input: { startAt: number; endAt: number }) => Promise<number>;
    openableSummary: (articleId: string) => Promise<unknown>;
    snapshot: (articleId: string, input?: { includeContent?: boolean }) => Promise<unknown>;
  };
};

export type DibaoFullContentExtractionInput = {
  articleUrl: string;
  html: string;
  contentType: string;
};

export type DibaoFullContentExtractionResult = {
  title?: string | null;
  contentHtml: string;
  contentText: string;
  excerpt?: string | null;
};

export type DibaoPluginSecretMetadata = {
  key: string;
  hasValue: boolean;
  hint: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DibaoPluginDeliveryStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type DibaoPluginDelivery = {
  id: string;
  pluginId: string;
  status: DibaoPluginDeliveryStatus;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  request: unknown;
  response: unknown;
  error: string | null;
  idempotencyKey: string | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type DibaoPluginValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function pluginPackageSigningPayload(pluginPackage: DibaoPluginPackage): string {
  return stableStringify({
    manifest: pluginPackage.manifest,
    files: pluginPackage.files ?? {},
    updateUrl: pluginPackage.updateUrl ?? null
  });
}

export function pluginPackageSha256(pluginPackage: DibaoPluginPackage): string {
  return createHash("sha256").update(pluginPackageSigningPayload(pluginPackage)).digest("hex");
}

export function signPluginPackage(input: {
  pluginPackage: DibaoPluginPackage;
  privateKeyPem: string;
  publicKeyPem?: string;
  keyId?: string;
  now?: () => Date;
}): DibaoPluginPackage {
  const payload = pluginPackageSigningPayload(input.pluginPackage);
  const signature = signPayload(null, Buffer.from(payload), input.privateKeyPem).toString("base64");
  return {
    ...input.pluginPackage,
    signature: {
      algorithm: "ed25519",
      publicKeyPem: input.publicKeyPem,
      keyId: input.keyId,
      signedAt: (input.now ?? (() => new Date()))().toISOString(),
      signature
    }
  };
}

export function verifyPluginPackageSignature(input: {
  pluginPackage: DibaoPluginPackage;
  trustedPublicKeys?: Record<string, string>;
  requireSignature?: boolean;
}): DibaoPluginValidationResult {
  const signature = input.pluginPackage.signature;
  if (!signature) {
    return input.requireSignature === false
      ? { ok: true }
      : { ok: false, errors: ["Plugin signature is required"] };
  }
  if (signature.algorithm !== "ed25519" || !signature.signature) {
    return { ok: false, errors: ["Plugin signature is invalid"] };
  }
  if (!signature.keyId) {
    return { ok: false, errors: ["Plugin signature keyId is required"] };
  }
  const publicKeyPem = input.trustedPublicKeys?.[signature.keyId];
  if (!publicKeyPem) {
    return { ok: false, errors: ["Plugin signature key is not trusted"] };
  }
  const ok = verifyPayload(
    null,
    Buffer.from(pluginPackageSigningPayload(input.pluginPackage)),
    publicKeyPem,
    Buffer.from(signature.signature, "base64")
  );
  return ok ? { ok: true } : { ok: false, errors: ["Plugin signature verification failed"] };
}

export function validatePluginPackage(pluginPackage: DibaoPluginPackage): DibaoPluginValidationResult {
  const errors: string[] = [];
  const manifest = pluginPackage.manifest as Record<string, unknown> | null;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push("manifest must be an object");
  } else {
    for (const key of ["manifestVersion", "id", "name", "version", "publisher", "dibao", "capabilities"]) {
      if (!Object.hasOwn(manifest, key)) {
        errors.push(`manifest.${key} is required`);
      }
    }
    const entry = manifest.entry as Record<string, unknown> | undefined;
    for (const entryPath of [entry?.server, entry?.web]) {
      if (typeof entryPath === "string" && pluginPackage.files && !Object.hasOwn(pluginPackage.files, entryPath)) {
        errors.push(`entry file is missing: ${entryPath}`);
      }
    }
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    for (const capability of capabilities) {
      if (typeof capability !== "string" || !dibaoPluginCapabilities.includes(capability as DibaoPluginCapability)) {
        errors.push(`manifest.capabilities contains unsupported capability: ${String(capability)}`);
      }
    }
    const migrations = Array.isArray(manifest.migrations) ? manifest.migrations : [];
    const migrationVersions = new Set<string>();
    for (const migration of migrations) {
      const record = migration && typeof migration === "object" && !Array.isArray(migration)
        ? migration as Record<string, unknown>
        : {};
      const version = typeof record.version === "string" ? record.version.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const path = typeof record.path === "string" ? record.path.trim() : "";
      if (!version || !name || !path) {
        errors.push("manifest.migrations entries require version, name, and path");
        continue;
      }
      if (migrationVersions.has(version)) {
        errors.push(`manifest.migrations contains duplicate version: ${version}`);
      }
      migrationVersions.add(version);
      if (pluginPackage.files && !Object.hasOwn(pluginPackage.files, path)) {
        errors.push(`migration file is missing: ${path}`);
      }
      if (record.checksum !== undefined && typeof record.checksum !== "string") {
        errors.push(`manifest.migrations checksum must be a string: ${version}`);
      }
    }
    const contributes = manifest.contributes as Record<string, unknown> | undefined;
    const hooks = Array.isArray(contributes?.hooks) ? contributes.hooks : [];
    for (const hook of hooks) {
      if (typeof hook !== "string" || !dibaoPluginEvents.includes(hook as DibaoPluginEvent)) {
        errors.push(`manifest.contributes.hooks contains unsupported event: ${String(hook)}`);
      }
    }
    const events = Array.isArray(contributes?.events) ? contributes.events : [];
    for (const event of events) {
      if (typeof event !== "string" || !dibaoPluginEvents.includes(event as DibaoPluginEvent)) {
        errors.push(`manifest.contributes.events contains unsupported event: ${String(event)}`);
      }
    }
    const fullContentExtractors = Array.isArray(contributes?.fullContentExtractors)
      ? contributes.fullContentExtractors
      : [];
    const fullContentExtractorIds = new Set<string>();
    for (const extractor of fullContentExtractors) {
      const record = extractor && typeof extractor === "object" && !Array.isArray(extractor)
        ? extractor as Record<string, unknown>
        : {};
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (!id || !title) {
        errors.push("manifest.contributes.fullContentExtractors entries require id and title");
      } else if (fullContentExtractorIds.has(id)) {
        errors.push(`manifest.contributes.fullContentExtractors contains duplicate id: ${id}`);
      }
      fullContentExtractorIds.add(id);
      if (record.order !== undefined && (typeof record.order !== "number" || !Number.isFinite(record.order))) {
        errors.push(`manifest.contributes.fullContentExtractors order must be a finite number: ${id || "(missing id)"}`);
      }
    }
    const tasks = Array.isArray(contributes?.tasks) ? contributes.tasks : [];
    const taskIds = new Set<string>();
    for (const task of tasks) {
      const record = task && typeof task === "object" && !Array.isArray(task)
        ? task as Record<string, unknown>
        : {};
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id) {
        errors.push("manifest.contributes.tasks entries require id");
      } else if (taskIds.has(id)) {
        errors.push(`manifest.contributes.tasks contains duplicate id: ${id}`);
      }
      taskIds.add(id);
      if (record.kind !== "foreground" && record.kind !== "background") {
        errors.push(`manifest.contributes.tasks has invalid kind: ${id || "(missing id)"}`);
      }
    }
  }
  const signatureResult = verifyPluginPackageSignature({
    pluginPackage,
    requireSignature: false
  });
  if (!signatureResult.ok) {
    errors.push(...signatureResult.errors);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
