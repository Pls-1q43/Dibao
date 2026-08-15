import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    const waitingWorker = {
      postMessage: vi.fn()
    };
    const registration = {
      addEventListener: registrationTarget.addEventListener,
      get installing() {
        return installingWorker;
      },
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
    const waitingWorker = {
      postMessage: vi.fn()
    };
    const registration = {
      addEventListener: registrationTarget.addEventListener,
      get installing() {
        return installingWorker;
      },
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
    registrationTarget.dispatch("updatefound");
    installingWorker.state = "installed";
    installingTarget.dispatch("statechange");

    const applyUpdate = onUpdateAvailable.mock.calls[0][0] as () => void;
    applyUpdate();
    browser.dispatchControllerChange();
    browser.dispatchControllerChange();

    expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(browser.reload).toHaveBeenCalledTimes(1);
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
  });
});
