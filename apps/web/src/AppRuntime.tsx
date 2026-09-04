import type { ChangeEvent, CSSProperties, FormEvent, MouseEvent, RefObject } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dibaoVersion } from "@dibao/shared";
import {
  ApiRequestError,
  defaultAppSettings,
  dibaoApi,
  userMessageForError,
  type ArticleActionRequest,
  type ArticleDetail,
  type ArticleListItem,
  type ArticleListResponse,
  type ArticleSearchSort,
  type ArticleSearchState,
  type ArticleState,
  type ArticleTimeWindow,
  type ArticleView,
  type AppSettings,
  type AuthSession,
  type CreateEmbeddingProviderInput,
  type DerivedDataUpgradeStatus,
  type EmbeddingIndex,
  type EmbeddingProvider,
  type EmbeddingProviderType,
  type FavoriteArticleSort,
  type Feed,
  type FeedDiagnosticItem,
  type FeedDiagnosticsResponse,
  type FeedDiscoveryCandidate,
  type FeedDiscoveryResponse,
  type FeedFolder,
  type FullContentBackfillResponse,
  type FullContentPreviewResponse,
  type JobListItem,
  type LatestReleaseStatus,
  type OpmlImportResponse,
  type PluginListItem,
  type RankExplanation,
  type RankExplanationReason,
  type ReadLaterArticleSort,
  type ReaderSettings,
  type ReaderDiscoveryResponse,
  type RelatedSearchResponse,
  type RecommendationInventory,
  type RecommendationStatus,
  type RecommendationClusterItem,
  type RecommendationClusterMergeCandidate,
  type RecommendationFamilySummaryItem,
  type RecommendationTransparency,
  type RecommendationMaintenanceTask,
  type RecommendationMaintenanceTaskResponse,
  type ClusterLabelLexiconResponse,
  type ClusterLabelLexiconOverrides,
  type ReaderCommandScope,
  type SetupStatus,
  type UpdateFeedFolderInput,
  type UpdateFeedInput,
  type UpdateEmbeddingProviderInput,
  type UpdateSettingsInput
} from "./api.js";
import {
  articleInteractionStatusForState,
  isArticleListIgnoreTelemetryEnabled,
  articleListAfterStateUpdate,
  articleListWithKnownLocalStates,
  articlesVisibleForUnreadFilter,
  shouldSkipPassiveIgnoreTelemetry,
  unreadCountWithKnownLocalStates,
  unreadCountAfterStateChange
} from "./articleListState.js";
import styles from "./design-system/AppShell/AppShell.module.css";
import { FeedManagementWorkspace } from "./FeedManagementPanel.js";
import {
  browserPreferredLocale,
  useI18n,
  type Dictionary,
  type Locale,
  type NavigationItemKey
} from "./i18n.js";
import {
  configureClientTelemetry,
  readStoredTelemetryPreference,
  storeTelemetryPreference
} from "./telemetry.js";
import { PwaStatusBanner, SetupWelcomePanel, AuthGatePanel, DerivedDataUpgradePanel, SetupSourcesPanel, SetupOptionalPluginsPanel } from "./setup/SetupPanels.js";
import { FeedPanel, ArticleListPanel, SearchResultsPanel, ArticleDetailPanel, ArticleExplanationDialog, NavigationIcon, ActionIcon, type OfflineReaderStatus, type PluginActionButton, type PluginActionContext, type ReaderDiscoveryPanelState } from "./reader/ReaderPanels.js";
import {
  activateOfflineImageScope,
  cacheOnlineArticleDetail,
  clearOfflineCache,
  clearOfflineScope,
  getOfflineArticleDetail,
  getOfflineCacheSummary,
  isOfflineModeActive,
  listOfflineArticles,
  offlineModePromptReasonForError,
  offlineScopeKey,
  queueOfflineArticleAction,
  readOfflineBootstrap,
  readOfflineProfile,
  refreshOfflineSnapshot,
  rememberOfflineSession,
  retryFailedOfflineActions,
  setOfflineReadingEnabled,
  setOfflineModeActive,
  setOfflineRecommendedTarget,
  syncOfflineArticleActions,
  updateOfflineProfile,
  type OfflineCacheSummary,
  type OfflineModePromptReason,
  type OfflineProfileRecord
} from "./offline/offlineReading.js";
import {
  actionErrorMessageFor,
  appendUniqueArticles,
  articleQueryFor,
  articleSortForView,
  canLoadRankExplanation,
  classNames,
  correctSourceSelection,
  countFeedsByFolder,
  defaultFavoriteArticleSort,
  defaultReadLaterArticleSort,
  defaultSearchForm,
  downloadTextFile,
  isNavigationItemActive,
  isRelatedSearchForm,
  isUtilityNavigationActive,
  maintenanceResultWasExisting,
  navigationItems,
  noticeTextFor,
  optimisticOpenedState,
  optimisticReadProgressState,
  optimisticStateForArticleAction,
  pageForNavigationItem,
  persistReaderFilters,
  readPersistedReaderFilters,
  readerFiltersForView,
  rememberArticleStates,
  requestForArticleAction,
  routeFromLocation,
  sameAppPage,
  sameSourceSelection,
  searchFormFromLocation,
  shouldLetBrowserHandleLinkClick,
  shouldLoadDetailRankExplanation,
  stageForAuthSession,
  stageForSetupStatus,
  supportsQuickFilters,
  supportsUnreadOnly,
  urlFavoriteSortParam,
  urlForAppPage,
  urlForArticle,
  urlForSearchPage,
  urlReadLaterSortParam,
  utilityNavigationItems,
  type AppPage,
  type AppStage,
  type ArticleActionIntent,
  type ArticleActionTarget,
  type AuthMode,
  type FeedDiagnosticsByFeedId,
  type Notice,
  type PendingArticleAction,
  type PwaUpdateAvailableEvent,
  type ReadProgressMetadata,
  type ReadProgressPostOptions,
  type SearchFormState,
  type SourceSelection
} from "./app/shared.js";

const LazySetupProviderPanel = lazy(() =>
  import("./setup/SetupProviderPanel.js").then((module) => ({ default: module.SetupProviderPanel }))
);

const IGNORE_TELEMETRY_BATCH_SIZE = 50;
const IGNORE_TELEMETRY_FLUSH_DELAY_MS = 250;
const IGNORE_TELEMETRY_TIMEOUT_MS = 8_000;
const ARTICLE_LIST_REQUEST_TIMEOUT_MS = 10_000;
const ARTICLE_LIST_FAILURE_TIMEOUT_MS = ARTICLE_LIST_REQUEST_TIMEOUT_MS * 3;
const ARTICLE_DETAIL_REQUEST_TIMEOUT_MS = 12_000;
const READER_DISCOVERY_REQUEST_TIMEOUT_MS = 10_000;
const AUTH_GATE_REQUEST_TIMEOUT_MS = 5_000;
const SERVER_AVAILABILITY_CHECK_INTERVAL_MS = 15_000;
const ARTICLE_STATE_OVERLAY_STORAGE_KEY = "dibao:article-state-overlay:v1";
const ARTICLE_STATE_OVERLAY_TTL_MS = 24 * 60 * 60 * 1000;
const ARTICLE_STATE_OVERLAY_LIMIT = 500;
const RECOMMENDATION_SESSION_STORAGE_PREFIX = "dibao:recommendation-session:v1:";
const AUTH_GATE_RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 10_000, 30_000] as const;
const AUTH_GATE_ERROR_VISIBLE_AFTER_ATTEMPT = 1;

function authGateRetryDelayMs(attempt: number): number {
  return AUTH_GATE_RETRY_DELAYS_MS[
    Math.min(attempt, AUTH_GATE_RETRY_DELAYS_MS.length - 1)
  ];
}

type IgnoredArticleQueueItem = {
  articleId: string;
  state: ArticleState;
  view: ArticleView;
};

type ArticleStateOverlayEntry = {
  articleId: string;
  state: ArticleState;
  updatedAt: number;
};

type ArticleStateOverlay = {
  states: Map<string, ArticleState>;
  locallyUpdatedIds: Set<string>;
};

type ReaderRecommendationSession = NonNullable<
  ArticleListResponse["meta"]["recommendationSession"]
> & {
  scopeKey: string;
};

function recommendationSessionScopeKey(
  selection: SourceSelection,
  unreadOnly: boolean,
  timeWindow: ArticleTimeWindow
): string {
  const source = selection.type === "all"
    ? "all"
    : selection.type === "feed"
      ? `feed:${selection.feedId}`
      : `folder:${selection.folderId}`;
  return `${source}|unread:${unreadOnly ? "1" : "0"}|time:${timeWindow}`;
}

function storedRecommendationSessionId(scopeKey: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage.getItem(
      `${RECOMMENDATION_SESSION_STORAGE_PREFIX}${scopeKey}`
    );
  } catch {
    return null;
  }
}

function storeRecommendationSessionId(scopeKey: string, sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(
      `${RECOMMENDATION_SESSION_STORAGE_PREFIX}${scopeKey}`,
      sessionId
    );
  } catch {
    // Recommendation continuity can fall back to a fresh server session.
  }
}

type PersonalizedRelatedRequestContext = {
  articleId: string;
  controller: AbortController;
  likeSucceeded: boolean;
  requestId: number;
  response?: ReaderDiscoveryResponse;
  failed?: boolean;
};

type OfflineConnectionMode = OfflineReaderStatus["mode"] | "online";

function emptyOfflineCacheSummary(targetCount = 200): OfflineCacheSummary {
  return {
    targetCount,
    availableCount: 0,
    recommendedCount: 0,
    readLaterCount: 0,
    recentCount: 0,
    pendingActionCount: 0,
    failedActionCount: 0,
    generatedAt: null,
    usageBytes: null,
    bodyBytes: null,
    imageBytes: null,
    quotaBytes: null,
    persisted: null
  };
}

const idleDiscoveryState: ReaderDiscoveryPanelState = {
  status: "idle",
  items: []
};

async function withRequestTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function withLongLoadingNotice<T>(
  noticeAfterMs: number,
  timeoutMs: number,
  onNotice: () => void,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const noticeId = window.setTimeout(onNotice, noticeAfterMs);
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    window.clearTimeout(noticeId);
    window.clearTimeout(timeoutId);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function articleDetailPlaceholder(article: ArticleListItem): ArticleDetail {
  return {
    ...article,
    contentHtml: null,
    contentText: article.summary,
    extractionStatus: "pending",
    extractionError: null
  };
}

function logReaderPerformance(event: string, data: Record<string, unknown>): void {
  if (typeof window === "undefined") {
    return;
  }
  const enabled =
    window.localStorage.getItem("dibao:perf") === "1" ||
    new URLSearchParams(window.location.search).get("perf") === "1";
  if (!enabled) {
    return;
  }
  console.debug("dibao.reader.performance", { event, ...data });
}
const LazyFullContentPreviewPage = lazy(() =>
  import("./fullContent/FullContentPreviewPage.js").then((module) => ({ default: module.FullContentPreviewPage }))
);
const LazySettingsWorkspace = lazy(() =>
  import("./settings/SettingsWorkspace.js").then((module) => ({ default: module.SettingsWorkspace }))
);
const LazyAlgorithmTransparencyPage = lazy(() =>
  import("./algorithm/AlgorithmPages.js").then((module) => ({ default: module.AlgorithmTransparencyPage }))
);
const LazyAlgorithmClustersPage = lazy(() =>
  import("./algorithm/AlgorithmPages.js").then((module) => ({ default: module.AlgorithmClustersPage }))
);

export function App() {
  const { locale, t, setLocale } = useI18n();
  const initialRoute = useMemo(
    () => routeFromLocation(defaultAppSettings.ui.defaultHomeView),
    []
  );
  const initialReaderFilters = useMemo(
    () =>
      readerFiltersForView(
        initialRoute.page.type === "reader"
          ? initialRoute.page.view
          : defaultAppSettings.ui.defaultHomeView
      ),
    [initialRoute.page]
  );
  const initialSearchForm = useMemo(() => searchFormFromLocation(), []);
  const initialArticleStateOverlay = useMemo(() => readArticleStateOverlay(), []);
  const [appStage, setAppStage] = useState<AppStage>({ type: "auth-loading" });
  const [authGateRetryToken, setAuthGateRetryToken] = useState(0);
  const [authUsername, setAuthUsername] = useState<string | null>(null);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [setupSourceError, setSetupSourceError] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [derivedDataUpgrade, setDerivedDataUpgrade] =
    useState<DerivedDataUpgradeStatus | null>(null);
  const [derivedDataUpgradeError, setDerivedDataUpgradeError] = useState<string | null>(null);
  const [isRetryingDerivedDataUpgrade, setIsRetryingDerivedDataUpgrade] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [telemetryEnabled, setTelemetryEnabled] = useState(() =>
    readStoredTelemetryPreference()
  );
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [pluginContributions, setPluginContributions] = useState<PluginListItem[]>([]);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [optionalPluginDecisionId, setOptionalPluginDecisionId] = useState<string | null>(null);
  const [embeddingProviders, setEmbeddingProviders] = useState<EmbeddingProvider[]>([]);
  const [embeddingIndexes, setEmbeddingIndexes] = useState<EmbeddingIndex[]>([]);
  const [isEmbeddingLoading, setIsEmbeddingLoading] = useState(false);
  const [isSavingEmbeddingProvider, setIsSavingEmbeddingProvider] = useState(false);
  const [activatingProviderId, setActivatingProviderId] = useState<string | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(null);
  const [rebuildingIndexId, setRebuildingIndexId] = useState<string | null>(null);
  const [backfillingIndexId, setBackfillingIndexId] = useState<string | null>(null);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);
  const [feedFolders, setFeedFolders] = useState<FeedFolder[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [sourceSelection, setSourceSelection] = useState<SourceSelection>(
    initialReaderFilters.sourceSelection
  );
  const [appPage, setAppPage] = useState<AppPage>(initialRoute.page);
  const [unreadOnly, setUnreadOnly] = useState(initialReaderFilters.unreadOnly);
  const [timeWindow, setTimeWindow] = useState<ArticleTimeWindow>(
    initialReaderFilters.timeWindow
  );
  const [searchForm, setSearchForm] = useState<SearchFormState>(initialSearchForm);
  const [hasSubmittedSearch, setHasSubmittedSearch] = useState(
    () =>
      initialRoute.page.type === "search" &&
      (initialSearchForm.q.trim().length > 0 || isRelatedSearchForm(initialSearchForm))
  );
  const [submittedSearchForm, setSubmittedSearchForm] = useState<SearchFormState>(
    initialSearchForm
  );
  const [relatedSearchMeta, setRelatedSearchMeta] = useState<{
    threshold: number;
    totalCount: number;
  } | null>(null);
  const [favoriteSort, setFavoriteSort] = useState<FavoriteArticleSort>(
    () => urlFavoriteSortParam() ?? defaultFavoriteArticleSort
  );
  const [readLaterSort, setReadLaterSort] = useState<ReadLaterArticleSort>(
    () => urlReadLaterSortParam() ?? defaultReadLaterArticleSort
  );
  const [isUtilityMenuOpen, setIsUtilityMenuOpen] = useState(false);
  const [isSourceDrawerOpen, setIsSourceDrawerOpen] = useState(false);
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(
    initialRoute.articleId
  );
  const [articleDetail, setArticleDetail] = useState<ArticleDetail | null>(null);
  const [relatedDiscovery, setRelatedDiscovery] =
    useState<ReaderDiscoveryPanelState>(idleDiscoveryState);
  const [personalizedDiscovery, setPersonalizedDiscovery] =
    useState<ReaderDiscoveryPanelState>(idleDiscoveryState);
  const [rankExplanation, setRankExplanation] = useState<RankExplanation | null>(null);
  const [listRankExplanation, setListRankExplanation] = useState<RankExplanation | null>(null);
  const [isExplanationOpen, setIsExplanationOpen] = useState(false);
  const [isListExplanationOpen, setIsListExplanationOpen] = useState(false);
  const [recommendationStatus, setRecommendationStatus] = useState<RecommendationStatus | null>(
    null
  );
  const [recommendationInventory, setRecommendationInventory] =
    useState<RecommendationInventory | null>(null);
  const [recommendationSession, setRecommendationSession] =
    useState<ReaderRecommendationSession | null>(null);
  const [allRecommendationClusters, setAllRecommendationClusters] = useState<
    RecommendationClusterItem[]
  >([]);
  const [allRecommendationClusterTotal, setAllRecommendationClusterTotal] = useState(0);
  const [isAllClustersLoading, setIsAllClustersLoading] = useState(false);
  const [allClustersError, setAllClustersError] = useState<string | null>(null);
  const [clusterLabelLexicon, setClusterLabelLexicon] =
    useState<ClusterLabelLexiconResponse | null>(null);
  const [mergeCandidates, setMergeCandidates] = useState<RecommendationClusterMergeCandidate[]>(
    []
  );
  const [runningMaintenanceTask, setRunningMaintenanceTask] =
    useState<RecommendationMaintenanceTask | null>(null);
  const [updatingClusterLabelId, setUpdatingClusterLabelId] = useState<string | null>(null);
  const [updatingFamilyLabelId, setUpdatingFamilyLabelId] = useState<string | null>(null);
  const [updatingClusterLexicon, setUpdatingClusterLexicon] = useState(false);
  const [updatingMergeCandidateId, setUpdatingMergeCandidateId] = useState<string | null>(null);
  const [isRecommendationStatusLoading, setIsRecommendationStatusLoading] = useState(false);
  const [isRecommendationInventoryLoading, setIsRecommendationInventoryLoading] = useState(false);
  const [recommendationStatusError, setRecommendationStatusError] = useState<string | null>(null);
  const [recommendationInventoryError, setRecommendationInventoryError] = useState<string | null>(
    null
  );
  const [feedUrl, setFeedUrl] = useState("");
  const [feedDiscovery, setFeedDiscovery] = useState<FeedDiscoveryResponse | null>(null);
  const [feedDiscoveryError, setFeedDiscoveryError] = useState<string | null>(null);
  const [isDiscoveringFeeds, setIsDiscoveringFeeds] = useState(false);
  const [feedDiagnostics, setFeedDiagnostics] = useState<FeedDiagnosticsResponse | null>(null);
  const [isFeedDiagnosticsLoading, setIsFeedDiagnosticsLoading] = useState(false);
  const [isFeedsLoading, setIsFeedsLoading] = useState(true);
  const [isArticlesLoading, setIsArticlesLoading] = useState(true);
  const [isLoadingMoreArticles, setIsLoadingMoreArticles] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailReloadRevision, setDetailReloadRevision] = useState(0);
  const [isExplanationLoading, setIsExplanationLoading] = useState(false);
  const [isListExplanationLoading, setIsListExplanationLoading] = useState(false);
  const [isAddingFeed, setIsAddingFeed] = useState(false);
  const [isImportingOpml, setIsImportingOpml] = useState(false);
  const [isExportingOpml, setIsExportingOpml] = useState(false);
  const [isRefreshingAllFeeds, setIsRefreshingAllFeeds] = useState(false);
  const [refreshingFeedId, setRefreshingFeedId] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [articleError, setArticleError] = useState<string | null>(null);
  const [articleLoadingNotice, setArticleLoadingNotice] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [explanationError, setExplanationError] = useState<string | null>(null);
  const [listExplanationError, setListExplanationError] = useState<string | null>(null);
  const [articleActionError, setArticleActionError] = useState<string | null>(null);
  const [readerCommandError, setReaderCommandError] = useState<string | null>(null);
  const [isMarkingScopeRead, setIsMarkingScopeRead] = useState(false);
  const [opmlSummary, setOpmlSummary] = useState<OpmlImportResponse | null>(null);
  const [nextArticleCursor, setNextArticleCursor] = useState<string | null>(null);
  const [pendingArticleAction, setPendingArticleAction] = useState<PendingArticleAction | null>(
    null
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isOffline, setIsOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false
  );
  const [offlineScope, setOfflineScope] = useState<string | null>(null);
  const [offlineProfile, setOfflineProfile] = useState<OfflineProfileRecord | null>(null);
  const [offlineSummary, setOfflineSummary] = useState<OfflineCacheSummary>(() =>
    emptyOfflineCacheSummary()
  );
  const [isUsingOfflineData, setIsUsingOfflineData] = useState(false);
  const [offlineConnectionMode, setOfflineConnectionMode] =
    useState<OfflineConnectionMode>("online");
  const [offlineModePrompt, setOfflineModePrompt] = useState<{
    reason: OfflineModePromptReason;
    availableCount: number;
  } | null>(null);
  const [isEnteringOfflineMode, setIsEnteringOfflineMode] = useState(false);
  const [isExitingOfflineMode, setIsExitingOfflineMode] = useState(false);
  const [isOfflineCacheRefreshing, setIsOfflineCacheRefreshing] = useState(false);
  const [offlineCacheError, setOfflineCacheError] = useState<string | null>(null);
  const [lastConnectedAt, setLastConnectedAt] = useState<number | null>(null);
  const [pwaUpdateApply, setPwaUpdateApply] = useState<(() => void) | null>(null);
  const openedArticleIds = useRef(new Set<string>());
  const ignoredArticleIds = useRef(new Set<string>());
  const ignoredArticleQueue = useRef<IgnoredArticleQueueItem[]>([]);
  const ignoredArticleInFlightIds = useRef(new Set<string>());
  const ignoredArticleFlushTimer = useRef<number | null>(null);
  const selectedArticleIdRef = useRef<string | null>(selectedArticleId);
  const articleStateById = useRef(new Map<string, ArticleState>(initialArticleStateOverlay.states));
  const locallyUpdatedArticleIds = useRef(
    new Set<string>(initialArticleStateOverlay.locallyUpdatedIds)
  );
  const articleRequestVersion = useRef(0);
  const detailExplanationRequestVersion = useRef(0);
  const listExplanationRequestVersion = useRef(0);
  const relatedDiscoveryRequestId = useRef(0);
  const relatedDiscoveryAbort = useRef<AbortController | null>(null);
  const personalizedDiscoveryRequestId = useRef(0);
  const personalizedDiscoveryRequest = useRef<PersonalizedRelatedRequestContext | null>(null);
  const reconnectInFlight = useRef(false);
  const serverAvailabilityCheckInFlight = useRef(false);
  const manualOfflineMode = useRef(false);
  const dismissedOfflinePromptReason = useRef<OfflineModePromptReason | null>(null);
  const offlinePromptRequestId = useRef(0);
  const hasScheduledOfflineRefresh = useRef<string | null>(null);
  const offlineTargetRefreshTimer = useRef<number | null>(null);
  const hasLoadedSettingsForSession = useRef(false);
  const hasAppliedDefaultHomeViewForSession = useRef(false);
  const appPageRef = useRef<AppPage>(appPage);
  const appStageRef = useRef<AppStage>(appStage);
  const hasExplicitUrlPageIntent = useRef(initialRoute.hasExplicitPage);
  const offlineReadingEnabled = offlineProfile?.deviceSettings.enabled !== false;

  const selectedFeed = useMemo(
    () =>
      sourceSelection.type === "feed"
        ? feeds.find((feed) => feed.id === sourceSelection.feedId) ?? null
        : null,
    [feeds, sourceSelection]
  );

  const selectedFolder = useMemo(
    () =>
      sourceSelection.type === "folder"
        ? feedFolders.find((folder) => folder.id === sourceSelection.folderId) ?? null
        : null,
    [feedFolders, sourceSelection]
  );
  const feedDiagnosticsByFeedId = useMemo<FeedDiagnosticsByFeedId>(() => {
    const diagnosticsByFeedId: FeedDiagnosticsByFeedId = {};
    for (const item of feedDiagnostics?.items ?? []) {
      diagnosticsByFeedId[item.feed.id] = item.diagnostic;
    }
    return diagnosticsByFeedId;
  }, [feedDiagnostics]);
  const currentArticleView = appPage.type === "reader" ? appPage.view : "latest";
  const articlesRef = useRef<ArticleListItem[]>(articles);
  const currentArticleViewRef = useRef<ArticleView>(currentArticleView);
  const articleListScrollKey = useMemo(
    () =>
      [
        "dibao:list-scroll",
        currentArticleView,
        sourceSelection.type,
        sourceSelection.type === "feed"
          ? sourceSelection.feedId
          : sourceSelection.type === "folder"
            ? sourceSelection.folderId
            : "all",
        unreadOnly ? "unread" : "all",
        timeWindow,
        currentArticleView === "favorites" ? favoriteSort : "",
        currentArticleView === "read_later" ? readLaterSort : ""
      ].join(":"),
    [
      currentArticleView,
      favoriteSort,
      readLaterSort,
      sourceSelection,
      timeWindow,
      unreadOnly
    ]
  );
  articlesRef.current = articles;
  currentArticleViewRef.current = currentArticleView;

  function applyArticleState(articleId: string, state: ArticleState) {
    const previousState =
      articleStateById.current.get(articleId) ??
      (articleDetail?.id === articleId ? articleDetail.state : null);
    articleStateById.current.set(articleId, state);
    locallyUpdatedArticleIds.current.delete(articleId);
    locallyUpdatedArticleIds.current.add(articleId);
    writeArticleStateOverlay(articleStateById.current, locallyUpdatedArticleIds.current);
    if (previousState) {
      setUnreadCount((current) =>
        unreadCountAfterStateChange(current, previousState, state)
      );
    }

    setArticles((current) => articleListAfterStateUpdate(current, articleId, state));
    setArticleDetail((current) =>
      current?.id === articleId
        ? {
            ...current,
            state
          }
        : current
    );
  }

  function clearSelectedArticle() {
    detailExplanationRequestVersion.current += 1;
    setSelectedArticleId(null);
    setArticleDetail(null);
    setRankExplanation(null);
    setIsExplanationOpen(false);
    setDetailError(null);
    setExplanationError(null);
  }

  function clearListExplanation() {
    listExplanationRequestVersion.current += 1;
    setListRankExplanation(null);
    setIsListExplanationOpen(false);
    setIsListExplanationLoading(false);
    setListExplanationError(null);
  }

  function reloadArticleStateOverlay() {
    const overlay = readArticleStateOverlay();
    articleStateById.current = overlay.states;
    locallyUpdatedArticleIds.current = overlay.locallyUpdatedIds;
    setArticles((current) =>
      articleListWithKnownLocalStates(
        current,
        articleStateById.current,
        locallyUpdatedArticleIds.current
      )
    );
    setArticleDetail((current) => {
      if (!current || !locallyUpdatedArticleIds.current.has(current.id)) {
        return current;
      }
      const state = articleStateById.current.get(current.id);
      return state ? { ...current, state } : current;
    });
  }

  function clearLocalArticleStates() {
    articleStateById.current.clear();
    locallyUpdatedArticleIds.current.clear();
    clearArticleStateOverlay();
  }

  function resetArticleListForPendingQuery() {
    articleRequestVersion.current += 1;
    setArticles([]);
    setUnreadCount(0);
    clearLocalArticleStates();
    setNextArticleCursor(null);
    clearSelectedArticle();
    clearListExplanation();
    setArticleError(null);
    setReaderCommandError(null);
    setLoadMoreError(null);
    setIsLoadingMoreArticles(false);
    setRelatedSearchMeta(null);
    setRecommendationSession(null);
  }

  function rememberRecommendationSession(
    session: ArticleListResponse["meta"]["recommendationSession"],
    scopeKey: string
  ): void {
    if (!session) {
      setRecommendationSession(null);
      return;
    }
    storeRecommendationSessionId(scopeKey, session.id);
    setRecommendationSession({ ...session, scopeKey });
  }

  function handleSelectSource(source: SourceSelection) {
    if (!sameSourceSelection(sourceSelection, source)) {
      resetArticleListForPendingQuery();
    }
    setSourceSelection(source);
    setIsSourceDrawerOpen(false);
  }

  function handleArticleViewChange(view: ArticleView) {
    if (appPage.type !== "reader" || appPage.view !== view) {
      resetArticleListForPendingQuery();
      if (supportsQuickFilters(view)) {
        const filters = readerFiltersForView(view);
        setSourceSelection(filters.sourceSelection);
        setUnreadOnly(filters.unreadOnly);
        setTimeWindow(filters.timeWindow);
      }
    }
    setAppPage({ type: "reader", view });
  }

  function handleFavoriteSortChange(nextSort: FavoriteArticleSort) {
    if (favoriteSort !== nextSort) {
      resetArticleListForPendingQuery();
    }
    setFavoriteSort(nextSort);
  }

  function handleReadLaterSortChange(nextSort: ReadLaterArticleSort) {
    if (readLaterSort !== nextSort) {
      resetArticleListForPendingQuery();
    }
    setReadLaterSort(nextSort);
  }

  function handleUnreadOnlyChange(nextUnreadOnly: boolean) {
    if (unreadOnly !== nextUnreadOnly) {
      resetArticleListForPendingQuery();
    }
    setUnreadOnly(nextUnreadOnly);
  }

  function handleTimeWindowChange(nextTimeWindow: ArticleTimeWindow) {
    if (timeWindow !== nextTimeWindow) {
      resetArticleListForPendingQuery();
    }
    setTimeWindow(nextTimeWindow);
  }

  function handleSearchFormChange(nextForm: SearchFormState) {
    if (nextForm.relatedArticle && !isRelatedSearchForm(nextForm)) {
      setSearchForm({
        ...nextForm,
        relatedArticle: null
      });
      return;
    }

    setSearchForm(nextForm);
  }

  function handleSearchSubmit(nextForm: SearchFormState) {
    if (isUsingOfflineData) return;
    const isRelated = isRelatedSearchForm(nextForm);
    const normalizedForm = {
      ...nextForm,
      q: nextForm.q.trim(),
      relatedArticle: isRelated ? nextForm.relatedArticle : null,
      fullText: isRelated ? false : nextForm.fullText,
      sort: isRelated ? "relevance" as const : nextForm.sort
    };
    resetArticleListForPendingQuery();
    setSearchForm(normalizedForm);
    setSubmittedSearchForm(normalizedForm);
    setHasSubmittedSearch(normalizedForm.q.length > 0 || isRelatedSearchForm(normalizedForm));
    window.history.pushState(
      { dibaoPage: "search" },
      "",
      urlForSearchPage(normalizedForm)
    );
  }

  const resetReaderState = useCallback(() => {
    setFeedFolders([]);
    setFeeds([]);
    setArticles([]);
    setUnreadCount(0);
    clearLocalArticleStates();
    setSourceSelection({ type: "all" });
    setAppPage({ type: "reader", view: defaultAppSettings.ui.defaultHomeView });
    setUnreadOnly(false);
    setTimeWindow("all");
    setSearchForm(defaultSearchForm());
    setSubmittedSearchForm(defaultSearchForm());
    setHasSubmittedSearch(false);
    setFavoriteSort(defaultFavoriteArticleSort);
    setReadLaterSort(defaultReadLaterArticleSort);
    setSelectedArticleId(null);
    setArticleDetail(null);
    detailExplanationRequestVersion.current += 1;
    setRankExplanation(null);
    setRecommendationStatus(null);
    setAllRecommendationClusters([]);
    setAllRecommendationClusterTotal(0);
    setIsAllClustersLoading(false);
    setAllClustersError(null);
    setClusterLabelLexicon(null);
    setMergeCandidates([]);
    setRunningMaintenanceTask(null);
    setUpdatingClusterLexicon(false);
    setUpdatingMergeCandidateId(null);
    setIsRecommendationStatusLoading(false);
    setRecommendationStatusError(null);
    setFeedUrl("");
    setIsFeedsLoading(false);
    setIsArticlesLoading(false);
    setIsLoadingMoreArticles(false);
    setIsDetailLoading(false);
    setIsExplanationLoading(false);
    setIsAddingFeed(false);
    setIsImportingOpml(false);
    setIsExportingOpml(false);
    setIsRefreshingAllFeeds(false);
    setRefreshingFeedId(null);
    setFeedError(null);
    setArticleError(null);
    setLoadMoreError(null);
    setDetailError(null);
    setExplanationError(null);
    setArticleActionError(null);
    setReaderCommandError(null);
    setIsMarkingScopeRead(false);
    setSetupSourceError(null);
    setAppSettings(defaultAppSettings);
    setIsSettingsLoading(false);
    setIsSavingSettings(false);
    setSettingsError(null);
    setEmbeddingProviders([]);
    setEmbeddingIndexes([]);
    setIsEmbeddingLoading(false);
    setIsSavingEmbeddingProvider(false);
    setActivatingProviderId(null);
    setTestingProviderId(null);
    setDeletingProviderId(null);
    setRebuildingIndexId(null);
    setEmbeddingError(null);
    setLocale(browserPreferredLocale());
    setOpmlSummary(null);
    setNextArticleCursor(null);
    setPendingArticleAction(null);
    setNotice(null);
    setOfflineScope(null);
    setOfflineProfile(null);
    setOfflineSummary(emptyOfflineCacheSummary());
    setIsUsingOfflineData(false);
    setOfflineConnectionMode("online");
    setOfflineModePrompt(null);
    setIsEnteringOfflineMode(false);
    setIsExitingOfflineMode(false);
    setIsOfflineCacheRefreshing(false);
    setOfflineCacheError(null);
    setLastConnectedAt(null);
    reconnectInFlight.current = false;
    manualOfflineMode.current = false;
    setOfflineModeActive(null);
    dismissedOfflinePromptReason.current = null;
    offlinePromptRequestId.current += 1;
    activateOfflineImageScope(null);
    hasLoadedSettingsForSession.current = false;
    hasAppliedDefaultHomeViewForSession.current = hasExplicitUrlPageIntent.current;
    openedArticleIds.current.clear();
    ignoredArticleIds.current.clear();
    ignoredArticleQueue.current = [];
    ignoredArticleInFlightIds.current.clear();
    if (ignoredArticleFlushTimer.current !== null) {
      window.clearTimeout(ignoredArticleFlushTimer.current);
      ignoredArticleFlushTimer.current = null;
    }
    if (offlineTargetRefreshTimer.current !== null) {
      window.clearTimeout(offlineTargetRefreshTimer.current);
      offlineTargetRefreshTimer.current = null;
    }
    articleRequestVersion.current += 1;
  }, [setLocale]);

  const applySettings = useCallback(
    (settings: AppSettings) => {
      setAppSettings(settings);
      setLocale(settings.ui.locale);
      setTelemetryEnabled(settings.telemetry.enabled);
      configureClientTelemetry(settings.telemetry.enabled);
    },
    [setLocale]
  );

  const applyOfflineBootstrap = useCallback(async (
    bootstrap: Awaited<ReturnType<typeof readOfflineBootstrap>>,
    mode: "offline" | "server-unavailable",
    options: { coldStart?: boolean } = {}
  ): Promise<boolean> => {
    if (!bootstrap) return false;
    const { profile, snapshot } = bootstrap;
    setOfflineScope(profile.scopeKey);
    setOfflineProfile(profile);
    setAuthUsername(profile.username);
    setFeeds(profile.feeds);
    setFeedFolders(profile.folders);
    setIsFeedsLoading(false);
    setFeedError(null);
    applySettings(profile.settings ?? defaultAppSettings);
    setIsSettingsLoading(false);
    setLastConnectedAt(profile.lastConnectedAt ?? null);
    setIsUsingOfflineData(true);
    setOfflineConnectionMode(snapshot ? mode : "empty");
    setOfflineSummary(await getOfflineCacheSummary(profile.scopeKey));
    setAppStage({ type: "reader" });
    const shouldOpenRecommended = options.coldStart ||
      !["reader", "settings"].includes(appPageRef.current.type);
    if (shouldOpenRecommended) {
      setAppPage({ type: "reader", view: "recommended" });
      setHasSubmittedSearch(false);
      setSearchForm(defaultSearchForm());
      setSubmittedSearchForm(defaultSearchForm());
      clearSelectedArticle();
      window.history.replaceState(
        { dibaoPage: "recommended" },
        "",
        urlForAppPage({ type: "reader", view: "recommended" })
      );
    }
    return true;
  }, [applySettings]);

  const markServerAvailable = useCallback(() => {
    setIsOffline(false);
    dismissedOfflinePromptReason.current = null;
    setOfflineModePrompt(null);
  }, []);

  const offerOfflineMode = useCallback(async (
    reason: OfflineModePromptReason
  ): Promise<boolean> => {
    if (
      manualOfflineMode.current ||
      isUsingOfflineData ||
      dismissedOfflinePromptReason.current === reason
    ) {
      return false;
    }
    const requestId = offlinePromptRequestId.current + 1;
    offlinePromptRequestId.current = requestId;
    try {
      const bootstrap = await readOfflineBootstrap();
      if (!bootstrap?.snapshot || requestId !== offlinePromptRequestId.current) return false;
      const summary = await getOfflineCacheSummary(bootstrap.profile.scopeKey);
      if (summary.availableCount <= 0 || requestId !== offlinePromptRequestId.current) return false;
      setOfflineSummary(summary);
      setOfflineModePrompt({ reason, availableCount: summary.availableCount });
      return true;
    } catch {
      return false;
    }
  }, [isUsingOfflineData]);

  const offerOfflineModeForError = useCallback(async (error: unknown): Promise<boolean> => {
    const reason = offlineModePromptReasonForError(error);
    return reason ? offerOfflineMode(reason) : false;
  }, [offerOfflineMode]);

  const checkServerAvailability = useCallback(async (): Promise<boolean> => {
    if (
      manualOfflineMode.current ||
      isUsingOfflineData ||
      serverAvailabilityCheckInFlight.current
    ) {
      return false;
    }
    if (navigator.onLine === false) {
      setIsOffline(true);
      await offerOfflineMode("network-offline");
      return false;
    }

    serverAvailabilityCheckInFlight.current = true;
    try {
      await withRequestTimeout(AUTH_GATE_REQUEST_TIMEOUT_MS, (signal) =>
        dibaoApi.getAuthSession(signal)
      );
      markServerAvailable();
      return true;
    } catch (error) {
      await offerOfflineModeForError(error);
      return false;
    } finally {
      serverAvailabilityCheckInFlight.current = false;
    }
  }, [isUsingOfflineData, markServerAvailable, offerOfflineMode, offerOfflineModeForError]);

  const handleEnterOfflineMode = useCallback(async () => {
    if (!offlineModePrompt || isEnteringOfflineMode) return;
    const reason = offlineModePrompt.reason;
    setIsEnteringOfflineMode(true);
    offlinePromptRequestId.current += 1;
    try {
      const bootstrap = await readOfflineBootstrap();
      if (!bootstrap?.snapshot) return;
      manualOfflineMode.current = true;
      const activated = await applyOfflineBootstrap(bootstrap, reason === "server-unavailable"
        ? "server-unavailable"
        : "offline", {
        coldStart: appStage.type === "auth-loading" || appStage.type === "setup-status-loading"
      });
      if (!activated) {
        manualOfflineMode.current = false;
        return;
      }
      setOfflineModeActive(bootstrap.profile.scopeKey);
      dismissedOfflinePromptReason.current = null;
      setOfflineModePrompt(null);
      setAuthError(null);
    } finally {
      setIsEnteringOfflineMode(false);
    }
  }, [appStage.type, applyOfflineBootstrap, isEnteringOfflineMode, offlineModePrompt]);

  const handleDismissOfflinePrompt = useCallback(() => {
    if (offlineModePrompt) dismissedOfflinePromptReason.current = offlineModePrompt.reason;
    offlinePromptRequestId.current += 1;
    setOfflineModePrompt(null);
    if (
      appStageRef.current.type === "auth-loading" ||
      appStageRef.current.type === "setup-status-loading"
    ) {
      setAuthGateRetryToken((value) => value + 1);
    }
  }, [offlineModePrompt]);

  const handleRetryAuthGate = useCallback(() => {
    setAuthError(null);
    setAppStage({ type: "auth-loading" });
    setAuthGateRetryToken((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadAuthSession() {
      if (manualOfflineMode.current) return;
      try {
        const bootstrap = await readOfflineBootstrap();
        if (bootstrap?.snapshot && isOfflineModeActive(bootstrap.profile.scopeKey)) {
          manualOfflineMode.current = true;
          if (await applyOfflineBootstrap(bootstrap, "offline", { coldStart: true })) return;
          manualOfflineMode.current = false;
          setOfflineModeActive(null);
        }
      } catch {
        manualOfflineMode.current = false;
        setOfflineModeActive(null);
      }
      if (cancelled) return;
      setAppStage({ type: "auth-loading" });
      setAuthError(null);

      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          const session = await withRequestTimeout(AUTH_GATE_REQUEST_TIMEOUT_MS, (signal) =>
            dibaoApi.getAuthSession(signal)
          );
          if (!cancelled && !manualOfflineMode.current) {
            manualOfflineMode.current = false;
            markServerAvailable();
            const nextStage = stageForAuthSession(session);
            setAuthUsername(session.authenticated ? session.username : null);
            if (session.authenticated && session.username) {
              try {
                const profile = await rememberOfflineSession(session.username);
                if (cancelled) return;
                setOfflineScope(profile.scopeKey);
                setOfflineProfile(profile);
                setOfflineSummary(await getOfflineCacheSummary(profile.scopeKey));
                setIsUsingOfflineData(false);
                setOfflineConnectionMode("online");
                const connectedAt = Date.now();
                setLastConnectedAt(connectedAt);
                void updateOfflineProfile(profile.scopeKey, { lastConnectedAt: connectedAt });
              } catch {
                // IndexedDB availability must not block normal online startup.
              }
            }
            if (nextStage.type === "welcome" || nextStage.type === "login") {
              resetReaderState();
            }
            setAppStage(nextStage);
          }
          return;
        } catch (error) {
          if (cancelled || manualOfflineMode.current) return;
          if (await offerOfflineModeForError(error)) return;
          if (!cancelled) {
            setAuthError(
              attempt >= AUTH_GATE_ERROR_VISIBLE_AFTER_ATTEMPT
                ? `${t.auth.errors.session} ${userMessageForError(error, t.errors.api)}`
                : null
            );
            setAppStage({ type: "auth-loading" });
          }
          await delay(authGateRetryDelayMs(attempt));
        }
      }
    }

    void loadAuthSession();

    return () => {
      cancelled = true;
    };
  }, [
    applyOfflineBootstrap,
    authGateRetryToken,
    markServerAvailable,
    offerOfflineModeForError,
    resetReaderState,
    t.auth.errors.session,
    t.errors.api
  ]);

  useEffect(() => {
    function handleOnline() {
      setIsOffline(false);
      if (!manualOfflineMode.current && appStageRef.current.type === "auth-loading") {
        setAuthGateRetryToken((value) => value + 1);
      }
    }

    function handleOffline() {
      setIsOffline(true);
      void offerOfflineMode("network-offline");
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    const browserOffline = navigator.onLine === false;
    setIsOffline(browserOffline);
    if (browserOffline) {
      void offerOfflineMode("network-offline");
    }

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [offerOfflineMode]);

  useEffect(() => {
    function handlePwaUpdateAvailable(event: Event) {
      setPwaUpdateApply(() => (event as PwaUpdateAvailableEvent).detail.applyUpdate);
    }

    window.addEventListener("dibao:pwa-update-available", handlePwaUpdateAvailable);

    return () => {
      window.removeEventListener("dibao:pwa-update-available", handlePwaUpdateAvailable);
    };
  }, []);

  useEffect(() => {
    if (appStage.type !== "setup-status-loading") {
      return;
    }

    let cancelled = false;

    async function loadSetupStatus() {
      setAuthError(null);

      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          const status = await withRequestTimeout(AUTH_GATE_REQUEST_TIMEOUT_MS, (signal) =>
            dibaoApi.getSetupStatus(signal)
          );
          if (!cancelled && !manualOfflineMode.current) {
            markServerAvailable();
            setDerivedDataUpgrade(status.coreDatabaseMigration ?? status.derivedDataUpgrade ?? null);
            const nextStage = stageForSetupStatus(status);
            if (nextStage.type === "welcome") {
              resetReaderState();
            }
            setAppStage(nextStage);
          }
          return;
        } catch (error) {
          if (cancelled || manualOfflineMode.current) return;
          if (await offerOfflineModeForError(error)) return;
          if (!cancelled) {
            setAuthError(
              attempt >= AUTH_GATE_ERROR_VISIBLE_AFTER_ATTEMPT
                ? `${t.auth.errors.setupStatus} ${userMessageForError(error, t.errors.api)}`
                : null
            );
            setAppStage({ type: "setup-status-loading" });
          }
          await delay(authGateRetryDelayMs(attempt));
        }
      }
    }

    void loadSetupStatus();

    return () => {
      cancelled = true;
    };
  }, [
    appStage.type,
    authGateRetryToken,
    markServerAvailable,
    offerOfflineModeForError,
    resetReaderState,
    t.auth.errors.setupStatus,
    t.errors.api
  ]);

  useEffect(() => {
    if (appStage.type !== "derived-data-upgrade") {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    async function pollUpgradeStatus() {
      try {
        const status = await dibaoApi.getDerivedDataUpgradeStatus();
        if (cancelled) {
          return;
        }
        setDerivedDataUpgrade(status);
        setDerivedDataUpgradeError(null);
        if (!status.blocking) {
          setAppStage({ type: "setup-status-loading" });
          return;
        }
      } catch (error) {
        if (!cancelled) {
          setDerivedDataUpgradeError(userMessageForError(error, t.errors.api));
        }
      }

      if (!cancelled) {
        timer = window.setTimeout(pollUpgradeStatus, 1500);
      }
    }

    void pollUpgradeStatus();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [appStage.type, t.errors.api]);

  useEffect(() => {
    if (appStage.type !== "reader" || isUsingOfflineData) {
      return;
    }

    let cancelled = false;

    async function loadPluginContributions() {
      try {
        const plugins = await dibaoApi.listPluginContributions();
        if (!cancelled) {
          setPluginContributions(plugins);
          setPluginError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setPluginError(userMessageForError(error, t.errors.api));
        }
      }
    }

    void loadPluginContributions();

    return () => {
      cancelled = true;
    };
  }, [appStage.type, isUsingOfflineData, t.errors.api]);

  useEffect(() => {
    appPageRef.current = appPage;
  }, [appPage]);

  useEffect(() => {
    appStageRef.current = appStage;
  }, [appStage]);

  useEffect(() => {
    selectedArticleIdRef.current = selectedArticleId;
  }, [selectedArticleId]);

  useEffect(() => {
    if (appStage.type !== "reader" || hasLoadedSettingsForSession.current) {
      return;
    }

    if (isUsingOfflineData) {
      hasLoadedSettingsForSession.current = true;
      applySettings(offlineProfile?.settings ?? defaultAppSettings);
      setIsSettingsLoading(false);
      return;
    }

    hasLoadedSettingsForSession.current = true;
    let cancelled = false;

    async function loadSettings() {
      setIsSettingsLoading(true);
      setSettingsError(null);

      try {
        const settings = await dibaoApi.getSettings();
        if (!cancelled) {
          applySettings(settings);
          if (offlineScope) void updateOfflineProfile(offlineScope, { settings });
          const currentAppPage = appPageRef.current;
          if (
            !hasAppliedDefaultHomeViewForSession.current &&
            !hasExplicitUrlPageIntent.current &&
            currentAppPage.type === "reader" &&
            currentAppPage.view !== settings.ui.defaultHomeView
          ) {
            resetArticleListForPendingQuery();
            setAppPage({ type: "reader", view: settings.ui.defaultHomeView });
          }
          hasAppliedDefaultHomeViewForSession.current = true;
        }
      } catch (error) {
        if (!cancelled) {
          setSettingsError(userMessageForError(error, t.errors.api));
          applySettings(defaultAppSettings);
          hasAppliedDefaultHomeViewForSession.current = true;
        }
      } finally {
        if (!cancelled) {
          setIsSettingsLoading(false);
        }
      }
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [appStage.type, applySettings, isUsingOfflineData, offlineProfile?.settings, offlineScope, t.errors.api]);

  const loadEmbeddingSettings = useCallback(async (options: { includeIndexes?: boolean } = {}) => {
    setIsEmbeddingLoading(true);
    setEmbeddingError(null);

    try {
      const includeIndexes = options.includeIndexes ?? true;
      const [providers, indexes] = await Promise.all([
        dibaoApi.listEmbeddingProviders(),
        includeIndexes ? dibaoApi.listEmbeddingIndexes() : Promise.resolve([])
      ]);
      setEmbeddingProviders(providers);
      setEmbeddingIndexes(indexes);
    } catch (error) {
      setEmbeddingError(userMessageForError(error, t.errors.api));
    } finally {
      setIsEmbeddingLoading(false);
    }
  }, [t.errors.api]);

  useEffect(() => {
    if (
      isUsingOfflineData ||
      (appStage.type !== "reader" || appPage.type !== "settings") &&
      appStage.type !== "setup-provider"
    ) {
      return;
    }

    void loadEmbeddingSettings({ includeIndexes: false });
  }, [appPage.type, appStage.type, isUsingOfflineData, loadEmbeddingSettings]);

  const refreshArticleExplanation = useCallback(async (articleId: string) => {
    const requestVersion = detailExplanationRequestVersion.current + 1;
    detailExplanationRequestVersion.current = requestVersion;
    setIsExplanationLoading(true);
    setExplanationError(null);

    try {
      const explanation = await dibaoApi.getArticleExplanation(articleId);
      if (detailExplanationRequestVersion.current === requestVersion) {
        setRankExplanation(explanation);
      }
    } catch (error) {
      if (detailExplanationRequestVersion.current === requestVersion) {
        setRankExplanation(null);
        setExplanationError(userMessageForError(error, t.errors.api));
      }
    } finally {
      if (detailExplanationRequestVersion.current === requestVersion) {
        setIsExplanationLoading(false);
      }
    }
  }, [t.errors.api]);

  const loadRecommendationStatus = useCallback(async () => {
    setIsRecommendationStatusLoading(true);
    setRecommendationStatusError(null);

    try {
      const status = await dibaoApi.getRecommendationTransparency({
        includeClusterItems: true,
        clusterItemLimit: 10,
        clusterDetailLevel: "summary"
      });
      setRecommendationStatus(status);
    } catch (error) {
      setRecommendationStatus(null);
      setRecommendationStatusError(userMessageForError(error, t.errors.api));
    } finally {
      setIsRecommendationStatusLoading(false);
    }
  }, [t.errors.api]);

  const loadRecommendationDiagnostics = useCallback(async () => {
    try {
      const [lexicon, candidates] = await Promise.all([
        dibaoApi.getClusterLabelLexicon(),
        dibaoApi.listRecommendationClusterMergeCandidates("all")
      ]);
      setClusterLabelLexicon(lexicon);
      setMergeCandidates(candidates.candidates);
    } catch (error) {
      setRecommendationStatusError(userMessageForError(error, t.errors.api));
    }
  }, [t.errors.api]);

  const loadRecommendationSummaryStatus = useCallback(async () => {
    setIsRecommendationStatusLoading(true);
    setRecommendationStatusError(null);

    try {
      const status = await dibaoApi.getRecommendationStatus({ includeClusterItems: false });
      setRecommendationStatus(status);
      setClusterLabelLexicon(null);
      setMergeCandidates([]);
    } catch (error) {
      setRecommendationStatus(null);
      setClusterLabelLexicon(null);
      setMergeCandidates([]);
      setRecommendationStatusError(userMessageForError(error, t.errors.api));
    } finally {
      setIsRecommendationStatusLoading(false);
    }
  }, [t.errors.api]);

  const loadAllRecommendationClusters = useCallback(async () => {
    setIsAllClustersLoading(true);
    setAllClustersError(null);

    try {
      const result = await dibaoApi.listRecommendationClusters("all", {
        clusterDetailLevel: "summary"
      });
      setAllRecommendationClusters(result.items);
      setAllRecommendationClusterTotal(result.total);
    } catch (error) {
      setAllRecommendationClusters([]);
      setAllRecommendationClusterTotal(0);
      setAllClustersError(userMessageForError(error, t.errors.api));
    } finally {
      setIsAllClustersLoading(false);
    }
  }, [t.errors.api]);

  const loadFeeds = useCallback(async () => {
    setIsFeedsLoading(true);
    setFeedError(null);

    if (isUsingOfflineData) {
      setIsFeedsLoading(false);
      return;
    }

    try {
      const nextFeeds = await dibaoApi.listFeeds();
      setFeeds(nextFeeds);
      if (offlineScope) void updateOfflineProfile(offlineScope, { feeds: nextFeeds });
      setSourceSelection((current) =>
        current.type === "feed" && !nextFeeds.some((feed) => feed.id === current.feedId)
          ? { type: "all" }
          : current
      );
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    } finally {
      setIsFeedsLoading(false);
    }
  }, [isUsingOfflineData, offlineScope, t.errors.api]);

  const loadFeedDiagnostics = useCallback(async () => {
    setIsFeedDiagnosticsLoading(true);

    try {
      setFeedDiagnostics(await dibaoApi.getFeedDiagnostics());
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    } finally {
      setIsFeedDiagnosticsLoading(false);
    }
  }, [t.errors.api]);

  const loadFeedFolders = useCallback(async () => {
    if (isUsingOfflineData) return;
    try {
      const nextFolders = await dibaoApi.listFeedFolders();
      setFeedFolders(nextFolders);
      if (offlineScope) void updateOfflineProfile(offlineScope, { folders: nextFolders });
      setSourceSelection((current) =>
        current.type === "folder" &&
        !nextFolders.some((folder) => folder.id === current.folderId)
          ? { type: "all" }
          : current
      );
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    }
  }, [isUsingOfflineData, offlineScope, t.errors.api]);

  const refreshOfflineCacheNow = useCallback(async (): Promise<OfflineCacheSummary> => {
    if (!offlineScope) throw new Error("Offline profile is not available");
    setIsOfflineCacheRefreshing(true);
    setOfflineCacheError(null);
    try {
      await syncOfflineArticleActions(offlineScope, dibaoApi);
      const summary = await refreshOfflineSnapshot(offlineScope, dibaoApi);
      setOfflineSummary(summary);
      return summary;
    } catch (error) {
      const summary = await getOfflineCacheSummary(offlineScope).catch(() => emptyOfflineCacheSummary());
      setOfflineSummary(summary);
      setOfflineCacheError(userMessageForError(error, t.errors.api));
      throw error;
    } finally {
      setIsOfflineCacheRefreshing(false);
    }
  }, [offlineScope, t.errors.api]);

  const reconnectToServer = useCallback(async (): Promise<boolean> => {
    if (!offlineScope || navigator.onLine === false) return false;
    setOfflineConnectionMode("reconnecting");
    setOfflineCacheError(null);
    try {
      const session = await withRequestTimeout(AUTH_GATE_REQUEST_TIMEOUT_MS, (signal) =>
        dibaoApi.getAuthSession(signal)
      );
      if (
        !session.authenticated ||
        !session.username ||
        offlineScopeKey(session.username) !== offlineScope
      ) {
        throw new ApiRequestError(401, "AUTH_REQUIRED", "Authentication required");
      }
      await syncOfflineArticleActions(offlineScope, dibaoApi);
      await withRequestTimeout(ARTICLE_LIST_REQUEST_TIMEOUT_MS, (signal) =>
        dibaoApi.listArticles({ view: "recommended", limit: 1, includeUnreadCount: false, signal })
      );
      const summary = await refreshOfflineSnapshot(offlineScope, dibaoApi);
      setOfflineSummary(summary);
      setOfflineConnectionMode(summary.failedActionCount > 0 ? "sync-failed" : "online");
      manualOfflineMode.current = false;
      setOfflineModeActive(null);
      setIsUsingOfflineData(false);
      markServerAvailable();
      const connectedAt = Date.now();
      setLastConnectedAt(connectedAt);
      await updateOfflineProfile(offlineScope, { lastConnectedAt: connectedAt });
      setArticleError(null);
      return true;
    } catch (error) {
      setOfflineSummary(
        await getOfflineCacheSummary(offlineScope).catch(() => emptyOfflineCacheSummary())
      );
      setOfflineConnectionMode(
        error instanceof ApiRequestError && error.status >= 500
          ? "server-unavailable"
          : error instanceof ApiRequestError && error.status < 500
            ? "sync-failed"
            : "offline"
      );
      setOfflineCacheError(userMessageForError(error, t.errors.api));
      return false;
    }
  }, [markServerAvailable, offlineScope, t.errors.api]);

  const retryOfflineSync = useCallback(async () => {
    if (!offlineScope || navigator.onLine === false || reconnectInFlight.current) return;
    reconnectInFlight.current = true;
    setIsExitingOfflineMode(true);
    try {
      await retryFailedOfflineActions(offlineScope);
      setOfflineSummary(await getOfflineCacheSummary(offlineScope));
      await reconnectToServer();
    } finally {
      reconnectInFlight.current = false;
      setIsExitingOfflineMode(false);
    }
  }, [offlineScope, reconnectToServer]);

  useEffect(() => {
    if (!isOffline || isUsingOfflineData) return;
    void offerOfflineMode("network-offline");
  }, [isOffline, isUsingOfflineData, offerOfflineMode]);

  useEffect(() => {
    if (
      appStage.type !== "reader" ||
      isUsingOfflineData ||
      !offlineReadingEnabled ||
      !offlineScope ||
      offlineSummary.availableCount <= 0
    ) {
      return;
    }

    const checkWhenVisible = () => {
      if (document.visibilityState !== "hidden") {
        void checkServerAvailability();
      }
    };
    const interval = window.setInterval(
      checkWhenVisible,
      SERVER_AVAILABILITY_CHECK_INTERVAL_MS
    );

    window.addEventListener("focus", checkWhenVisible);
    window.addEventListener("pageshow", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkWhenVisible);
      window.removeEventListener("pageshow", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [
    appStage.type,
    checkServerAvailability,
    isUsingOfflineData,
    offlineReadingEnabled,
    offlineScope,
    offlineSummary.availableCount
  ]);

  useEffect(() => {
    if (
      appStage.type !== "reader" ||
      isUsingOfflineData ||
      isOffline ||
      !offlineReadingEnabled ||
      !offlineScope ||
      hasScheduledOfflineRefresh.current === offlineScope
    ) {
      return;
    }
    hasScheduledOfflineRefresh.current = offlineScope;
    const timer = window.setTimeout(() => {
      void refreshOfflineCacheNow().catch(() => {
        hasScheduledOfflineRefresh.current = null;
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [
    appStage.type,
    isOffline,
    isUsingOfflineData,
    offlineReadingEnabled,
    offlineScope,
    refreshOfflineCacheNow
  ]);

  useEffect(() => {
    if (!offlineScope) return;
    const updateSummary = () => {
      void Promise.all([
        getOfflineCacheSummary(offlineScope),
        readOfflineProfile(offlineScope)
      ]).then(([summary, profile]) => {
        setOfflineSummary(summary);
        if (!profile) return;
        const nextEnabled = profile.deviceSettings.enabled;
        if (nextEnabled !== offlineReadingEnabled) {
          hasScheduledOfflineRefresh.current = null;
          if (offlineTargetRefreshTimer.current !== null) {
            window.clearTimeout(offlineTargetRefreshTimer.current);
            offlineTargetRefreshTimer.current = null;
          }
        }
        activateOfflineImageScope(nextEnabled ? offlineScope : null);
        setOfflineProfile(profile);
        if (!nextEnabled && isUsingOfflineData) {
          setOfflineConnectionMode("empty");
          setArticles([]);
          setNextArticleCursor(null);
          setArticleDetail(null);
          setSelectedArticleId(null);
        }
      }).catch(() => undefined);
    };
    const handleLocalStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ scopeKey?: string }>).detail;
      if (detail?.scopeKey === offlineScope) updateSummary();
    };
    window.addEventListener("dibao:offline-status-changed", handleLocalStatus);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("dibao-offline-sync");
      channel.onmessage = (event: MessageEvent<{ scopeKey?: string }>) => {
        if (event.data?.scopeKey === offlineScope) updateSummary();
      };
    } catch {
      channel = null;
    }
    return () => {
      window.removeEventListener("dibao:offline-status-changed", handleLocalStatus);
      channel?.close();
    };
  }, [isUsingOfflineData, offlineReadingEnabled, offlineScope]);

  const loadArticles = useCallback(async (
    selection: SourceSelection,
    view: ArticleView,
    onlyUnread: boolean,
    sort: FavoriteArticleSort = defaultFavoriteArticleSort,
    laterSort: ReadLaterArticleSort = defaultReadLaterArticleSort,
    selectedTimeWindow: ArticleTimeWindow = "all"
  ) => {
    const requestVersion = articleRequestVersion.current + 1;
    articleRequestVersion.current = requestVersion;
    setIsArticlesLoading(true);
    setArticleError(null);
    setArticleLoadingNotice(null);
    setLoadMoreError(null);
    setNextArticleCursor(null);
    if (view !== "recommended" && appPage.type !== "algorithm-transparency") {
      setRecommendationStatus(null);
      setIsRecommendationStatusLoading(false);
      setRecommendationStatusError(null);
      setRecommendationInventory(null);
      setIsRecommendationInventoryLoading(false);
      setRecommendationInventoryError(null);
    }
    setDetailError(null);
    setExplanationError(null);

    try {
      const activeRecommendationScopeKey = recommendationSessionScopeKey(
        selection,
        onlyUnread,
        selectedTimeWindow
      );
      const persistedRecommendationSessionId =
        view === "recommended"
          ? storedRecommendationSessionId(activeRecommendationScopeKey)
          : null;
      const requestInput = {
        ...articleQueryFor(selection),
        view,
        limit: 50,
        unreadOnly: supportsUnreadOnly(view) ? onlyUnread : false,
        timeWindow: supportsQuickFilters(view) ? selectedTimeWindow : "all",
        sort: articleSortForView(view, sort, laterSort),
        recommendationSessionId: persistedRecommendationSessionId
      };
      if (isUsingOfflineData && offlineScope) {
        if (offlineConnectionMode === "empty") {
          setArticles([]);
          setUnreadCount(0);
          setNextArticleCursor(null);
          return;
        }
        const response = await listOfflineArticles(offlineScope, {
          ...articleQueryFor(selection),
          view,
          unreadOnly: supportsUnreadOnly(view) ? onlyUnread : false,
          timeWindow: supportsQuickFilters(view) ? selectedTimeWindow : "all",
          favoriteSort: sort,
          readLaterSort: laterSort,
          limit: 50
        });
        const responseArticles = articleListWithKnownLocalStates(
          response.data,
          articleStateById.current,
          locallyUpdatedArticleIds.current
        );
        rememberArticleStates(responseArticles, articleStateById.current);
        setArticles(responseArticles);
        setUnreadCount(response.unreadCount);
        setNextArticleCursor(response.nextCursor);
        setRecommendationSession(null);
        return;
      }
      const requestStartedAt = performance.now();
      const response = await withLongLoadingNotice(
        ARTICLE_LIST_REQUEST_TIMEOUT_MS,
        ARTICLE_LIST_FAILURE_TIMEOUT_MS,
        () => {
          if (requestVersion === articleRequestVersion.current) {
            setArticleLoadingNotice(t.articles.loadingSlow);
          }
        },
        (signal) =>
          dibaoApi.listArticles({
            ...requestInput,
            includeUnreadCount: false,
            signal
          })
      );
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      markServerAvailable();
      setArticleLoadingNotice(null);
      const responseArticles = articleListWithKnownLocalStates(
        response.data,
        articleStateById.current,
        locallyUpdatedArticleIds.current
      );
      rememberArticleStates(responseArticles, articleStateById.current);
      if (view === "recommended") {
        rememberRecommendationSession(
          response.meta.recommendationSession,
          activeRecommendationScopeKey
        );
      }
      setArticles(
        articlesVisibleForUnreadFilter(responseArticles, supportsUnreadOnly(view) && onlyUnread)
      );
      logReaderPerformance("articleList.loaded", {
        view,
        requestMs: Math.round(performance.now() - requestStartedAt),
        articlesLength: responseArticles.length,
        hasMore: response.page.nextCursor !== null
      });
      if (response.meta.unreadCount !== null) {
        setUnreadCount(
          unreadCountWithKnownLocalStates(
            response.meta.unreadCount,
            response.data,
            articleStateById.current,
            locallyUpdatedArticleIds.current
          )
        );
      }
      setNextArticleCursor(response.page.nextCursor);
      window.setTimeout(() => {
        if (requestVersion !== articleRequestVersion.current) {
          return;
        }
        void withRequestTimeout(ARTICLE_LIST_REQUEST_TIMEOUT_MS, (signal) =>
          dibaoApi.listArticles({
            ...requestInput,
            limit: 1,
            recommendationSessionId:
              response.meta.recommendationSession?.id ?? persistedRecommendationSessionId,
            includeUnreadCount: true,
            signal
          })
        )
          .then((countResponse) => {
            if (
              requestVersion === articleRequestVersion.current &&
              countResponse.meta.unreadCount !== null
            ) {
              setUnreadCount(
                unreadCountWithKnownLocalStates(
                  countResponse.meta.unreadCount,
                  response.data,
                  articleStateById.current,
                  locallyUpdatedArticleIds.current
                )
              );
            }
          })
          .catch(() => undefined);
      }, 300);
    } catch (error) {
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      if (!isUsingOfflineData) await offerOfflineModeForError(error);
      setArticleLoadingNotice(null);
      setArticleError(userMessageForError(error, t.errors.api));
      setNextArticleCursor(null);
    } finally {
      if (requestVersion === articleRequestVersion.current) {
        setIsArticlesLoading(false);
      }
    }
  }, [
    appPage.type,
    isUsingOfflineData,
    markServerAvailable,
    offlineConnectionMode,
    offlineScope,
    offerOfflineModeForError,
    t.articles.loadingSlow,
    t.errors.api
  ]);

  const loadSearchArticles = useCallback(async (form: SearchFormState) => {
    const requestVersion = articleRequestVersion.current + 1;
    articleRequestVersion.current = requestVersion;
    setIsArticlesLoading(true);
    setArticleError(null);
    setArticleLoadingNotice(null);
    setLoadMoreError(null);
    setNextArticleCursor(null);
    setDetailError(null);
    setExplanationError(null);
    setRecommendationStatus(null);
    setIsRecommendationStatusLoading(false);
    setRecommendationStatusError(null);

    try {
      const relatedArticleId = isRelatedSearchForm(form) ? form.relatedArticle?.id ?? null : null;
      const requestInput = {
        ...articleQueryFor(form.sourceSelection),
        q: form.q.trim(),
        state: form.state,
        sort: relatedArticleId ? "relevance" as const : form.sort,
        fullText: relatedArticleId ? false : form.fullText,
        from: form.from || null,
        to: form.to || null,
        limit: 50
      };
      const requestStartedAt = performance.now();
      const response = await withLongLoadingNotice(
        ARTICLE_LIST_REQUEST_TIMEOUT_MS,
        ARTICLE_LIST_FAILURE_TIMEOUT_MS,
        () => {
          if (requestVersion === articleRequestVersion.current) {
            setArticleLoadingNotice(t.articles.loadingSlow);
          }
        },
        (signal) =>
          relatedArticleId
            ? dibaoApi.getRelatedSearchArticles(relatedArticleId, {
                limit: requestInput.limit,
                state: form.state,
                signal
              })
            : dibaoApi.searchArticles({
                ...requestInput,
                includeUnreadCount: false,
                signal
              })
      );
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      markServerAvailable();
      setArticleLoadingNotice(null);
      const responseArticles = articleListWithKnownLocalStates(
        response.data,
        articleStateById.current,
        locallyUpdatedArticleIds.current
      );
      rememberArticleStates(responseArticles, articleStateById.current);
      setArticles(responseArticles);
      setRelatedSearchMeta(
        relatedArticleId && isRelatedSearchResponse(response)
          ? {
              threshold: response.threshold,
              totalCount: response.totalCount
            }
          : null
      );
      logReaderPerformance("searchList.loaded", {
        requestMs: Math.round(performance.now() - requestStartedAt),
        articlesLength: responseArticles.length,
        hasMore: response.page.nextCursor !== null
      });
      if (response.meta.unreadCount !== null) {
        setUnreadCount(
          unreadCountWithKnownLocalStates(
            response.meta.unreadCount,
            response.data,
            articleStateById.current,
            locallyUpdatedArticleIds.current
          )
        );
      }
      setNextArticleCursor(response.page.nextCursor);
      if (!relatedArticleId) {
        window.setTimeout(() => {
          if (requestVersion !== articleRequestVersion.current) {
            return;
          }
          void withRequestTimeout(ARTICLE_LIST_REQUEST_TIMEOUT_MS, (signal) =>
            dibaoApi.searchArticles({
              ...requestInput,
              limit: 1,
              includeUnreadCount: true,
              signal
            })
          )
            .then((countResponse) => {
              if (
                requestVersion === articleRequestVersion.current &&
                countResponse.meta.unreadCount !== null
              ) {
                setUnreadCount(
                  unreadCountWithKnownLocalStates(
                    countResponse.meta.unreadCount,
                    response.data,
                    articleStateById.current,
                    locallyUpdatedArticleIds.current
                  )
                );
              }
            })
            .catch(() => undefined);
        }, 300);
      }
    } catch (error) {
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      await offerOfflineModeForError(error);
      setArticleLoadingNotice(null);
      setArticleError(userMessageForError(error, t.errors.api));
      setNextArticleCursor(null);
    } finally {
      if (requestVersion === articleRequestVersion.current) {
        setIsArticlesLoading(false);
      }
    }
  }, [markServerAvailable, offerOfflineModeForError, t.articles.loadingSlow, t.errors.api]);

  useEffect(() => {
    if (appStage.type !== "reader" || isUsingOfflineData) {
      return;
    }

    if (appPage.type === "feed-management") {
      void Promise.all([loadFeedFolders(), loadFeeds(), loadFeedDiagnostics()]);
      return;
    }

    void Promise.all([loadFeedFolders(), loadFeeds()]);
  }, [appPage.type, appStage.type, loadFeedDiagnostics, loadFeedFolders, loadFeeds]);

  useEffect(() => {
    if (appStage.type !== "reader" || appPage.type !== "reader") {
      return;
    }

    void loadArticles(sourceSelection, currentArticleView, unreadOnly, favoriteSort, readLaterSort, timeWindow);
  }, [
    appPage.type,
    appStage.type,
    currentArticleView,
    isUsingOfflineData,
    favoriteSort,
    loadArticles,
    readLaterSort,
    sourceSelection,
    timeWindow,
    unreadOnly
  ]);

  useEffect(() => {
    if (appStage.type !== "reader" || !isUsingOfflineData || appPage.type !== "search") return;
    resetArticleListForPendingQuery();
    setAppPage({ type: "reader", view: "recommended" });
    setHasSubmittedSearch(false);
    window.history.replaceState(
      { dibaoPage: "recommended" },
      "",
      urlForAppPage({ type: "reader", view: "recommended" })
    );
  }, [appPage.type, appStage.type, isUsingOfflineData]);

  useEffect(() => {
    if (appStage.type !== "reader" || appPage.type !== "search" || !hasSubmittedSearch) {
      return;
    }

    void loadSearchArticles(submittedSearchForm);
  }, [appPage.type, appStage.type, hasSubmittedSearch, loadSearchArticles, submittedSearchForm]);

  useEffect(() => {
    if (
      appStage.type !== "reader" ||
      isUsingOfflineData ||
      appPage.type !== "reader" ||
      !supportsQuickFilters(currentArticleView)
    ) {
      return;
    }

    persistReaderFilters(currentArticleView, {
      sourceSelection,
      unreadOnly,
      timeWindow
    });
  }, [appPage.type, appStage.type, currentArticleView, isUsingOfflineData, sourceSelection, timeWindow, unreadOnly]);

  useEffect(() => {
    if (appStage.type !== "reader" || isUsingOfflineData) {
      setRecommendationStatus(null);
      setRecommendationStatusError(null);
      setIsRecommendationStatusLoading(false);
      return;
    }

    if (appPage.type === "reader" && currentArticleView === "recommended") {
      void loadRecommendationSummaryStatus();
      return;
    }

    if (appPage.type === "algorithm-transparency" || appPage.type === "algorithm-clusters") {
      void loadRecommendationStatus();
      return;
    }

    setRecommendationStatus(null);
    setRecommendationStatusError(null);
    setIsRecommendationStatusLoading(false);
  }, [
    appPage.type,
    appStage.type,
    currentArticleView,
    isUsingOfflineData,
    loadRecommendationStatus,
    loadRecommendationSummaryStatus
  ]);

  useEffect(() => {
    if (
      appStage.type !== "reader" ||
      isUsingOfflineData ||
      appPage.type !== "reader" ||
      currentArticleView !== "recommended"
    ) {
      setRecommendationInventory(null);
      setRecommendationInventoryError(null);
      setIsRecommendationInventoryLoading(false);
      return;
    }

    const input = {
      feedId: selectedFeed?.id ?? null,
      folderId: selectedFolder?.id ?? null,
      unreadOnly,
      timeWindow,
      loadedCount: articles.length,
      recommendationSessionId: recommendationSession?.id ?? null,
      recommendationSessionPosition: recommendationSession?.consumedThrough ?? null
    };
    let disposed = false;
    setIsRecommendationInventoryLoading(true);
    setRecommendationInventoryError(null);

    void dibaoApi
      .getRecommendationInventory(input)
      .then((inventory) => {
        if (disposed) {
          return;
        }
        setRecommendationInventory(inventory);
        setRecommendationInventoryError(null);
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        setRecommendationInventory(null);
        setRecommendationInventoryError(userMessageForError(error, t.errors.api));
      })
      .finally(() => {
        if (!disposed) {
          setIsRecommendationInventoryLoading(false);
        }
      });

    if (typeof EventSource === "undefined") {
      return () => {
        disposed = true;
      };
    }

    const source = new EventSource(dibaoApi.recommendationInventoryEventsUrl(input));
    const handleInventory = (event: MessageEvent<string>) => {
      if (disposed) {
        return;
      }
      try {
        const inventory = JSON.parse(event.data) as RecommendationInventory;
        setRecommendationInventory(inventory);
        setRecommendationInventoryError(null);
        setIsRecommendationInventoryLoading(false);
      } catch {
        setRecommendationInventoryError(t.recommendationInventory.connectionError);
      }
    };
    source.addEventListener("inventory", handleInventory as EventListener);
    source.onerror = () => {
      if (!disposed) {
        setIsRecommendationInventoryLoading(false);
        setRecommendationInventoryError(t.recommendationInventory.connectionError);
      }
    };

    return () => {
      disposed = true;
      source.removeEventListener("inventory", handleInventory as EventListener);
      source.close();
    };
  }, [
    appPage.type,
    appStage.type,
    articles.length,
    currentArticleView,
    isUsingOfflineData,
    recommendationSession?.consumedThrough,
    recommendationSession?.id,
    selectedFeed?.id,
    selectedFolder?.id,
    t.errors.api,
    t.recommendationInventory.connectionError,
    timeWindow,
    unreadOnly
  ]);

  useEffect(() => {
    if (appStage.type !== "reader" || appPage.type !== "algorithm-transparency") {
      return;
    }
    if (isRecommendationStatusLoading || !recommendationStatus) {
      return;
    }
    if (clusterLabelLexicon !== null || mergeCandidates.length > 0) {
      return;
    }

    void loadRecommendationDiagnostics();
  }, [
    appPage.type,
    appStage.type,
    clusterLabelLexicon,
    isRecommendationStatusLoading,
    loadRecommendationDiagnostics,
    mergeCandidates.length,
    recommendationStatus
  ]);

  useEffect(() => {
    if (appStage.type !== "reader" || appPage.type !== "algorithm-clusters") {
      return;
    }

    void loadAllRecommendationClusters();
  }, [appPage.type, appStage.type, loadAllRecommendationClusters]);

  useEffect(() => {
    function handlePopState() {
      reloadArticleStateOverlay();
      const route = routeFromLocation(appSettings.ui.defaultHomeView);
      hasExplicitUrlPageIntent.current = route.hasExplicitPage;
      setIsExplanationOpen(false);
      setIsSourceDrawerOpen(false);

      const currentPage = appPageRef.current;
      if (
        currentPage.type !== route.page.type ||
        (currentPage.type === "reader" &&
          route.page.type === "reader" &&
          currentPage.view !== route.page.view)
      ) {
        resetArticleListForPendingQuery();
      }
      setAppPage((current) => (sameAppPage(current, route.page) ? current : route.page));
      if (route.page.type === "search") {
        const nextSearchForm = searchFormFromLocation();
        setSearchForm(nextSearchForm);
        setSubmittedSearchForm(nextSearchForm);
        setHasSubmittedSearch(
          nextSearchForm.q.trim().length > 0 || isRelatedSearchForm(nextSearchForm)
        );
      }
      setSelectedArticleId(route.articleId);
      if (route.page.type === "reader" && supportsQuickFilters(route.page.view)) {
        const filters = readerFiltersForView(route.page.view);
        setSourceSelection((current) =>
          sameSourceSelection(current, filters.sourceSelection) ? current : filters.sourceSelection
        );
        setUnreadOnly((current) => (current === filters.unreadOnly ? current : filters.unreadOnly));
        setTimeWindow((current) => (current === filters.timeWindow ? current : filters.timeWindow));
      }
      setFavoriteSort(urlFavoriteSortParam() ?? defaultFavoriteArticleSort);
      setReadLaterSort(urlReadLaterSortParam() ?? defaultReadLaterArticleSort);
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [appSettings.ui.defaultHomeView]);

  useEffect(() => {
    function handlePageShow() {
      reloadArticleStateOverlay();
    }

    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  useEffect(() => {
    relatedDiscoveryRequestId.current += 1;
    relatedDiscoveryAbort.current?.abort();
    relatedDiscoveryAbort.current = null;
    setRelatedDiscovery(idleDiscoveryState);

    personalizedDiscoveryRequestId.current += 1;
    personalizedDiscoveryRequest.current?.controller.abort();
    personalizedDiscoveryRequest.current = null;
    setPersonalizedDiscovery(idleDiscoveryState);
  }, [selectedArticleId]);

  useEffect(() => {
    let cancelled = false;

    async function loadDetail(articleId: string) {
      setIsDetailLoading(true);
      setDetailError(null);
      detailExplanationRequestVersion.current += 1;
      setRankExplanation(null);
      setExplanationError(null);
      setIsExplanationOpen(false);
      const listArticle = articlesRef.current.find((article) => article.id === articleId);
      if (listArticle) {
        setArticleDetail((current) =>
          current?.id === articleId ? current : articleDetailPlaceholder(listArticle)
        );
      }

      const knownState =
        articleStateById.current.get(articleId) ??
        listArticle?.state ??
        null;
      if (!openedArticleIds.current.has(articleId)) {
        openedArticleIds.current.add(articleId);
        const openedState = knownState ? optimisticOpenedState(knownState) : null;
        if (openedState) applyArticleState(articleId, openedState);
        const request: ArticleActionRequest = {
          type: "open",
          value: true
        };
        if (isUsingOfflineData && offlineScope && openedState) {
          void queueOfflineArticleAction({
            scopeKey: offlineScope,
            articleId,
            request,
            state: openedState
          });
        } else {
          void dibaoApi.postArticleAction(articleId, request)
            .then((result) => {
              if (!cancelled) {
                markServerAvailable();
                applyArticleState(articleId, result.state);
              }
            })
            .catch(async (error) => {
              await offerOfflineModeForError(error);
              if (knownState) applyArticleState(articleId, knownState);
              openedArticleIds.current.delete(articleId);
              if (!cancelled) setArticleActionError(t.actions.errors.open);
            });
        }
      }

      try {
        let detail: ArticleDetail | null;
        if (isUsingOfflineData && offlineScope) {
          detail = await getOfflineArticleDetail(offlineScope, articleId);
          if (!detail) throw new Error(t.offlineReading.articleUnavailable);
        } else {
          detail = await withRequestTimeout(ARTICLE_DETAIL_REQUEST_TIMEOUT_MS, (signal) =>
            dibaoApi.getArticle(articleId, { signal })
          );
          markServerAvailable();
          if (offlineScope) {
            void cacheOnlineArticleDetail(offlineScope, detail).catch(() => undefined);
          }
        }
        const overlayState = locallyUpdatedArticleIds.current.has(articleId)
          ? articleStateById.current.get(articleId)
          : null;
        const detailWithKnownState = overlayState ? { ...detail, state: overlayState } : detail;
        if (!cancelled) {
          articleStateById.current.set(articleId, detailWithKnownState.state);
          setArticleDetail(detailWithKnownState);
          setArticleActionError(null);
          setIsDetailLoading(false);
        }
      } catch (error) {
        if (!isUsingOfflineData) await offerOfflineModeForError(error);
        if (!cancelled) {
          setDetailError(
            isUsingOfflineData
              ? t.offlineReading.articleUnavailable
              : userMessageForError(error, t.errors.api)
          );
        }
      } finally {
        if (!cancelled) {
          setIsDetailLoading(false);
        }
      }
    }

    if (!selectedArticleId) {
      detailExplanationRequestVersion.current += 1;
      setArticleDetail(null);
      setRankExplanation(null);
      setIsExplanationOpen(false);
      setIsDetailLoading(false);
      setIsExplanationLoading(false);
      setDetailError(null);
      setExplanationError(null);
      return;
    }

    void loadDetail(selectedArticleId);

    return () => {
      cancelled = true;
    };
  }, [
    currentArticleView,
    detailReloadRevision,
    isUsingOfflineData,
    markServerAvailable,
    offlineScope,
    offerOfflineModeForError,
    selectedArticleId,
    submittedSearchForm.sort,
    t.actions.errors.open,
    t.errors.api,
    t.offlineReading.articleUnavailable
  ]);

  function handleTelemetryEnabledChange(enabled: boolean) {
    setTelemetryEnabled(enabled);
    storeTelemetryPreference(enabled);
    configureClientTelemetry(enabled);
  }

  async function handleAuthSubmit(mode: AuthMode, username: string, password: string) {
    if (!username.trim()) {
      setAuthError(t.auth.usernameRequired);
      return;
    }

    if (!password.trim()) {
      setAuthError(t.auth.passwordRequired);
      return;
    }

    setIsAuthSubmitting(true);
    setAuthError(null);

    try {
      if (mode === "setup") {
        await dibaoApi.setupAuth(username, password, telemetryEnabled);
        try {
          const profile = await rememberOfflineSession(username.trim());
          const connectedAt = Date.now();
          await updateOfflineProfile(profile.scopeKey, { lastConnectedAt: connectedAt });
          setOfflineScope(profile.scopeKey);
          setOfflineProfile({ ...profile, lastConnectedAt: connectedAt });
          setLastConnectedAt(connectedAt);
        } catch {
          // Local offline storage must not turn a successful online setup into a failure.
        }
        setAuthUsername(username.trim());
        resetReaderState();
        setAppStage({ type: "setup-sources" });
      } else {
        await dibaoApi.login(username, password);
        try {
          const profile = await rememberOfflineSession(username.trim());
          const connectedAt = Date.now();
          await updateOfflineProfile(profile.scopeKey, { lastConnectedAt: connectedAt });
          setOfflineScope(profile.scopeKey);
          setOfflineProfile({ ...profile, lastConnectedAt: connectedAt });
          setLastConnectedAt(connectedAt);
        } catch {
          // Local offline storage must not turn a successful online login into a failure.
        }
        setAuthUsername(username.trim());
        setAppStage({ type: "setup-status-loading" });
      }
    } catch (error) {
      setAuthError(userMessageForError(error, t.errors.api));
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleLogout() {
    setLogoutError(null);

    const pendingOfflineActions =
      offlineSummary.pendingActionCount + offlineSummary.failedActionCount;
    if (
      pendingOfflineActions > 0 &&
      !window.confirm(t.offlineReading.settings.clearPendingConfirm(pendingOfflineActions))
    ) {
      return;
    }

    try {
      if (!isUsingOfflineData) await dibaoApi.logout();
      if (offlineScope) {
        try {
          await clearOfflineScope(offlineScope);
        } catch {
          // The authenticated session is already closed; finish logout even if local cleanup fails.
        }
      }
      setAuthUsername(null);
      setAppStage({ type: "login" });
      resetReaderState();
    } catch (error) {
      setLogoutError(userMessageForError(error, t.errors.api) || t.auth.errors.logout);
    }
  }

  async function handleRetryDerivedDataUpgrade() {
    setIsRetryingDerivedDataUpgrade(true);
    setDerivedDataUpgradeError(null);

    try {
      setDerivedDataUpgrade(await dibaoApi.retryDerivedDataUpgrade());
    } catch (error) {
      setDerivedDataUpgradeError(userMessageForError(error, t.errors.api));
    } finally {
      setIsRetryingDerivedDataUpgrade(false);
    }
  }

  async function handleAddFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFeedUrl = feedUrl.trim();

    if (!nextFeedUrl) {
      setFeedDiscoveryError(t.feedDiscovery.errors.urlRequired);
      return;
    }

    setIsDiscoveringFeeds(true);
    setFeedError(null);
    setFeedDiscoveryError(null);
    setFeedDiscovery(null);
    setNotice(null);

    try {
      setFeedDiscovery(await dibaoApi.discoverFeeds(nextFeedUrl));
    } catch (error) {
      setFeedDiscoveryError(
        userMessageForError(error, t.errors.api) || t.feedDiscovery.errors.discoverFailed
      );
    } finally {
      setIsDiscoveringFeeds(false);
    }
  }

  async function handleAddDiscoveredFeed(candidate: FeedDiscoveryCandidate) {
    if (candidate.status !== "valid") {
      return;
    }

    setIsAddingFeed(true);
    setFeedError(null);
    setFeedDiscoveryError(null);
    setNotice(null);

    try {
      const result = await dibaoApi.createFeed(candidate.feedUrl);
      setFeedUrl("");
      setFeedDiscovery(null);
      setNotice({ type: "feedAddedAndRefreshed", feedTitle: result.feed.title });
      await Promise.all([loadFeeds(), loadFeedDiagnostics()]);
      handleSelectSource({ type: "feed", feedId: result.feed.id });
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    } finally {
      setIsAddingFeed(false);
    }
  }

  async function advanceSetupAfterSource(noFeedsMessage: string) {
    const status = await dibaoApi.getSetupStatus();
    if (status.hasFeeds) {
      setSetupSourceError(null);
      const nextStage = stageForSetupStatus(status);
      setAppStage(nextStage.type === "setup-sources" ? { type: "setup-provider" } : nextStage);
      return;
    }

    setSetupSourceError(noFeedsMessage);
  }

  async function handleOptionalPluginDecision(pluginId: string, enabled: boolean) {
    setOptionalPluginDecisionId(pluginId);
    setAuthError(null);

    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
      await dibaoApi.selectOptionalPlugin(pluginId, { enabled, timezone });
      setPluginContributions(await dibaoApi.listPluginContributions());
      setAppStage({ type: "setup-provider" });
    } catch (error) {
      setAuthError(userMessageForError(error, t.errors.api));
    } finally {
      setOptionalPluginDecisionId(null);
    }
  }

  async function handleSetupAddFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFeedUrl = feedUrl.trim();

    if (!nextFeedUrl) {
      setSetupSourceError(t.feedDiscovery.errors.urlRequired);
      return;
    }

    setIsDiscoveringFeeds(true);
    setSetupSourceError(null);
    setFeedDiscoveryError(null);
    setFeedDiscovery(null);
    setOpmlSummary(null);

    try {
      setFeedDiscovery(await dibaoApi.discoverFeeds(nextFeedUrl));
    } catch (error) {
      setSetupSourceError(
        userMessageForError(error, t.errors.api) || t.feedDiscovery.errors.discoverFailed
      );
    } finally {
      setIsDiscoveringFeeds(false);
    }
  }

  async function handleSetupAddDiscoveredFeed(candidate: FeedDiscoveryCandidate) {
    if (candidate.status !== "valid") {
      return;
    }

    setIsAddingFeed(true);
    setSetupSourceError(null);
    setFeedDiscoveryError(null);
    setOpmlSummary(null);

    try {
      await dibaoApi.createFeed(candidate.feedUrl);
      setFeedUrl("");
      setFeedDiscovery(null);
      await advanceSetupAfterSource(t.setup.sources.noFeedsAfterAdd);
    } catch (error) {
      setSetupSourceError(userMessageForError(error, t.errors.api));
    } finally {
      setIsAddingFeed(false);
    }
  }

  async function handleSetupImportOpml(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    setIsImportingOpml(true);
    setSetupSourceError(null);
    setOpmlSummary(null);

    try {
      const result = await dibaoApi.importOpml(file);
      setOpmlSummary(result);
      await advanceSetupAfterSource(t.setup.sources.noFeedsAfterImport);
    } catch (error) {
      setSetupSourceError(userMessageForError(error, t.errors.api));
    } finally {
      setIsImportingOpml(false);
    }
  }

  function handleSetupProviderContinue() {
    resetReaderState();
    setIsFeedsLoading(true);
    setIsArticlesLoading(true);
    setAppStage({ type: "reader" });
  }

  async function handleRefreshFeed(feed: Feed) {
    setRefreshingFeedId(feed.id);
    setFeedError(null);
    setArticleError(null);
    setNotice(null);

    try {
      await dibaoApi.refreshFeed(feed.id);
      setNotice({ type: "feedRefreshed", feedTitle: feed.title });
      await Promise.all([
        loadFeeds(),
        loadFeedDiagnostics(),
        appPage.type === "reader"
          ? loadArticles(sourceSelection, appPage.view, unreadOnly, favoriteSort, readLaterSort, timeWindow)
          : Promise.resolve()
      ]);
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    } finally {
      setRefreshingFeedId(null);
    }
  }

  async function handleRefreshAllFeeds() {
    setIsRefreshingAllFeeds(true);
    setFeedError(null);
    setNotice(null);

    try {
      const result = await dibaoApi.refreshAllFeeds();
      setNotice({ type: "allFeedsRefreshQueued", jobCount: result.jobIds.length });
      await Promise.all([loadFeeds(), loadFeedDiagnostics()]);
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    } finally {
      setIsRefreshingAllFeeds(false);
    }
  }

  async function handleImportOpml(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    setIsImportingOpml(true);
    setFeedError(null);
    setOpmlSummary(null);
    setNotice(null);

    try {
      const result = await dibaoApi.importOpml(file);
      setOpmlSummary(result);
      setNotice({ type: "opmlImported", result });
      await Promise.all([
        loadFeedFolders(),
        loadFeeds(),
        loadFeedDiagnostics(),
        appPage.type === "reader"
          ? loadArticles(sourceSelection, appPage.view, unreadOnly, favoriteSort, readLaterSort, timeWindow)
          : Promise.resolve()
      ]);
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    } finally {
      setIsImportingOpml(false);
    }
  }

  async function handleExportOpml() {
    setIsExportingOpml(true);
    setFeedError(null);
    setNotice(null);

    try {
      const xml = await dibaoApi.exportOpml();
      downloadTextFile("dibao-subscriptions.opml", xml, "application/xml");
      setNotice({ type: "opmlExported" });
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    } finally {
      setIsExportingOpml(false);
    }
  }

  async function refreshSourcesAfterManagementMutation() {
    const [nextFolders, nextFeeds, nextDiagnostics] = await Promise.all([
      dibaoApi.listFeedFolders(),
      dibaoApi.listFeeds(),
      dibaoApi.getFeedDiagnostics()
    ]);
    const nextSourceSelection = correctSourceSelection(sourceSelection, nextFeeds, nextFolders);

    setFeedFolders(nextFolders);
    setFeeds(nextFeeds);
    setFeedDiagnostics(nextDiagnostics);

    if (!sameSourceSelection(sourceSelection, nextSourceSelection)) {
      resetArticleListForPendingQuery();
    }
    setSourceSelection(nextSourceSelection);

    if (articleDetail && !nextFeeds.some((feed) => feed.id === articleDetail.feedId)) {
      detailExplanationRequestVersion.current += 1;
      setSelectedArticleId(null);
      setArticleDetail(null);
      setRankExplanation(null);
      setDetailError(null);
      setExplanationError(null);
    }

    if (appPage.type === "reader") {
      await loadArticles(
        nextSourceSelection,
        appPage.view,
        unreadOnly,
        favoriteSort,
        readLaterSort,
        timeWindow
      );
    }
  }

  async function handleCreateManagedFolder(title: string) {
    await dibaoApi.createFeedFolder(title);
    await refreshSourcesAfterManagementMutation();
  }

  async function handleUpdateManagedFolder(folderId: string, input: UpdateFeedFolderInput) {
    await dibaoApi.updateFeedFolder(folderId, input);
    await refreshSourcesAfterManagementMutation();
  }

  async function handleDeleteManagedFolder(folderId: string) {
    await dibaoApi.deleteFeedFolder(folderId);
    await refreshSourcesAfterManagementMutation();
  }

  async function handleUpdateManagedFeed(feedId: string, input: UpdateFeedInput) {
    await dibaoApi.updateFeed(feedId, input);
    await refreshSourcesAfterManagementMutation();
  }

  async function handleDeleteManagedFeed(feedId: string) {
    await dibaoApi.deleteFeed(feedId);
    await refreshSourcesAfterManagementMutation();
  }

  function handlePreviewFullContent(feedId: string) {
    window.open(urlForAppPage({ type: "full-content-preview", feedId }), "_blank", "noopener");
  }

  async function handleBackfillCurrentFeedFullContent(
    feedId: string
  ): Promise<FullContentBackfillResponse> {
    const result = await dibaoApi.backfillCurrentFeedFullContent(feedId);
    await refreshSourcesAfterManagementMutation();
    if (selectedArticleId) {
      setArticleDetail(
        await withRequestTimeout(ARTICLE_DETAIL_REQUEST_TIMEOUT_MS, (signal) =>
          dibaoApi.getArticle(selectedArticleId, { signal })
        )
      );
    }
    return result;
  }

  function handlePreviewSettings(settings: AppSettings) {
    applySettings(settings);
    setSettingsError(null);
  }

  async function handleSaveSettings(input: UpdateSettingsInput) {
    setIsSavingSettings(true);
    setSettingsError(null);
    setNotice(null);

    try {
      const result = await dibaoApi.updateSettings(input);
      applySettings(result.settings);
      if (offlineScope) await updateOfflineProfile(offlineScope, { settings: result.settings });
      setNotice({ type: "settingsSaved" });
    } catch (error) {
      setSettingsError(userMessageForError(error, t.errors.api));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleOfflineTargetChange(target: number) {
    if (!offlineScope) throw new Error("Offline profile is not available");
    const recommendedTarget = await setOfflineRecommendedTarget(offlineScope, target);
    setOfflineProfile((current) => current ? {
      ...current,
      deviceSettings: { ...current.deviceSettings, recommendedTarget }
    } : current);
    setOfflineSummary(await getOfflineCacheSummary(offlineScope));
    if (offlineReadingEnabled && !isUsingOfflineData && navigator.onLine !== false) {
      if (offlineTargetRefreshTimer.current !== null) {
        window.clearTimeout(offlineTargetRefreshTimer.current);
      }
      offlineTargetRefreshTimer.current = window.setTimeout(() => {
        offlineTargetRefreshTimer.current = null;
        void refreshOfflineCacheNow().catch(() => undefined);
      }, 600);
    }
  }

  async function handleOfflineEnabledChange(enabled: boolean) {
    if (!offlineScope) throw new Error("Offline profile is not available");
    await setOfflineReadingEnabled(offlineScope, enabled);
    setOfflineProfile((current) => current ? {
      ...current,
      activeSnapshotId: enabled ? current.activeSnapshotId : null,
      deviceSettings: { ...current.deviceSettings, enabled }
    } : current);
    setOfflineSummary(await getOfflineCacheSummary(offlineScope));
    hasScheduledOfflineRefresh.current = null;
    if (offlineTargetRefreshTimer.current !== null) {
      window.clearTimeout(offlineTargetRefreshTimer.current);
      offlineTargetRefreshTimer.current = null;
    }
    if (!enabled && isUsingOfflineData) {
      manualOfflineMode.current = false;
      setOfflineModeActive(null);
      setOfflineConnectionMode("empty");
      setArticles([]);
      setNextArticleCursor(null);
      setArticleDetail(null);
      setSelectedArticleId(null);
    }
  }

  async function handleClearOfflineCache() {
    if (!offlineScope) return;
    await clearOfflineCache(offlineScope);
    setOfflineSummary(await getOfflineCacheSummary(offlineScope));
    if (isUsingOfflineData) {
      setOfflineConnectionMode("empty");
      setArticles([]);
      setNextArticleCursor(null);
      setArticleDetail(null);
      setSelectedArticleId(null);
    }
  }

  async function handleChangePassword(currentPassword: string, newPassword: string) {
    await dibaoApi.changePassword(currentPassword, newPassword);
  }

  async function handleSaveEmbeddingProvider(
    providerId: string | null,
    input: CreateEmbeddingProviderInput | UpdateEmbeddingProviderInput
  ): Promise<string | null> {
    setIsSavingEmbeddingProvider(true);
    setEmbeddingError(null);
    setNotice(null);

    try {
      let savedProviderId = providerId;
      if (providerId) {
        await dibaoApi.updateEmbeddingProvider(providerId, input);
      } else {
        const created = await dibaoApi.createEmbeddingProvider(input as CreateEmbeddingProviderInput);
        savedProviderId = created.id;
      }
      await loadEmbeddingSettings();
      setNotice({ type: "embeddingProviderSaved" });
      return savedProviderId;
    } catch (error) {
      setEmbeddingError(userMessageForError(error, t.errors.api));
      return null;
    } finally {
      setIsSavingEmbeddingProvider(false);
    }
  }

  async function handleActivateEmbeddingProvider(providerId: string): Promise<boolean> {
    setActivatingProviderId(providerId);
    setEmbeddingError(null);
    setNotice(null);

    try {
      await dibaoApi.activateEmbeddingProvider(providerId);
      await loadEmbeddingSettings();
      setNotice({ type: "embeddingProviderActivated" });
      return true;
    } catch (error) {
      setEmbeddingError(userMessageForError(error, t.errors.api));
      await loadEmbeddingSettings();
      return false;
    } finally {
      setActivatingProviderId(null);
    }
  }

  async function handleTestEmbeddingProvider(providerId: string) {
    setTestingProviderId(providerId);
    setEmbeddingError(null);
    setNotice(null);

    try {
      await dibaoApi.testEmbeddingProvider(providerId);
      await loadEmbeddingSettings();
      setNotice({ type: "embeddingProviderTested" });
    } catch (error) {
      setEmbeddingError(userMessageForError(error, t.errors.api));
      await loadEmbeddingSettings();
    } finally {
      setTestingProviderId(null);
    }
  }

  async function handleDeleteEmbeddingProvider(providerId: string) {
    setDeletingProviderId(providerId);
    setEmbeddingError(null);
    setNotice(null);

    try {
      await dibaoApi.deleteEmbeddingProvider(providerId);
      await loadEmbeddingSettings();
      setNotice({ type: "embeddingProviderDeleted" });
    } catch (error) {
      setEmbeddingError(userMessageForError(error, t.errors.api));
    } finally {
      setDeletingProviderId(null);
    }
  }

  async function handleRebuildEmbeddingIndex(indexId: string) {
    setRebuildingIndexId(indexId);
    setEmbeddingError(null);
    setNotice(null);

    try {
      await dibaoApi.rebuildEmbeddingIndex(indexId);
      await loadEmbeddingSettings();
      setNotice({ type: "embeddingIndexRebuildQueued" });
    } catch (error) {
      setEmbeddingError(userMessageForError(error, t.errors.api));
    } finally {
      setRebuildingIndexId(null);
    }
  }

  async function handleBackfillEmbeddingIndex(indexId: string) {
    setBackfillingIndexId(indexId);
    setEmbeddingError(null);
    setNotice(null);

    try {
      await dibaoApi.backfillEmbeddingIndex(indexId);
      await loadEmbeddingSettings();
      await loadRecommendationStatus();
      setNotice({ type: "embeddingIndexBackfillQueued" });
    } catch (error) {
      setEmbeddingError(userMessageForError(error, t.errors.api));
    } finally {
      setBackfillingIndexId(null);
    }
  }

  async function handleRunRecommendationMaintenanceTask(
    task: RecommendationMaintenanceTask,
    label: string
  ) {
    setRunningMaintenanceTask(task);
    setRecommendationStatusError(null);
    setNotice(null);

    try {
      const result = await dibaoApi.runRecommendationMaintenanceTask(task);
      setNotice({
        type: "recommendationMaintenanceQueued",
        label,
        existing: maintenanceResultWasExisting(result)
      });
      await loadRecommendationStatus();
      if (
        task === "keyword_rebuild" ||
        task === "recent_intent_rebuild" ||
        task === "cluster_label_rebuild" ||
        task === "cluster_merge_diagnostics" ||
        task === "cluster_auto_merge"
      ) {
        await loadAllRecommendationClusters();
      }
    } catch (error) {
      setRecommendationStatusError(userMessageForError(error, t.errors.api));
    } finally {
      setRunningMaintenanceTask(null);
    }
  }

  async function handleUpdateRecommendationClusterLabel(
    clusterId: string,
    manualLabel: string | null
  ) {
    setUpdatingClusterLabelId(clusterId);
    setRecommendationStatusError(null);
    setAllClustersError(null);

    try {
      const result = await dibaoApi.updateRecommendationClusterLabel(clusterId, manualLabel);
      patchRecommendationClusterLabel(clusterId, {
        displayLabel: result.displayLabel,
        labelSource: result.labelSource,
        manualLabel
      });
    } catch (error) {
      const message = userMessageForError(error, t.errors.api);
      setRecommendationStatusError(message);
      setAllClustersError(message);
    } finally {
      setUpdatingClusterLabelId(null);
    }
  }

  async function handleUpdateRecommendationFamilyLabel(
    familyId: string,
    manualLabel: string | null
  ) {
    setUpdatingFamilyLabelId(familyId);
    setRecommendationStatusError(null);
    setAllClustersError(null);

    try {
      const result = await dibaoApi.updateRecommendationFamilyLabel(familyId, manualLabel);
      patchRecommendationFamilyLabel(familyId, {
        displayLabel: result.displayLabel,
        manualLabel: result.manualLabel
      });
    } catch (error) {
      const message = userMessageForError(error, t.errors.api);
      setRecommendationStatusError(message);
      setAllClustersError(message);
    } finally {
      setUpdatingFamilyLabelId(null);
    }
  }

  function patchRecommendationClusterLabel(
    clusterId: string,
    label: {
      displayLabel: string;
      labelSource: RecommendationClusterItem["labelSource"];
      manualLabel: string | null;
    }
  ) {
    const patchCluster = (cluster: RecommendationClusterItem): RecommendationClusterItem =>
      cluster.id === clusterId
        ? {
            ...cluster,
            displayLabel: label.displayLabel,
            labelSource: label.labelSource,
            manualLabel: label.manualLabel
          }
        : cluster;
    setRecommendationStatus((current) =>
      current
        ? {
            ...current,
            clusters: {
              ...current.clusters,
              items: current.clusters.items?.map(patchCluster) ?? []
            }
          }
        : current
    );
    setAllRecommendationClusters((current) => current.map(patchCluster));
  }

  function patchRecommendationFamilyLabel(
    familyId: string,
    label: {
      displayLabel: string;
      manualLabel: string | null;
    }
  ) {
    const patchFamily = <T extends { id: string; displayLabel: string; manualLabel?: string | null }>(
      family: T
    ): T =>
      family.id === familyId
        ? {
            ...family,
            displayLabel: label.displayLabel,
            manualLabel: label.manualLabel
          }
        : family;
    const patchCluster = (cluster: RecommendationClusterItem): RecommendationClusterItem =>
      cluster.family?.id === familyId
        ? {
            ...cluster,
            family: patchFamily(cluster.family)
          }
        : cluster;
    setRecommendationStatus((current) =>
      current
        ? {
            ...current,
            clusters: {
              ...current.clusters,
              families: current.clusters.families
                ? {
                    ...current.clusters.families,
                    topFamilies: current.clusters.families.topFamilies.map(patchFamily),
                    dominantFamily: current.clusters.families.dominantFamily
                      ? patchFamily(current.clusters.families.dominantFamily)
                      : null
                  }
                : current.clusters.families,
              items: current.clusters.items?.map(patchCluster) ?? []
            }
          }
        : current
    );
    setAllRecommendationClusters((current) => current.map(patchCluster));
  }

  async function handleUpdateClusterLabelLexicon(
    overrides: Partial<ClusterLabelLexiconOverrides>
  ) {
    setUpdatingClusterLexicon(true);
    setRecommendationStatusError(null);
    setNotice(null);

    try {
      const result = await dibaoApi.updateClusterLabelLexicon(overrides);
      setClusterLabelLexicon(result);
      setNotice({
        type: "recommendationMaintenanceQueued",
        label: t.algorithmTransparency.lexicon.saveAndRebuild,
        existing: result.rebuildJob?.existing ?? false
      });
      await loadRecommendationStatus();
      if (appPageRef.current.type === "algorithm-clusters") {
        await loadAllRecommendationClusters();
      }
    } catch (error) {
      setRecommendationStatusError(userMessageForError(error, t.errors.api));
    } finally {
      setUpdatingClusterLexicon(false);
    }
  }

  async function handleMergeClusterCandidate(candidateId: string) {
    setUpdatingMergeCandidateId(candidateId);
    setRecommendationStatusError(null);

    try {
      await dibaoApi.mergeRecommendationClusterCandidate(candidateId);
      await loadRecommendationStatus();
      if (appPageRef.current.type === "algorithm-clusters") {
        await loadAllRecommendationClusters();
      }
    } catch (error) {
      setRecommendationStatusError(userMessageForError(error, t.errors.api));
    } finally {
      setUpdatingMergeCandidateId(null);
    }
  }

  async function handleIgnoreClusterCandidate(candidateId: string) {
    setUpdatingMergeCandidateId(candidateId);
    setRecommendationStatusError(null);

    try {
      await dibaoApi.ignoreRecommendationClusterCandidate(candidateId);
      await loadRecommendationStatus();
      if (appPageRef.current.type === "algorithm-clusters") {
        await loadAllRecommendationClusters();
      }
    } catch (error) {
      setRecommendationStatusError(userMessageForError(error, t.errors.api));
    } finally {
      setUpdatingMergeCandidateId(null);
    }
  }

  async function handleLoadMoreArticles() {
    if (!nextArticleCursor) {
      return;
    }

    const requestVersion = articleRequestVersion.current;
    const requestStartedAt = performance.now();
    const previousLength = articlesRef.current.length;
    setIsLoadingMoreArticles(true);
    setLoadMoreError(null);

    try {
      if (isUsingOfflineData && offlineScope && appPage.type !== "search") {
        const response = await listOfflineArticles(offlineScope, {
          ...articleQueryFor(sourceSelection),
          view: currentArticleView,
          unreadOnly: supportsUnreadOnly(currentArticleView) ? unreadOnly : false,
          timeWindow: supportsQuickFilters(currentArticleView) ? timeWindow : "all",
          favoriteSort,
          readLaterSort,
          limit: 50,
          cursor: nextArticleCursor
        });
        rememberArticleStates(response.data, articleStateById.current);
        setArticles((current) => appendUniqueArticles(current, response.data));
        setUnreadCount(response.unreadCount);
        setNextArticleCursor(response.nextCursor);
        return;
      }
      const relatedSearchArticleId =
        appPage.type === "search" && isRelatedSearchForm(submittedSearchForm)
          ? submittedSearchForm.relatedArticle?.id ?? null
          : null;
      const activeRecommendationScopeKey = recommendationSessionScopeKey(
        sourceSelection,
        unreadOnly,
        timeWindow
      );
      const response =
        appPage.type === "search"
          ? await withRequestTimeout(ARTICLE_LIST_REQUEST_TIMEOUT_MS, (signal) =>
              relatedSearchArticleId
                ? dibaoApi.getRelatedSearchArticles(relatedSearchArticleId, {
                    limit: 50,
                    cursor: nextArticleCursor,
                    state: submittedSearchForm.state,
                    signal
                  })
                : dibaoApi.searchArticles({
                    ...articleQueryFor(submittedSearchForm.sourceSelection),
                    q: submittedSearchForm.q.trim(),
                    state: submittedSearchForm.state,
                    sort: submittedSearchForm.sort,
                    fullText: submittedSearchForm.fullText,
                    from: submittedSearchForm.from || null,
                    to: submittedSearchForm.to || null,
                    limit: 50,
                    cursor: nextArticleCursor,
                    includeUnreadCount: false,
                    signal
                  })
            )
          : await withRequestTimeout(ARTICLE_LIST_REQUEST_TIMEOUT_MS, (signal) =>
              dibaoApi.listArticles({
                ...articleQueryFor(sourceSelection),
                view: currentArticleView,
                limit: 50,
                cursor: nextArticleCursor,
                recommendationSessionId:
                  currentArticleView === "recommended"
                    ? recommendationSession?.id ??
                      storedRecommendationSessionId(activeRecommendationScopeKey)
                    : null,
                unreadOnly: supportsUnreadOnly(currentArticleView) ? unreadOnly : false,
                timeWindow: supportsQuickFilters(currentArticleView) ? timeWindow : "all",
                sort: articleSortForView(currentArticleView, favoriteSort, readLaterSort),
                includeUnreadCount: false,
                signal
              })
            );
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      const responseArticles = articleListWithKnownLocalStates(
        response.data,
        articleStateById.current,
        locallyUpdatedArticleIds.current
      );
      rememberArticleStates(responseArticles, articleStateById.current);
      if (appPage.type !== "search" && currentArticleView === "recommended") {
        rememberRecommendationSession(
          response.meta.recommendationSession,
          activeRecommendationScopeKey
        );
      }
      const visibleResponseArticles =
        appPage.type === "search"
          ? responseArticles
          : articlesVisibleForUnreadFilter(
              responseArticles,
              supportsUnreadOnly(currentArticleView) && unreadOnly
            );
      setArticles((current) =>
        appendUniqueArticles(current, visibleResponseArticles)
      );
      if (relatedSearchArticleId && isRelatedSearchResponse(response)) {
        setRelatedSearchMeta({
          threshold: response.threshold,
          totalCount: response.totalCount
        });
      }
      logReaderPerformance("articleList.loadMore", {
        view: appPage.type === "search" ? "search" : currentArticleView,
        requestMs: Math.round(performance.now() - requestStartedAt),
        previousArticlesLength: previousLength,
        receivedArticlesLength: responseArticles.length,
        visibleReceivedArticlesLength: visibleResponseArticles.length,
        hasMore: response.page.nextCursor !== null
      });
      if (response.meta.unreadCount !== null) {
        setUnreadCount(
          unreadCountWithKnownLocalStates(
            response.meta.unreadCount,
            response.data,
            articleStateById.current,
            locallyUpdatedArticleIds.current
          )
        );
      }
      setNextArticleCursor(response.page.nextCursor);
    } catch (error) {
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      setLoadMoreError(userMessageForError(error, t.errors.api));
    } finally {
      if (requestVersion === articleRequestVersion.current) {
        setIsLoadingMoreArticles(false);
      }
    }
  }

  async function handleMarkCurrentArticleListScopeRead() {
    if (
      isUsingOfflineData ||
      (currentArticleView !== "latest" && currentArticleView !== "recommended")
    ) {
      return;
    }

    await markScopeRead(
      currentArticleListReaderCommandScope(),
      () =>
        loadArticles(
          sourceSelection,
          currentArticleView,
          unreadOnly,
          favoriteSort,
          readLaterSort,
          timeWindow
        )
    );
  }

  async function previewCurrentArticleListScopeRead(): Promise<number> {
    if (
      isUsingOfflineData ||
      (currentArticleView !== "latest" && currentArticleView !== "recommended")
    ) {
      return 0;
    }

    const result = await dibaoApi.previewMarkScopeRead(currentArticleListReaderCommandScope());
    return result.markedReadCount;
  }

  function currentArticleListReaderCommandScope(): ReaderCommandScope {
    return {
      type: "article_list",
      view: currentArticleView === "recommended" ? "recommended" : "latest",
      ...articleQueryFor(sourceSelection),
      clearWindow: timeWindow
    };
  }

  async function handleMarkCurrentSearchScopeRead() {
    if (!hasSubmittedSearch || submittedSearchForm.q.trim().length === 0) {
      return;
    }

    await markScopeRead(
      {
        type: "search",
        ...articleQueryFor(submittedSearchForm.sourceSelection),
        q: submittedSearchForm.q.trim(),
        state: submittedSearchForm.state,
        from: submittedSearchForm.from || null,
        to: submittedSearchForm.to || null
      },
      () => loadSearchArticles(submittedSearchForm)
    );
  }

  async function markScopeRead(scope: ReaderCommandScope, reload: () => Promise<void>) {
    if (isUsingOfflineData) return;
    setIsMarkingScopeRead(true);
    setReaderCommandError(null);
    setNotice(null);

    try {
      const result = await dibaoApi.markScopeRead(scope);
      setNotice({ type: "readerCommandMarkScopeRead", count: result.markedReadCount });
      clearLocalArticleStates();
      await reload();
    } catch {
      setReaderCommandError(t.readerCommands.markScopeRead.error);
    } finally {
      setIsMarkingScopeRead(false);
    }
  }

  async function handleLoadRelatedArticles() {
    if (
      isUsingOfflineData ||
      !articleDetail ||
      relatedDiscovery.status === "loading" ||
      relatedDiscovery.status === "ready"
    ) {
      return;
    }

    const articleId = articleDetail.id;
    const requestId = relatedDiscoveryRequestId.current + 1;
    relatedDiscoveryRequestId.current = requestId;
    relatedDiscoveryAbort.current?.abort();
    const controller = new AbortController();
    relatedDiscoveryAbort.current = controller;
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      READER_DISCOVERY_REQUEST_TIMEOUT_MS
    );
    setRelatedDiscovery({ status: "loading", items: [] });

    try {
      const response = await dibaoApi.getRelatedArticles(articleId, {
        limit: 5,
        signal: controller.signal
      });
      if (
        relatedDiscoveryRequestId.current === requestId &&
        selectedArticleIdRef.current === articleId
      ) {
        setRelatedDiscovery(discoveryStateForResponse(response));
      }
    } catch (error) {
      if (
        !isAbortError(error) &&
        relatedDiscoveryRequestId.current === requestId &&
        selectedArticleIdRef.current === articleId
      ) {
        setRelatedDiscovery({ status: "error", items: [] });
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (relatedDiscoveryAbort.current === controller) {
        relatedDiscoveryAbort.current = null;
      }
    }
  }

  function startPersonalizedRelatedRequest(
    articleId: string,
    input: { likeSucceeded?: boolean } = {}
  ) {
    if (isUsingOfflineData) return;
    personalizedDiscoveryRequestId.current += 1;
    personalizedDiscoveryRequest.current?.controller.abort();
    const controller = new AbortController();
    const request: PersonalizedRelatedRequestContext = {
      articleId,
      controller,
      likeSucceeded: input.likeSucceeded ?? false,
      requestId: personalizedDiscoveryRequestId.current
    };
    personalizedDiscoveryRequest.current = request;
    if (request.likeSucceeded) {
      setPersonalizedDiscovery({ status: "loading", items: [] });
    } else {
      setPersonalizedDiscovery(idleDiscoveryState);
    }

    const timeoutId = window.setTimeout(
      () => controller.abort(),
      READER_DISCOVERY_REQUEST_TIMEOUT_MS
    );

    void dibaoApi.getPersonalizedRelatedArticles(articleId, {
      limit: 5,
      signal: controller.signal
    })
      .then((response) => {
        if (
          personalizedDiscoveryRequest.current !== request ||
          selectedArticleIdRef.current !== articleId
        ) {
          return;
        }
        request.response = response;
        if (request.likeSucceeded) {
          setPersonalizedDiscovery(discoveryStateForResponse(response));
        }
      })
      .catch((error) => {
        if (
          isAbortError(error) ||
          personalizedDiscoveryRequest.current !== request ||
          selectedArticleIdRef.current !== articleId
        ) {
          return;
        }
        request.failed = true;
        if (request.likeSucceeded) {
          setPersonalizedDiscovery({ status: "error", items: [] });
        }
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
      });
  }

  function confirmPersonalizedRelatedLike(articleId: string) {
    const request = personalizedDiscoveryRequest.current;
    if (!request || request.articleId !== articleId) {
      startPersonalizedRelatedRequest(articleId, { likeSucceeded: true });
      return;
    }

    request.likeSucceeded = true;
    if (request.response) {
      setPersonalizedDiscovery(discoveryStateForResponse(request.response));
    } else if (request.failed) {
      setPersonalizedDiscovery({ status: "error", items: [] });
    } else {
      setPersonalizedDiscovery({ status: "loading", items: [] });
    }
  }

  function discardPersonalizedRelated(articleId: string) {
    const request = personalizedDiscoveryRequest.current;
    if (request?.articleId === articleId) {
      request.controller.abort();
      personalizedDiscoveryRequest.current = null;
    }
    if (selectedArticleIdRef.current === articleId) {
      setPersonalizedDiscovery(idleDiscoveryState);
    }
  }

  function handleRetryPersonalizedRelated() {
    if (!articleDetail?.state.liked) {
      return;
    }
    startPersonalizedRelatedRequest(articleDetail.id, { likeSucceeded: true });
  }

  async function handleArticleAction(article: ArticleActionTarget, intent: ArticleActionIntent) {
    setPendingArticleAction({ articleId: article.id, intent });
    setArticleActionError(null);
    const previousState =
      articleStateById.current.get(article.id) ??
      (articleDetail?.id === article.id ? articleDetail.state : article.state);
    const shouldLoadPersonalizedRelated =
      !isUsingOfflineData && intent === "like" && !previousState.liked;
    const shouldDiscardPersonalizedRelated = intent === "like" && previousState.liked;
    if (shouldLoadPersonalizedRelated) {
      startPersonalizedRelatedRequest(article.id);
    } else if (shouldDiscardPersonalizedRelated) {
      discardPersonalizedRelated(article.id);
    }
    const nextState = optimisticStateForArticleAction(intent, previousState);
    applyArticleState(article.id, nextState);
    const request = requestForArticleAction(intent, previousState);

    try {
      if (isUsingOfflineData && offlineScope) {
        await queueOfflineArticleAction({
          scopeKey: offlineScope,
          articleId: article.id,
          request,
          state: nextState
        });
        return;
      }
      const result = await dibaoApi.postArticleAction(
        article.id,
        request
      );
      markServerAvailable();
      applyArticleState(article.id, result.state);
      if (shouldLoadPersonalizedRelated) {
        confirmPersonalizedRelatedLike(article.id);
      }
      if (isExplanationOpen && selectedArticleIdRef.current === article.id) {
        void refreshArticleExplanation(article.id);
      }
    } catch (error) {
      if (!isUsingOfflineData) await offerOfflineModeForError(error);
      applyArticleState(article.id, previousState);
      if (shouldLoadPersonalizedRelated) {
        discardPersonalizedRelated(article.id);
      }
      setArticleActionError(actionErrorMessageFor(intent, t));
    } finally {
      setPendingArticleAction((current) =>
        current?.articleId === article.id && current.intent === intent ? null : current
      );
    }
  }

  function handleIgnoreArticle(articleId: string) {
    if (isUsingOfflineData) return;
    const article = articlesRef.current.find((candidate) => candidate.id === articleId);
    const state = article?.state ?? articleStateById.current.get(articleId);
    if (!state || articleInteractionStatusForState(state) !== "unseen") {
      return;
    }

    if (
      ignoredArticleIds.current.has(articleId) ||
      ignoredArticleInFlightIds.current.has(articleId) ||
      ignoredArticleQueue.current.some((item) => item.articleId === articleId)
    ) {
      return;
    }

    ignoredArticleQueue.current.push({
      articleId,
      state,
      view: currentArticleViewRef.current
    });
    scheduleIgnoredArticleQueueDrain();
  }

  function scheduleIgnoredArticleQueueDrain() {
    if (ignoredArticleFlushTimer.current !== null || ignoredArticleInFlightIds.current.size > 0) {
      return;
    }
    ignoredArticleFlushTimer.current = window.setTimeout(() => {
      ignoredArticleFlushTimer.current = null;
      void drainIgnoredArticleQueue();
    }, IGNORE_TELEMETRY_FLUSH_DELAY_MS);
  }

  function drainIgnoredArticleQueue() {
    if (ignoredArticleInFlightIds.current.size > 0 || ignoredArticleQueue.current.length === 0) {
      return;
    }
    const batch: IgnoredArticleQueueItem[] = [];
    while (batch.length < IGNORE_TELEMETRY_BATCH_SIZE && ignoredArticleQueue.current.length > 0) {
      const item = ignoredArticleQueue.current.shift();
      if (!item) {
        continue;
      }
      const liveState =
        articleStateById.current.get(item.articleId) ??
        articlesRef.current.find((candidate) => candidate.id === item.articleId)?.state ??
        item.state;
      const interactionStatus = articleInteractionStatusForState(liveState);
      if (
        shouldSkipPassiveIgnoreTelemetry({
          articleId: item.articleId,
          interactionStatus,
          isAlreadyIgnored: ignoredArticleIds.current.has(item.articleId),
          isOpened: openedArticleIds.current.has(item.articleId),
          selectedArticleId: selectedArticleIdRef.current
        })
      ) {
        continue;
      }
      ignoredArticleInFlightIds.current.add(item.articleId);
      ignoredArticleIds.current.add(item.articleId);
      batch.push(item);
    }
    if (batch.length === 0) {
      return;
    }
    void postIgnoredArticles(batch).finally(() => {
      for (const item of batch) {
        ignoredArticleInFlightIds.current.delete(item.articleId);
      }
      scheduleIgnoredArticleQueueDrain();
    });
  }

  async function postIgnoredArticles(batch: IgnoredArticleQueueItem[]) {
    const abortController =
      typeof AbortController === "undefined" ? null : new AbortController();
    const timeout =
      abortController && typeof window !== "undefined"
        ? window.setTimeout(() => abortController.abort(), IGNORE_TELEMETRY_TIMEOUT_MS)
        : null;

    try {
      const result = await dibaoApi.postArticleActionsBulk(
        {
          actions: batch.map((item) => ({
            articleId: item.articleId,
            type: "impression",
            metadata: {
              reason: "scrolled_past_unopened",
              view: item.view
            }
          }))
        },
        abortController ? { signal: abortController.signal } : undefined
      );
      for (const item of result.data) {
        if (
          selectedArticleIdRef.current !== item.articleId &&
          !openedArticleIds.current.has(item.articleId)
        ) {
          applyArticleState(item.articleId, item.state);
        }
      }
    } catch {
      for (const item of batch) {
        ignoredArticleIds.current.delete(item.articleId);
      }
      // Passive list telemetry should not interrupt browsing.
    } finally {
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
    }
  }

  async function handleReadProgress(
    articleId: string,
    progress: number,
    metadata: ReadProgressMetadata,
    options: ReadProgressPostOptions = {}
  ) {
    const request: ArticleActionRequest = {
      type: "read_progress",
      progress,
      metadata
    };
    const previousState =
      articleStateById.current.get(articleId) ??
      (articleDetail?.id === articleId ? articleDetail.state : null);
    if (previousState) {
      applyArticleState(articleId, optimisticReadProgressState(previousState, progress));
    }
    if (
      progress >= 0.5 &&
      articleId === selectedArticleId &&
      shouldLoadDetailRankExplanation(appPage, currentArticleView, submittedSearchForm.sort) &&
      rankExplanation?.articleId !== articleId &&
      !isExplanationLoading
    ) {
      void refreshArticleExplanation(articleId);
    }

    if (options.keepalive) {
      if (isUsingOfflineData && offlineScope && previousState) {
        void queueOfflineArticleAction({
          scopeKey: offlineScope,
          articleId,
          request,
          state: optimisticReadProgressState(previousState, progress)
        });
        return;
      }
      dibaoApi.postArticleActionKeepalive(articleId, request);
      return;
    }

    try {
      if (isUsingOfflineData && offlineScope && previousState) {
        await queueOfflineArticleAction({
          scopeKey: offlineScope,
          articleId,
          request,
          state: optimisticReadProgressState(previousState, progress)
        });
        return;
      }
      const result = await dibaoApi.postArticleAction(articleId, request);
      markServerAvailable();
      applyArticleState(articleId, result.state);
    } catch (error) {
      if (!isUsingOfflineData) await offerOfflineModeForError(error);
      // Automatic reading telemetry should never interrupt the reader surface.
    }
  }

  function handleSelectArticle(articleId: string) {
    setIsExplanationOpen(false);
    const listArticle = articlesRef.current.find((article) => article.id === articleId);
    if (listArticle) {
      setArticleDetail(articleDetailPlaceholder(listArticle));
    }
    const href =
      appPage.type === "search"
        ? urlForSearchPage(submittedSearchForm, articleId)
        : urlForArticle(currentArticleView, articleId, {
            favoriteSort,
            readLaterSort,
            timeWindow,
            unreadOnly
          });
    if (selectedArticleId !== articleId) {
      window.history.pushState({ dibaoArticleId: articleId }, "", href);
    }
    setSelectedArticleId(articleId);
    setIsSourceDrawerOpen(false);
  }

  function handleRetryArticleDetail() {
    if (selectedArticleId) {
      setDetailReloadRevision((current) => current + 1);
    }
  }

  function navigateToAppPage(page: AppPage) {
    window.history.pushState({ dibaoPage: page.type }, "", urlForAppPage(page, {
      favoriteSort,
      readLaterSort,
      timeWindow,
      unreadOnly
    }));
    if (page.type === "reader") {
      handleArticleViewChange(page.view);
    } else {
      resetArticleListForPendingQuery();
      setAppPage(page);
    }
    setIsSourceDrawerOpen(false);
  }

  function handleOpenRelatedSearch() {
    if (isUsingOfflineData || !articleDetail) {
      return;
    }

    const relatedSearchForm: SearchFormState = {
      ...defaultSearchForm(),
      q: articleDetail.title,
      relatedArticle: {
        id: articleDetail.id,
        title: articleDetail.title
      },
      fullText: false,
      sort: "relevance"
    };
    resetArticleListForPendingQuery();
    setAppPage({ type: "search" });
    setSearchForm(relatedSearchForm);
    setSubmittedSearchForm(relatedSearchForm);
    setHasSubmittedSearch(true);
    window.history.pushState(
      { dibaoPage: "search" },
      "",
      urlForSearchPage(relatedSearchForm)
    );
    setIsSourceDrawerOpen(false);
  }

  function handleOpenExplanation() {
    if (
      isUsingOfflineData ||
      !shouldLoadDetailRankExplanation(appPage, currentArticleView, submittedSearchForm.sort)
    ) {
      return;
    }

    if (
      selectedArticleId &&
      rankExplanation?.articleId !== selectedArticleId &&
      !isExplanationLoading
    ) {
      void refreshArticleExplanation(selectedArticleId);
    }
    setIsExplanationOpen(true);
  }

  async function handleOpenListExplanation(articleId: string) {
    if (isUsingOfflineData || !canLoadRankExplanation(appPageRef.current, currentArticleView)) {
      return;
    }

    const requestVersion = listExplanationRequestVersion.current + 1;
    listExplanationRequestVersion.current = requestVersion;
    setIsListExplanationOpen(true);
    setIsListExplanationLoading(true);
    setListExplanationError(null);
    setListRankExplanation(null);

    try {
      const explanation = await dibaoApi.getArticleExplanation(articleId);
      if (listExplanationRequestVersion.current === requestVersion) {
        setListRankExplanation(explanation);
      }
    } catch (error) {
      if (listExplanationRequestVersion.current === requestVersion) {
        setListRankExplanation(null);
        setListExplanationError(userMessageForError(error, t.errors.api));
      }
    } finally {
      if (listExplanationRequestVersion.current === requestVersion) {
        setIsListExplanationLoading(false);
      }
    }
  }

  function handleCloseExplanation() {
    setIsExplanationOpen(false);
  }

  function handleBackToArticleList() {
    if (isExplanationOpen) {
      handleCloseExplanation();
      return;
    }

    window.history.pushState(
      { dibaoPage: appPage.type === "search" ? "search" : currentArticleView },
      "",
      appPage.type === "search"
        ? urlForSearchPage(submittedSearchForm)
        : urlForAppPage({ type: "reader", view: currentArticleView }, {
            favoriteSort,
            readLaterSort,
            timeWindow,
            unreadOnly
          })
    );
    clearSelectedArticle();
  }

  function handleNavigationClick(event: MouseEvent<HTMLAnchorElement>, item: NavigationItemKey) {
    if (isUsingOfflineData && (item === "search" || item === "feeds")) {
      event.preventDefault();
      return;
    }
    if (shouldLetBrowserHandleLinkClick(event)) {
      return;
    }
    event.preventDefault();
    const page = pageForNavigationItem(item);
    if (!page) {
      return;
    }
    setIsUtilityMenuOpen(false);
    navigateToAppPage(page);
  }

  function handlePluginNavigationClick(event: MouseEvent<HTMLAnchorElement>, page: AppPage) {
    if (shouldLetBrowserHandleLinkClick(event)) {
      return;
    }
    event.preventDefault();
    setIsUtilityMenuOpen(false);
    navigateToAppPage(page);
  }

  async function handlePluginAction(action: PluginActionButton, context: PluginActionContext) {
    setPluginError(null);
    try {
      if (action.command.startsWith("task:")) {
        const taskId = action.command.slice("task:".length);
        await dibaoApi.startPluginTask(action.pluginId, taskId);
        return;
      }
      if (action.command.startsWith("route:")) {
        navigateToAppPage({
          type: "plugin",
          pluginId: action.pluginId,
          route: action.command.slice("route:".length)
        });
        return;
      }
      if (action.command.startsWith("api:")) {
        await dibaoApi.callPluginApi(action.pluginId, action.command.slice("api:".length), {
          actionId: action.id,
          context
        });
        return;
      }
      await dibaoApi.callPluginApi(action.pluginId, `/${action.command}`, {
        actionId: action.id,
        context
      });
    } catch (error) {
      setPluginError(userMessageForError(error, t.errors.api));
    }
  }

  const noticeText = notice ? noticeTextFor(notice, t) : null;
  const shouldShowOfflineStatus = isUsingOfflineData ||
    offlineSummary.failedActionCount > 0 ||
    (offlineConnectionMode === "reconnecting" && offlineSummary.pendingActionCount > 0);
  const offlineReaderStatus: OfflineReaderStatus | null = shouldShowOfflineStatus
    ? {
        mode: !isUsingOfflineData
          ? offlineConnectionMode === "reconnecting" ? "reconnecting" : "sync-failed"
          : offlineConnectionMode === "online"
            ? offlineSummary.availableCount > 0 ? "offline" : "empty"
            : offlineConnectionMode,
        summary: offlineSummary,
        lastConnectedAt,
        error: offlineCacheError,
        isBrowserOffline: isOffline,
        isExiting: isExitingOfflineMode,
        onExit: isUsingOfflineData ? () => void retryOfflineSync() : undefined,
        onRetry: isUsingOfflineData ? undefined : () => void retryOfflineSync()
      }
    : null;
  const pwaStatusBanner = (
    <PwaStatusBanner
      offlinePrompt={offlineModePrompt}
      isEnteringOfflineMode={isEnteringOfflineMode}
      onApplyUpdate={pwaUpdateApply}
      onDismissOfflinePrompt={handleDismissOfflinePrompt}
      onDismissUpdate={() => setPwaUpdateApply(null)}
      onEnterOfflineMode={() => void handleEnterOfflineMode()}
    />
  );
  const activePlugin =
    appPage.type === "plugin"
      ? pluginContributions.find((plugin) => plugin.id === appPage.pluginId) ?? null
      : null;
  const activePluginRoute =
    activePlugin && appPage.type === "plugin"
      ? activePlugin.contributions.routes.find((route) => route.id === appPage.route) ??
        activePlugin.contributions.routes[0] ??
        null
      : null;
  const availablePluginContributions = isUsingOfflineData ? [] : pluginContributions;
  const pluginDesktopNavItems = availablePluginContributions.flatMap((plugin) =>
    plugin.contributions.primaryNav.map((nav) => ({
      plugin,
      nav,
      page: { type: "plugin", pluginId: plugin.id, route: nav.route } satisfies AppPage
    }))
  );
  const pluginMobilePrimaryNavItems = availablePluginContributions.flatMap((plugin) =>
    plugin.contributions.primaryMobile.map((nav) => ({
      plugin,
      nav,
      page: { type: "plugin", pluginId: plugin.id, route: nav.route } satisfies AppPage
    }))
  );
  const pluginMobilePrimaryNavKeys = new Set(
    pluginMobilePrimaryNavItems.map(({ plugin, nav }) => `${plugin.id}:${nav.route}`)
  );
  const pluginMobileOverflowNavItems = pluginDesktopNavItems.filter(
    ({ plugin, nav }) => !pluginMobilePrimaryNavKeys.has(`${plugin.id}:${nav.route}`)
  );
  const isMobileUtilityNavigationActive =
    isUtilityNavigationActive(appPage) ||
    pluginMobileOverflowNavItems.some(({ page }) => sameAppPage(appPage, page));
  const pluginActionsBySlot = new Map<string, PluginActionButton[]>();
  for (const plugin of availablePluginContributions) {
    for (const action of plugin.contributions.actions) {
      const actions = pluginActionsBySlot.get(action.slot) ?? [];
      actions.push({
        ...action,
        pluginId: plugin.id,
        pluginName: plugin.name
      });
      pluginActionsBySlot.set(action.slot, actions);
    }
  }
  for (const actions of pluginActionsBySlot.values()) {
    actions.sort(
      (left, right) =>
        (left.order ?? 100) - (right.order ?? 100) ||
        left.label.localeCompare(right.label)
    );
  }
  const pluginActionsForSlot = (slot: string) => pluginActionsBySlot.get(slot) ?? [];
  const pageTitle =
    appPage.type === "feed-management"
      ? t.feedManagement.pageTitle
      : appPage.type === "full-content-preview"
        ? t.fullContentPreview.pageTitle
      : appPage.type === "search"
        ? t.search.pageTitle
      : appPage.type === "settings"
        ? t.settings.pageTitle
        : appPage.type === "plugin"
          ? activePluginRoute?.title ?? activePlugin?.name ?? "Plugin"
        : appPage.type === "algorithm-transparency" || appPage.type === "algorithm-clusters"
          ? t.algorithmTransparency.pageTitle
          : t.shell.pageTitles[currentArticleView];
  const pageKicker =
    locale === "en-US"
      ? null
      : appPage.type === "feed-management"
        ? t.feedManagement.kicker
        : appPage.type === "full-content-preview"
          ? t.fullContentPreview.kicker
          : appPage.type === "search"
            ? t.search.kicker
            : appPage.type === "settings"
              ? t.settings.kicker
              : appPage.type === "plugin"
                ? activePlugin?.name ?? "Plugin"
                : appPage.type === "algorithm-transparency" ||
                    appPage.type === "algorithm-clusters"
                  ? t.algorithmTransparency.kicker
                  : t.shell.pageKickers[currentArticleView];
  const topbarStatus =
    appPage.type === "feed-management"
      ? isFeedsLoading
        ? t.feedManagement.loading
        : t.feedManagement.status(feeds.length, feedFolders.length)
      : appPage.type === "full-content-preview"
        ? t.fullContentPreview.status
      : appPage.type === "search"
        ? articleError ??
          (hasSubmittedSearch
            ? isArticlesLoading
              ? t.search.submitting
              : t.search.resultsCount(articles.length)
            : t.search.initialTitle)
      : appPage.type === "settings"
        ? settingsError ??
          embeddingError ??
          noticeText ??
          (isSettingsLoading || isEmbeddingLoading ? t.settings.loading : t.settings.status)
        : appPage.type === "plugin"
          ? pluginError
        : appPage.type === "algorithm-transparency"
          ? recommendationStatusError ??
            (isRecommendationStatusLoading
              ? t.recommendationStatus.loading
              : t.algorithmTransparency.status)
          : appPage.type === "algorithm-clusters"
            ? allClustersError ??
              (isAllClustersLoading
                ? t.recommendationStatus.loading
                : t.algorithmTransparency.status)
          : noticeText ??
            (isArticlesLoading ? t.shell.loadingArticles : t.shell.viewStatus[currentArticleView]);

  if (appStage.type === "auth-loading" || appStage.type === "setup-status-loading") {
    return (
      <main className={styles.authShell}>
        {pwaStatusBanner}
        <AuthGatePanel
          error={authError}
          isSubmitting={false}
          loadingLabel={
            appStage.type === "setup-status-loading" ? t.auth.setupStatusLoading : t.auth.loading
          }
          mode="loading"
          onRetryLoading={handleRetryAuthGate}
          retryLoadingLabel={t.auth.retry}
        />
      </main>
    );
  }

  if (appStage.type === "welcome") {
    return (
      <main className={styles.authShell}>
        {pwaStatusBanner}
        <SetupWelcomePanel onStart={() => setAppStage({ type: "setup-password" })} />
      </main>
    );
  }

  if (appStage.type === "setup-password" || appStage.type === "login") {
    return (
      <main className={styles.authShell}>
        {pwaStatusBanner}
        <AuthGatePanel
          error={authError}
          isSubmitting={isAuthSubmitting}
          mode={appStage.type === "login" ? "login" : "setup"}
          onTelemetryEnabledChange={handleTelemetryEnabledChange}
          onSubmit={handleAuthSubmit}
          telemetryEnabled={telemetryEnabled}
        />
      </main>
    );
  }

  if (appStage.type === "derived-data-upgrade") {
    return (
      <main className={styles.authShell}>
        {pwaStatusBanner}
        <DerivedDataUpgradePanel
          error={derivedDataUpgradeError}
          isRetrying={isRetryingDerivedDataUpgrade}
          onRetry={handleRetryDerivedDataUpgrade}
          status={derivedDataUpgrade}
        />
      </main>
    );
  }

  if (appStage.type === "setup-sources") {
    return (
      <main className={styles.authShell}>
        {pwaStatusBanner}
        <SetupSourcesPanel
          error={setupSourceError}
          discovery={feedDiscovery}
          discoveryError={feedDiscoveryError}
          feedUrl={feedUrl}
          isAddingFeed={isAddingFeed}
          isDiscoveringFeeds={isDiscoveringFeeds}
          isImportingOpml={isImportingOpml}
          onAddCandidate={handleSetupAddDiscoveredFeed}
          onAddFeed={handleSetupAddFeed}
          onImportOpml={handleSetupImportOpml}
          onUpdateFeedUrl={setFeedUrl}
          opmlSummary={opmlSummary}
        />
      </main>
    );
  }

  if (appStage.type === "setup-optional-plugins") {
    return (
      <main className={styles.authShell}>
        {pwaStatusBanner}
        <SetupOptionalPluginsPanel
          busyPluginId={optionalPluginDecisionId}
          error={authError}
          onDecision={handleOptionalPluginDecision}
          plugins={appStage.plugins}
        />
      </main>
    );
  }

  if (appStage.type === "setup-provider") {
    return (
      <main className={styles.authShell}>
        {pwaStatusBanner}
        <Suspense fallback={<AuthGatePanel isSubmitting={false} mode="loading" />}>
          <LazySetupProviderPanel
          activatingProviderId={activatingProviderId}
          embeddingError={embeddingError}
          embeddingProviders={embeddingProviders}
          isEmbeddingLoading={isEmbeddingLoading}
          isSavingEmbeddingProvider={isSavingEmbeddingProvider}
          testingProviderId={testingProviderId}
          onContinue={handleSetupProviderContinue}
          onActivateEmbeddingProvider={handleActivateEmbeddingProvider}
          onSaveEmbeddingProvider={handleSaveEmbeddingProvider}
          onTestEmbeddingProvider={handleTestEmbeddingProvider}
          />
        </Suspense>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      {pwaStatusBanner}
      <aside className={styles.sidebar} aria-label={t.navigation.ariaLabel}>
        <div className={styles.brand}>
          <img alt="" className={styles.brandMark} src="/logo-64.png" />
          <span>
            <strong>{t.common.brandName}</strong>
            <small>{t.common.brandSubtitle}</small>
          </span>
        </div>
        <nav className={styles.nav}>
          {navigationItems.map((item) => {
            const navigationPage = pageForNavigationItem(item);
            const isPlaceholder = !navigationPage;
            const isOfflineDisabled = isUsingOfflineData && (item === "search" || item === "feeds");

            return (
              <a
                aria-disabled={isPlaceholder || isOfflineDisabled ? "true" : undefined}
                aria-label={t.navigation.items[item]}
                className={classNames(
                  isNavigationItemActive(item, appPage) ? styles.navItemActive : styles.navItem,
                  utilityNavigationItems.includes(item) ? styles.navUtilityItem : null
                )}
                data-disabled={isPlaceholder || isOfflineDisabled ? "true" : undefined}
                href={
                  navigationPage
                    ? urlForAppPage(navigationPage, {
                        favoriteSort,
                        readLaterSort,
                        timeWindow,
                        unreadOnly
                      })
                    : "#"
                }
                key={item}
                onClick={(event) => handleNavigationClick(event, item)}
                title={isOfflineDisabled ? t.offlineReading.unavailable : t.navigation.items[item]}
              >
                <NavigationIcon item={item} />
                <span className={styles.navLabel}>{t.navigation.items[item]}</span>
              </a>
            );
          })}
          {pluginDesktopNavItems.map(({ plugin, nav, page }) => (
            <a
              aria-label={nav.label}
              className={classNames(
                sameAppPage(appPage, page) ? styles.navItemActive : styles.navItem,
                styles.navDesktopOnly
              )}
              href={urlForAppPage(page)}
              key={`${plugin.id}:${nav.route}`}
              onClick={(event) => handlePluginNavigationClick(event, page)}
              title={nav.label}
            >
              <ActionIcon name={iconNameForPlugin(nav.icon)} />
              <span className={styles.navLabel}>{nav.label}</span>
            </a>
          ))}
          {pluginMobilePrimaryNavItems.map(({ plugin, nav, page }) => (
            <a
              aria-label={nav.label}
              className={classNames(
                sameAppPage(appPage, page) ? styles.navItemActive : styles.navItem,
                styles.navMobileOnly
              )}
              href={urlForAppPage(page)}
              key={`${plugin.id}:${nav.route}:mobile`}
              onClick={(event) => handlePluginNavigationClick(event, page)}
              title={nav.label}
            >
              <ActionIcon name={iconNameForPlugin(nav.icon)} />
              <span className={styles.navLabel}>{nav.label}</span>
            </a>
          ))}
          <button
            aria-controls="mobile-utility-menu"
            aria-expanded={isUtilityMenuOpen}
            aria-label={t.navigation.utilityMenuLabel}
            className={classNames(
              isMobileUtilityNavigationActive ? styles.navItemActive : styles.navItem,
              styles.navUtilityToggle
            )}
            onClick={() => setIsUtilityMenuOpen((isOpen) => !isOpen)}
            title={t.navigation.utilityMenuLabel}
            type="button"
          >
            <ActionIcon name="more" />
            <span className={styles.navLabel}>{t.navigation.utilityMenuLabel}</span>
          </button>
          {isUtilityMenuOpen ? (
            <div
              className={styles.utilityMenu}
              id="mobile-utility-menu"
              role="menu"
              aria-label={t.navigation.utilityMenuLabel}
            >
              {utilityNavigationItems.map((item) => {
                const navigationPage = pageForNavigationItem(item);
                const isPlaceholder = !navigationPage;
                const isOfflineDisabled = isUsingOfflineData && (item === "search" || item === "feeds");

                return (
                  <a
                    aria-disabled={isPlaceholder || isOfflineDisabled ? "true" : undefined}
                    className={styles.utilityMenuItem}
                    data-disabled={isPlaceholder || isOfflineDisabled ? "true" : undefined}
                    href={navigationPage ? urlForAppPage(navigationPage) : "#"}
                    key={item}
                    onClick={(event) => handleNavigationClick(event, item)}
                    role="menuitem"
                    title={isOfflineDisabled ? t.offlineReading.unavailable : undefined}
                  >
                    <NavigationIcon item={item} />
                    <span>{t.navigation.items[item]}</span>
                  </a>
                );
              })}
              {pluginMobileOverflowNavItems.map(({ plugin, nav, page }) => (
                <a
                  className={styles.utilityMenuItem}
                  href={urlForAppPage(page)}
                  key={`${plugin.id}:${nav.route}`}
                  onClick={(event) => handlePluginNavigationClick(event, page)}
                  role="menuitem"
                >
                  <ActionIcon name={iconNameForPlugin(nav.icon)} />
                  <span>{nav.label}</span>
                </a>
              ))}
            </div>
          ) : null}
        </nav>
      </aside>

      <section className={styles.content} aria-labelledby="page-title">
        <header className={styles.topbar}>
          <div>
            {pageKicker ? <p className={styles.kicker}>{pageKicker}</p> : null}
            <h1 id="page-title">{pageTitle}</h1>
          </div>
          <div className={styles.topbarMeta}>
            {topbarStatus ? (
              <span className={styles.statusText} aria-live="polite">
                {topbarStatus}
              </span>
            ) : null}
            {authUsername ? <span className={styles.accountName}>{authUsername}</span> : null}
            {logoutError ? <span className={styles.logoutError}>{logoutError}</span> : null}
            <button
              className={styles.secondaryButton}
              onClick={handleLogout}
              title={t.auth.logoutTitle}
              type="button"
            >
              {t.auth.logout}
            </button>
            <span className={styles.version}>{t.common.version(dibaoVersion)}</span>
          </div>
        </header>

        {appPage.type === "feed-management" ? (
          <FeedManagementWorkspace
            diagnostics={feedDiagnostics}
            diagnosticsByFeedId={feedDiagnosticsByFeedId}
            feedError={feedError}
            feedDiscovery={feedDiscovery}
            feedDiscoveryError={feedDiscoveryError}
            feedUrl={feedUrl}
            feedFolders={feedFolders}
            feeds={feeds}
            isAddingFeed={isAddingFeed}
            isDiscoveringFeeds={isDiscoveringFeeds}
            isFeedDiagnosticsLoading={isFeedDiagnosticsLoading}
            isExportingOpml={isExportingOpml}
            isImportingOpml={isImportingOpml}
            isLoading={isFeedsLoading}
            isRefreshingAllFeeds={isRefreshingAllFeeds}
            onAddCandidate={handleAddDiscoveredFeed}
            onAddFeed={handleAddFeed}
            onCreateFolder={handleCreateManagedFolder}
            onDeleteFeed={handleDeleteManagedFeed}
            onDeleteFolder={handleDeleteManagedFolder}
            onExportOpml={handleExportOpml}
            onImportOpml={handleImportOpml}
            onPluginAction={(action, context) => {
              void handlePluginAction(action, context);
            }}
            onRefreshFeed={handleRefreshFeed}
            onRefreshAllFeeds={handleRefreshAllFeeds}
            onPreviewFullContent={handlePreviewFullContent}
            onBackfillCurrentFeedFullContent={handleBackfillCurrentFeedFullContent}
            onUpdateFeedUrl={setFeedUrl}
            onUpdateFeed={handleUpdateManagedFeed}
            onUpdateFolder={handleUpdateManagedFolder}
            opmlSummary={opmlSummary}
            pluginToolbarActions={pluginActionsForSlot("feed.management.toolbar.end")}
            refreshingFeedId={refreshingFeedId}
          />
        ) : appPage.type === "full-content-preview" ? (
          <Suspense fallback={<p className={styles.settingsNotice}>{t.fullContentPreview.loading}</p>}>
          <LazyFullContentPreviewPage
            feed={feeds.find((feed) => feed.id === appPage.feedId) ?? null}
            feedId={appPage.feedId}
            onBack={() => navigateToAppPage({ type: "feed-management" })}
          />
          </Suspense>
        ) : appPage.type === "settings" ? (
          <Suspense fallback={<p className={styles.settingsNotice}>{t.settings.loading}</p>}>
          <LazySettingsWorkspace
            embeddingError={embeddingError}
            embeddingIndexes={embeddingIndexes}
            embeddingProviders={embeddingProviders}
            error={settingsError}
            isEmbeddingLoading={isEmbeddingLoading}
            isLoading={isSettingsLoading}
            isOffline={isUsingOfflineData}
            isOfflineCacheRefreshing={isOfflineCacheRefreshing}
            activatingProviderId={activatingProviderId}
            isSavingEmbeddingProvider={isSavingEmbeddingProvider}
            isSaving={isSavingSettings}
            backfillingIndexId={backfillingIndexId}
            deletingProviderId={deletingProviderId}
            rebuildingIndexId={rebuildingIndexId}
            testingProviderId={testingProviderId}
            onBackfillEmbeddingIndex={handleBackfillEmbeddingIndex}
            onActivateEmbeddingProvider={async (providerId) => {
              await handleActivateEmbeddingProvider(providerId);
            }}
            onDeleteEmbeddingProvider={handleDeleteEmbeddingProvider}
            onChangePassword={handleChangePassword}
            onPreviewSettings={handlePreviewSettings}
            onRebuildEmbeddingIndex={handleRebuildEmbeddingIndex}
            onOpenAlgorithmTransparency={() => navigateToAppPage({ type: "algorithm-transparency" })}
            offlineSummary={offlineSummary}
            offlineEnabled={offlineReadingEnabled}
            offlineTarget={offlineProfile?.deviceSettings.recommendedTarget ?? offlineSummary.targetCount}
            onOfflineEnabledChange={handleOfflineEnabledChange}
            onOfflineTargetChange={handleOfflineTargetChange}
            onRefreshOfflineCache={
              isUsingOfflineData || !offlineReadingEnabled
                ? undefined
                : async () => { await refreshOfflineCacheNow(); }
            }
            onClearOfflineCache={handleClearOfflineCache}
            onSaveSettings={handleSaveSettings}
            onSaveEmbeddingProvider={handleSaveEmbeddingProvider}
            onTestEmbeddingProvider={handleTestEmbeddingProvider}
            settings={appSettings}
          />
          </Suspense>
        ) : appPage.type === "plugin" ? (
          <PluginWorkspace
            plugin={activePlugin}
            route={appPage.route}
            onArticleStateChange={applyArticleState}
            onOpenArticle={(articleId) => {
              navigateToAppPage({ type: "reader", view: currentArticleView });
              setSelectedArticleId(articleId);
            }}
          />
        ) : appPage.type === "algorithm-transparency" ? (
          <Suspense fallback={<p className={styles.settingsNotice}>{t.recommendationStatus.loading}</p>}>
          <LazyAlgorithmTransparencyPage
            error={recommendationStatusError}
            isLoading={isRecommendationStatusLoading}
            onBack={() => navigateToAppPage({ type: "settings" })}
            onOpenAllClusters={() => navigateToAppPage({ type: "algorithm-clusters" })}
            onRunMaintenanceTask={handleRunRecommendationMaintenanceTask}
            onUpdateClusterLabelLexicon={handleUpdateClusterLabelLexicon}
            onUpdateClusterLabel={handleUpdateRecommendationClusterLabel}
            onUpdateFamilyLabel={handleUpdateRecommendationFamilyLabel}
            onMergeCandidate={handleMergeClusterCandidate}
            onIgnoreCandidate={handleIgnoreClusterCandidate}
            clusterLabelLexicon={clusterLabelLexicon}
            mergeCandidates={mergeCandidates}
            runningMaintenanceTask={runningMaintenanceTask}
            status={recommendationStatus}
            updatingClusterLexicon={updatingClusterLexicon}
            updatingClusterLabelId={updatingClusterLabelId}
            updatingFamilyLabelId={updatingFamilyLabelId}
            updatingMergeCandidateId={updatingMergeCandidateId}
          />
          </Suspense>
        ) : appPage.type === "algorithm-clusters" ? (
          <Suspense fallback={<p className={styles.settingsNotice}>{t.recommendationStatus.loading}</p>}>
          <LazyAlgorithmClustersPage
            clusters={allRecommendationClusters}
            error={allClustersError}
            isLoading={isAllClustersLoading}
            onBack={() => navigateToAppPage({ type: "algorithm-transparency" })}
            onUpdateClusterLabel={handleUpdateRecommendationClusterLabel}
            onUpdateFamilyLabel={handleUpdateRecommendationFamilyLabel}
            total={allRecommendationClusterTotal}
            updatingClusterLabelId={updatingClusterLabelId}
            updatingFamilyLabelId={updatingFamilyLabelId}
          />
          </Suspense>
        ) : appPage.type === "search" ? (
          <div
            className={classNames(
              styles.workspace,
              selectedArticleId ? styles.workspaceReading : null
            )}
          >
            <SearchResultsPanel
              articleError={articleError}
              articleLoadingNotice={articleLoadingNotice}
              articles={articles}
              feedFolders={feedFolders}
              feeds={feeds}
              form={searchForm}
              hasSubmitted={hasSubmittedSearch}
              infiniteArticleLoading={appSettings.behavior.infiniteArticleLoading}
              isArticlesLoading={isArticlesLoading}
              isMarkingScopeRead={isMarkingScopeRead}
              isLoadingMore={isLoadingMoreArticles}
              loadMoreError={loadMoreError}
              nextCursor={nextArticleCursor}
              onArticleAction={handleArticleAction}
              onPluginAction={(action, context) => {
                void handlePluginAction(action, context);
              }}
              onChange={handleSearchFormChange}
              onExplainArticle={(articleId) => {
                void handleOpenListExplanation(articleId);
              }}
              onLoadMore={handleLoadMoreArticles}
              onMarkScopeRead={handleMarkCurrentSearchScopeRead}
              onSelectArticle={handleSelectArticle}
              onSubmit={handleSearchSubmit}
              pendingAction={pendingArticleAction}
              pluginRowActions={pluginActionsForSlot("article.list.item.actions.end")}
              readerCommandError={readerCommandError}
              relatedSearchMeta={relatedSearchMeta}
              resultUrlForm={submittedSearchForm}
              selectedArticleId={selectedArticleId}
              unreadCount={unreadCount}
            />

            <ArticleDetailPanel
              actionError={articleActionError}
              article={articleDetail}
              articleView={
                submittedSearchForm.sort === "recommended" ? "recommended" : currentArticleView
              }
              detailError={detailError}
              explanation={
                articleDetail && rankExplanation?.articleId === articleDetail.id
                  ? rankExplanation
                  : null
              }
              explanationError={explanationError}
              isDetailLoading={isDetailLoading}
              isExplanationOpen={isExplanationOpen}
              isExplanationLoading={isExplanationLoading}
              isOffline={isUsingOfflineData}
              onArticleAction={handleArticleAction}
              onPluginAction={(action, context) => {
                void handlePluginAction(action, context);
              }}
              onBackToList={handleBackToArticleList}
              onCloseExplanation={handleCloseExplanation}
              onLoadRelatedArticles={handleLoadRelatedArticles}
              onOpenExplanation={handleOpenExplanation}
              onOpenRelatedSearch={handleOpenRelatedSearch}
              onRetryPersonalizedRelated={handleRetryPersonalizedRelated}
              onSelectDiscoveryArticle={handleSelectArticle}
              onReadProgress={handleReadProgress}
              onRetryDetail={handleRetryArticleDetail}
              pendingAction={
                articleDetail && pendingArticleAction?.articleId === articleDetail.id
                  ? pendingArticleAction.intent
                  : null
              }
              pluginBottomActions={pluginActionsForSlot("article.reader.bottomSheet.actions")}
              pluginToolbarActions={pluginActionsForSlot("article.reader.toolbar.end")}
              readerSettings={appSettings.reader}
              relatedDiscovery={relatedDiscovery}
              personalizedDiscovery={personalizedDiscovery}
            />

            <ArticleExplanationDialog
              error={listExplanationError}
              explanation={listRankExplanation}
              isLoading={isListExplanationLoading}
              isOpen={isListExplanationOpen}
              onClose={clearListExplanation}
            />
          </div>
        ) : (
          <div
            className={classNames(
              styles.workspace,
              selectedArticleId ? styles.workspaceReading : null,
              isSourceDrawerOpen ? styles.workspaceSourcesOpen : null
            )}
          >
            <button
              aria-label={t.feeds.closeSources}
              className={styles.sourceBackdrop}
              onClick={() => setIsSourceDrawerOpen(false)}
              type="button"
            />
            <FeedPanel
              diagnosticsByFeedId={feedDiagnosticsByFeedId}
              feedError={feedError}
              feedFolders={feedFolders}
              feeds={feeds}
              isOpen={isSourceDrawerOpen}
              isFeedsLoading={isFeedsLoading}
              refreshDisabled={isUsingOfflineData}
              onRefreshFeed={handleRefreshFeed}
              onCloseSources={() => setIsSourceDrawerOpen(false)}
              onSelectSource={handleSelectSource}
              refreshingFeedId={refreshingFeedId}
              sourceSelection={sourceSelection}
            />

            <ArticleListPanel
              articleError={articleError}
              articleLoadingNotice={articleLoadingNotice}
              articleView={currentArticleView}
              articles={articles}
              feedCount={feeds.length}
              infiniteArticleLoading={appSettings.behavior.infiniteArticleLoading}
              isIgnoreTelemetryEnabled={!isUsingOfflineData && isArticleListIgnoreTelemetryEnabled({
                articleView: currentArticleView,
                markScrolledArticlesIgnored: appSettings.behavior.markScrolledArticlesIgnored
              })}
              isArticlesLoading={isArticlesLoading}
              isMarkingScopeRead={isMarkingScopeRead}
              isLoadingMore={isLoadingMoreArticles}
              listScrollKey={articleListScrollKey}
              loadMoreError={loadMoreError}
              nextCursor={nextArticleCursor}
              onIgnoreArticle={handleIgnoreArticle}
              onRecordRecommendationExposures={(input) => {
                if (isUsingOfflineData) return;
                void dibaoApi.recordRecommendationExposures(input).catch(() => undefined);
              }}
              onLoadMore={handleLoadMoreArticles}
              onMarkScopeRead={handleMarkCurrentArticleListScopeRead}
              onPreviewMarkScopeRead={previewCurrentArticleListScopeRead}
              onOpenSources={() => setIsSourceDrawerOpen(true)}
              onArticleAction={handleArticleAction}
              onPluginAction={(action, context) => {
                void handlePluginAction(action, context);
              }}
              onSelectArticle={handleSelectArticle}
              onExplainArticle={(articleId) => {
                void handleOpenListExplanation(articleId);
              }}
              onFavoriteSortChange={handleFavoriteSortChange}
              onReadLaterSortChange={handleReadLaterSortChange}
              onTimeWindowChange={handleTimeWindowChange}
              onUnreadOnlyChange={handleUnreadOnlyChange}
              favoriteSort={favoriteSort}
              readLaterSort={readLaterSort}
              pendingAction={pendingArticleAction}
              pluginListToolbarEndActions={pluginActionsForSlot("article.list.toolbar.end")}
              pluginListToolbarStartActions={pluginActionsForSlot("article.list.toolbar.start")}
              pluginRowActions={pluginActionsForSlot("article.list.item.actions.end")}
              recommendationStatus={
                currentArticleView === "recommended" ? recommendationStatus : null
              }
              recommendationStatusError={
                currentArticleView === "recommended" ? recommendationStatusError : null
              }
              recommendationInventory={
                currentArticleView === "recommended" ? recommendationInventory : null
              }
              recommendationInventoryError={
                currentArticleView === "recommended" ? recommendationInventoryError : null
              }
              offlineStatus={offlineReaderStatus}
              readerCommandsDisabled={isUsingOfflineData}
              readerCommandError={readerCommandError}
              selectedArticleId={selectedArticleId}
              selectedFeed={selectedFeed}
              selectedFolder={selectedFolder}
              showRecommendationStatus={currentArticleView === "recommended"}
              showQuickFilters={supportsQuickFilters(currentArticleView)}
              isRecommendationStatusLoading={isRecommendationStatusLoading}
              isRecommendationInventoryLoading={isRecommendationInventoryLoading}
              timeWindow={timeWindow}
              unreadCount={unreadCount}
              unreadOnly={unreadOnly}
            />

            <ArticleDetailPanel
              actionError={articleActionError}
              article={articleDetail}
              articleView={currentArticleView}
              detailError={detailError}
              explanation={
                articleDetail && rankExplanation?.articleId === articleDetail.id
                  ? rankExplanation
                  : null
              }
              explanationError={explanationError}
              isDetailLoading={isDetailLoading}
              isExplanationOpen={isExplanationOpen}
              isExplanationLoading={isExplanationLoading}
              isOffline={isUsingOfflineData}
              onArticleAction={handleArticleAction}
              onPluginAction={(action, context) => {
                void handlePluginAction(action, context);
              }}
              onBackToList={handleBackToArticleList}
              onCloseExplanation={handleCloseExplanation}
              onLoadRelatedArticles={handleLoadRelatedArticles}
              onOpenExplanation={handleOpenExplanation}
              onOpenRelatedSearch={handleOpenRelatedSearch}
              onRetryPersonalizedRelated={handleRetryPersonalizedRelated}
              onSelectDiscoveryArticle={handleSelectArticle}
              onReadProgress={handleReadProgress}
              onRetryDetail={handleRetryArticleDetail}
              pendingAction={
                articleDetail && pendingArticleAction?.articleId === articleDetail.id
                  ? pendingArticleAction.intent
                  : null
              }
              pluginBottomActions={pluginActionsForSlot("article.reader.bottomSheet.actions")}
              pluginToolbarActions={pluginActionsForSlot("article.reader.toolbar.end")}
              readerSettings={appSettings.reader}
              relatedDiscovery={relatedDiscovery}
              personalizedDiscovery={personalizedDiscovery}
            />

            <ArticleExplanationDialog
              error={listExplanationError}
              explanation={listRankExplanation}
              isLoading={isListExplanationLoading}
              isOpen={isListExplanationOpen}
              onClose={clearListExplanation}
            />
          </div>
        )}
      </section>
    </main>
  );
}

function readArticleStateOverlay(now: number = Date.now()): ArticleStateOverlay {
  if (typeof window === "undefined") {
    return {
      states: new Map(),
      locallyUpdatedIds: new Set()
    };
  }

  try {
    const raw = window.sessionStorage.getItem(ARTICLE_STATE_OVERLAY_STORAGE_KEY);
    if (!raw) {
      return {
        states: new Map(),
        locallyUpdatedIds: new Set()
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      clearArticleStateOverlay();
      return {
        states: new Map(),
        locallyUpdatedIds: new Set()
      };
    }

    const entries = (parsed as { entries: unknown[] }).entries
      .filter(isArticleStateOverlayEntry)
      .filter((entry) => now - entry.updatedAt <= ARTICLE_STATE_OVERLAY_TTL_MS)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, ARTICLE_STATE_OVERLAY_LIMIT)
      .reverse();
    const states = new Map<string, ArticleState>();
    const locallyUpdatedIds = new Set<string>();
    for (const entry of entries) {
      states.set(entry.articleId, entry.state);
      locallyUpdatedIds.add(entry.articleId);
    }
    if (entries.length !== (parsed as { entries: unknown[] }).entries.length) {
      writeArticleStateOverlay(states, locallyUpdatedIds, now);
    }
    return { states, locallyUpdatedIds };
  } catch {
    clearArticleStateOverlay();
    return {
      states: new Map(),
      locallyUpdatedIds: new Set()
    };
  }
}

function writeArticleStateOverlay(
  states: Map<string, ArticleState>,
  locallyUpdatedIds: Set<string>,
  now: number = Date.now()
): void {
  if (typeof window === "undefined") {
    return;
  }

  const entries: ArticleStateOverlayEntry[] = Array.from(locallyUpdatedIds)
    .map((articleId) => {
      const state = states.get(articleId);
      return state
        ? {
            articleId,
            state,
            updatedAt: now
          }
        : null;
    })
    .filter((entry): entry is ArticleStateOverlayEntry => entry !== null)
    .slice(-ARTICLE_STATE_OVERLAY_LIMIT);

  try {
    window.sessionStorage.setItem(
      ARTICLE_STATE_OVERLAY_STORAGE_KEY,
      JSON.stringify({
        entries
      })
    );
  } catch {
    // Best-effort overlay. Server state remains authoritative.
  }
}

function clearArticleStateOverlay(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(ARTICLE_STATE_OVERLAY_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function isArticleStateOverlayEntry(value: unknown): value is ArticleStateOverlayEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ArticleStateOverlayEntry>;
  return (
    typeof candidate.articleId === "string" &&
    candidate.articleId.length > 0 &&
    typeof candidate.updatedAt === "number" &&
    Number.isFinite(candidate.updatedAt) &&
    isArticleState(candidate.state)
  );
}

function isArticleState(value: unknown): value is ArticleState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ArticleState>;
  return (
    typeof candidate.read === "boolean" &&
    typeof candidate.favorited === "boolean" &&
    typeof candidate.liked === "boolean" &&
    typeof candidate.readLater === "boolean" &&
    typeof candidate.hidden === "boolean" &&
    typeof candidate.notInterested === "boolean" &&
    typeof candidate.readingProgress === "number" &&
    Number.isFinite(candidate.readingProgress)
  );
}

function PluginWorkspace(props: {
  plugin: PluginListItem | null;
  route: string;
  onArticleStateChange: (articleId: string, state: ArticleState) => void;
  onOpenArticle: (articleId: string) => void;
}) {
  const { locale, t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    async function handleMessage(event: MessageEvent) {
      if (!props.plugin || event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const data = event.data as {
        type?: unknown;
        pluginId?: unknown;
        articleId?: unknown;
        url?: unknown;
        requestId?: unknown;
        method?: unknown;
        payload?: unknown;
      };
      if (data.pluginId !== props.plugin.id) {
        return;
      }
      if (data.type === "dibao.openArticle" && typeof data.articleId === "string") {
        props.onOpenArticle(data.articleId);
        return;
      }
      if (data.type !== "dibao.bridge" || typeof data.requestId !== "string" || data.requestId.length > 128) {
        return;
      }
      try {
        const result = await handlePluginBridgeRequest(
          props.plugin,
          data.method,
          data.payload,
          props.onArticleStateChange,
          props.onOpenArticle
        );
        (event.source as WindowProxy | null)?.postMessage(
          {
            type: "dibao.bridge.response",
            schemaVersion: 1,
            pluginId: props.plugin.id,
            requestId: data.requestId,
            ok: true,
            result
          },
          "*"
        );
      } catch (error) {
        (event.source as WindowProxy | null)?.postMessage(
          {
            type: "dibao.bridge.response",
            schemaVersion: 1,
            pluginId: props.plugin.id,
            requestId: data.requestId,
            ok: false,
            error: userMessageForError(error, t.errors.api)
          },
          "*"
        );
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [props.plugin, props.onArticleStateChange, props.onOpenArticle, t.errors.api]);

  if (!props.plugin) {
    return (
      <section className={styles.pluginWorkspace}>
        <div className={styles.emptyState}>
          <strong>插件不可用</strong>
          <p>这个插件尚未启用，或当前贡献点已经失效。</p>
        </div>
      </section>
    );
  }

  const baseUrl =
    props.plugin.webEntryUrl ??
    `/api/plugins/${encodeURIComponent(props.plugin.id)}/assets/web/index.html`;
  const params = new URLSearchParams();
  params.set("route", props.route);
  params.set("locale", locale);
  if (props.route === "settings") {
    params.set("panel", "settings");
  }

  return (
    <section className={styles.pluginWorkspace} aria-label={props.plugin.name}>
      <iframe
        className={styles.pluginFrame}
        ref={frameRef}
        sandbox="allow-scripts allow-forms"
        src={`${baseUrl}?${params.toString()}`}
        title={props.plugin.name || t.common.brandName}
      />
    </section>
  );
}

async function handlePluginBridgeRequest(
  plugin: PluginListItem,
  method: unknown,
  payload: unknown,
  onArticleStateChange: (articleId: string, state: ArticleState) => void,
  onOpenArticle: (articleId: string) => void
): Promise<unknown> {
  const input = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  switch (method) {
    case "getAuthSession":
      return await dibaoApi.getAuthSession();
    case "getSettings":
      return await dibaoApi.getPluginSettings(plugin.id);
    case "getLocale":
      return document.documentElement.lang || "zh-CN";
    case "updatePluginSettings":
      return await dibaoApi.updatePluginSettings(
        plugin.id,
        input.settings && typeof input.settings === "object" && !Array.isArray(input.settings)
          ? input.settings as Record<string, unknown>
          : input
      );
    case "listPluginSecrets":
      return await dibaoApi.listPluginSecrets(plugin.id);
    case "setPluginSecret":
      if (typeof input.key !== "string" || typeof input.value !== "string") {
        throw new Error("key and value are required");
      }
      return await dibaoApi.setPluginSecret(plugin.id, input.key, {
        value: input.value,
        hint: typeof input.hint === "string" ? input.hint : null
      });
    case "deletePluginSecret":
      if (typeof input.key !== "string") {
        throw new Error("key is required");
      }
      return await dibaoApi.deletePluginSecret(plugin.id, input.key);
    case "listPluginDeliveries":
      return await dibaoApi.listPluginDeliveries(plugin.id, {
        status: isPluginDeliveryStatus(input.status) ? input.status : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined
      });
    case "getPluginDelivery":
      if (typeof input.deliveryId !== "string") {
        throw new Error("deliveryId is required");
      }
      return await dibaoApi.getPluginDelivery(plugin.id, input.deliveryId);
    case "startTask":
      if (typeof input.taskId !== "string") {
        throw new Error("taskId is required");
      }
      return await dibaoApi.startPluginTask(plugin.id, input.taskId);
    case "listJobs":
      return await dibaoApi.listJobs({
        type: typeof input.type === "string" ? input.type : undefined,
        status: isPluginJobStatus(input.status) ? input.status : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined
      });
    case "readArticles":
      return await dibaoApi.listArticles({
        view: isArticleView(input.view) ? input.view : "recommended",
        limit: typeof input.limit === "number" ? input.limit : undefined
      });
    case "getArticleState": {
      if (typeof input.articleId !== "string") {
        throw new Error("articleId is required");
      }
      const article = await dibaoApi.getArticle(input.articleId);
      onArticleStateChange(input.articleId, article.state);
      return {
        articleId: input.articleId,
        state: article.state
      };
    }
    case "recordArticleAction": {
      if (typeof input.articleId !== "string") {
        throw new Error("articleId is required");
      }
      if (!isPluginArticleActionIntent(input.intent)) {
        throw new Error("intent must be favorite, like, readLater, or notInterested");
      }
      const article = await dibaoApi.getArticle(input.articleId);
      const result = await dibaoApi.postArticleAction(
        input.articleId,
        requestForArticleAction(input.intent, article.state)
      );
      onArticleStateChange(input.articleId, result.state);
      return {
        articleId: input.articleId,
        state: result.state
      };
    }
    case "getArticleExplanation":
      if (typeof input.articleId !== "string") {
        throw new Error("articleId is required");
      }
      return await dibaoApi.getArticleExplanation(input.articleId);
    case "openArticle":
      if (typeof input.articleId !== "string") {
        throw new Error("articleId is required");
      }
      onOpenArticle(input.articleId);
      return { ok: true };
    case "pluginApi":
      if (typeof input.path !== "string") {
        throw new Error("path is required");
      }
      return await dibaoApi.callPluginApi(
        plugin.id,
        input.path,
        input.body ?? {},
        input.method === "GET" ? "GET" : "POST"
      );
    default:
      throw new Error("Unsupported plugin bridge method");
  }
}

function isPluginArticleActionIntent(value: unknown): value is ArticleActionIntent {
  return value === "favorite" || value === "like" || value === "readLater" || value === "notInterested";
}

function isArticleView(value: unknown): value is ArticleView {
  return value === "latest" || value === "recommended" || value === "favorites" || value === "read_later";
}

function discoveryStateForResponse(response: ReaderDiscoveryResponse): ReaderDiscoveryPanelState {
  if (response.status === "unavailable") {
    return {
      status: "unavailable",
      items: [],
      reason: response.reason
    };
  }

  return {
    status: "ready",
    items: response.items
  };
}

function isRelatedSearchResponse(response: unknown): response is RelatedSearchResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "threshold" in response &&
    typeof (response as { threshold?: unknown }).threshold === "number" &&
    "totalCount" in response &&
    typeof (response as { totalCount?: unknown }).totalCount === "number"
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
}

function isPluginJobStatus(value: unknown): value is JobListItem["status"] {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isPluginDeliveryStatus(value: unknown): value is "queued" | "running" | "succeeded" | "failed" | "cancelled" {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function iconNameForPlugin(icon: string | undefined): Parameters<typeof ActionIcon>[0]["name"] {
  if (icon === "settings" || icon === "gear") {
    return "gear";
  }
  if (icon === "search") {
    return "search";
  }
  if (icon === "star" || icon === "favorites") {
    return "star";
  }
  if (icon === "bookmark" || icon === "read_later") {
    return "bookmark";
  }
  if (icon === "sparkle" || icon === "recommended") {
    return "sparkle";
  }
  return "feed";
}
