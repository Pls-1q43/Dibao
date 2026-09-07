import {
  ApiRequestError,
  type AppSettings,
  type ArticleActionRequest,
  type ArticleActionResponse,
  type ArticleDetail,
  type ArticleListItem,
  type ArticleState,
  type ArticleTimeWindow,
  type ArticleView,
  type FavoriteArticleSort,
  type Feed,
  type FeedFolder,
  type OfflineManifest,
  type OfflineManifestArticle,
  type ReadLaterArticleSort
} from "../api.js";
import { articleInteractionStatusForState } from "../articleListState.js";
import {
  optimisticOpenedState,
  optimisticReadProgressState,
  optimisticStateForArticleAction,
  savedOptimisticState
} from "../app/shared.js";

const DATABASE_NAME = "dibao-offline-reading";
const DATABASE_VERSION = 1;
const PROFILES_STORE = "profiles";
const SNAPSHOTS_STORE = "snapshots";
const ARTICLES_STORE = "articles";
const ACTIONS_STORE = "actions";
const META_STORE = "meta";
const ARTICLE_IMAGE_CACHE_PREFIX = "dibao:article-images:v1:";
const MAX_OFFLINE_IMAGES_PER_ARTICLE = 24;
const MAX_OFFLINE_IMAGE_URLS_PER_SYNC = 4_000;
export const DEFAULT_OFFLINE_RECOMMENDED_TARGET = 200;
export const MIN_OFFLINE_RECOMMENDED_TARGET = 50;
export const MAX_OFFLINE_RECOMMENDED_TARGET = 1_000;
const OFFLINE_PAGE_SIZE = 50;
const ARTICLE_BATCH_SIZE = 25;
const SYNC_CHANNEL_NAME = "dibao-offline-sync";
const ACTIVE_MODE_STORAGE_KEY = "dibao:offline-reading:active-mode:v1";
const REVOKED_SCOPE_STORAGE_PREFIX = "dibao:offline-reading:revoked-scope:v1:";
const REVOKED_SCOPE_META_PREFIX = "offline-reading:revoked-scope:v1:";
const PENDING_SERVER_LOGOUT_STORAGE_PREFIX = "dibao:auth:pending-server-logout:v1:";
const PENDING_SERVER_LOGOUT_META_PREFIX = "auth:pending-server-logout:v1:";
const SYNC_LEASE_DURATION_MS = 30_000;

export type OfflineDeviceSettings = {
  enabled: boolean;
  recommendedTarget: number;
};

export type OfflineProfileRecord = {
  scopeKey: string;
  origin: string;
  username: string;
  activeSnapshotId: string | null;
  settings: AppSettings | null;
  feeds: Feed[];
  folders: FeedFolder[];
  deviceSettings: OfflineDeviceSettings;
  lastConnectedAt: number | null;
  updatedAt: number;
  cacheGeneration?: string;
};

export type OfflineSnapshotRecord = {
  key: string;
  scopeKey: string;
  id: string;
  generatedAt: number;
  rankContext: string;
  recommendedTarget: number;
  recommended: OfflineManifestArticle[];
  readLater: OfflineManifestArticle[];
  recent: OfflineManifestArticle[];
  status: "active" | "superseded";
};

export type OfflineArticleRecord = {
  key: string;
  scopeKey: string;
  articleId: string;
  contentRevision: string;
  detail: ArticleDetail;
  cachedAt: number;
  lastAccessedAt: number;
  mediaStatus: "none" | "partial" | "complete";
};

export type OfflineActionRecord = {
  clientActionId: string;
  scopeKey: string;
  articleId: string;
  sequence: number;
  createdAt: number;
  request: ArticleActionRequest;
  status: "pending" | "syncing" | "failed";
  attemptCount: number;
  lastErrorCode: string | null;
};

export type OfflineCacheSummary = {
  targetCount: number;
  availableCount: number;
  recommendedCount: number;
  readLaterCount: number;
  recentCount: number;
  pendingActionCount: number;
  failedActionCount: number;
  generatedAt: number | null;
  usageBytes: number | null;
  bodyBytes: number | null;
  imageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
};

export type OfflineArticleListInput = {
  view: ArticleView;
  feedId?: string | null;
  folderId?: string | null;
  unreadOnly?: boolean;
  timeWindow?: ArticleTimeWindow;
  favoriteSort?: FavoriteArticleSort;
  readLaterSort?: ReadLaterArticleSort;
  limit?: number;
  cursor?: string | null;
};

export type OfflineArticleListResult = {
  data: ArticleListItem[];
  nextCursor: string | null;
  unreadCount: number;
};

type OfflineApi = {
  getOfflineManifest: (recommendedLimit: number) => Promise<OfflineManifest>;
  getOfflineArticles: (articleIds: string[]) => Promise<ArticleDetail[]>;
  postArticleAction: (
    articleId: string,
    request: ArticleActionRequest
  ) => Promise<ArticleActionResponse>;
};

type MetaRecord = {
  key: string;
  value: string;
};

let openDatabasePromise: Promise<IDBDatabase> | null = null;
let inMemorySync: Promise<void> = Promise.resolve();

export function offlineScopeKey(username: string, origin = window.location.origin): string {
  return `${origin}::${username}`;
}

export function isOfflineModeActive(
  scopeKey: string,
  storage: Pick<Storage, "getItem"> = window.localStorage
): boolean {
  try {
    return storage.getItem(ACTIVE_MODE_STORAGE_KEY) === scopeKey;
  } catch {
    return false;
  }
}

export function setOfflineModeActive(
  scopeKey: string | null,
  storage: Pick<Storage, "removeItem" | "setItem"> = window.localStorage
): void {
  try {
    if (scopeKey) {
      storage.setItem(ACTIVE_MODE_STORAGE_KEY, scopeKey);
    } else {
      storage.removeItem(ACTIVE_MODE_STORAGE_KEY);
    }
  } catch {
    // Storage restrictions must not block entering or leaving offline mode.
  }
}

export function isOfflineScopeRevokedInStorage(
  scopeKey: string,
  storage: Pick<Storage, "getItem"> = window.localStorage
): boolean {
  try {
    return storage.getItem(revokedScopeStorageKey(scopeKey)) === "1";
  } catch {
    return false;
  }
}

export async function isOfflineScopeRevoked(scopeKey: string): Promise<boolean> {
  const localMarker = readStorageMarker(revokedScopeStorageKey(scopeKey));
  if (localMarker === "1") return true;
  if (!isOfflineStorageSupported()) {
    return false;
  }
  try {
    return Boolean(
      await getRecord<MetaRecord>(META_STORE, revokedScopeMetaKey(scopeKey))
    );
  } catch {
    return false;
  }
}

export async function markOfflineScopeRevoked(scopeKey: string): Promise<void> {
  const storedLocally = setStorageMarker(revokedScopeStorageKey(scopeKey), "1");
  let storedInDatabase = false;
  if (isOfflineStorageSupported()) {
    try {
      await offlineTransaction([META_STORE, PROFILES_STORE], async (transaction) => {
        transaction.objectStore(META_STORE).put({ key: revokedScopeMetaKey(scopeKey), value: "1" } satisfies MetaRecord);
        const store = transaction.objectStore(PROFILES_STORE);
        const profile = await requestResult<OfflineProfileRecord | undefined>(store.get(scopeKey));
        if (profile) store.put({ ...profile, cacheGeneration: createClientActionId() });
      });
      storedInDatabase = true;
    } catch {
      // The localStorage marker still prevents a cold offline bootstrap.
    }
  }
  if (!storedLocally && !storedInDatabase) {
    throw new Error("Unable to persist the offline logout marker");
  }
  setOfflineModeActive(null);
  activateOfflineImageScope(null);
  notifyOfflineStatusChanged(scopeKey);
}

export async function clearOfflineScopeRevocation(scopeKey: string): Promise<void> {
  if (isOfflineStorageSupported()) {
    await deleteRecord(META_STORE, revokedScopeMetaKey(scopeKey));
  }
  setStorageMarker(revokedScopeStorageKey(scopeKey), "0");
}

export function hasPendingServerLogoutInStorage(
  origin: string,
  storage: Pick<Storage, "getItem"> = window.localStorage
): boolean {
  try {
    return storage.getItem(pendingServerLogoutStorageKey(origin)) === "1";
  } catch {
    return false;
  }
}

export async function hasPendingServerLogout(
  origin = window.location.origin
): Promise<boolean> {
  const localMarker = readStorageMarker(pendingServerLogoutStorageKey(origin));
  if (localMarker !== null) {
    return localMarker === "1";
  }
  if (!isOfflineStorageSupported()) {
    return false;
  }
  try {
    return Boolean(
      await getRecord<MetaRecord>(META_STORE, pendingServerLogoutMetaKey(origin))
    );
  } catch {
    return false;
  }
}

export async function markPendingServerLogout(
  origin = window.location.origin
): Promise<void> {
  const storedLocally = setStorageMarker(pendingServerLogoutStorageKey(origin), "1");
  let storedInDatabase = false;
  if (isOfflineStorageSupported()) {
    try {
      await putRecord(META_STORE, {
        key: pendingServerLogoutMetaKey(origin),
        value: "1"
      } satisfies MetaRecord);
      storedInDatabase = true;
    } catch {
      // The localStorage marker is sufficient when IndexedDB is unavailable.
    }
  }
  if (!storedLocally && !storedInDatabase) {
    throw new Error("Unable to persist the pending server logout marker");
  }
}

export async function clearPendingServerLogout(
  origin = window.location.origin
): Promise<void> {
  setStorageMarker(pendingServerLogoutStorageKey(origin), "0");
  if (isOfflineStorageSupported()) {
    try {
      await deleteRecord(META_STORE, pendingServerLogoutMetaKey(origin));
    } catch {
      // The local tombstone takes precedence over a stale durable marker.
    }
  }
}

export async function rememberOfflineSession(username: string): Promise<OfflineProfileRecord> {
  const origin = window.location.origin;
  const scopeKey = offlineScopeKey(username, origin);
  const profile = await offlineTransaction([PROFILES_STORE, META_STORE], async (transaction) => {
    if (await scopeRevokedInTransaction(transaction, scopeKey)) throw new Error("Offline session is revoked");
    const existing = await requestResult<OfflineProfileRecord | undefined>(transaction.objectStore(PROFILES_STORE).get(scopeKey));
    const profile: OfflineProfileRecord = existing ? normalizeOfflineProfile(existing) : {
      scopeKey,
      origin,
      username,
      activeSnapshotId: null,
      settings: null,
      feeds: [],
      folders: [],
      deviceSettings: {
        enabled: false,
        recommendedTarget: DEFAULT_OFFLINE_RECOMMENDED_TARGET
      },
      lastConnectedAt: null,
      updatedAt: Date.now(),
      cacheGeneration: createClientActionId()
    };
    profile.updatedAt = Date.now();
    transaction.objectStore(PROFILES_STORE).put(profile);
    transaction.objectStore(META_STORE).put({ key: lastScopeKey(origin), value: scopeKey } satisfies MetaRecord);
    return profile;
  });
  activateOfflineImageScope(profile.deviceSettings.enabled ? scopeKey : null);
  return profile;
}

export async function readOfflineBootstrap(): Promise<{
  profile: OfflineProfileRecord;
  snapshot: OfflineSnapshotRecord | null;
} | null> {
  if (!isOfflineStorageSupported()) {
    return null;
  }
  const origin = window.location.origin;
  const meta = await getRecord<MetaRecord>(META_STORE, lastScopeKey(origin));
  if (!meta) {
    return null;
  }
  if (await isOfflineScopeRevoked(meta.value)) {
    activateOfflineImageScope(null);
    return null;
  }
  const profile = await readOfflineProfile(meta.value);
  if (!profile || profile.origin !== origin) {
    return null;
  }
  if (!profile.deviceSettings.enabled) {
    activateOfflineImageScope(null);
    return null;
  }
  const snapshot = profile.activeSnapshotId
    ? await getRecord<OfflineSnapshotRecord>(
        SNAPSHOTS_STORE,
        snapshotKey(profile.scopeKey, profile.activeSnapshotId)
      ) ?? null
    : null;
  activateOfflineImageScope(profile.scopeKey);
  return { profile, snapshot };
}

export async function readOfflineProfile(
  scopeKey: string
): Promise<OfflineProfileRecord | null> {
  return await offlineTransaction([PROFILES_STORE, META_STORE], async (transaction) => {
    if (await scopeRevokedInTransaction(transaction, scopeKey)) return null;
    const profile = await requestResult<OfflineProfileRecord | undefined>(
      transaction.objectStore(PROFILES_STORE).get(scopeKey)
    );
    return profile ? normalizeOfflineProfile(profile) : null;
  });
}

export async function updateOfflineProfile(
  scopeKey: string,
  patch: Partial<Pick<
    OfflineProfileRecord,
    "settings" | "feeds" | "folders" | "lastConnectedAt"
  >>
): Promise<void> {
  await offlineTransaction([PROFILES_STORE, META_STORE], async (transaction) => {
    if (await scopeRevokedInTransaction(transaction, scopeKey)) return;
    const store = transaction.objectStore(PROFILES_STORE);
    const storedProfile = await requestResult<OfflineProfileRecord | undefined>(store.get(scopeKey));
    if (!storedProfile) return;
    const profile = normalizeOfflineProfile(storedProfile);
    store.put({
      ...profile,
      ...patch,
      updatedAt: Date.now()
    });
  });
}

export async function setOfflineRecommendedTarget(
  scopeKey: string,
  target: number
): Promise<number> {
  await requireProfile(scopeKey);
  const recommendedTarget = normalizeRecommendedTarget(target);
  const didTrimSnapshot = await updateOfflineRecommendedTarget(
    scopeKey,
    recommendedTarget
  );
  activateOfflineImageScope(scopeKey);
  if (didTrimSnapshot) await pruneOfflineArticles(scopeKey);
  notifyOfflineStatusChanged(scopeKey);
  return recommendedTarget;
}

export async function setOfflineReadingEnabled(
  scopeKey: string,
  enabled: boolean
): Promise<boolean> {
  await requireProfile(scopeKey);
  if (enabled) {
    await updateOfflineEnabled(scopeKey, true);
  } else {
    await clearOfflineCacheRecords(scopeKey, false);
  }
  activateOfflineImageScope(enabled ? scopeKey : null);
  notifyOfflineStatusChanged(scopeKey);
  return enabled;
}

export async function refreshOfflineSnapshot(
  scopeKey: string,
  api: Pick<OfflineApi, "getOfflineManifest" | "getOfflineArticles">
): Promise<OfflineCacheSummary> {
  const profile = await requireProfile(scopeKey);
  if (!profile.deviceSettings.enabled) {
    return await getOfflineCacheSummary(scopeKey);
  }
  const manifest = await api.getOfflineManifest(profile.deviceSettings.recommendedTarget);
  const refs = uniqueManifestArticles(manifest);
  const existingRecords = await listScopeRecords<OfflineArticleRecord>(ARTICLES_STORE, scopeKey);
  const existingById = new Map(existingRecords.map((record) => [record.articleId, record]));
  const changedIds = refs.flatMap((ref) => {
    const existing = existingById.get(ref.article.id);
    return existing?.contentRevision === ref.contentRevision ? [] : [ref.article.id];
  });
  const downloaded = new Map<string, ArticleDetail>();

  for (const articleIds of chunks(changedIds, ARTICLE_BATCH_SIZE)) {
    const details = await api.getOfflineArticles(articleIds);
    for (const detail of details) {
      if (hasReadableArticle(detail)) {
        downloaded.set(detail.id, detail);
      }
    }
  }

  const availableIds = new Set<string>();
  const articleRecords: OfflineArticleRecord[] = [];
  for (const ref of refs) {
    const downloadedDetail = downloaded.get(ref.article.id);
    const existing = existingById.get(ref.article.id);
    const detail = downloadedDetail ??
      (existing?.contentRevision === ref.contentRevision ? existing.detail : null);
    if (!detail || !hasReadableArticle(detail)) {
      continue;
    }
    availableIds.add(ref.article.id);
    articleRecords.push({
      key: articleKey(scopeKey, ref.article.id),
      scopeKey,
      articleId: ref.article.id,
      contentRevision: ref.contentRevision,
      detail: { ...detail, state: ref.article.state },
      cachedAt: downloadedDetail ? Date.now() : existing?.cachedAt ?? Date.now(),
      lastAccessedAt: existing?.lastAccessedAt ?? Date.now(),
      mediaStatus: downloadedDetail ? "partial" : existing?.mediaStatus ?? "none"
    });
  }

  const snapshot: OfflineSnapshotRecord = {
    key: snapshotKey(scopeKey, manifest.snapshotId),
    scopeKey,
    id: manifest.snapshotId,
    generatedAt: Date.parse(manifest.generatedAt),
    rankContext: manifest.rankContext,
    recommendedTarget: manifest.recommendedTarget,
    recommended: manifest.recommended.filter((ref) => availableIds.has(ref.article.id)),
    readLater: manifest.readLater.filter((ref) => availableIds.has(ref.article.id)),
    recent: manifest.recent.filter((ref) => availableIds.has(ref.article.id)),
    status: "active"
  };
  let committed: { cacheGeneration: string | null } | null = null;
  try {
    committed = await commitSnapshot(profile, snapshot, articleRecords);
  } catch (error) {
    if (!isStorageQuotaError(error)) throw error;
    await clearArticleImages(scopeKey);
    committed = await commitSnapshot(profile, snapshot, articleRecords);
  }
  if (!committed) {
    return await getOfflineCacheSummary(scopeKey);
  }
  activateOfflineImageScope(scopeKey);
  const imageUrlsToKeep = offlineArticleImageUrls(
    articleRecords.map((record) => record.detail)
  );
  cacheArticleImages(scopeKey, articleRecords.map((record) => record.detail), committed.cacheGeneration);
  pruneArticleImages(scopeKey, imageUrlsToKeep, committed.cacheGeneration);
  await pruneOfflineArticles(scopeKey);
  void requestPersistentOfflineStorage();
  notifyOfflineStatusChanged(scopeKey);
  return await getOfflineCacheSummary(scopeKey);
}

export async function listOfflineArticles(
  scopeKey: string,
  input: OfflineArticleListInput
): Promise<OfflineArticleListResult> {
  const { profile, snapshot } = await requireActiveSnapshot(scopeKey);
  const articleRecords = await listScopeRecords<OfflineArticleRecord>(ARTICLES_STORE, scopeKey);
  const detailsById = new Map(articleRecords.map((record) => [record.articleId, record.detail]));
  const candidates = refsForView(snapshot, input.view);
  const feedIdsForFolder = input.folderId
    ? new Set(
        profile.feeds
          .filter((feed) => feed.folderId === input.folderId)
          .map((feed) => feed.id)
      )
    : null;
  const ordered = candidates.flatMap((ref) => {
    const detail = detailsById.get(ref.article.id);
    if (!detail) {
      return [];
    }
    const article = { ...ref.article, state: detail.state };
    return [{ article, ref }];
  });
  ordered.sort((left, right) => compareOfflineArticles(left, right, input));
  const visible = ordered.filter(({ article }) => isVisibleOfflineArticle(article, input, feedIdsForFolder));
  const unreadCount = visible.filter(
    ({ article }) => articleInteractionStatusForState(article.state) === "unseen"
  ).length;
  const visibleById = new Map(visible.map(({ article }) => [article.id, article]));
  // Freeze the remaining snapshot candidates, not their mutable filtered offset.
  // IDs also keep read-later/recent paging stable when actions remove or reorder refs.
  const remainingIds = offlineCursorArticleIds(input.cursor, snapshot.id)
    ?? ordered.map(({ article }) => article.id);
  const remaining = remainingIds.flatMap((id) => {
    const article = visibleById.get(id);
    return article ? [article] : [];
  });
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? OFFLINE_PAGE_SIZE), 1), 100);
  const page = remaining.slice(0, limit);
  const lastId = page.at(-1)?.id;
  return {
    data: page,
    nextCursor: remaining.length > limit && lastId
      ? `offline:v2:${encodeURIComponent(JSON.stringify({ snapshotId: snapshot.id,
          ids: remainingIds.slice(remainingIds.indexOf(lastId) + 1) }))}`
      : null,
    unreadCount
  };
}

export async function getOfflineArticleDetail(
  scopeKey: string,
  articleId: string
): Promise<ArticleDetail | null> {
  if (!(await readOfflineProfile(scopeKey))?.deviceSettings.enabled) return null;
  const record = await getRecord<OfflineArticleRecord>(ARTICLES_STORE, articleKey(scopeKey, articleId));
  if (!record) {
    return null;
  }
  void touchOfflineArticle(scopeKey, articleId).catch(() => undefined);
  return record.detail;
}

export async function cacheOnlineArticleDetail(
  scopeKey: string,
  detail: ArticleDetail
): Promise<void> {
  if (!hasReadableArticle(detail)) {
    return;
  }
  const profile = await readOfflineProfile(scopeKey);
  if (!profile?.deviceSettings.enabled) return;
  const committed = await commitOnlineArticleDetail({
    key: articleKey(scopeKey, detail.id),
    scopeKey,
    articleId: detail.id,
    contentRevision: `opportunistic:${Date.now()}`,
    detail,
    cachedAt: Date.now(),
    lastAccessedAt: Date.now(),
    mediaStatus: "partial"
  } satisfies OfflineArticleRecord, profile.cacheGeneration);
  if (!committed) return;
  cacheArticleImages(scopeKey, [detail], committed.cacheGeneration);
  notifyOfflineStatusChanged(scopeKey);
}

export async function queueOfflineArticleAction(input: {
  scopeKey: string;
  articleId: string;
  request: ArticleActionRequest;
  state: ArticleState;
}): Promise<OfflineActionRecord> {
  const action = await offlineTransaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE, ACTIONS_STORE, META_STORE],
    async (transaction) => {
      const profile = await writableProfile(transaction, input.scopeKey);
      if (!profile?.deviceSettings.enabled) throw new Error("Offline reading is not available");
      const actions = await actionsInTransaction(transaction, input.scopeKey);
      const previous = actions.filter((item) => item.articleId === input.articleId).at(-1);
      const store = transaction.objectStore(ACTIONS_STORE);
      let request = input.request;
      // Only adjacent, never-attempted actions can be replaced. An attempted ID
      // may already have been accepted by the server, even after a network error.
      if (previous?.status === "pending" && previous.attemptCount === 0 &&
        previous.request.type === request.type && compressibleActionField(request.type)) {
        if (request.type === "read_progress" && previous.request.type === "read_progress") {
          request = { ...request, progress: Math.max(previous.request.progress, request.progress),
            metadata: { ...previous.request.metadata, ...request.metadata } };
        }
        store.delete(previous.clientActionId);
      }
      const meta = transaction.objectStore(META_STORE);
      const key = `action-sequence::${input.scopeKey}`;
      const counter = await requestResult<MetaRecord | undefined>(meta.get(key));
      const sequence = actions.reduce((max, item) => Math.max(max, item.sequence), Number(counter?.value) || 0) + 1;
      const clientActionId = createClientActionId();
      const action: OfflineActionRecord = {
        clientActionId, scopeKey: input.scopeKey, articleId: input.articleId,
        sequence, createdAt: Date.now(),
        request: { ...request, clientActionId, metadata: { ...request.metadata, origin: "offline" } },
        status: "pending", attemptCount: 0, lastErrorCode: null
      };
      meta.put({ key, value: String(sequence) } satisfies MetaRecord);
      store.put(action);
      await updateCachedArticleState(transaction, input.scopeKey, input.articleId,
        (state) => applyOfflineAction(state ?? input.state, action));
      return action;
    }
  );
  notifyOfflineStatusChanged(input.scopeKey);
  return action;
}

export async function syncOfflineArticleActions(
  scopeKey: string,
  api: Pick<OfflineApi, "postArticleAction">
): Promise<void> {
  await runWithOfflineSyncLock(scopeKey, async () => {
    const actions = await listScopeRecords<OfflineActionRecord>(ACTIONS_STORE, scopeKey);
    const throughSequence = actions.reduce((max, action) => Math.max(max, action.sequence), 0);
    let completedAny = false;
    while (true) {
      const action = await offlineTransaction([PROFILES_STORE, ACTIONS_STORE, META_STORE], async (transaction) => {
        const profile = await writableProfile(transaction, scopeKey);
        if (!profile?.deviceSettings.enabled) return null;
        const next = (await actionsInTransaction(transaction, scopeKey))
          .find((item) => item.status !== "failed" && item.sequence <= throughSequence);
        if (!next) return null;
        const claimed: OfflineActionRecord = { ...next, status: "syncing", attemptCount: next.attemptCount + 1 };
        transaction.objectStore(ACTIONS_STORE).put(claimed);
        return claimed;
      });
      if (!action) break;
      try {
        const result = await api.postArticleAction(action.articleId, action.request);
        await settleOfflineAction(action, { state: result.state });
        completedAny = true;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) {
          await settleOfflineAction(action, { missing: true });
          completedAny = true;
          continue;
        }
        const permanent = isPermanentActionFailure(error);
        await settleOfflineAction(action, {
          errorCode: error instanceof ApiRequestError ? error.code : "NETWORK_ERROR", permanent
        });
        if (!permanent) {
          notifyOfflineStatusChanged(scopeKey);
          throw error;
        }
      }
    }
    if (completedAny) {
      await pruneOfflineArticles(scopeKey);
      activateOfflineImageScope(scopeKey);
    }
    notifyOfflineStatusChanged(scopeKey);
  });
}

export async function retryFailedOfflineActions(scopeKey: string): Promise<void> {
  await offlineTransaction([PROFILES_STORE, ACTIONS_STORE, META_STORE], async (transaction) => {
    if (!(await writableProfile(transaction, scopeKey))?.deviceSettings.enabled) return;
    for (const action of await actionsInTransaction(transaction, scopeKey)) {
      if (action.status === "failed") transaction.objectStore(ACTIONS_STORE).put({
        ...action, status: "pending", lastErrorCode: null
      } satisfies OfflineActionRecord);
    }
  });
  notifyOfflineStatusChanged(scopeKey);
}

export async function getOfflineCacheSummary(scopeKey: string): Promise<OfflineCacheSummary> {
  const profile = await readOfflineProfile(scopeKey);
  const snapshot = profile?.activeSnapshotId
    ? await getRecord<OfflineSnapshotRecord>(
        SNAPSHOTS_STORE,
        snapshotKey(scopeKey, profile.activeSnapshotId)
      )
    : null;
  const [actions, articles, imageBytes] = await Promise.all([
    listScopeRecords<OfflineActionRecord>(ACTIONS_STORE, scopeKey),
    listScopeRecords<OfflineArticleRecord>(ARTICLES_STORE, scopeKey),
    estimateArticleImageBytes(scopeKey)
  ]);
  const cachedIds = new Set(articles.filter((article) => hasReadableArticle(article.detail))
    .map((article) => article.articleId));
  const availableRefs = (refs: OfflineManifestArticle[] | undefined) =>
    (refs ?? []).filter((ref) => cachedIds.has(ref.article.id));
  const availableIds = snapshot
    ? new Set(availableRefs(uniqueManifestArticles(snapshot)).map((ref) => ref.article.id))
    : new Set<string>();
  const estimate = await storageEstimate();
  const bodyBytes = estimateJsonBytes({ profile, snapshot, articles, actions });
  return {
    targetCount: profile?.deviceSettings.recommendedTarget ?? DEFAULT_OFFLINE_RECOMMENDED_TARGET,
    availableCount: availableIds.size,
    recommendedCount: availableRefs(snapshot?.recommended).length,
    readLaterCount: availableRefs(snapshot?.readLater).length,
    recentCount: availableRefs(snapshot?.recent).length,
    pendingActionCount: actions.filter((action) => action.status !== "failed").length,
    failedActionCount: actions.filter((action) => action.status === "failed").length,
    generatedAt: snapshot?.generatedAt ?? null,
    usageBytes: estimate.usage,
    bodyBytes,
    imageBytes,
    quotaBytes: estimate.quota,
    persisted: estimate.persisted
  };
}

export async function clearOfflineScope(scopeKey: string): Promise<void> {
  const origin = scopeKey.slice(0, scopeKey.lastIndexOf("::"));
  await offlineTransaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE, ACTIONS_STORE, META_STORE],
    async (transaction) => {
      transaction.objectStore(PROFILES_STORE).delete(scopeKey);
      deleteScopeRecordsInTransaction<OfflineSnapshotRecord>(transaction, SNAPSHOTS_STORE, scopeKey, (item) => item.key);
      deleteScopeRecordsInTransaction<OfflineArticleRecord>(transaction, ARTICLES_STORE, scopeKey, (item) => item.key);
      deleteScopeRecordsInTransaction<OfflineActionRecord>(transaction, ACTIONS_STORE, scopeKey, (item) => item.clientActionId);
      const lastScope = await requestResult<MetaRecord | undefined>(transaction.objectStore(META_STORE).get(lastScopeKey(origin)));
      if (lastScope?.value === scopeKey) {
        transaction.objectStore(META_STORE).delete(lastScopeKey(origin));
      }
    });
  await clearArticleImages(scopeKey);
}

export async function clearOfflineCache(scopeKey: string): Promise<void> {
  await requireProfile(scopeKey);
  await clearOfflineCacheRecords(scopeKey);
  notifyOfflineStatusChanged(scopeKey);
}

async function clearOfflineCacheRecords(
  scopeKey: string,
  enabled?: boolean
): Promise<void> {
  await offlineTransaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE, ACTIONS_STORE, META_STORE],
    async (transaction) => {
      const profilesStore = transaction.objectStore(PROFILES_STORE);
      const profile = await writableProfile(transaction, scopeKey);
      if (profile) {
        profilesStore.put({
          ...profile,
          cacheGeneration: createClientActionId(),
          activeSnapshotId: null,
          deviceSettings: enabled === undefined
            ? profile.deviceSettings
            : { ...profile.deviceSettings, enabled },
          updatedAt: Date.now()
        } satisfies OfflineProfileRecord);
      }
      deleteScopeRecordsInTransaction<OfflineSnapshotRecord>(
        transaction,
        SNAPSHOTS_STORE,
        scopeKey,
        (record) => record.key
      );
      deleteScopeRecordsInTransaction<OfflineArticleRecord>(
        transaction,
        ARTICLES_STORE,
        scopeKey,
        (record) => record.key
      );
      deleteScopeRecordsInTransaction<OfflineActionRecord>(
        transaction,
        ACTIONS_STORE,
        scopeKey,
        (record) => record.clientActionId
      );
    });
  await clearArticleImages(scopeKey);
}

export type OfflineModePromptReason = "network-offline" | "server-unavailable";

export function offlineModePromptReasonForError(
  error: unknown,
  browserOffline = typeof navigator !== "undefined" && navigator.onLine === false
): OfflineModePromptReason | null {
  if (browserOffline) return "network-offline";
  if (error instanceof ApiRequestError) {
    return error.status >= 500 ? "server-unavailable" : null;
  }
  if (
    error instanceof TypeError ||
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
  ) {
    return "server-unavailable";
  }
  return null;
}

export function isOfflineFallbackError(error: unknown): boolean {
  return offlineModePromptReasonForError(error) !== null;
}

export async function requestPersistentOfflineStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) {
    return null;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export function isOfflineStorageSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

export function normalizeRecommendedTarget(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_OFFLINE_RECOMMENDED_TARGET;
  }
  const stepped = Math.round(value / 50) * 50;
  return Math.min(
    Math.max(stepped, MIN_OFFLINE_RECOMMENDED_TARGET),
    MAX_OFFLINE_RECOMMENDED_TARGET
  );
}

export function normalizeOfflineDeviceSettings(
  value: Partial<OfflineDeviceSettings> | null | undefined
): OfflineDeviceSettings {
  return {
    enabled: value?.enabled === true,
    recommendedTarget: normalizeRecommendedTarget(
      value?.recommendedTarget ?? DEFAULT_OFFLINE_RECOMMENDED_TARGET
    )
  };
}

function normalizeOfflineProfile(profile: OfflineProfileRecord): OfflineProfileRecord {
  return {
    ...profile,
    deviceSettings: normalizeOfflineDeviceSettings(
      profile.deviceSettings as Partial<OfflineDeviceSettings> | undefined
    )
  };
}

async function pruneOfflineArticles(scopeKey: string): Promise<void> {
  const retainedArticles = await offlineTransaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE, ACTIONS_STORE, META_STORE],
    async (transaction) => {
      const profile = await writableProfile(transaction, scopeKey);
      if (!profile?.deviceSettings.enabled || !profile.activeSnapshotId) return null;
      const [snapshot, allArticles, actions] = await Promise.all([
        requestResult<OfflineSnapshotRecord | undefined>(transaction.objectStore(SNAPSHOTS_STORE).get(
          snapshotKey(scopeKey, profile.activeSnapshotId))),
        requestResult<OfflineArticleRecord[]>(transaction.objectStore(ARTICLES_STORE).getAll()),
        actionsInTransaction(transaction, scopeKey)
      ]);
      if (!snapshot) return null;
      const articles = allArticles.filter((article) => article.scopeKey === scopeKey);
      const retainedIds = new Set(uniqueManifestArticles(snapshot).map((ref) => ref.article.id));
      for (const action of actions) retainedIds.add(action.articleId);
      for (const article of articles) {
        if (!retainedIds.has(article.articleId)) transaction.objectStore(ARTICLES_STORE).delete(article.key);
      }
      return { articles: articles.filter((article) => retainedIds.has(article.articleId)),
        cacheGeneration: profile.cacheGeneration ?? null };
    });
  if (!retainedArticles) return;
  pruneArticleImages(
    scopeKey,
    offlineArticleImageUrls(retainedArticles.articles.map((article) => article.detail)),
    retainedArticles.cacheGeneration
  );
}

function isPermanentActionFailure(error: unknown): boolean {
  return error instanceof ApiRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 408, 429].includes(error.status);
}

function isStorageQuotaError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

function compressibleActionField(type: ArticleActionRequest["type"]): string | null {
  if (type === "favorite") return "favorite";
  if (type === "like") return "like";
  if (type === "read_later") return "read_later";
  if (type === "read_progress") return "progress";
  return null;
}

function refsForView(
  snapshot: OfflineSnapshotRecord,
  view: ArticleView
): OfflineManifestArticle[] {
  if (view === "recommended") {
    return snapshot.recommended;
  }
  if (view === "read_later") {
    return snapshot.readLater;
  }
  return uniqueManifestArticles(snapshot);
}

function isVisibleOfflineArticle(
  article: ArticleListItem,
  input: OfflineArticleListInput,
  feedIdsForFolder: Set<string> | null
): boolean {
  if (article.state.hidden || article.state.notInterested) return false;
  if (input.view === "favorites" && !article.state.favorited) return false;
  if (input.view === "read_later" && !article.state.readLater) return false;
  if (input.feedId && article.feedId !== input.feedId) return false;
  if (feedIdsForFolder && !feedIdsForFolder.has(article.feedId)) return false;
  if (input.unreadOnly && articleInteractionStatusForState(article.state) !== "unseen") {
    return false;
  }
  const cutoff = timeWindowCutoff(input.timeWindow ?? "all");
  if (cutoff !== null && articleTimestamp(article) < cutoff) return false;
  return true;
}

function compareOfflineArticles(
  left: { article: ArticleListItem; ref: OfflineManifestArticle },
  right: { article: ArticleListItem; ref: OfflineManifestArticle },
  input: OfflineArticleListInput
): number {
  if (input.view === "recommended") {
    return left.ref.position - right.ref.position;
  }
  if (input.view === "favorites") {
    return compareFavoriteArticles(left, right, input.favoriteSort ?? "favorited_desc");
  }
  if (input.view === "read_later") {
    return compareReadLaterArticles(left, right, input.readLaterSort ?? "ranked");
  }
  return articleTimestamp(right.article) - articleTimestamp(left.article) ||
    right.article.id.localeCompare(left.article.id);
}

function compareFavoriteArticles(
  left: { article: ArticleListItem; ref: OfflineManifestArticle },
  right: { article: ArticleListItem; ref: OfflineManifestArticle },
  sort: FavoriteArticleSort
): number {
  if (sort === "published_desc" || sort === "published_asc") {
    const order = sort === "published_desc" ? -1 : 1;
    return order * (articleTimestamp(left.article) - articleTimestamp(right.article));
  }
  const order = sort === "favorited_desc" ? -1 : 1;
  return order * (isoTimestamp(left.ref.favoritedAt) - isoTimestamp(right.ref.favoritedAt));
}

function compareReadLaterArticles(
  left: { article: ArticleListItem; ref: OfflineManifestArticle },
  right: { article: ArticleListItem; ref: OfflineManifestArticle },
  sort: ReadLaterArticleSort
): number {
  if (sort === "ranked") {
    return (right.article.rank?.score ?? -Infinity) - (left.article.rank?.score ?? -Infinity) ||
      left.ref.position - right.ref.position;
  }
  if (sort === "published_desc" || sort === "published_asc") {
    const order = sort === "published_desc" ? -1 : 1;
    return order * (articleTimestamp(left.article) - articleTimestamp(right.article));
  }
  const order = sort === "read_later_desc" ? -1 : 1;
  return order * (isoTimestamp(left.ref.readLaterAt) - isoTimestamp(right.ref.readLaterAt));
}

async function commitSnapshot(
  profile: OfflineProfileRecord,
  snapshot: OfflineSnapshotRecord,
  articles: OfflineArticleRecord[]
): Promise<{ cacheGeneration: string | null } | null> {
  return await offlineTransaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE, ACTIONS_STORE, META_STORE],
    async (transaction) => {
      const currentProfile = await writableProfile(transaction, profile.scopeKey);
      if (!currentProfile?.deviceSettings.enabled ||
        currentProfile.cacheGeneration !== profile.cacheGeneration ||
        currentProfile.deviceSettings.recommendedTarget !== profile.deviceSettings.recommendedTarget) return null;
      const profilesStore = transaction.objectStore(PROFILES_STORE);
      const snapshotsStore = transaction.objectStore(SNAPSHOTS_STORE);
      const actions = await actionsInTransaction(transaction, profile.scopeKey);
      if (
        currentProfile.activeSnapshotId &&
        currentProfile.activeSnapshotId !== snapshot.id
      ) {
        const previous = await requestResult<OfflineSnapshotRecord | undefined>(snapshotsStore.get(
          snapshotKey(profile.scopeKey, currentProfile.activeSnapshotId)));
        if (previous) snapshotsStore.put({ ...previous, status: "superseded" });
      }
      for (const article of articles) {
        const pending = actions.filter((action) => action.articleId === article.articleId);
        const state = pending.reduce(applyOfflineAction, article.detail.state);
        transaction.objectStore(ARTICLES_STORE).put({ ...article, detail: { ...article.detail, state } });
        if (pending.length) snapshot = snapshotWithArticleState(snapshot, article.articleId, state);
      }
      snapshotsStore.put(snapshot);
      const cacheGeneration = createClientActionId();
      profilesStore.put({
        ...currentProfile,
        cacheGeneration,
        activeSnapshotId: snapshot.id,
        updatedAt: Date.now()
      } satisfies OfflineProfileRecord);
      return { cacheGeneration };
    });
}

async function updateOfflineRecommendedTarget(
  scopeKey: string,
  recommendedTarget: number
): Promise<boolean> {
  return await offlineTransaction([PROFILES_STORE, SNAPSHOTS_STORE, META_STORE], async (transaction) => {
    const profilesStore = transaction.objectStore(PROFILES_STORE);
    const snapshotsStore = transaction.objectStore(SNAPSHOTS_STORE);
    const profile = await writableProfile(transaction, scopeKey);
    if (!profile) return false;
    profilesStore.put({
      ...profile,
      cacheGeneration: createClientActionId(),
      deviceSettings: { ...profile.deviceSettings, recommendedTarget },
      updatedAt: Date.now()
    } satisfies OfflineProfileRecord);
    if (!profile.activeSnapshotId) return false;
    const snapshot = await requestResult<OfflineSnapshotRecord | undefined>(snapshotsStore.get(
      snapshotKey(scopeKey, profile.activeSnapshotId)));
    if (!snapshot || snapshot.recommended.length <= recommendedTarget) return false;
    snapshotsStore.put({
      ...snapshot,
      recommendedTarget,
      recommended: snapshot.recommended.slice(0, recommendedTarget)
    } satisfies OfflineSnapshotRecord);
    return true;
  });
}

async function updateOfflineEnabled(scopeKey: string, enabled: boolean): Promise<void> {
  await offlineTransaction([PROFILES_STORE, META_STORE], async (transaction) => {
    const store = transaction.objectStore(PROFILES_STORE);
    const profile = await writableProfile(transaction, scopeKey);
    if (!profile) return;
    store.put({
      ...profile,
      cacheGeneration: createClientActionId(),
      deviceSettings: { ...profile.deviceSettings, enabled },
      updatedAt: Date.now()
    } satisfies OfflineProfileRecord);
  });
}

async function commitOnlineArticleDetail(
  article: OfflineArticleRecord,
  cacheGeneration: string | undefined
): Promise<{ cacheGeneration: string | null } | null> {
  return await offlineTransaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE, ACTIONS_STORE, META_STORE],
    async (transaction) => {
      const snapshotsStore = transaction.objectStore(SNAPSHOTS_STORE);
      const profile = await writableProfile(transaction, article.scopeKey);
      if (!profile?.deviceSettings.enabled || profile.cacheGeneration !== cacheGeneration) return null;
      const committed = { cacheGeneration: profile.cacheGeneration ?? null };
      const existingArticle = await requestResult<OfflineArticleRecord | undefined>(
        transaction.objectStore(ARTICLES_STORE).get(article.key));
      const pending = (await actionsInTransaction(transaction, article.scopeKey))
        .filter((action) => action.articleId === article.articleId);
      article = {
        ...article, contentRevision: existingArticle?.contentRevision ?? article.contentRevision,
        detail: { ...article.detail, state: pending.reduce(applyOfflineAction, article.detail.state) }
      };
      transaction.objectStore(ARTICLES_STORE).put(article);
      if (!profile.activeSnapshotId) return committed;
      const snapshot = await requestResult<OfflineSnapshotRecord | undefined>(snapshotsStore.get(
        snapshotKey(article.scopeKey, profile.activeSnapshotId)));
      if (!snapshot) return committed;
      const now = new Date().toISOString();
      const existing = uniqueManifestArticles(snapshot)
        .find((ref) => ref.article.id === article.articleId);
      const recentRef: OfflineManifestArticle = existing
        ? {
          ...existing,
          article: { ...existing.article, state: article.detail.state },
          openedAt: now
        }
        : {
          article: articleListItemForDetail(article.detail),
          contentRevision: article.contentRevision,
          position: 0,
          favoritedAt: article.detail.state.favorited ? now : null,
          readLaterAt: article.detail.state.readLater ? now : null,
          openedAt: now
        };
      const recent = [
        recentRef,
        ...snapshot.recent.filter((ref) => ref.article.id !== article.articleId)
      ].slice(0, 20).map((ref, position) => ({ ...ref, position }));
      snapshotsStore.put(snapshotWithArticleState({ ...snapshot, recent }, article.articleId, article.detail.state));
      return committed;
    });
}

async function touchOfflineArticle(scopeKey: string, articleId: string): Promise<void> {
  await offlineTransaction([PROFILES_STORE, ARTICLES_STORE, META_STORE], async (transaction) => {
    if (!(await writableProfile(transaction, scopeKey))?.deviceSettings.enabled) return;
    const articlesStore = transaction.objectStore(ARTICLES_STORE);
    const article = await requestResult<OfflineArticleRecord | undefined>(articlesStore.get(articleKey(scopeKey, articleId)));
    if (article) articlesStore.put({ ...article, lastAccessedAt: Date.now() });
  });
}

function deleteScopeRecordsInTransaction<T extends { scopeKey: string }>(
  transaction: IDBTransaction,
  storeName: string,
  scopeKey: string,
  keyForRecord: (record: T) => IDBValidKey
): void {
  const store = transaction.objectStore(storeName);
  const request = store.getAll();
  request.onsuccess = () => {
    for (const record of request.result as T[]) {
      if (record.scopeKey === scopeKey) store.delete(keyForRecord(record));
    }
  };
}

async function updateCachedArticleState(
  transaction: IDBTransaction,
  scopeKey: string,
  articleId: string,
  update: (state: ArticleState | undefined) => ArticleState
): Promise<void> {
  const profile = await writableProfile(transaction, scopeKey);
  if (!profile?.deviceSettings.enabled) return;
  const [article, snapshot] = await Promise.all([
    requestResult<OfflineArticleRecord | undefined>(transaction.objectStore(ARTICLES_STORE).get(articleKey(scopeKey, articleId))),
    profile?.activeSnapshotId
      ? requestResult<OfflineSnapshotRecord | undefined>(transaction.objectStore(SNAPSHOTS_STORE).get(
          snapshotKey(scopeKey, profile.activeSnapshotId)))
      : Promise.resolve(undefined)
  ]);
  const state = update(article?.detail.state ?? (snapshot && uniqueManifestArticles(snapshot)
    .find((ref) => ref.article.id === articleId)?.article.state));
  if (article) {
    transaction.objectStore(ARTICLES_STORE).put({
      ...article, detail: { ...article.detail, state }
    } satisfies OfflineArticleRecord);
  }
  if (snapshot) {
    transaction.objectStore(SNAPSHOTS_STORE).put(snapshotWithArticleState(snapshot, articleId, state));
  }
}

function snapshotWithArticleState(
  snapshot: OfflineSnapshotRecord, articleId: string, state: ArticleState
): OfflineSnapshotRecord {
  const updateRefs = (refs: OfflineManifestArticle[]) =>
    refs.map((ref) =>
      ref.article.id === articleId
        ? { ...ref, article: { ...ref.article, state } }
        : ref
    );
  const allRefs = uniqueManifestArticles(snapshot);
  const sourceRef = allRefs.find((ref) => ref.article.id === articleId);
  const now = new Date().toISOString();
  const updatedRef = sourceRef
    ? { ...sourceRef, article: { ...sourceRef.article, state } }
    : null;
  const readLater = state.readLater && updatedRef
    ? [
      { ...updatedRef, readLaterAt: updatedRef.readLaterAt ?? now },
      ...updateRefs(snapshot.readLater).filter((ref) => ref.article.id !== articleId)
    ].slice(0, 200).map((ref, position) => ({ ...ref, position }))
    : updateRefs(snapshot.readLater).filter((ref) => ref.article.id !== articleId);
  const recent = state.openedAt && updatedRef
    ? [
      { ...updatedRef, openedAt: new Date(state.openedAt).toISOString() },
      ...updateRefs(snapshot.recent).filter((ref) => ref.article.id !== articleId)
    ].slice(0, 20).map((ref, position) => ({ ...ref, position }))
    : updateRefs(snapshot.recent);
  return {
    ...snapshot,
    recommended: updateRefs(snapshot.recommended),
    readLater,
    recent
  };
}

function applyOfflineAction(state: ArticleState, action: OfflineActionRecord): ArticleState {
  let next = { ...state };
  const request = action.request;
  switch (request.type) {
    case "favorite": next.favorited = request.value; break;
    case "like": next.liked = request.value; break;
    case "read_later": next.readLater = request.value; break;
    case "open":
      next = { ...optimisticOpenedState(next), openedAt: action.createdAt };
      break;
    case "read_progress":
      next = { ...optimisticReadProgressState(next, request.progress),
        openedAt: next.openedAt ?? action.createdAt };
      break;
    case "mark_read":
      next.read = request.value;
      next.readingProgress = request.value ? 1 : 0;
      // Explicit unread is a reset, not progress merged with earlier reading.
      break;
    case "hide": next.hidden = true; break;
    case "not_interested":
      return { ...optimisticStateForArticleAction("notInterested", next), ignoredAt: action.createdAt };
    case "impression":
      if (next.interactionStatus === "unseen" && !next.openedAt && !next.read &&
        !next.favorited && !next.liked && !next.readLater && next.readingProgress === 0) {
        next.interactionStatus = "ignored";
        next.ignoredAt = action.createdAt;
      }
      return next;
  }
  // Saving/opening does not undo explicit not-interested; hide is one-way in the API.
  if (next.notInterested) return { ...next, interactionStatus: "ignored", ignoredAt: state.ignoredAt };
  return savedOptimisticState(next);
}

async function settleOfflineAction(
  action: OfflineActionRecord,
  result: { state: ArticleState } | { missing: true } | { errorCode: string; permanent: boolean }
): Promise<void> {
  await offlineTransaction(
    [PROFILES_STORE, ARTICLES_STORE, SNAPSHOTS_STORE, ACTIONS_STORE, META_STORE],
    async (transaction) => {
      const profile = await writableProfile(transaction, action.scopeKey);
      if (!profile?.deviceSettings.enabled) return;
      const store = transaction.objectStore(ACTIONS_STORE);
      const current = await requestResult<OfflineActionRecord | undefined>(store.get(action.clientActionId));
      if (!current || current.status !== "syncing" || current.attemptCount !== action.attemptCount) return;
      if ("errorCode" in result) {
        store.put({ ...current, status: result.permanent ? "failed" : "pending",
          lastErrorCode: result.errorCode } satisfies OfflineActionRecord);
        return;
      }
      store.delete(action.clientActionId);
      // A manifest fetched before this acknowledgement contains stale server state.
      transaction.objectStore(PROFILES_STORE).put({ ...profile, cacheGeneration: createClientActionId() });
      if ("missing" in result) {
        transaction.objectStore(ARTICLES_STORE).delete(articleKey(action.scopeKey, action.articleId));
        const snapshotsStore = transaction.objectStore(SNAPSHOTS_STORE);
        const snapshots = await requestResult<OfflineSnapshotRecord[]>(snapshotsStore.getAll());
        for (const snapshot of snapshots) {
          if (snapshot.scopeKey !== action.scopeKey) continue;
          const withoutArticle = (refs: OfflineManifestArticle[]) =>
            refs.filter((ref) => ref.article.id !== action.articleId);
          snapshotsStore.put({ ...snapshot,
            recommended: withoutArticle(snapshot.recommended),
            readLater: withoutArticle(snapshot.readLater),
            recent: withoutArticle(snapshot.recent)
          } satisfies OfflineSnapshotRecord);
        }
        return;
      }
      const remaining = (await actionsInTransaction(transaction, action.scopeKey))
        .filter((item) => item.articleId === action.articleId && item.sequence > action.sequence);
      await updateCachedArticleState(transaction, action.scopeKey, action.articleId,
        () => remaining.reduce(applyOfflineAction, result.state));
    }
  );
}

async function actionsInTransaction(transaction: IDBTransaction, scopeKey: string): Promise<OfflineActionRecord[]> {
  const actions = await requestResult<OfflineActionRecord[]>(transaction.objectStore(ACTIONS_STORE).getAll());
  return actions.filter((action) => action.scopeKey === scopeKey).sort((a, b) => a.sequence - b.sequence);
}

async function scopeRevokedInTransaction(transaction: IDBTransaction, scopeKey: string): Promise<boolean> {
  const marker = await requestResult<MetaRecord | undefined>(
    transaction.objectStore(META_STORE).get(revokedScopeMetaKey(scopeKey))
  );
  return Boolean(marker) || isOfflineScopeRevokedInStorage(scopeKey);
}

async function writableProfile(transaction: IDBTransaction, scopeKey: string): Promise<OfflineProfileRecord | null> {
  if (await scopeRevokedInTransaction(transaction, scopeKey)) return null;
  const profile = await requestResult<OfflineProfileRecord | undefined>(transaction.objectStore(PROFILES_STORE).get(scopeKey));
  return profile ? normalizeOfflineProfile(profile) : null;
}

// Await only IndexedDB requests inside work; external work would close the transaction.
async function offlineTransaction<T>(stores: string[], work: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(stores, "readwrite");
  const done = transactionDone(transaction);
  void done.catch(() => undefined);
  try {
    const result = await work(transaction);
    await done;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* Already completed or aborted. */ }
    await done.catch(() => undefined);
    throw error;
  }
}

async function requireProfile(scopeKey: string): Promise<OfflineProfileRecord> {
  const profile = await readOfflineProfile(scopeKey);
  if (!profile) throw new Error("Offline profile is not available");
  return profile;
}

async function requireActiveSnapshot(scopeKey: string): Promise<{
  profile: OfflineProfileRecord;
  snapshot: OfflineSnapshotRecord;
}> {
  const profile = await requireProfile(scopeKey);
  if (!profile.activeSnapshotId) throw new Error("Offline snapshot is not available");
  const snapshot = await getRecord<OfflineSnapshotRecord>(
    SNAPSHOTS_STORE,
    snapshotKey(scopeKey, profile.activeSnapshotId)
  );
  if (!snapshot) throw new Error("Offline snapshot is not available");
  return { profile, snapshot };
}

async function openOfflineDatabase(): Promise<IDBDatabase> {
  if (!isOfflineStorageSupported()) {
    throw new Error("IndexedDB is not supported");
  }
  if (!openDatabasePromise) {
    openDatabasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(PROFILES_STORE)) {
          database.createObjectStore(PROFILES_STORE, { keyPath: "scopeKey" });
        }
        if (!database.objectStoreNames.contains(SNAPSHOTS_STORE)) {
          database.createObjectStore(SNAPSHOTS_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(ARTICLES_STORE)) {
          database.createObjectStore(ARTICLES_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(ACTIONS_STORE)) {
          database.createObjectStore(ACTIONS_STORE, { keyPath: "clientActionId" });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open offline database"));
      request.onblocked = () => reject(new Error("Offline database upgrade is blocked"));
    }).catch((error) => {
      openDatabasePromise = null;
      throw error;
    });
  }
  const database = openDatabasePromise;
  if (!database) throw new Error("Offline database is not available");
  return await database;
}

async function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const request = transaction.objectStore(storeName).get(key);
  const result = await requestResult<T | undefined>(request);
  await transactionDone(transaction);
  return result;
}

async function putRecord(storeName: string, value: unknown): Promise<void> {
  await putRecords([{ store: storeName, value }]);
}

async function putRecords(records: Array<{ store: string; value: unknown }>): Promise<void> {
  if (records.length === 0) return;
  const database = await openOfflineDatabase();
  const storeNames = Array.from(new Set(records.map((record) => record.store)));
  const transaction = database.transaction(storeNames, "readwrite");
  for (const record of records) transaction.objectStore(record.store).put(record.value);
  await transactionDone(transaction);
}

async function deleteRecord(storeName: string, key: IDBValidKey): Promise<void> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

async function listScopeRecords<T extends { scopeKey: string }>(
  storeName: string,
  scopeKey: string
): Promise<T[]> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const result = await requestResult<T[]>(transaction.objectStore(storeName).getAll());
  await transactionDone(transaction);
  return result.filter((record) => record.scopeKey === scopeKey);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline database request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Offline database transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline database transaction failed"));
  });
}

async function runWithOfflineSyncLock(scopeKey: string, work: () => Promise<void>): Promise<void> {
  const locks = (navigator as Navigator & {
    locks?: { request: (name: string, callback: () => Promise<void>) => Promise<void> };
  }).locks;
  if (locks) {
    await locks.request(`dibao-offline-sync:${scopeKey}`, work);
    return;
  }
  const previous = inMemorySync;
  let release: () => void = () => undefined;
  inMemorySync = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await runWithOfflineSyncLease(scopeKey, work);
  } finally {
    release();
  }
}

async function runWithOfflineSyncLease(scopeKey: string, work: () => Promise<void>): Promise<void> {
  const owner = createClientActionId();
  while (!(await tryAcquireOfflineSyncLease(scopeKey, owner))) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250 + Math.random() * 250));
  }
  const heartbeat = window.setInterval(() => {
    void renewOfflineSyncLease(scopeKey, owner);
  }, SYNC_LEASE_DURATION_MS / 3);
  try {
    await work();
  } finally {
    window.clearInterval(heartbeat);
    await releaseOfflineSyncLease(scopeKey, owner);
  }
}

async function tryAcquireOfflineSyncLease(scopeKey: string, owner: string): Promise<boolean> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(META_STORE);
  const key = syncLeaseKey(scopeKey);
  const existing = parseSyncLease(await requestResult<MetaRecord | undefined>(store.get(key)));
  const now = Date.now();
  const acquired = !existing || existing.owner === owner || existing.expiresAt <= now;
  if (acquired) {
    store.put({
      key,
      value: JSON.stringify({ owner, expiresAt: now + SYNC_LEASE_DURATION_MS })
    } satisfies MetaRecord);
  }
  await done;
  return acquired;
}

async function renewOfflineSyncLease(scopeKey: string, owner: string): Promise<void> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(META_STORE);
  const key = syncLeaseKey(scopeKey);
  const existing = parseSyncLease(await requestResult<MetaRecord | undefined>(store.get(key)));
  if (existing?.owner === owner) {
    store.put({
      key,
      value: JSON.stringify({ owner, expiresAt: Date.now() + SYNC_LEASE_DURATION_MS })
    } satisfies MetaRecord);
  }
  await done;
}

async function releaseOfflineSyncLease(scopeKey: string, owner: string): Promise<void> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(META_STORE);
  const key = syncLeaseKey(scopeKey);
  const existing = parseSyncLease(await requestResult<MetaRecord | undefined>(store.get(key)));
  if (existing?.owner === owner) store.delete(key);
  await done;
}

function parseSyncLease(record: MetaRecord | undefined): {
  owner: string;
  expiresAt: number;
} | null {
  if (!record) return null;
  try {
    const value = JSON.parse(record.value) as { owner?: unknown; expiresAt?: unknown };
    return typeof value.owner === "string" && typeof value.expiresAt === "number"
      ? { owner: value.owner, expiresAt: value.expiresAt }
      : null;
  } catch {
    return null;
  }
}

function notifyOfflineStatusChanged(scopeKey: string): void {
  window.dispatchEvent(new CustomEvent("dibao:offline-status-changed", { detail: { scopeKey } }));
  try {
    const channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    channel.postMessage({ type: "status-changed", scopeKey });
    channel.close();
  } catch {
    // BroadcastChannel is optional; IndexedDB remains authoritative.
  }
}

export function activateOfflineImageScope(scopeKey: string | null): void {
  if (!scopeKey) {
    postOfflineWorkerMessage({ type: "SET_OFFLINE_SCOPE", scopeKey: null, cacheGeneration: null });
    return;
  }
  void readOfflineProfile(scopeKey).then((profile) => {
    if (!profile?.deviceSettings.enabled) return;
    postOfflineWorkerMessage({ type: "SET_OFFLINE_SCOPE", scopeKey,
      cacheGeneration: profile.cacheGeneration ?? null });
  }).catch(() => undefined);
}

function cacheArticleImages(scopeKey: string, articles: ArticleDetail[], cacheGeneration: string | null): void {
  const urls = offlineArticleImageUrls(articles);
  if (urls.length === 0) return;
  postOfflineWorkerMessage({
    type: "CACHE_ARTICLE_IMAGES",
    scopeKey,
    cacheGeneration,
    urls
  });
}

function pruneArticleImages(scopeKey: string, urls: string[], cacheGeneration: string | null): void {
  postOfflineWorkerMessage({
    type: "PRUNE_ARTICLE_IMAGES",
    scopeKey,
    cacheGeneration,
    urls: Array.from(new Set(urls))
  });
}

async function clearArticleImages(scopeKey: string): Promise<void> {
  if (!navigator.serviceWorker || typeof MessageChannel === "undefined") return;
  const profile = await getRecord<OfflineProfileRecord>(PROFILES_STORE, scopeKey).catch(() => undefined);
  await new Promise<void>((resolve) => {
    let finished = false;
    let channel: MessageChannel | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      channel?.port1.close();
      channel?.port2.close();
      resolve();
    };
    // Bound worker lookup as well as acknowledgement. ready never resolves if
    // the browser supports Service Workers but this page has no registration.
    const timer = window.setTimeout(finish, 2_000);
    void (async () => {
      const worker = navigator.serviceWorker.controller ??
        (await navigator.serviceWorker.getRegistration().catch(() => undefined))?.active;
      if (finished) return;
      if (!worker) {
        if (typeof caches !== "undefined") {
          await caches.delete(`${ARTICLE_IMAGE_CACHE_PREFIX}${encodeURIComponent(scopeKey)}`);
        }
        finish();
        return;
      }
      channel = new MessageChannel();
      channel.port1.onmessage = finish;
      worker.postMessage({ type: "CLEAR_ARTICLE_IMAGES", scopeKey,
        cacheGeneration: profile?.cacheGeneration ?? null }, [channel.port2]);
    })().catch(finish);
  });
}

function postOfflineWorkerMessage(message: unknown): void {
  const controller = navigator.serviceWorker?.controller;
  if (controller) {
    controller.postMessage(message);
    return;
  }
  void navigator.serviceWorker?.ready
    .then((registration) => registration.active?.postMessage(message))
    .catch(() => undefined);
}

function offlineArticleImageUrls(articles: ArticleDetail[]): string[] {
  const urlsByArticle = articles.map((article) =>
    imageUrls(article.contentHtml, article.url).slice(0, MAX_OFFLINE_IMAGES_PER_ARTICLE)
  );
  const urls = new Set<string>();
  for (let imageIndex = 0; imageIndex < MAX_OFFLINE_IMAGES_PER_ARTICLE; imageIndex += 1) {
    for (const articleUrls of urlsByArticle) {
      const url = articleUrls[imageIndex];
      if (url) urls.add(url);
      if (urls.size >= MAX_OFFLINE_IMAGE_URLS_PER_SYNC) return Array.from(urls);
    }
  }
  return Array.from(urls);
}

function imageUrls(html: string | null, articleUrl: string | null): string[] {
  if (!html || typeof DOMParser === "undefined") return [];
  const document = new DOMParser().parseFromString(html, "text/html");
  return Array.from(document.querySelectorAll("img[src]")).flatMap((image) => {
    const source = image.getAttribute("src")?.trim();
    if (!source) return [];
    const url = resolveOfflineArticleImageUrl(source, articleUrl);
    return url ? [url] : [];
  });
}

export function resolveOfflineArticleImageUrl(
  source: string,
  articleUrl: string | null,
  pageUrl = window.location.href
): string | null {
  try {
    const url = new URL(source, articleUrl?.trim() || pageUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !isSafeOfflineImageHostname(url.hostname)
    ) {
      return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function isSafeOfflineImageHostname(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
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

async function storageEstimate(): Promise<{
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}> {
  try {
    const [estimate, persisted] = await Promise.all([
      navigator.storage?.estimate?.() ?? Promise.resolve({}),
      navigator.storage?.persisted?.() ?? Promise.resolve(null)
    ]);
    return {
      usage: typeof estimate.usage === "number" ? estimate.usage : null,
      quota: typeof estimate.quota === "number" ? estimate.quota : null,
      persisted
    };
  } catch {
    return { usage: null, quota: null, persisted: null };
  }
}

async function estimateArticleImageBytes(scopeKey: string): Promise<number | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cacheName = `${ARTICLE_IMAGE_CACHE_PREFIX}${encodeURIComponent(scopeKey)}`;
    if (!(await caches.has(cacheName))) return 0;
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    const responses = await Promise.all(requests.map((request) => cache.match(request)));
    let total = 0;
    for (const response of responses) {
      if (!response) continue;
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength >= 0) {
        total += contentLength;
      } else {
        total += (await response.clone().blob()).size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

function estimateJsonBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return typeof TextEncoder === "undefined"
      ? json.length * 2
      : new TextEncoder().encode(json).byteLength;
  } catch {
    return null;
  }
}

function uniqueManifestArticles(input: Pick<OfflineManifest, "recommended" | "readLater" | "recent">): OfflineManifestArticle[] {
  const seen = new Set<string>();
  const result: OfflineManifestArticle[] = [];
  for (const ref of [...input.recommended, ...input.readLater, ...input.recent]) {
    if (!seen.has(ref.article.id)) {
      seen.add(ref.article.id);
      result.push(ref);
    }
  }
  return result;
}

function hasReadableArticle(article: ArticleDetail): boolean {
  return Boolean(article.contentText?.trim() || article.contentHtml?.trim() || article.summary?.trim());
}

function articleListItemForDetail(detail: ArticleDetail): ArticleListItem {
  const { contentHtml: _contentHtml, contentText: _contentText, extractionStatus: _status,
    extractionError: _error, ...article } = detail;
  return article;
}

function articleTimestamp(article: ArticleListItem): number {
  return Date.parse(article.publishedAt ?? article.discoveredAt) || 0;
}

function isoTimestamp(value: string | null): number {
  return value ? Date.parse(value) || 0 : 0;
}

function timeWindowCutoff(timeWindow: ArticleTimeWindow): number | null {
  const duration = timeWindow === "24h"
    ? 24 * 60 * 60 * 1000
    : timeWindow === "7d"
      ? 7 * 24 * 60 * 60 * 1000
      : timeWindow === "30d"
        ? 30 * 24 * 60 * 60 * 1000
        : null;
  return duration === null ? null : Date.now() - duration;
}

function offlineCursorArticleIds(cursor: string | null | undefined, snapshotId: string): string[] | null {
  if (!cursor?.startsWith("offline:v2:")) return null;
  try {
    const value = JSON.parse(decodeURIComponent(cursor.slice("offline:v2:".length))) as {
      snapshotId?: unknown; ids?: unknown;
    };
    return value.snapshotId === snapshotId && Array.isArray(value.ids) &&
      value.ids.every((id) => typeof id === "string") ? value.ids : null;
  } catch { return null; }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function snapshotKey(scopeKey: string, snapshotId: string): string {
  return `${scopeKey}::snapshot::${snapshotId}`;
}

function articleKey(scopeKey: string, articleId: string): string {
  return `${scopeKey}::article::${articleId}`;
}

function lastScopeKey(origin: string): string {
  return `last-scope::${origin}`;
}

function revokedScopeStorageKey(scopeKey: string): string {
  return `${REVOKED_SCOPE_STORAGE_PREFIX}${scopeKey}`;
}

function revokedScopeMetaKey(scopeKey: string): string {
  return `${REVOKED_SCOPE_META_PREFIX}${scopeKey}`;
}

function pendingServerLogoutStorageKey(origin: string): string {
  return `${PENDING_SERVER_LOGOUT_STORAGE_PREFIX}${origin}`;
}

function pendingServerLogoutMetaKey(origin: string): string {
  return `${PENDING_SERVER_LOGOUT_META_PREFIX}${origin}`;
}

function setStorageMarker(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readStorageMarker(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function syncLeaseKey(scopeKey: string): string {
  return `sync-lease::${scopeKey}`;
}

function createClientActionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
