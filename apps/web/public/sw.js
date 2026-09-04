const CACHE_VERSION = "dibao-pwa-v12";
const APP_SHELL_CACHE = `${CACHE_VERSION}:app-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}:runtime`;
const ARTICLE_IMAGE_CACHE_PREFIX = "dibao:article-images:v1:";
const ARTICLE_IMAGE_TRIM_COUNT = 24;
const MAX_ARTICLE_IMAGE_URLS_PER_MESSAGE = 4_000;
const ARTICLE_IMAGE_FETCH_TIMEOUT_MS = 10_000;
const NAVIGATION_FETCH_TIMEOUT_MS = 8_000;
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

const OPTIONAL_APP_SHELL_URLS = [
  "/site.webmanifest",
  ...PUBLIC_ICON_URLS
];

const STATIC_PATHS = new Set([
  "/site.webmanifest",
  ...PUBLIC_ICON_URLS
]);

self.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell());
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
  if (
    requestUrl.origin === self.location.origin &&
    isApiPathname(requestUrl.pathname)
  ) {
    return;
  }

  const imageScope = imageScopesByClientId.get(event.clientId);
  if (request.destination === "image" && imageScope && isSafeArticleImageUrl(requestUrl)) {
    event.respondWith(articleImageCacheFirst(request, imageScope));
    return;
  }
  if (requestUrl.origin !== self.location.origin) {
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
  const shellResponse = await fetch(new Request("/index.html", { cache: "reload" }));
  if (!shellResponse.ok || !isHtmlResponse(shellResponse)) {
    throw new Error("Unable to cache the Dibao application shell");
  }

  await cache.put("/index.html", shellResponse.clone());
  await cache.put("/", shellResponse.clone());
  await cacheDiscoveredStaticAssets(cache, await shellResponse.text(), true);

  await Promise.all(OPTIONAL_APP_SHELL_URLS.map(async (url) => {
    try {
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (response.ok) {
        await cache.put(url, response);
      }
    } catch {
      // Missing icons and manifest metadata must not abort an otherwise usable app shell.
    }
  }));
}

async function cacheArticleImages(scopeKey, urls) {
  if (urls.length === 0) return;
  const cache = await caches.open(articleImageCacheName(scopeKey));
  for (const url of urls) {
    const request = new Request(url, {
      mode: "no-cors",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    });
    try {
      const response = await fetchWithTimeout(request, ARTICLE_IMAGE_FETCH_TIMEOUT_MS);
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
    const response = await fetchWithTimeout(request, ARTICLE_IMAGE_FETCH_TIMEOUT_MS);
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
  const urls = new Set();
  for (const item of value) {
    if (urls.size >= MAX_ARTICLE_IMAGE_URLS_PER_MESSAGE) break;
    if (typeof item !== "string") continue;
    try {
      const url = new URL(item);
      if (
        isSafeArticleImageUrl(url) &&
        !(url.origin === self.location.origin && isApiPathname(url.pathname))
      ) {
        url.hash = "";
        urls.add(url.href);
      }
    } catch {
      // Ignore malformed image URLs from article content.
    }
  }
  return Array.from(urls);
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(APP_SHELL_CACHE);

  try {
    const response = await fetchWithTimeout(request, NAVIGATION_FETCH_TIMEOUT_MS);
    if (response.ok && isHtmlResponse(response)) {
      await cache.put("/index.html", response.clone());
      await cache.put("/", response.clone());
      const html = await response.clone().text();
      await cacheDiscoveredStaticAssets(cache, html);
    }
    if (response.status >= 500) {
      return (await cachedNavigationResponse(cache)) ?? response;
    }
    return response;
  } catch {
    return (await cachedNavigationResponse(cache)) ?? Response.error();
  }
}

async function cachedNavigationResponse(cache) {
  return (await cache.match("/index.html")) ?? (await cache.match("/"));
}

async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort();
  if (request.signal?.aborted) {
    controller.abort();
  } else {
    request.signal?.addEventListener("abort", abortFromRequest, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromRequest);
  }
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

function isSafeArticleImageUrl(url) {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (!hostname || hostname.includes(":")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) return false;
  return !(
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".home.arpa")
  );
}

function isApiPathname(pathname) {
  try {
    const decodedPathname = decodeURIComponent(pathname);
    return decodedPathname === "/api" || decodedPathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function isHtmlResponse(response) {
  return response.headers.get("content-type")?.includes("text/html") ?? false;
}

async function cacheDiscoveredStaticAssets(cache, html, required = false) {
  const urls = new Set();
  const attributePattern = /\b(?:href|src)=["']([^"']+)["']/g;

  for (const match of html.matchAll(attributePattern)) {
    const url = new URL(match[1], self.location.origin);
    if (url.origin === self.location.origin && isStaticAsset(url.pathname)) {
      urls.add(url.pathname);
    }
  }

  const cacheAsset = async (url) => {
    const response = await fetch(new Request(url, { cache: "reload" }));
    if (!response.ok) {
      throw new Error(`Unable to cache application asset: ${url}`);
    }
    await cache.put(url, response);
  };

  if (required) {
    await Promise.all(Array.from(urls).map(cacheAsset));
    return;
  }

  await Promise.all(Array.from(urls).map(async (url) => {
    try {
      await cacheAsset(url);
    } catch {
      // Runtime refresh is best effort after a complete shell has already been installed.
    }
  }));
}
