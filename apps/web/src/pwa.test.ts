import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./pwa.js";

type Listener = () => void;

function createEventTargetMock() {
  const listeners = new Map<string, Listener[]>();

  return {
    addEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }),
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    }
  };
}

function installBrowserMocks(options: {
  controller?: unknown;
  registration?: Partial<ServiceWorkerRegistration>;
  serviceWorkerSupported?: boolean;
} = {}) {
  const windowTarget = createEventTargetMock();
  const serviceWorkerTarget = createEventTargetMock();
  const register = vi.fn().mockResolvedValue(options.registration ?? {});
  const reload = vi.fn();
  const setInterval = vi.fn();
  const dispatchEvent = vi.fn();

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: windowTarget.addEventListener,
      dispatchEvent,
      location: {
        reload
      },
      setInterval
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value:
      options.serviceWorkerSupported === false
        ? {}
        : {
            serviceWorker: {
              addEventListener: serviceWorkerTarget.addEventListener,
              controller: options.controller ?? null,
              register
            }
          }
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: class MockCustomEvent {
      detail: unknown;

      constructor(
        public type: string,
        options?: { detail?: unknown }
      ) {
        this.detail = options?.detail;
      }
    }
  });

  return {
    dispatchControllerChange: () => serviceWorkerTarget.dispatch("controllerchange"),
    dispatchLoad: () => windowTarget.dispatch("load"),
    dispatchEvent,
    register,
    reload,
    setInterval
  };
}

beforeEach(() => {
  vi.stubEnv("PROD", false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "navigator");
  Reflect.deleteProperty(globalThis, "CustomEvent");
});

describe("registerServiceWorker", () => {
  it("does not register service workers in dev/test mode", () => {
    const browser = installBrowserMocks();

    registerServiceWorker();

    expect(browser.register).not.toHaveBeenCalled();
  });

  it("does not throw when service workers are unsupported", () => {
    vi.stubEnv("PROD", true);
    installBrowserMocks({ serviceWorkerSupported: false });

    expect(() => registerServiceWorker()).not.toThrow();
  });

  it("registers /sw.js with root scope in production", async () => {
    vi.stubEnv("PROD", true);
    const registration = {
      addEventListener: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined)
    };
    const browser = installBrowserMocks({ registration });

    registerServiceWorker();
    browser.dispatchLoad();
    await Promise.resolve();

    expect(browser.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(browser.setInterval).toHaveBeenCalled();
  });

  it("reports updates when a new installed worker appears under an existing controller", async () => {
    vi.stubEnv("PROD", true);
    const installingTarget = createEventTargetMock();
    const registrationTarget = createEventTargetMock();
    const installingWorker = {
      addEventListener: installingTarget.addEventListener,
      postMessage: vi.fn(),
      state: "installing"
    };
    const registration = {
      addEventListener: registrationTarget.addEventListener,
      get installing() {
        return installingWorker;
      },
      update: vi.fn().mockResolvedValue(undefined),
      get waiting() {
        return installingWorker.state === "installed" ? installingWorker : null;
      }
    } as unknown as ServiceWorkerRegistration;
    const onUpdateAvailable = vi.fn();
    const browser = installBrowserMocks({
      controller: {},
      registration
    });

    registerServiceWorker({ onUpdateAvailable });
    browser.dispatchLoad();
    await Promise.resolve();
    registrationTarget.dispatch("updatefound");
    installingWorker.state = "installed";
    installingTarget.dispatch("statechange");

    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(browser.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dibao:pwa-update-available"
      })
    );
  });

  it("applies an available update and reloads once after controllerchange", async () => {
    vi.stubEnv("PROD", true);
    const installingTarget = createEventTargetMock();
    const registrationTarget = createEventTargetMock();
    const installingWorker = {
      addEventListener: installingTarget.addEventListener,
      postMessage: vi.fn(),
      state: "installing"
    };
    const registration = {
      addEventListener: registrationTarget.addEventListener,
      get installing() {
        return installingWorker;
      },
      update: vi.fn().mockResolvedValue(undefined),
      get waiting() {
        return installingWorker.state === "installed" ? installingWorker : null;
      }
    } as unknown as ServiceWorkerRegistration;
    const onUpdateAvailable = vi.fn();
    const browser = installBrowserMocks({
      controller: {},
      registration
    });

    registerServiceWorker({ onUpdateAvailable });
    browser.dispatchLoad();
    await Promise.resolve();
    registrationTarget.dispatch("updatefound");
    installingWorker.state = "installed";
    installingTarget.dispatch("statechange");

    const applyUpdate = onUpdateAvailable.mock.calls[0][0] as () => void;
    applyUpdate();
    browser.dispatchControllerChange();
    browser.dispatchControllerChange();

    expect(installingWorker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it("reports a worker that was already waiting when the page opened", async () => {
    vi.stubEnv("PROD", true);
    const waitingWorker = {
      postMessage: vi.fn()
    };
    const registration = {
      addEventListener: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      waiting: waitingWorker
    } as unknown as ServiceWorkerRegistration;
    const onUpdateAvailable = vi.fn();
    const browser = installBrowserMocks({
      controller: {},
      registration
    });

    registerServiceWorker({ onUpdateAvailable });
    browser.dispatchLoad();
    await Promise.resolve();

    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
    const applyUpdate = onUpdateAvailable.mock.calls[0][0] as () => void;
    applyUpdate();
    expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });
});

describe("service worker source", () => {
  it("contains the foundation lifecycle and API bypass markers", () => {
    const source = readFileSync(resolve("public/sw.js"), "utf8");

    expect(source).toContain("CACHE_VERSION");
    expect(source).toContain("install");
    expect(source).toContain("activate");
    expect(source).toContain("fetch");
    expect(source).toContain("/api/");
    expect(source).toContain("/logo-64.png");
    expect(source).toContain("SKIP_WAITING");
    expect(source).toContain("ARTICLE_IMAGE_CACHE_PREFIX");
    expect(source).toContain("CACHE_ARTICLE_IMAGES");
    expect(source).toContain("PRUNE_ARTICLE_IMAGES");
    expect(source).toContain("CLEAR_ARTICLE_IMAGES");
    expect(source).toContain("articleImageCacheFirst");
    expect(source).toContain("imageScopesByClientId");
    expect(source).toContain("event.clientId");
    expect(source).toContain('CACHE_VERSION = "dibao-pwa-v14"');
    expect(source).toContain("MAX_ARTICLE_IMAGE_URLS_PER_MESSAGE");
    expect(source).toContain('event.waitUntil(precacheAppShell());');
    expect(source).not.toContain("precacheAppShell().then(() => self.skipWaiting())");
    expect(source).toContain("decodeURIComponent(pathname)");
    expect(source.indexOf("isApiPathname(requestUrl.pathname)")).toBeLessThan(
      source.indexOf('request.destination === "image"')
    );
  });

  it("recognizes encoded API paths before any image-cache handling", () => {
    const isApiPathname = loadServiceWorkerFunction<(pathname: string) => boolean>(
      "isApiPathname"
    );

    expect(isApiPathname("/api/auth/session")).toBe(true);
    expect(isApiPathname("/%61pi/auth/session")).toBe(true);
    expect(isApiPathname("/api%2Fauth%2Fsession")).toBe(true);
    expect(isApiPathname("/assets/api-client.js")).toBe(false);
  });

  it("rejects local-network targets from automatic article image caching", () => {
    const validHttpUrls = loadServiceWorkerFunction<(value: unknown) => string[]>(
      "validHttpUrls"
    );

    expect(validHttpUrls([
      "https://cdn.example/image.jpg#preview",
      "https://dibao.test/%61pi/auth/session",
      "http://127.0.0.1/admin/action",
      "http://[::1]/admin/action",
      "http://router.local/admin/action"
    ])).toEqual(["https://cdn.example/image.jpg"]);
  });

  it("refuses to activate a new worker when a required build asset is unavailable", async () => {
    const { cache, precacheAppShell } = loadPrecacheHandler((url) => {
      if (url.endsWith("/index.html")) {
        return new Response('<script src="/assets/app.js"></script>', {
          headers: { "content-type": "text/html" },
          status: 200
        });
      }
      if (url.endsWith("/assets/app.js")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response("optional", { status: 200 });
    });

    await expect(precacheAppShell()).rejects.toThrow(
      "Unable to cache application asset: /assets/app.js"
    );
    expect(cache.put).not.toHaveBeenCalledWith("/index.html", expect.any(Response));
    expect(cache.put).not.toHaveBeenCalledWith("/", expect.any(Response));
  });

  it("keeps optional icons from blocking an otherwise complete app shell", async () => {
    const { cache, precacheAppShell } = loadPrecacheHandler((url) => {
      if (url.endsWith("/index.html")) {
        return new Response('<link href="/assets/app.css" rel="stylesheet">', {
          headers: { "content-type": "text/html" },
          status: 200
        });
      }
      if (url.endsWith("/assets/app.css")) {
        return new Response("body {}", { status: 200 });
      }
      throw new TypeError("optional asset unavailable");
    });

    await expect(precacheAppShell()).resolves.toBeUndefined();
    expect(cache.put).toHaveBeenCalledWith("/assets/app.css", expect.any(Response));
  });

  it("caches lazy build chunks declared for offline settings", async () => {
    const { cache, precacheAppShell } = loadPrecacheHandler((url) => {
      if (url.endsWith("/index.html")) {
        return new Response('<link rel="dibao-offline" href="/assets/SettingsWorkspace-hash.js">', {
          headers: { "content-type": "text/html" }
        });
      }
      return new Response("asset");
    });
    await precacheAppShell();
    expect(cache.put.mock.calls.map(([key]) => key).indexOf("/assets/SettingsWorkspace-hash.js"))
      .toBeLessThan(cache.put.mock.calls.map(([key]) => key).indexOf("/index.html"));
  });

  it("stops in-flight image downloads from restoring a cleared scope", async () => {
    let release!: (response: Response) => void;
    const delayedResponse = new Promise<Response>((resolve) => { release = resolve; });
    const worker = loadImageWorker({ fetch: async () => delayedResponse });
    const pending = worker.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL, `${IMAGE_URL}?two`] });
    await vi.waitFor(() => expect(worker.fetch).toHaveBeenCalledTimes(1));
    worker.authorization.profile!.cacheGeneration = "new-generation";
    await worker.message("CLEAR_ARTICLE_IMAGES");
    release(new Response("image"));
    await pending;
    expect(worker.put).not.toHaveBeenCalled();
    expect(worker.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects late cache, prune and scope messages after clear acknowledgement", async () => {
    const worker = loadImageWorker();
    await worker.message("SET_OFFLINE_SCOPE", {}, "old-tab");
    await worker.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL] });
    worker.authorization.profile!.cacheGeneration = "new-generation";
    const ack = vi.fn();
    await worker.message("CLEAR_ARTICLE_IMAGES", {}, "clearing-tab", ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(worker.bindings.size).toBe(0);
    worker.fetch.mockClear();
    worker.caches.open.mockClear();
    await worker.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL] }, "old-tab");
    await worker.message("PRUNE_ARTICLE_IMAGES", { urls: [] }, "old-tab");
    await worker.message("SET_OFFLINE_SCOPE", {}, "old-tab");
    expect(worker.bindings.size).toBe(0);
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(worker.caches.open).not.toHaveBeenCalled();
    expect(worker.cacheNames()).toEqual([]);
  });

  it.each(["revoked", "disabled", "deleted", "rotated"] as const)(
    "checks durable %s authorization after worker restart", async (reason) => {
      const worker = loadImageWorker();
      await worker.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL] });
      if (reason === "revoked") worker.authorization.revoked = true;
      if (reason === "disabled") worker.authorization.profile!.deviceSettings.enabled = false;
      if (reason === "deleted") worker.authorization.profile = undefined;
      if (reason === "rotated") worker.authorization.profile!.cacheGeneration = "new-generation";
      const restarted = loadImageWorker({ authorization: worker.authorization, storage: worker.storage });
      await restarted.message("SET_OFFLINE_SCOPE");
      await restarted.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL] });
      expect(restarted.bindings.size).toBe(0);
      expect(restarted.fetch).not.toHaveBeenCalled();
      expect(restarted.caches.open).not.toHaveBeenCalled();
    }
  );

  it("does not serve existing cached images after durable revocation", async () => {
    const worker = loadImageWorker();
    await worker.message("SET_OFFLINE_SCOPE");
    await worker.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL] });
    worker.authorization.revoked = true;
    expect((await worker.image())?.status).toBe(204);
    expect(worker.fetch).toHaveBeenCalledTimes(1);
  });

  it("allows current generations and follows normal generation changes for bound clients", async () => {
    const worker = loadImageWorker();
    await worker.message("SET_OFFLINE_SCOPE");
    await worker.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL] });
    worker.authorization.profile!.cacheGeneration = "new-generation";
    expect(await (await worker.image())?.text()).toBe("image");
    await worker.message("SET_OFFLINE_SCOPE", { cacheGeneration: "new-generation" }, "new-tab");
    expect(worker.bindings.size).toBe(2);
    await worker.message("CACHE_ARTICLE_IMAGES", { cacheGeneration: "new-generation", urls: [`${IMAGE_URL}?new`] });
    expect(worker.put).toHaveBeenCalledTimes(2);
  });

  it("allows explicit legacy null generations but rejects generationless old messages", async () => {
    const worker = loadImageWorker();
    delete worker.authorization.profile!.cacheGeneration;
    await worker.message("SET_OFFLINE_SCOPE", { cacheGeneration: undefined });
    expect(worker.bindings.size).toBe(0);
    await worker.message("SET_OFFLINE_SCOPE", { cacheGeneration: null });
    expect(worker.bindings.size).toBe(1);
    await worker.message("SET_OFFLINE_SCOPE", { scopeKey: null, cacheGeneration: null });
    expect(worker.bindings.size).toBe(0);
  });

  it("never exposes an unverified stale SET binding to a concurrent image fetch", async () => {
    const worker = loadImageWorker();
    await worker.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL] });
    worker.authorization.profile!.cacheGeneration = "new-generation";
    let release!: (databases: Array<{ name: string }>) => void;
    worker.indexedDB.databases.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const setting = worker.message("SET_OFFLINE_SCOPE");
    expect(worker.bindings.size).toBe(0);
    expect(await worker.image()).toBeUndefined();
    release([{ name: "dibao-offline-reading" }]);
    await setting;
    expect(worker.bindings.size).toBe(0);
    expect(worker.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["unset", "replace", "clear"])("does not let a slow authorized SET override a newer %s", async (action) => {
    const worker = loadImageWorker();
    let release!: (databases: Array<{ name: string }>) => void;
    worker.indexedDB.databases.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const setting = worker.message("SET_OFFLINE_SCOPE");
    if (action === "clear") await worker.message("CLEAR_ARTICLE_IMAGES");
    else await worker.message("SET_OFFLINE_SCOPE", action === "unset"
      ? { scopeKey: null } : { cacheGeneration: "invalid-generation" });
    release([{ name: "dibao-offline-reading" }]);
    await setting;
    expect(worker.bindings.size).toBe(0);
  });

  it("waits for an in-progress cache put before acknowledging clear", async () => {
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { release = resolve; });
    const worker = loadImageWorker({ put: async () => writing });
    const pending = worker.message("CACHE_ARTICLE_IMAGES", { urls: [IMAGE_URL] });
    await vi.waitFor(() => expect(worker.put).toHaveBeenCalledTimes(1));
    worker.authorization.profile!.cacheGeneration = "new-generation";
    const ack = vi.fn();
    const clearing = worker.message("CLEAR_ARTICLE_IMAGES", {}, "tab", ack);
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled();
    release();
    await Promise.all([pending, clearing]);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(worker.cacheNames()).toEqual([]);
  });

  it("never opens an absent database and aborts creation during an inventory race", async () => {
    const worker = loadImageWorker();
    worker.authorization.databaseExists = false;
    await worker.message("SET_OFFLINE_SCOPE");
    expect(worker.indexedDB.open).not.toHaveBeenCalled();
    worker.authorization.inventoryExists = true;
    await worker.message("SET_OFFLINE_SCOPE");
    expect(worker.abortCreation).toHaveBeenCalledTimes(1);
    expect(worker.authorization.databaseExists).toBe(false);
    expect(worker.bindings.size).toBe(0);
  });

  it("does not acknowledge successful clearing when cache deletion fails", async () => {
    const worker = loadImageWorker();
    worker.caches.delete.mockRejectedValueOnce(new Error("storage failure"));
    const ack = vi.fn();
    await worker.message("CLEAR_ARTICLE_IMAGES", {}, "tab", ack);
    expect(ack).toHaveBeenCalledWith({ ok: false });
  });

  it("falls back to the cached app shell for server-side navigation failures", async () => {
    const cachedShell = new Response("cached app shell", {
      headers: { "content-type": "text/html" },
      status: 200
    });
    const { cache, networkFirstNavigation } = loadNavigationHandler({
      cachedShell,
      networkResponse: new Response("Bad gateway", { status: 502 })
    });

    const response = await networkFirstNavigation(
      new Request("https://dibao.test/?view=recommended")
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("cached app shell");
    expect(cache.match).toHaveBeenCalledWith("/index.html");
  });

  it("falls back to the cached app shell when navigation stalls", async () => {
    vi.useFakeTimers();
    try {
      const cachedShell = new Response("cached after timeout", {
        headers: { "content-type": "text/html" },
        status: 200
      });
      const { networkFirstNavigation } = loadNavigationHandler({
        cachedShell,
        networkResponse: new Response("unused"),
        networkFetch: (_request, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        })
      });

      const responsePromise = networkFirstNavigation(
        new Request("https://dibao.test/?view=recommended")
      );
      await vi.advanceTimersByTimeAsync(8_000);

      const response = await responsePromise;
      expect(await response.text()).toBe("cached after timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores successful navigation HTML only under fixed shell keys", async () => {
    const { cache, networkFirstNavigation } = loadNavigationHandler({
      cachedShell: new Response("cached", { status: 200 }),
      networkResponse: new Response("fresh shell", {
        headers: { "content-type": "text/html" },
        status: 200
      })
    });

    await networkFirstNavigation(
      new Request("https://dibao.test/?q=private-search&view=search")
    );

    expect(cache.put).toHaveBeenCalledWith("/index.html", expect.any(Response));
    expect(cache.put).toHaveBeenCalledWith("/", expect.any(Response));
    expect(cache.put.mock.calls.every(([key]) => typeof key === "string")).toBe(true);
  });

  it.each([503, 200])("preserves the last complete shell when a new script returns HTTP %s with HTML", async (status) => {
    const { cache, networkFirstNavigation } = loadNavigationHandler({
      cachedShell: new Response("previous working shell", { status: 200 }),
      networkResponse: new Response("unused"),
      networkFetch: async (request) => request.url.includes("/assets/")
        ? new Response("gateway or SPA fallback", { status, headers: { "content-type": "text/html" } })
        : new Response('<script src="/assets/new.js"></script>', {
            headers: { "content-type": "text/html" }
          })
    });

    const response = await networkFirstNavigation(new Request("https://dibao.test/"));

    expect(await response.text()).toBe("previous working shell");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("publishes updated navigation only after its required script is cached", async () => {
    const { cache, networkFirstNavigation } = loadNavigationHandler({
      cachedShell: new Response("old shell"),
      networkResponse: new Response("unused"),
      networkFetch: async (request) => request.url.includes("/assets/")
        ? new Response("console.log('ready')", { headers: { "content-type": "text/javascript" } })
        : new Response('<script src="/assets/new.js"></script>', {
            headers: { "content-type": "text/html" }
          })
    });
    await networkFirstNavigation(new Request("https://dibao.test/"));
    expect(cache.put.mock.calls.map(([key]) => key)).toEqual([
      "/assets/new.js", "/index.html", "/"
    ]);
  });

  it("uses the previous shell if a required script download stalls", async () => {
    vi.useFakeTimers();
    try {
      const { cache, networkFirstNavigation } = loadNavigationHandler({
        cachedShell: new Response("previous working shell"),
        networkResponse: new Response("unused"),
        networkFetch: async (request, init) => {
          if (!request.url.includes("/assets/")) {
            return new Response('<script src="/assets/new.js"></script>', {
              headers: { "content-type": "text/html" }
            });
          }
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
      });
      const pending = networkFirstNavigation(new Request("https://dibao.test/"));
      await vi.advanceTimersByTimeAsync(8_100);
      expect(await (await pending).text()).toBe("previous working shell");
      expect(cache.put).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hide client-side navigation errors behind the cached app shell", async () => {
    const networkResponse = new Response("Not found", { status: 404 });
    const { cache, networkFirstNavigation } = loadNavigationHandler({
      cachedShell: new Response("cached app shell", { status: 200 }),
      networkResponse
    });

    const response = await networkFirstNavigation(
      new Request("https://dibao.test/missing")
    );

    expect(response).toBe(networkResponse);
    expect(cache.match).not.toHaveBeenCalled();
  });

  it("never replaces the cached app shell with a non-HTML navigation response", async () => {
    const networkResponse = new Response("<svg></svg>", {
      headers: { "content-type": "image/svg+xml" },
      status: 200
    });
    const { cache, networkFirstNavigation } = loadNavigationHandler({
      cachedShell: new Response("cached app shell", {
        headers: { "content-type": "text/html" },
        status: 200
      }),
      networkResponse
    });

    const response = await networkFirstNavigation(
      new Request("https://dibao.test/logo.svg")
    );

    expect(response).toBe(networkResponse);
    expect(cache.put).not.toHaveBeenCalled();
  });
});

const IMAGE_URL = "https://cdn.example/image.png";
type ImageAuthorizationFixture = {
  profile?: { deviceSettings: { enabled: boolean }; cacheGeneration?: string };
  revoked?: boolean;
  databaseExists: boolean;
  inventoryExists?: boolean;
};

function loadImageWorker(options: {
  authorization?: ImageAuthorizationFixture;
  storage?: Map<string, Map<string, Response>>;
  fetch?: () => Promise<Response>;
  put?: () => Promise<void>;
} = {}) {
  const authorization = options.authorization ?? {
    profile: { deviceSettings: { enabled: true }, cacheGeneration: "generation" }, databaseExists: true
  };
  const storage = options.storage ?? new Map<string, Map<string, Response>>();
  const put = vi.fn(async () => { await options.put?.(); });
  const caches = {
    open: vi.fn(async (name: string) => {
      const entries = storage.get(name) ?? new Map<string, Response>();
      storage.set(name, entries);
      return {
        put: async (request: Request, response: Response) => { await put(); entries.set(request.url, response.clone()); },
        match: async (request: Request) => entries.get(request.url)?.clone(),
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
        delete: async (request: Request) => entries.delete(request.url)
      };
    }),
    delete: vi.fn(async (name: string) => storage.delete(name))
  };
  const abortCreation = vi.fn();
  const indexedDB = {
    databases: vi.fn(async () => authorization.inventoryExists ?? authorization.databaseExists
      ? [{ name: "dibao-offline-reading" }] : []),
    open: vi.fn(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (!authorization.databaseExists) {
          Object.assign(request, { transaction: { abort: () => {
            abortCreation(); queueMicrotask(() => request.onerror?.({} as Event));
          } } });
          request.onupgradeneeded?.({} as IDBVersionChangeEvent);
          return;
        }
        Object.assign(request, { result: {
          close: vi.fn(),
          transaction: () => {
            const transaction = {
              objectStore: (name: string) => ({ get: (key: string) => ({ result: structuredClone(
                name === "profiles" ? authorization.profile :
                  key === "offline-reading:revoked-scope:v1:scope" && authorization.revoked ? { value: "1" } : undefined
              ) }) }),
              oncomplete: null as (() => void) | null
            };
            queueMicrotask(() => transaction.oncomplete?.());
            return transaction;
          }
        } });
        request.onsuccess?.({} as Event);
      });
      return request;
    })
  };
  type WorkerEvent = {
    data?: Record<string, unknown>; source?: { id: string }; ports?: Array<{ postMessage: (value: unknown) => void }>;
    request?: Request; clientId?: string;
    waitUntil?: (promise: Promise<unknown>) => void; respondWith?: (promise: Promise<Response>) => void;
  };
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const fetch = vi.fn(options.fetch ?? (async () => new Response("image")));
  const context = {
    AbortController, clearTimeout, setTimeout, Map, Set, URL, Request, Response,
    encodeURIComponent, fetch, caches, indexedDB,
    self: { addEventListener: (name: string, handler: (event: WorkerEvent) => void) => listeners.set(name, handler),
      location: { origin: "https://dibao.test" } }
  };
  runInNewContext(readFileSync(resolve("public/sw.js"), "utf8") + "\nthis.bindings = imageScopesByClientId;", context);
  return {
    authorization, storage, put, fetch, caches, indexedDB, abortCreation,
    bindings: (context as typeof context & { bindings: Map<string, unknown> }).bindings,
    cacheNames: () => [...storage.keys()],
    message: async (type: string, extra: Record<string, unknown> = {}, clientId = "tab", ack = vi.fn()) => {
      let pending: Promise<unknown> | undefined;
      listeners.get("message")!({ data: { type, scopeKey: "scope", cacheGeneration: "generation", ...extra },
        source: { id: clientId }, ports: [{ postMessage: ack }], waitUntil: (promise) => { pending = promise; } });
      await pending;
    },
    image: async (clientId = "tab") => {
      const request = new Request(IMAGE_URL);
      Object.defineProperty(request, "destination", { value: "image" });
      let response: Promise<Response> | undefined;
      listeners.get("fetch")!({ request, clientId, respondWith: (promise) => { response = promise; } });
      return response;
    }
  };
}

function loadNavigationHandler(input: {
  cachedShell: Response;
  networkResponse: Response;
  networkFetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}): {
  cache: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  networkFirstNavigation: (request: Request) => Promise<Response>;
} {
  const source = readFileSync(resolve("public/sw.js"), "utf8");
  const cache = {
    match: vi.fn(async (request: Request | string) =>
      request === "/index.html" ? input.cachedShell : undefined
    ),
    put: vi.fn()
  };
  const context = {
    AbortController,
    clearTimeout,
    Map,
    Promise,
    Request,
    Response,
    Set,
    URL,
    caches: {
      open: vi.fn(async () => cache)
    },
    encodeURIComponent,
    fetch: vi.fn(async (request: Request, init?: RequestInit) =>
      input.networkFetch ? input.networkFetch(request, init) : input.networkResponse
    ),
    setTimeout,
    self: {
      addEventListener: vi.fn(),
      location: { origin: "https://dibao.test" }
    }
  } as Record<string, unknown>;

  runInNewContext(source, context);

  return {
    cache,
    networkFirstNavigation: context.networkFirstNavigation as (
      request: Request
    ) => Promise<Response>
  };
}

function loadPrecacheHandler(
  fetchResponse: (url: string) => Response
): {
  cache: { put: ReturnType<typeof vi.fn> };
  precacheAppShell: () => Promise<void>;
} {
  const source = readFileSync(resolve("public/sw.js"), "utf8");
  const cache = {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined)
  };
  class ServiceWorkerRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string"
          ? new URL(input, "https://dibao.test")
          : input,
        init
      );
    }
  }
  const context = {
    AbortController,
    clearTimeout,
    setTimeout,
    Map,
    Promise,
    Request: ServiceWorkerRequest,
    Response,
    Set,
    URL,
    caches: {
      open: vi.fn(async () => cache)
    },
    encodeURIComponent,
    fetch: vi.fn(async (request: Request) => fetchResponse(request.url)),
    self: {
      addEventListener: vi.fn(),
      location: { origin: "https://dibao.test" }
    }
  } as Record<string, unknown>;

  runInNewContext(source, context);

  return {
    cache,
    precacheAppShell: context.precacheAppShell as () => Promise<void>
  };
}

function loadServiceWorkerFunction<T extends (...args: never[]) => unknown>(name: string): T {
  const source = readFileSync(resolve("public/sw.js"), "utf8");
  const context = {
    Map,
    Set,
    URL,
    decodeURIComponent,
    encodeURIComponent,
    self: {
      addEventListener: vi.fn(),
      location: { origin: "https://dibao.test" }
    }
  } as Record<string, unknown>;

  runInNewContext(source, context);
  return context[name] as T;
}
