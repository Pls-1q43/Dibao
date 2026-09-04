const CACHE_VERSION = "dibao-pwa-v10";
const APP_SHELL_CACHE = `${CACHE_VERSION}:app-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}:runtime`;
const ARTICLE_IMAGE_CACHE_PREFIX = "dibao:article-images:v1:";
const ARTICLE_IMAGE_TRIM_COUNT = 24;
const imageScopesByClientId = new Map();

const PUBLIC_ICON_URLS = [
  "/logo.svg",
  "/logo-16.png",
  "/logo-32.png",
  "/logo-48.png",
  "/logo-64.png",
  "/logo-192.png",
  "/logo-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico"
];

const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/site.webmanifest",
  ...PUBLIC_ICON_URLS
];

const STATIC_PATHS = new Set([
  "/site.webmanifest",
  ...PUBLIC_ICON_URLS
]);

self.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter(
              (cacheName) =>
                !cacheName.startsWith(CACHE_VERSION) &&
                !cacheName.startsWith(ARTICLE_IMAGE_CACHE_PREFIX)
            )
            .map((cacheName) => caches.delete(cacheName))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message && message.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (message && message.type === "SET_OFFLINE_SCOPE") {
    const clientId = event.source?.id;
    if (clientId) {
      if (validScopeKey(message.scopeKey)) {
        imageScopesByClientId.set(clientId, message.scopeKey);
      } else {
        imageScopesByClientId.delete(clientId);
      }
    }
    return;
  }
  if (message && message.type === "CACHE_ARTICLE_IMAGES" && validScopeKey(message.scopeKey)) {
    event.waitUntil(cacheArticleImages(message.scopeKey, validHttpUrls(message.urls)));
    return;
  }
  if (message && message.type === "PRUNE_ARTICLE_IMAGES" && validScopeKey(message.scopeKey)) {
    event.waitUntil(pruneArticleImages(message.scopeKey, validHttpUrls(message.urls)));
    return;
  }
  if (message && message.type === "CLEAR_ARTICLE_IMAGES" && validScopeKey(message.scopeKey)) {
    event.waitUntil(
      caches.delete(articleImageCacheName(message.scopeKey)).finally(() => {
        event.ports[0]?.postMessage({ ok: true });
      })
    );
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(request.url);
  const imageScope = imageScopesByClientId.get(event.clientId);
  if (request.destination === "image" && imageScope) {
    event.respondWith(articleImageCacheFirst(request, imageScope));
    return;
  }
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isStaticAsset(requestUrl.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function precacheAppShell() {
  const cache = await caches.open(APP_SHELL_CACHE);

  await Promise.all(
    APP_SHELL_URLS.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: "reload" }));
        if (response.ok) {
          await cache.put(url, response.clone());
          if (isHtmlResponse(response)) {
            const html = await response.clone().text();
            await cacheDiscoveredStaticAssets(cache, html);
          }
        }
      } catch {
        // Missing optional public assets must not abort service worker install.
      }
    })
  );
}

async function cacheArticleImages(scopeKey, urls) {
  if (urls.length === 0) return;
  const cache = await caches.open(articleImageCacheName(scopeKey));
  for (const url of urls) {
    const request = new Request(url, { mode: "no-cors", credentials: "omit" });
    try {
      const response = await fetch(request);
      if (isCacheableImageResponse(response)) {
        await putArticleImageWithTrim(cache, request, response);
      }
    } catch {
      // Article images are best effort and never block the text snapshot.
    }
  }
}

async function pruneArticleImages(scopeKey, urls) {
  const cache = await caches.open(articleImageCacheName(scopeKey));
  const retained = new Set(urls);
  const keys = await cache.keys();
  await Promise.all(keys.filter((request) => !retained.has(request.url)).map((request) => cache.delete(request)));
}

async function articleImageCacheFirst(request, scopeKey) {
  const cache = await caches.open(articleImageCacheName(scopeKey));
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (isCacheableImageResponse(response)) {
      await putArticleImageWithTrim(cache, request, response.clone());
    }
    return response;
  } catch {
    return new Response(null, { status: 204, statusText: "Offline image unavailable" });
  }
}

async function putArticleImageWithTrim(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch {
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, ARTICLE_IMAGE_TRIM_COUNT).map((key) => cache.delete(key)));
    try {
      await cache.put(request, response);
    } catch {
      // Storage pressure may still reject the image; structured article data has priority.
    }
  }
}

function articleImageCacheName(scopeKey) {
  return `${ARTICLE_IMAGE_CACHE_PREFIX}${encodeURIComponent(scopeKey)}`;
}

function isCacheableImageResponse(response) {
  return response.ok || response.type === "opaque";
}

function validScopeKey(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function validHttpUrls(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((item) => {
    if (typeof item !== "string") return [];
    try {
      const url = new URL(item);
      return url.protocol === "http:" || url.protocol === "https:" ? [url.href] : [];
    } catch {
      return [];
    }
  })));
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(APP_SHELL_CACHE);

  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      await cache.put("/index.html", response.clone());
      if (isHtmlResponse(response)) {
        const html = await response.clone().text();
        await cacheDiscoveredStaticAssets(cache, html);
      }
    }
    if (response.status >= 500) {
      return (await cachedNavigationResponse(cache, request)) ?? response;
    }
    return response;
  } catch {
    return (await cachedNavigationResponse(cache, request)) ?? Response.error();
  }
}

async function cachedNavigationResponse(cache, request) {
  return (await cache.match(request)) ?? (await cache.match("/index.html"));
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cachedResponse = await caches.match(request);

  const freshResponsePromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cachedResponse ?? (await freshResponsePromise) ?? Response.error();
}

function isStaticAsset(pathname) {
  return pathname.startsWith("/assets/") || STATIC_PATHS.has(pathname);
}

function isHtmlResponse(response) {
  return response.headers.get("content-type")?.includes("text/html") ?? false;
}

async function cacheDiscoveredStaticAssets(cache, html) {
  const urls = new Set();
  const attributePattern = /\b(?:href|src)=["']([^"']+)["']/g;

  for (const match of html.matchAll(attributePattern)) {
    const url = new URL(match[1], self.location.origin);
    if (url.origin === self.location.origin && isStaticAsset(url.pathname)) {
      urls.add(url.pathname);
    }
  }

  await Promise.all(
    Array.from(urls).map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: "reload" }));
        if (response.ok) {
          await cache.put(url, response);
        }
      } catch {
        // Runtime build asset caching is best effort; navigation fallback still works.
      }
    })
  );
}
