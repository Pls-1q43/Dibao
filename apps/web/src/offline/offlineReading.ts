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

const DATABASE_NAME = "dibao-offline-reading";
const DATABASE_VERSION = 1;
const PROFILES_STORE = "profiles";
const SNAPSHOTS_STORE = "snapshots";
const ARTICLES_STORE = "articles";
const ACTIONS_STORE = "actions";
const META_STORE = "meta";
const ARTICLE_IMAGE_CACHE_PREFIX = "dibao:article-images:v1:";
export const DEFAULT_OFFLINE_RECOMMENDED_TARGET = 200;
export const MIN_OFFLINE_RECOMMENDED_TARGET = 50;
export const MAX_OFFLINE_RECOMMENDED_TARGET = 1_000;
const OFFLINE_PAGE_SIZE = 50;
const ARTICLE_BATCH_SIZE = 25;
const SYNC_CHANNEL_NAME = "dibao-offline-sync";
const SYNC_LEASE_DURATION_MS = 30_000;

export type OfflineDeviceSettings = {
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
let profileUpdateQueue: Promise<void> = Promise.resolve();

export function offlineScopeKey(username: string, origin = window.location.origin): string {
  return `${origin}::${username}`;
}

export async function rememberOfflineSession(username: string): Promise<OfflineProfileRecord> {
  const origin = window.location.origin;
  const scopeKey = offlineScopeKey(username, origin);
  const existing = await getRecord<OfflineProfileRecord>(PROFILES_STORE, scopeKey);
  const profile: OfflineProfileRecord = existing ?? {
    scopeKey,
    origin,
    username,
    activeSnapshotId: null,
    settings: null,
    feeds: [],
    folders: [],
    deviceSettings: { recommendedTarget: DEFAULT_OFFLINE_RECOMMENDED_TARGET },
    lastConnectedAt: null,
    updatedAt: Date.now()
  };
  profile.updatedAt = Date.now();
  await putRecords([
    { store: PROFILES_STORE, value: profile },
    {
      store: META_STORE,
      value: { key: lastScopeKey(origin), value: scopeKey } satisfies MetaRecord
    }
  ]);
  activateOfflineImageScope(scopeKey);
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
  const profile = await getRecord<OfflineProfileRecord>(PROFILES_STORE, meta.value);
  if (!profile || profile.origin !== origin) {
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
  return (await getRecord<OfflineProfileRecord>(PROFILES_STORE, scopeKey)) ?? null;
}

export async function updateOfflineProfile(
  scopeKey: string,
  patch: Partial<Pick<
    OfflineProfileRecord,
    "settings" | "feeds" | "folders" | "lastConnectedAt"
  >>
): Promise<void> {
  profileUpdateQueue = profileUpdateQueue.catch(() => undefined).then(async () => {
    const profile = await getRecord<OfflineProfileRecord>(PROFILES_STORE, scopeKey);
    if (!profile) return;
    await putRecord(PROFILES_STORE, {
      ...profile,
      ...patch,
      updatedAt: Date.now()
    });
  });
  await profileUpdateQueue;
}

export async function setOfflineRecommendedTarget(
  scopeKey: string,
  target: number
): Promise<number> {
  const profile = await requireProfile(scopeKey);
  const recommendedTarget = normalizeRecommendedTarget(target);
  await putRecord(PROFILES_STORE, {
    ...profile,
    deviceSettings: { recommendedTarget },
    updatedAt: Date.now()
  });
  if (profile.activeSnapshotId) {
    const snapshot = await getRecord<OfflineSnapshotRecord>(
      SNAPSHOTS_STORE,
      snapshotKey(scopeKey, profile.activeSnapshotId)
    );
    if (snapshot && snapshot.recommended.length > recommendedTarget) {
      await putRecord(SNAPSHOTS_STORE, {
        ...snapshot,
        recommendedTarget,
        recommended: snapshot.recommended.slice(0, recommendedTarget)
      } satisfies OfflineSnapshotRecord);
      await pruneOfflineArticles(scopeKey);
    }
  }
  notifyOfflineStatusChanged(scopeKey);
  return recommendedTarget;
}

export async function refreshOfflineSnapshot(
  scopeKey: string,
  api: Pick<OfflineApi, "getOfflineManifest" | "getOfflineArticles">
): Promise<OfflineCacheSummary> {
  const profile = await requireProfile(scopeKey);
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
  try {
    await commitSnapshot(profile, snapshot, articleRecords);
  } catch (error) {
    if (!isStorageQuotaError(error)) throw error;
    await clearArticleImages(scopeKey);
    await commitSnapshot(profile, snapshot, articleRecords);
  }
  const imageUrlsToKeep = articleRecords.flatMap((record) => imageUrls(record.detail.contentHtml));
  cacheArticleImages(scopeKey, articleRecords.map((record) => record.detail));
  pruneArticleImages(scopeKey, imageUrlsToKeep);
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
  const visible = candidates.flatMap((ref) => {
    const detail = detailsById.get(ref.article.id);
    if (!detail) {
      return [];
    }
    const article = { ...ref.article, state: detail.state };
    if (!isVisibleOfflineArticle(article, input, feedIdsForFolder)) {
      return [];
    }
    return [{ article, ref }];
  });
  visible.sort((left, right) => compareOfflineArticles(left, right, input));
  const unreadCount = visible.filter(
    ({ article }) => articleInteractionStatusForState(article.state) === "unseen"
  ).length;
  const offset = offlineCursorOffset(input.cursor);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? OFFLINE_PAGE_SIZE), 1), 100);
  const page = visible.slice(offset, offset + limit).map(({ article }) => article);
  return {
    data: page,
    nextCursor: offset + limit < visible.length ? `offline:${offset + limit}` : null,
    unreadCount
  };
}

export async function getOfflineArticleDetail(
  scopeKey: string,
  articleId: string
): Promise<ArticleDetail | null> {
  const record = await getRecord<OfflineArticleRecord>(ARTICLES_STORE, articleKey(scopeKey, articleId));
  if (!record) {
    return null;
  }
  void putRecord(ARTICLES_STORE, { ...record, lastAccessedAt: Date.now() });
  return record.detail;
}

export async function cacheOnlineArticleDetail(
  scopeKey: string,
  detail: ArticleDetail
): Promise<void> {
  if (!hasReadableArticle(detail)) {
    return;
  }
  const existing = await getRecord<OfflineArticleRecord>(
    ARTICLES_STORE,
    articleKey(scopeKey, detail.id)
  );
  await putRecord(ARTICLES_STORE, {
    key: articleKey(scopeKey, detail.id),
    scopeKey,
    articleId: detail.id,
    contentRevision: existing?.contentRevision ?? `opportunistic:${Date.now()}`,
    detail,
    cachedAt: Date.now(),
    lastAccessedAt: Date.now(),
    mediaStatus: "partial"
  } satisfies OfflineArticleRecord);
  const profile = await readOfflineProfile(scopeKey);
  if (profile?.activeSnapshotId) {
    const snapshot = await getRecord<OfflineSnapshotRecord>(
      SNAPSHOTS_STORE,
      snapshotKey(scopeKey, profile.activeSnapshotId)
    );
    if (snapshot) {
      const now = new Date().toISOString();
      const existing = uniqueManifestArticles(snapshot).find((ref) => ref.article.id === detail.id);
      const recentRef: OfflineManifestArticle = existing
        ? { ...existing, article: { ...existing.article, state: detail.state }, openedAt: now }
        : {
            article: articleListItemForDetail(detail),
            contentRevision: `opportunistic:${Date.now()}`,
            position: 0,
            favoritedAt: detail.state.favorited ? now : null,
            readLaterAt: detail.state.readLater ? now : null,
            openedAt: now
          };
      const recent = [
        recentRef,
        ...snapshot.recent.filter((ref) => ref.article.id !== detail.id)
      ].slice(0, 20).map((ref, position) => ({ ...ref, position }));
      await putRecord(SNAPSHOTS_STORE, { ...snapshot, recent } satisfies OfflineSnapshotRecord);
    }
  }
  cacheArticleImages(scopeKey, [detail]);
  notifyOfflineStatusChanged(scopeKey);
}

export async function queueOfflineArticleAction(input: {
  scopeKey: string;
  articleId: string;
  request: ArticleActionRequest;
  state: ArticleState;
}): Promise<OfflineActionRecord> {
  const actions = await listScopeRecords<OfflineActionRecord>(ACTIONS_STORE, input.scopeKey);
  const now = Date.now();
  if (input.request.type === "read_progress") {
    const existing = actions
      .filter((action) =>
        action.articleId === input.articleId &&
        action.status === "pending" &&
        action.request.type === "read_progress"
      )
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (existing && existing.request.type === "read_progress") {
      const action: OfflineActionRecord = {
        ...existing,
        request: {
          ...existing.request,
          progress: Math.max(existing.request.progress, input.request.progress),
          metadata: { ...(existing.request.metadata ?? {}), ...(input.request.metadata ?? {}), origin: "offline" }
        }
      };
      await putRecord(ACTIONS_STORE, action);
      await updateCachedArticleState(input.scopeKey, input.articleId, input.state);
      notifyOfflineStatusChanged(input.scopeKey);
      return action;
    }
  }
  const field = compressibleActionField(input.request.type);
  if (field) {
    await Promise.all(
      actions
        .filter((action) =>
          action.articleId === input.articleId &&
          action.status === "pending" &&
          compressibleActionField(action.request.type) === field
        )
        .map((action) => deleteRecord(ACTIONS_STORE, action.clientActionId))
    );
  }
  const clientActionId = createClientActionId();
  const action: OfflineActionRecord = {
    clientActionId,
    scopeKey: input.scopeKey,
    articleId: input.articleId,
    sequence: actions.reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
    createdAt: now,
    request: {
      ...input.request,
      clientActionId,
      metadata: { ...(input.request.metadata ?? {}), origin: "offline" }
    },
    status: "pending",
    attemptCount: 0,
    lastErrorCode: null
  };
  await putRecord(ACTIONS_STORE, action);
  await updateCachedArticleState(input.scopeKey, input.articleId, input.state);
  notifyOfflineStatusChanged(input.scopeKey);
  return action;
}

export async function syncOfflineArticleActions(
  scopeKey: string,
  api: Pick<OfflineApi, "postArticleAction">
): Promise<void> {
  await runWithOfflineSyncLock(scopeKey, async () => {
    const actions = (await listScopeRecords<OfflineActionRecord>(ACTIONS_STORE, scopeKey))
      .filter((action) => action.status !== "failed")
      .sort((left, right) => left.sequence - right.sequence);
    let completedAny = false;
    for (const action of actions) {
      await putRecord(ACTIONS_STORE, {
        ...action,
        status: "syncing",
        attemptCount: action.attemptCount + 1
      } satisfies OfflineActionRecord);
      try {
        const result = await api.postArticleAction(action.articleId, action.request);
        await updateCachedArticleState(scopeKey, action.articleId, result.state);
        await deleteRecord(ACTIONS_STORE, action.clientActionId);
        completedAny = true;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) {
          await deleteRecord(ACTIONS_STORE, action.clientActionId);
          await deleteRecord(ARTICLES_STORE, articleKey(scopeKey, action.articleId));
          completedAny = true;
          continue;
        }
        const permanent = isPermanentActionFailure(error);
        await putRecord(ACTIONS_STORE, {
          ...action,
          status: permanent ? "failed" : "pending",
          attemptCount: action.attemptCount + 1,
          lastErrorCode: error instanceof ApiRequestError ? error.code : "NETWORK_ERROR"
        } satisfies OfflineActionRecord);
        if (!permanent) {
          notifyOfflineStatusChanged(scopeKey);
          throw error;
        }
      }
    }
    if (completedAny) {
      await pruneOfflineArticles(scopeKey);
    }
    notifyOfflineStatusChanged(scopeKey);
  });
}

export async function retryFailedOfflineActions(scopeKey: string): Promise<void> {
  const failed = (await listScopeRecords<OfflineActionRecord>(ACTIONS_STORE, scopeKey))
    .filter((action) => action.status === "failed")
    .map((action) => ({
      store: ACTIONS_STORE,
      value: {
        ...action,
        status: "pending",
        lastErrorCode: null
      } satisfies OfflineActionRecord
    }));
  await putRecords(failed);
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
  const availableIds = snapshot
    ? new Set(uniqueManifestArticles(snapshot).map((ref) => ref.article.id))
    : new Set<string>();
  const estimate = await storageEstimate();
  const bodyBytes = estimateJsonBytes({ profile, snapshot, articles, actions });
  return {
    targetCount: profile?.deviceSettings.recommendedTarget ?? DEFAULT_OFFLINE_RECOMMENDED_TARGET,
    availableCount: availableIds.size,
    recommendedCount: snapshot?.recommended.length ?? 0,
    readLaterCount: snapshot?.readLater.length ?? 0,
    recentCount: snapshot?.recent.length ?? 0,
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
  const [snapshots, articles, actions, lastScope] = await Promise.all([
    listScopeRecords<OfflineSnapshotRecord>(SNAPSHOTS_STORE, scopeKey),
    listScopeRecords<OfflineArticleRecord>(ARTICLES_STORE, scopeKey),
    listScopeRecords<OfflineActionRecord>(ACTIONS_STORE, scopeKey),
    getRecord<MetaRecord>(META_STORE, lastScopeKey(origin))
  ]);
  const database = await openOfflineDatabase();
  const transaction = database.transaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE, ACTIONS_STORE, META_STORE],
    "readwrite"
  );
  transaction.objectStore(PROFILES_STORE).delete(scopeKey);
  for (const snapshot of snapshots) transaction.objectStore(SNAPSHOTS_STORE).delete(snapshot.key);
  for (const article of articles) transaction.objectStore(ARTICLES_STORE).delete(article.key);
  for (const action of actions) transaction.objectStore(ACTIONS_STORE).delete(action.clientActionId);
  if (lastScope?.value === scopeKey) {
    transaction.objectStore(META_STORE).delete(lastScopeKey(origin));
  }
  await transactionDone(transaction);
  await clearArticleImages(scopeKey);
}

export async function clearOfflineCache(scopeKey: string): Promise<void> {
  const profile = await requireProfile(scopeKey);
  const [snapshots, articles, actions] = await Promise.all([
    listScopeRecords<OfflineSnapshotRecord>(SNAPSHOTS_STORE, scopeKey),
    listScopeRecords<OfflineArticleRecord>(ARTICLES_STORE, scopeKey),
    listScopeRecords<OfflineActionRecord>(ACTIONS_STORE, scopeKey)
  ]);
  const database = await openOfflineDatabase();
  const transaction = database.transaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE, ACTIONS_STORE],
    "readwrite"
  );
  transaction.objectStore(PROFILES_STORE).put({
    ...profile,
    activeSnapshotId: null,
    updatedAt: Date.now()
  } satisfies OfflineProfileRecord);
  for (const snapshot of snapshots) transaction.objectStore(SNAPSHOTS_STORE).delete(snapshot.key);
  for (const article of articles) transaction.objectStore(ARTICLES_STORE).delete(article.key);
  for (const action of actions) transaction.objectStore(ACTIONS_STORE).delete(action.clientActionId);
  await transactionDone(transaction);
  await clearArticleImages(scopeKey);
  notifyOfflineStatusChanged(scopeKey);
}

export function isOfflineFallbackError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  if (error instanceof ApiRequestError) {
    return error.status >= 500;
  }
  return error instanceof TypeError ||
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError");
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

async function pruneOfflineArticles(scopeKey: string): Promise<void> {
  const profile = await readOfflineProfile(scopeKey);
  if (!profile?.activeSnapshotId) return;
  const [snapshot, articles, actions] = await Promise.all([
    getRecord<OfflineSnapshotRecord>(
      SNAPSHOTS_STORE,
      snapshotKey(scopeKey, profile.activeSnapshotId)
    ),
    listScopeRecords<OfflineArticleRecord>(ARTICLES_STORE, scopeKey),
    listScopeRecords<OfflineActionRecord>(ACTIONS_STORE, scopeKey)
  ]);
  if (!snapshot) return;
  const retainedIds = new Set(uniqueManifestArticles(snapshot).map((ref) => ref.article.id));
  for (const action of actions) retainedIds.add(action.articleId);
  const retainedArticles = articles.filter((article) => retainedIds.has(article.articleId));
  await Promise.all(
    articles
      .filter((article) => !retainedIds.has(article.articleId))
      .map((article) => deleteRecord(ARTICLES_STORE, article.key))
  );
  pruneArticleImages(
    scopeKey,
    retainedArticles.flatMap((article) => imageUrls(article.detail.contentHtml))
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
  if (type === "mark_read") return "read";
  if (type === "open") return "open";
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
): Promise<void> {
  const database = await openOfflineDatabase();
  const transaction = database.transaction(
    [PROFILES_STORE, SNAPSHOTS_STORE, ARTICLES_STORE],
    "readwrite"
  );
  const snapshotsStore = transaction.objectStore(SNAPSHOTS_STORE);
  if (profile.activeSnapshotId && profile.activeSnapshotId !== snapshot.id) {
    const previousRequest = snapshotsStore.get(snapshotKey(profile.scopeKey, profile.activeSnapshotId));
    previousRequest.onsuccess = () => {
      const previous = previousRequest.result as OfflineSnapshotRecord | undefined;
      if (previous) snapshotsStore.put({ ...previous, status: "superseded" });
    };
  }
  for (const article of articles) transaction.objectStore(ARTICLES_STORE).put(article);
  snapshotsStore.put(snapshot);
  transaction.objectStore(PROFILES_STORE).put({
    ...profile,
    activeSnapshotId: snapshot.id,
    updatedAt: Date.now()
  } satisfies OfflineProfileRecord);
  await transactionDone(transaction);
}

async function updateCachedArticleState(
  scopeKey: string,
  articleId: string,
  state: ArticleState
): Promise<void> {
  const profile = await readOfflineProfile(scopeKey);
  const [article, snapshot] = await Promise.all([
    getRecord<OfflineArticleRecord>(ARTICLES_STORE, articleKey(scopeKey, articleId)),
    profile?.activeSnapshotId
      ? getRecord<OfflineSnapshotRecord>(
          SNAPSHOTS_STORE,
          snapshotKey(scopeKey, profile.activeSnapshotId)
        )
      : Promise.resolve(undefined)
  ]);
  const writes: Array<{ store: string; value: unknown }> = [];
  if (article) {
    writes.push({
      store: ARTICLES_STORE,
      value: { ...article, detail: { ...article.detail, state } } satisfies OfflineArticleRecord
    });
  }
  if (snapshot) {
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
    writes.push({
      store: SNAPSHOTS_STORE,
      value: {
        ...snapshot,
        recommended: updateRefs(snapshot.recommended),
        readLater,
        recent
      } satisfies OfflineSnapshotRecord
    });
  }
  if (writes.length > 0) await putRecords(writes);
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
  const message = { type: "SET_OFFLINE_SCOPE", scopeKey };
  navigator.serviceWorker?.controller?.postMessage(message);
  void navigator.serviceWorker?.ready
    .then((registration) => registration.active?.postMessage(message))
    .catch(() => undefined);
}

function cacheArticleImages(scopeKey: string, articles: ArticleDetail[]): void {
  const urls = Array.from(new Set(articles.flatMap((article) => imageUrls(article.contentHtml))));
  if (urls.length === 0) return;
  postOfflineWorkerMessage({
    type: "CACHE_ARTICLE_IMAGES",
    scopeKey,
    urls
  });
}

function pruneArticleImages(scopeKey: string, urls: string[]): void {
  postOfflineWorkerMessage({
    type: "PRUNE_ARTICLE_IMAGES",
    scopeKey,
    urls: Array.from(new Set(urls))
  });
}

async function clearArticleImages(scopeKey: string): Promise<void> {
  if (!navigator.serviceWorker || typeof MessageChannel === "undefined") return;
  const worker = navigator.serviceWorker.controller ??
    (await navigator.serviceWorker.ready.catch(() => null))?.active;
  if (!worker) return;
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(resolve, 2_000);
    channel.port1.onmessage = () => {
      window.clearTimeout(timer);
      resolve();
    };
    worker.postMessage({ type: "CLEAR_ARTICLE_IMAGES", scopeKey }, [channel.port2]);
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

function imageUrls(html: string | null): string[] {
  if (!html || typeof DOMParser === "undefined") return [];
  const document = new DOMParser().parseFromString(html, "text/html");
  return Array.from(document.querySelectorAll("img[src]")).flatMap((image) => {
    const source = image.getAttribute("src")?.trim();
    if (!source) return [];
    try {
      const url = new URL(source, window.location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? [url.href] : [];
    } catch {
      return [];
    }
  });
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

function offlineCursorOffset(cursor: string | null | undefined): number {
  const match = cursor?.match(/^offline:(\d+)$/);
  return match ? Number(match[1]) : 0;
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

function syncLeaseKey(scopeKey: string): string {
  return `sync-lease::${scopeKey}`;
}

function createClientActionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
