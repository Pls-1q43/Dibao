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
    expect(source).toContain('CACHE_VERSION = "dibao-pwa-v13"');
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
    expect(cache.put).toHaveBeenCalledWith("/index.html", expect.any(Response));
    expect(cache.put).toHaveBeenCalledWith("/", expect.any(Response));
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
