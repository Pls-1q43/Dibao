type HostCallMessage = {
  type: "host.call";
  id: string;
  method: string;
  args?: unknown;
};

type HostResponseMessage = {
  type: "host.response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: SerializedPluginError;
};

type PluginInvokeMessage = {
  type: "plugin.invoke";
  id: string;
  kind: "hook" | "task" | "api" | "fullContentExtractor";
  name: string;
  input?: unknown;
};

type SerializedPluginError = {
  message: string;
  statusCode?: number;
  code?: string;
  details?: unknown;
};

type PluginHostConfig = {
  pluginId: string;
  manifest: unknown;
  entryPath: string;
  locale?: string;
};

const hookHandlers = new Map<string, Array<(payload: unknown) => Promise<void> | void>>();
const taskHandlers = new Map<string, (job: unknown) => Promise<void> | void>();
const apiHandlers = new Map<string, (input: unknown) => Promise<unknown> | unknown>();
const fullContentExtractorHandlers = new Map<string, (input: unknown) => Promise<unknown> | unknown>();
const pendingHostCalls = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

let hostCallSequence = 0;

process.on("message", (message: PluginInvokeMessage | HostResponseMessage) => {
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "host.response") {
    handleHostResponse(message);
    return;
  }
  if (message.type === "plugin.invoke") {
    void handlePluginInvoke(message);
  }
});

void main().catch((error) => {
  send({
    type: "plugin.failed",
    error: serializeError(error)
  });
  process.exit(1);
});

async function main(): Promise<void> {
  const config = readConfig();
  const module = await import(pathToFileUrl(config.entryPath));
  const activate =
    typeof module.default === "function"
      ? module.default
      : module.default?.activate ?? module.activate;
  if (typeof activate === "function") {
    await activate(createContext(config));
  }
  send({ type: "plugin.ready" });
}

function createContext(config: PluginHostConfig): Record<string, unknown> {
  return {
    pluginId: config.pluginId,
    manifest: config.manifest,
    locale: typeof config.locale === "string" && config.locale ? config.locale : "zh-CN",
    i18n: {
      getLocale: () => callHost("locale.get")
    },
    now: () => callHost("now"),
    hooks: {
      on: (hook: string, handler: (payload: unknown) => Promise<void> | void) => {
        const handlers = hookHandlers.get(hook) ?? [];
        handlers.push(handler);
        hookHandlers.set(hook, handlers);
        send({ type: "plugin.register", kind: "hook", name: hook });
      }
    },
    fullContent: {
      register: (extractorId: string, handler: (input: unknown) => Promise<unknown> | unknown) => {
        fullContentExtractorHandlers.set(extractorId, handler);
        send({ type: "plugin.register", kind: "fullContentExtractor", name: extractorId });
      }
    },
    events: {
      catalog: () => callHost("events.catalog"),
      emit: (event: string, payload: unknown) => callHost("events.emit", { event, payload })
    },
    tasks: {
      register: (taskId: string, handler: (job: unknown) => Promise<void> | void) => {
        taskHandlers.set(taskId, handler);
        send({ type: "plugin.register", kind: "task", name: taskId });
      },
      start: (taskId: string, payload?: Record<string, unknown>) =>
        callHost("tasks.start", { taskId, payload })
    },
    api: {
      get: (path: string, handler: (input: unknown) => Promise<unknown> | unknown) => {
        const name = `GET ${normalizeApiPath(path)}`;
        apiHandlers.set(name, handler);
        send({ type: "plugin.register", kind: "api:get", name: normalizeApiPath(path) });
      },
      post: (path: string, handler: (input: unknown) => Promise<unknown> | unknown) => {
        const name = `POST ${normalizeApiPath(path)}`;
        apiHandlers.set(name, handler);
        send({ type: "plugin.register", kind: "api:post", name: normalizeApiPath(path) });
      }
    },
    storage: {
      get: (key: string) => callHost("storage.get", { key }),
      set: (key: string, value: unknown) => callHost("storage.set", { key, value }),
      listByPrefix: (prefix: string) => callHost("storage.listByPrefix", { prefix }),
      delete: (key: string) => callHost("storage.delete", { key })
    },
    settings: {
      get: (key: string) => callHost("settings.get", { key }),
      set: (key: string, value: unknown) => callHost("settings.set", { key, value }),
      list: () => callHost("settings.list")
    },
    secrets: {
      list: () => callHost("secrets.list"),
      get: (key: string) => callHost("secrets.get", { key }),
      set: (key: string, value: string, hint?: string | null) =>
        callHost("secrets.set", { key, value, hint }),
      delete: (key: string) => callHost("secrets.delete", { key })
    },
    network: {
      fetch: (input: unknown) => callHost("network.fetch", input)
    },
    deliveries: {
      enqueue: (input: unknown) => callHost("deliveries.enqueue", input),
      get: (deliveryId: string) => callHost("deliveries.get", { deliveryId }),
      list: (input: unknown = {}) => callHost("deliveries.list", input),
      cancel: (deliveryId: string) => callHost("deliveries.cancel", { deliveryId }),
      flush: (deliveryId: string) => callHost("deliveries.flush", { deliveryId })
    },
    database: {
      defineTable: (definition: unknown) => callHost("database.defineTable", definition),
      insert: (tableName: string, record: Record<string, unknown>) =>
        callHost("database.insert", { tableName, record }),
      get: (tableName: string, rowId: number) => callHost("database.get", { tableName, rowId }),
      list: (tableName: string, input: unknown = {}) =>
        callHost("database.list", { tableName, input }),
      delete: (tableName: string, rowId: number) =>
        callHost("database.delete", { tableName, rowId })
    },
    scheduler: {
      configureDaily: (taskId: string, input: unknown) =>
        callHost("scheduler.configureDaily", { taskId, input })
    },
    ranking: {
      listRankedWinners: (input: unknown) => callHost("ranking.listRankedWinners", input),
      listTopicTargets: () => callHost("ranking.listTopicTargets")
    },
    articles: {
      countDiscovered: (input: unknown) => callHost("articles.countDiscovered", input),
      openableSummary: (articleId: string) => callHost("articles.openableSummary", { articleId }),
      snapshot: (articleId: string, input: unknown = {}) =>
        callHost("articles.snapshot", { articleId, input })
    }
  };
}

async function handlePluginInvoke(message: PluginInvokeMessage): Promise<void> {
  try {
    if (message.kind === "hook") {
      for (const handler of hookHandlers.get(message.name) ?? []) {
        await handler(message.input);
      }
      send({ type: "plugin.response", id: message.id, ok: true });
      return;
    }
    if (message.kind === "task") {
      const handler = taskHandlers.get(message.name);
      if (!handler) {
        throw Object.assign(new Error(`Plugin task is not registered: ${message.name}`), {
          statusCode: 409,
          code: "PLUGIN_TASK_PAUSED"
        });
      }
      await handler(message.input);
      send({ type: "plugin.response", id: message.id, ok: true });
      return;
    }
    if (message.kind === "fullContentExtractor") {
      const handler = fullContentExtractorHandlers.get(message.name);
      if (!handler) {
        throw Object.assign(new Error(`Plugin full content extractor is not registered: ${message.name}`), {
          statusCode: 409,
          code: "PLUGIN_EXTRACTOR_PAUSED"
        });
      }
      const result = await handler(message.input);
      send({ type: "plugin.response", id: message.id, ok: true, result });
      return;
    }
    const handler = apiHandlers.get(message.name);
    if (!handler) {
      throw Object.assign(new Error(`Plugin API route is not registered: ${message.name}`), {
        statusCode: 404,
        code: "NOT_FOUND"
      });
    }
    const result = await handler(message.input);
    send({ type: "plugin.response", id: message.id, ok: true, result });
  } catch (error) {
    send({
      type: "plugin.response",
      id: message.id,
      ok: false,
      error: serializeError(error)
    });
  }
}

function callHost(method: string, args?: unknown): Promise<unknown> {
  const id = `host_${process.pid}_${++hostCallSequence}`;
  const message: HostCallMessage = { type: "host.call", id, method, args };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHostCalls.delete(id);
      reject(new Error(`Plugin host call timed out: ${method}`));
    }, 30_000);
    pendingHostCalls.set(id, { resolve, reject, timer });
    send(message);
  });
}

function handleHostResponse(message: HostResponseMessage): void {
  const pending = pendingHostCalls.get(message.id);
  if (!pending) {
    return;
  }
  pendingHostCalls.delete(message.id);
  clearTimeout(pending.timer);
  if (message.ok) {
    pending.resolve(message.result);
    return;
  }
  pending.reject(errorFromSerialized(message.error));
}

function readConfig(): PluginHostConfig {
  const raw = process.env.DIBAO_PLUGIN_HOST_CONFIG;
  if (!raw) {
    throw new Error("Missing plugin host config");
  }
  const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PluginHostConfig;
  if (!parsed.pluginId || !parsed.entryPath) {
    throw new Error("Invalid plugin host config");
  }
  return parsed;
}

function send(message: Record<string, unknown>): void {
  if (!process.send) {
    throw new Error("Plugin host IPC is unavailable");
  }
  process.send(message);
}

function normalizeApiPath(path: string): string {
  const trimmed = String(path).trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function pathToFileUrl(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${prefixed.split("/").map(encodeURIComponent).join("/")}`;
}

function serializeError(error: unknown): SerializedPluginError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(typeof record.statusCode === "number" ? { statusCode: record.statusCode } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(Object.hasOwn(record, "details") ? { details: record.details } : {})
  };
}

function errorFromSerialized(error: SerializedPluginError | undefined): Error {
  const message = error?.message ?? "Plugin host call failed";
  return Object.assign(new Error(message), {
    statusCode: error?.statusCode,
    code: error?.code,
    details: error?.details
  });
}
