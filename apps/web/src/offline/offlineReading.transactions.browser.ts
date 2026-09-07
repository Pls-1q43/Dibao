import * as offline from "./offlineReading.js";
import type { ArticleActionRequest, ArticleDetail, ArticleState, OfflineManifest } from "../api.js";
import { ApiRequestError } from "../api.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const initial: ArticleState = {
  read: false, favorited: false, liked: false, readLater: false, hidden: false,
  notInterested: false, readingProgress: 0, interactionStatus: "unseen",
  openedAt: null, ignoredAt: null
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function records<T>(store: string): Promise<T[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("dibao-offline-reading", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store);
      const request = tx.objectStore(store).getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function actions() {
  return (await records<offline.OfflineActionRecord>("actions"))
    .sort((a, b) => a.sequence - b.sequence);
}

async function setup() {
  const profile = await offline.rememberOfflineSession("transaction-test");
  const scope = profile.scopeKey;
  await offline.setOfflineReadingEnabled(scope, true);
  const detail = (id: string): ArticleDetail => ({
    id, title: id, summary: "body", contentText: "body", contentHtml: null,
    state: { ...initial }, feedId: "feed", discoveredAt: new Date().toISOString(),
    publishedAt: null, url: "https://example.com/article"
  } as ArticleDetail);
  const manifest = (id = "first", count = 2): OfflineManifest => ({
    snapshotId: id, generatedAt: new Date().toISOString(), rankContext: "test",
    recommendedTarget: 200, readLater: [], recent: [],
    recommended: Array.from({ length: count }, (_, index) => ({
      article: detail(String(index)), contentRevision: id, position: index,
      favoritedAt: null, readLaterAt: null, openedAt: null
    }))
  });
  const refresh = (value = manifest()) => offline.refreshOfflineSnapshot(scope, {
    getOfflineManifest: async () => value,
    getOfflineArticles: async (ids) => ids.map(detail)
  });
  await refresh();
  const queue = (request: ArticleActionRequest, patch: Partial<ArticleState> = {}, articleId = "0") =>
    offline.queueOfflineArticleAction({ scopeKey: scope, articleId, request, state: { ...initial, ...patch } });
  return { scope, queue, refresh, manifest, detail };
}

export const scenarios: Record<string, () => Promise<void>> = {
  async unregisteredWorkerCleanup() {
    check(Boolean(navigator.serviceWorker), "test must use real Service Worker support");
    check(navigator.serviceWorker.controller === null &&
      (await navigator.serviceWorker.getRegistrations()).length === 0, "test requires no registration");
    const { scope } = await setup();
    const cacheName = `dibao:article-images:v1:${encodeURIComponent(scope)}`;
    const cache = await caches.open(cacheName);
    await cache.put("https://example.com/orphan.png", new Response("cached image"));
    await offline.markOfflineScopeRevoked(scope);
    let timer: number | undefined;
    try {
      await Promise.race([
        offline.clearOfflineScope(scope),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("cleanup hung on unregistered serviceWorker.ready")), 2_300);
        })
      ]);
    } finally { window.clearTimeout(timer); }
    check(await offline.isOfflineScopeRevoked(scope), "cleanup lost revocation");
    check((await records("profiles")).length === 0 && (await records("articles")).length === 0,
      "cleanup retained offline data");
    check(!(await caches.has(cacheName)), "unregistered worker left orphan image cache");
    await offline.clearOfflineScopeRevocation(scope);
    check(Boolean(await offline.rememberOfflineSession("transaction-test")), "explicit login remained blocked after cleanup");
  },
  async missingArticleSettlement() {
    const { queue, scope, refresh, manifest } = await setup();
    const next = manifest("missing");
    next.readLater = [next.recommended[0]!];
    next.recent = [next.recommended[0]!];
    await refresh(next);
    await queue({ type: "read_later", value: true });
    await offline.syncOfflineArticleActions(scope, {
      postArticleAction: async () => { throw new ApiRequestError(404, "ARTICLE_NOT_FOUND", "missing"); }
    });
    check(await offline.getOfflineArticleDetail(scope, "0") === null, "404 retained article body");
    check((await actions()).length === 0, "404 retained acknowledged action");
    for (const snapshot of await records<offline.OfflineSnapshotRecord>("snapshots")) {
      check([...snapshot.recommended, ...snapshot.readLater, ...snapshot.recent]
        .every((ref) => ref.article.id !== "0"), "404 retained snapshot reference");
    }
    const summary = await offline.getOfflineCacheSummary(scope);
    check(summary.availableCount === 1 && summary.recommendedCount === 1 &&
      summary.readLaterCount === 0 && summary.recentCount === 0, "404 inflated cache counts");
    const list = await offline.listOfflineArticles(scope, { view: "recommended" });
    check(list.data.length === 1 && list.data[0]?.id === "1", "404 corrupted surviving snapshot order");
  },
  async workerGeneration() {
    const { scope, refresh, manifest, detail } = await setup();
    const messages: Array<{ type: string; scopeKey: string | null; cacheGeneration: string | null }> = [];
    const worker = { postMessage(message: (typeof messages)[number], ports?: MessagePort[]) {
      messages.push(message);
      ports?.[0]?.postMessage({ ok: true });
    } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      controller: worker, ready: Promise.resolve({ active: worker })
    } });
    const value = manifest("images");
    await offline.refreshOfflineSnapshot(scope, {
      getOfflineManifest: async () => value,
      getOfflineArticles: async (ids) => ids.map((id) => ({ ...detail(id), contentHtml: '<img src="https://example.com/image.png">' }))
    });
    const generation = (await offline.readOfflineProfile(scope))?.cacheGeneration;
    const cached = messages.find((message) => message.type === "CACHE_ARTICLE_IMAGES");
    check(cached?.cacheGeneration === generation && Boolean(generation), "CACHE missing committed generation");
    check(messages.some((message) => message.type === "PRUNE_ARTICLE_IMAGES" && message.cacheGeneration === generation), "PRUNE missing generation");
    await offline.setOfflineReadingEnabled(scope, false);
    const clear = messages.find((message) => message.type === "CLEAR_ARTICLE_IMAGES");
    check(clear?.cacheGeneration !== generation && clear?.cacheGeneration === (await offline.readOfflineProfile(scope))?.cacheGeneration, "CLEAR did not carry invalidated generation");
    check(messages.some((message) => message.type === "SET_OFFLINE_SCOPE" && message.scopeKey === null && message.cacheGeneration === null), "disabled binding was not cleared");
  },
  async stateSemantics() {
    const { queue, scope } = await setup();
    await queue({ type: "mark_read", value: true });
    await queue({ type: "mark_read", value: false });
    check((await offline.getOfflineArticleDetail(scope, "0"))?.state.interactionStatus === "seen", "explicit unread is not unseen");
    await queue({ type: "favorite", value: true });
    await queue({ type: "mark_read", value: false });
    check((await offline.getOfflineArticleDetail(scope, "0"))?.state.interactionStatus === "saved", "unread discarded saved status");
    await queue({ type: "open" });
    await queue({ type: "mark_read", value: false });
    check((await offline.getOfflineArticleDetail(scope, "0"))?.state.interactionStatus === "opened", "unread discarded opened history");
    await queue({ type: "hide" });
    await queue({ type: "favorite", value: false });
    check((await offline.getOfflineArticleDetail(scope, "0"))?.state.hidden, "unfavorite undid hide");
    await queue({ type: "not_interested" });
    await queue({ type: "favorite", value: true });
    check((await offline.getOfflineArticleDetail(scope, "0"))?.state.interactionStatus === "ignored", "saving undid explicit not-interested");
  },
  async concurrentContent() {
    const { queue, scope, detail } = await setup();
    await Promise.all([
      queue({ type: "favorite", value: true }),
      offline.cacheOnlineArticleDetail(scope, { ...detail("0"), contentText: "replacement body" })
    ]);
    const article = (await offline.getOfflineArticleDetail(scope, "0"))!;
    check(article.state.favorited && article.contentText === "replacement body", "state RMW overwrote new content revision");
  },
  async snapshotCursor() {
    const { scope, refresh, manifest } = await setup();
    await refresh(manifest("page-a", 100));
    const first = await offline.listOfflineArticles(scope, { view: "recommended" });
    const next = manifest("page-b", 3);
    next.recommended.reverse();
    next.recommended.forEach((ref, position) => { ref.position = position; });
    await refresh(next);
    const restarted = await offline.listOfflineArticles(scope, { view: "recommended", cursor: first.nextCursor });
    check(JSON.stringify(restarted.data.map((a) => a.id)) === '["2","1","0"]', "old snapshot cursor leaked into new snapshot");
    const onlineCursor = await offline.listOfflineArticles(scope, { view: "recommended", cursor: "online-cursor" });
    check(onlineCursor.data.length === 3, "online cursor interpreted as offline cursor");
  },
  async staleRefreshAfterAck() {
    const { scope, queue, manifest, detail } = await setup();
    await queue({ type: "favorite", value: true });
    const entered = deferred<void>();
    const release = deferred<void>();
    const refresh = offline.refreshOfflineSnapshot(scope, {
      getOfflineManifest: async () => { entered.resolve(); await release.promise; return manifest("pre-ack"); },
      getOfflineArticles: async (ids) => ids.map(detail)
    });
    await entered.promise;
    await offline.syncOfflineArticleActions(scope, {
      postArticleAction: async () => ({ eventId: "ack", state: { ...initial, favorited: true, interactionStatus: "saved" } })
    });
    release.resolve();
    await refresh;
    check((await offline.getOfflineArticleDetail(scope, "0"))?.state.favorited, "pre-ack manifest overwrote acknowledged state");
  },
  async progressCompression() {
    const { queue } = await setup();
    const first = await queue({ type: "read_progress", progress: 0.8 });
    const second = await queue({ type: "read_progress", progress: 0.3 });
    const pending = await actions();
    check(pending.length === 1 && second.clientActionId !== first.clientActionId, "replacement did not get fresh id");
    check(second.sequence > first.sequence && second.request.type === "read_progress" && second.request.progress === 0.8, "replacement sequence/progress regressed");
  },
  async explicitUnreadRebase() {
    const { queue, scope } = await setup();
    await queue({ type: "read_progress", progress: 0.95 });
    await offline.syncOfflineArticleActions(scope, { postArticleAction: async () => {
      await queue({ type: "mark_read", value: false });
      return { eventId: "ok", state: { ...initial, read: true, readingProgress: 0.95, interactionStatus: "read" } };
    } });
    const state = (await offline.getOfflineArticleDetail(scope, "0"))!.state;
    check(!state.read && state.readingProgress === 0 && state.interactionStatus !== "read", "late ack undid explicit unread");
  },
  async onlinePendingState() {
    const { queue, scope, detail } = await setup();
    await queue({ type: "favorite", value: true });
    await offline.cacheOnlineArticleDetail(scope, { ...detail("0"), contentText: "new body" });
    const article = (await offline.getOfflineArticleDetail(scope, "0"))!;
    check(article.state.favorited && article.contentText === "new body", "online content cache overwrote pending state");
  },
  async unreadPagination() {
    const { queue, scope, refresh, manifest } = await setup();
    await refresh(manifest("page", 100));
    const first = await offline.listOfflineArticles(scope, { view: "recommended", unreadOnly: true });
    check(first.data.length === 50 && first.data.at(-1)?.id === "49", "bad first page");
    await queue({ type: "favorite", value: true }, { favorited: true }, "0");
    await queue({ type: "hide" }, { hidden: true }, "1");
    await queue({ type: "hide" }, { hidden: true }, "60");
    const second = await offline.listOfflineArticles(scope, {
      view: "recommended", unreadOnly: true, cursor: first.nextCursor
    });
    check(second.data[0]?.id === "50", "mutable visibility skipped first unseen page candidate");
    check(JSON.stringify(second.data.map((a) => a.id)) === JSON.stringify(
      Array.from({ length: 50 }, (_, i) => String(i + 50)).filter((id) => id !== "60")
    ), "pagination omitted, repeated, or reordered candidates");
    check(second.nextCursor === null, "incorrect pagination end");
  },
  async revocation() {
    const { scope, queue, detail } = await setup();
    let notified = false;
    window.addEventListener("dibao:offline-status-changed", () => { notified = true; }, { once: true });
    await offline.markOfflineScopeRevoked(scope);
    check(notified, "revocation did not notify runtime");
    check(await offline.readOfflineProfile(scope) === null, "revoked profile exposed");
    const before = JSON.stringify(await records("profiles"));
    await offline.updateOfflineProfile(scope, { lastConnectedAt: 999 });
    await offline.cacheOnlineArticleDetail(scope, detail("unexpected"));
    check(JSON.stringify(await records("profiles")) === before, "revoked profile updated");
    check(await queue({ type: "favorite", value: true }).then(() => false, () => true), "revoked queue accepted");
    check(await offline.rememberOfflineSession("transaction-test").then(() => false, () => true), "automatic remember cleared revocation");
    await offline.clearOfflineScope(scope);
    check(await offline.rememberOfflineSession("transaction-test").then(() => false, () => true), "remember revived cleared revoked profile");
    check((await records("profiles")).length === 0 && (await actions()).length === 0, "revoked writes resurrected data");
    await offline.clearOfflineScopeRevocation(scope);
    check(Boolean(await offline.rememberOfflineSession("transaction-test")), "explicit login cannot restore profile");
  },
  async revokeDuringRefresh() {
    const { scope, manifest, detail } = await setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const refresh = offline.refreshOfflineSnapshot(scope, {
      getOfflineManifest: async () => { entered.resolve(); await release.promise; return manifest("revoked"); },
      getOfflineArticles: async (ids) => ids.map(detail)
    });
    await entered.promise;
    await offline.markOfflineScopeRevoked(scope);
    await offline.clearOfflineScope(scope);
    await offline.clearOfflineScopeRevocation(scope);
    await offline.rememberOfflineSession("transaction-test");
    await offline.setOfflineReadingEnabled(scope, true);
    release.resolve();
    await refresh;
    check((await records("snapshots")).length === 0, "old session refresh crossed explicit login generation");
  },
  async concurrentQueue() {
    const { queue } = await setup();
    await Promise.all([
      queue({ type: "favorite", value: true }, { favorited: true }),
      queue({ type: "like", value: true }, { liked: true })
    ]);
    const pending = await actions();
    check(pending.length === 2, "concurrent actions lost");
    check(new Set(pending.map((action) => action.sequence)).size === 2, "sequence collision");
    const article = (await records<offline.OfflineArticleRecord>("articles")).find((a) => a.articleId === "0")!;
    check(article.detail.state.favorited && article.detail.state.liked, "stale input overwrote other action");
  },
  async progressBarrier() {
    const { queue } = await setup();
    await queue({ type: "read_progress", progress: 0.95 }, { read: true, readingProgress: 0.95 });
    await queue({ type: "mark_read", value: false });
    await queue({ type: "read_progress", progress: 0.2 }, { readingProgress: 0.2 });
    const pending = await actions();
    check(pending.length === 3, "progress compressed across explicit unread");
    check(pending[2]!.request.type === "read_progress" && pending[2]!.request.progress === 0.2, "old progress crossed reset");
  },
  async attemptedProgress() {
    const { queue, scope } = await setup();
    const first = await queue({ type: "read_progress", progress: 0.3 });
    await offline.syncOfflineArticleActions(scope, { postArticleAction: async () => { throw new TypeError("lost response"); } }).catch(() => undefined);
    await queue({ type: "read_progress", progress: 0.8 });
    const pending = await actions();
    check(pending.length === 2, "possibly accepted action was compressed");
    check(pending[0]!.clientActionId === first.clientActionId && pending[0]!.request.type === "read_progress" && pending[0]!.request.progress === 0.3, "retry id changed payload");
  },
  async syncRebase() {
    const { queue, scope } = await setup();
    await queue({ type: "favorite", value: true }, { favorited: true });
    let posted = false;
    await offline.syncOfflineArticleActions(scope, { postArticleAction: async () => {
      if (!posted) await queue({ type: "like", value: true }, { favorited: true, liked: true });
      posted = true;
      return { eventId: "ok", state: { ...initial, favorited: true } };
    } });
    const article = await offline.getOfflineArticleDetail(scope, "0");
    check(article?.state.favorited && article.state.liked, "server response overwrote newer intent");
  },
  async syncLiveQueue() {
    const { queue, scope } = await setup();
    await queue({ type: "open" });
    const replaced = await queue({ type: "favorite", value: true });
    const sent: string[] = [];
    await offline.syncOfflineArticleActions(scope, { postArticleAction: async (_id, request) => {
      sent.push(request.clientActionId!);
      if (sent.length === 1) await queue({ type: "favorite", value: false });
      return { eventId: "ok", state: initial };
    } });
    check(!sent.includes(replaced.clientActionId), "sync resurrected a compressed action from old list");
  },
  async clearDuringPost() {
    for (const failure of [false, true]) {
      const { queue, scope } = await setup();
      await queue({ type: "favorite", value: true });
      await offline.syncOfflineArticleActions(scope, { postArticleAction: async () => {
        await offline.setOfflineReadingEnabled(scope, false);
        if (failure) throw new TypeError("network");
        return { eventId: "ok", state: initial };
      } }).catch(() => undefined);
      check((await actions()).length === 0, "late response resurrected cleared queue");
      check((await records("articles")).length === 0 && (await records("snapshots")).length === 0, "late response resurrected cache");
    }
  },
  async profileDisable() {
    const { scope } = await setup();
    await Promise.all([
      offline.updateOfflineProfile(scope, { lastConnectedAt: 123 }),
      offline.setOfflineReadingEnabled(scope, false)
    ]);
    const profile = await offline.readOfflineProfile(scope);
    check(!profile?.deviceSettings.enabled && profile?.activeSnapshotId === null, "profile update revived enabled/snapshot");
  },
  async staleRefreshClear() {
    const { scope, manifest, detail } = await setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const refresh = offline.refreshOfflineSnapshot(scope, {
      getOfflineManifest: async () => { entered.resolve(); await release.promise; return manifest("stale"); },
      getOfflineArticles: async (ids) => ids.map(detail)
    });
    await entered.promise;
    await offline.clearOfflineCache(scope);
    release.resolve();
    await refresh;
    check((await records("snapshots")).length === 0 && (await records("articles")).length === 0, "pre-clear refresh repopulated cache");
  },
  async staleRefreshTarget() {
    const { scope, manifest, detail } = await setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const refresh = offline.refreshOfflineSnapshot(scope, {
      getOfflineManifest: async () => { entered.resolve(); await release.promise; return manifest("stale", 80); },
      getOfflineArticles: async (ids) => ids.map(detail)
    });
    await entered.promise;
    await offline.setOfflineRecommendedTarget(scope, 50);
    release.resolve();
    await refresh;
    check((await offline.readOfflineProfile(scope))?.activeSnapshotId === "first", "old target refresh committed");
  },
  async snapshotPending() {
    const { queue, scope, refresh, manifest } = await setup();
    await queue({ type: "favorite", value: true }, { favorited: true });
    await refresh(manifest("new"));
    check((await offline.getOfflineArticleDetail(scope, "0"))?.state.favorited, "snapshot overwrote pending intent");
  },
  async concurrentSnapshotStates() {
    const { queue } = await setup();
    await Promise.all([
      queue({ type: "favorite", value: true }, { favorited: true }, "0"),
      queue({ type: "like", value: true }, { liked: true }, "1")
    ]);
    const snapshot = (await records<offline.OfflineSnapshotRecord>("snapshots"))[0]!;
    check(snapshot.recommended[0]!.article.state.favorited && snapshot.recommended[1]!.article.state.liked, "snapshot RMW lost another article state");
  },
  async rollback() {
    const { queue, scope } = await setup();
    await queue({ type: "favorite", value: true }, { favorited: true });
    const before = await actions();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "actions") {
        this.transaction.abort();
        throw new DOMException("Injected quota failure", "QuotaExceededError");
      }
      return put.apply(this, args);
    };
    try {
      await queue({ type: "favorite", value: false }).then(
        () => { throw new Error("expected transaction failure"); }, () => undefined
      );
    } finally { IDBObjectStore.prototype.put = put; }
    check(JSON.stringify(await actions()) === JSON.stringify(before), "failed put lost previous pending action");
    check((await offline.getOfflineArticleDetail(scope, "0"))?.state.favorited, "failed queue changed state");
  }
};

export async function prepareCrossTab(): Promise<void> { await setup(); }

export async function queueCrossTab(type: "favorite" | "like"): Promise<void> {
  await offline.queueOfflineArticleAction({ scopeKey: offline.offlineScopeKey("transaction-test"),
    articleId: "0", request: { type, value: true }, state: initial });
}

export async function verifyCrossTab(): Promise<void> {
  const pending = await actions();
  check(pending.length === 2 && new Set(pending.map((a) => a.sequence)).size === 2, "cross-tab sequence collision/action loss");
  const article = await offline.getOfflineArticleDetail(offline.offlineScopeKey("transaction-test"), "0");
  check(article?.state.favorited && article.state.liked, "cross-tab stale optimistic state lost update");
}
