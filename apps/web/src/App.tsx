import type {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  MouseEvent,
  RefObject,
  SyntheticEvent
} from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dibaoVersion } from "@dibao/shared";
import {
  defaultAppSettings,
  dibaoApi,
  userMessageForError,
  type ArticleActionRequest,
  type ArticleDetail,
  type ArticleListItem,
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
  type LatestReleaseStatus,
  type OpmlImportResponse,
  type RankExplanation,
  type RankExplanationReason,
  type ReadLaterArticleSort,
  type ReaderSettings,
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
  articleListAfterStateUpdate,
  articleListWithKnownLocalStates,
  articlesVisibleForUnreadFilter,
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

const primaryNavigationItems: NavigationItemKey[] = [
  "recommended",
  "latest",
  "read_later",
  "favorites"
];

const utilityNavigationItems: NavigationItemKey[] = [
  "search",
  "feeds",
  "settings"
];

const navigationItems: NavigationItemKey[] = [
  ...primaryNavigationItems,
  ...utilityNavigationItems
];

const defaultFavoriteArticleSort: FavoriteArticleSort = "favorited_desc";
const defaultReadLaterArticleSort: ReadLaterArticleSort = "ranked";
const defaultReaderFilters: PersistedReaderFilters = {
  sourceSelection: { type: "all" },
  unreadOnly: false,
  timeWindow: "all"
};

type Notice =
  | { type: "feedAddedAndRefreshed"; feedTitle: string }
  | { type: "feedRefreshed"; feedTitle: string }
  | { type: "allFeedsRefreshQueued"; jobCount: number }
  | { type: "opmlImported"; result: OpmlImportResponse }
  | { type: "opmlExported" }
  | { type: "settingsSaved" }
  | { type: "embeddingProviderSaved" }
  | { type: "embeddingProviderActivated" }
  | { type: "embeddingProviderTested" }
  | { type: "embeddingProviderDeleted" }
  | { type: "embeddingIndexRebuildQueued" }
  | { type: "embeddingIndexBackfillQueued" }
  | { type: "recommendationMaintenanceQueued"; label: string; existing: boolean }
  | { type: "readerCommandMarkScopeRead"; count: number };

type PwaUpdateAvailableEvent = CustomEvent<{
  applyUpdate: () => void;
}>;

type FeedDiagnosticsByFeedId = Record<string, FeedDiagnosticItem["diagnostic"]>;

export type SourceSelection =
  | { type: "all" }
  | { type: "folder"; folderId: string }
  | { type: "feed"; feedId: string };

type AuthMode = "setup" | "login";

export type AppPage =
  | { type: "reader"; view: ArticleView }
  | { type: "search" }
  | { type: "feed-management" }
  | { type: "full-content-preview"; feedId: string }
  | { type: "settings" }
  | { type: "algorithm-transparency" }
  | { type: "algorithm-clusters" };

type AppRoute = {
  page: AppPage;
  articleId: string | null;
  hasExplicitPage: boolean;
};

type PersistedReaderFilters = {
  sourceSelection: SourceSelection;
  unreadOnly: boolean;
  timeWindow: ArticleTimeWindow;
};

type SearchFormState = {
  q: string;
  sourceSelection: SourceSelection;
  state: ArticleSearchState;
  sort: ArticleSearchSort;
  from: string;
  to: string;
};

export type AppStage =
  | { type: "auth-loading" }
  | { type: "welcome" }
  | { type: "setup-password" }
  | { type: "login" }
  | { type: "setup-status-loading" }
  | { type: "derived-data-upgrade" }
  | { type: "setup-sources" }
  | { type: "setup-provider" }
  | { type: "reader" };

export type ArticleActionIntent = "favorite" | "like" | "readLater" | "notInterested";

type ArticleActionTarget = Pick<ArticleDetail, "id" | "state">;

type PendingArticleAction = {
  articleId: string;
  intent: ArticleActionIntent;
};

type ReadProgressMetadata = {
  durationMs: number;
  activeDurationMs: number;
  scrollSource: "reader";
};

type ReadProgressPostOptions = {
  keepalive?: boolean;
};

export function stageForAuthSession(session: AuthSession): AppStage {
  if (!session.setupCompleted) {
    return { type: "welcome" };
  }

  if (!session.authenticated) {
    return { type: "login" };
  }

  return { type: "setup-status-loading" };
}

export function stageForSetupStatus(status: SetupStatus): AppStage {
  if (!status.setupCompleted) {
    return { type: "welcome" };
  }

  if (status.derivedDataUpgrade?.blocking) {
    return { type: "derived-data-upgrade" };
  }

  return { type: status.hasFeeds ? "reader" : "setup-sources" };
}

export function correctSourceSelection(
  source: SourceSelection,
  feeds: Pick<Feed, "id">[],
  folders: Pick<FeedFolder, "id">[]
): SourceSelection {
  if (source.type === "feed") {
    return feeds.some((feed) => feed.id === source.feedId) ? source : { type: "all" };
  }

  if (source.type === "folder") {
    return folders.some((folder) => folder.id === source.folderId) ? source : { type: "all" };
  }

  return source;
}

function sameAppPage(left: AppPage, right: AppPage): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "reader" && right.type === "reader") {
    return left.view === right.view;
  }

  if (left.type === "full-content-preview" && right.type === "full-content-preview") {
    return left.feedId === right.feedId;
  }

  return true;
}

export function App() {
  const { t, setLocale } = useI18n();
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
  const [appStage, setAppStage] = useState<AppStage>({ type: "auth-loading" });
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
    () => initialRoute.page.type === "search" && initialSearchForm.q.trim().length > 0
  );
  const [submittedSearchForm, setSubmittedSearchForm] = useState<SearchFormState>(
    initialSearchForm
  );
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
  const [rankExplanation, setRankExplanation] = useState<RankExplanation | null>(null);
  const [listRankExplanation, setListRankExplanation] = useState<RankExplanation | null>(null);
  const [isExplanationOpen, setIsExplanationOpen] = useState(false);
  const [isListExplanationOpen, setIsListExplanationOpen] = useState(false);
  const [recommendationStatus, setRecommendationStatus] = useState<RecommendationStatus | null>(
    null
  );
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
  const [updatingClusterLexicon, setUpdatingClusterLexicon] = useState(false);
  const [updatingMergeCandidateId, setUpdatingMergeCandidateId] = useState<string | null>(null);
  const [isRecommendationStatusLoading, setIsRecommendationStatusLoading] = useState(false);
  const [recommendationStatusError, setRecommendationStatusError] = useState<string | null>(null);
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
  const [isExplanationLoading, setIsExplanationLoading] = useState(false);
  const [isListExplanationLoading, setIsListExplanationLoading] = useState(false);
  const [isAddingFeed, setIsAddingFeed] = useState(false);
  const [isImportingOpml, setIsImportingOpml] = useState(false);
  const [isExportingOpml, setIsExportingOpml] = useState(false);
  const [isRefreshingAllFeeds, setIsRefreshingAllFeeds] = useState(false);
  const [refreshingFeedId, setRefreshingFeedId] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [articleError, setArticleError] = useState<string | null>(null);
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
  const [pwaUpdateApply, setPwaUpdateApply] = useState<(() => void) | null>(null);
  const openedArticleIds = useRef(new Set<string>());
  const ignoredArticleIds = useRef(new Set<string>());
  const ignoredArticleQueue = useRef<string[]>([]);
  const isSendingIgnoredArticle = useRef(false);
  const selectedArticleIdRef = useRef<string | null>(selectedArticleId);
  const articleStateById = useRef(new Map<string, ArticleState>());
  const locallyUpdatedArticleIds = useRef(new Set<string>());
  const articleRequestVersion = useRef(0);
  const detailExplanationRequestVersion = useRef(0);
  const listExplanationRequestVersion = useRef(0);
  const hasLoadedSettingsForSession = useRef(false);
  const hasAppliedDefaultHomeViewForSession = useRef(false);
  const appPageRef = useRef<AppPage>(appPage);
  const hasExplicitUrlPageIntent = useRef(initialRoute.hasExplicitPage);

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
    locallyUpdatedArticleIds.current.add(articleId);
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

  function resetArticleListForPendingQuery() {
    articleRequestVersion.current += 1;
    setArticles([]);
    setUnreadCount(0);
    articleStateById.current.clear();
    locallyUpdatedArticleIds.current.clear();
    setNextArticleCursor(null);
    clearSelectedArticle();
    clearListExplanation();
    setArticleError(null);
    setReaderCommandError(null);
    setLoadMoreError(null);
    setIsLoadingMoreArticles(false);
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
    setSearchForm(nextForm);
  }

  function handleSearchSubmit(nextForm: SearchFormState) {
    const normalizedForm = {
      ...nextForm,
      q: nextForm.q.trim()
    };
    resetArticleListForPendingQuery();
    setSearchForm(normalizedForm);
    setSubmittedSearchForm(normalizedForm);
    setHasSubmittedSearch(normalizedForm.q.length > 0);
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
    articleStateById.current.clear();
    locallyUpdatedArticleIds.current.clear();
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
    hasLoadedSettingsForSession.current = false;
    hasAppliedDefaultHomeViewForSession.current = hasExplicitUrlPageIntent.current;
    openedArticleIds.current.clear();
    ignoredArticleIds.current.clear();
    locallyUpdatedArticleIds.current.clear();
    articleRequestVersion.current += 1;
  }, [setLocale]);

  useEffect(() => {
    let cancelled = false;

    async function loadAuthSession() {
      setAppStage({ type: "auth-loading" });
      setAuthError(null);

      try {
        const session = await dibaoApi.getAuthSession();
        if (!cancelled) {
          const nextStage = stageForAuthSession(session);
          if (nextStage.type === "welcome" || nextStage.type === "login") {
            resetReaderState();
          }
          setAppStage(nextStage);
        }
      } catch (error) {
        if (!cancelled) {
          setAuthError(userMessageForError(error, t.errors.api));
          resetReaderState();
          setAppStage({ type: "login" });
        }
      }
    }

    void loadAuthSession();

    return () => {
      cancelled = true;
    };
  }, [resetReaderState, t.errors.api]);

  useEffect(() => {
    function updateOnlineStatus() {
      setIsOffline(navigator.onLine === false);
    }

    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    updateOnlineStatus();

    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

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

      try {
        const status = await dibaoApi.getSetupStatus();
        if (!cancelled) {
          setDerivedDataUpgrade(status.derivedDataUpgrade ?? null);
          const nextStage = stageForSetupStatus(status);
          if (nextStage.type === "welcome") {
            resetReaderState();
          }
          setAppStage(nextStage);
        }
      } catch (error) {
        if (!cancelled) {
          setAuthError(userMessageForError(error, t.errors.api));
          resetReaderState();
          setAppStage({ type: "login" });
        }
      }
    }

    void loadSetupStatus();

    return () => {
      cancelled = true;
    };
  }, [appStage.type, resetReaderState, t.errors.api]);

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

  const applySettings = useCallback(
    (settings: AppSettings) => {
      setAppSettings(settings);
      setLocale(settings.ui.locale);
      setTelemetryEnabled(settings.telemetry.enabled);
      configureClientTelemetry(settings.telemetry.enabled);
    },
    [setLocale]
  );

  useEffect(() => {
    appPageRef.current = appPage;
  }, [appPage]);

  useEffect(() => {
    selectedArticleIdRef.current = selectedArticleId;
    if (selectedArticleId) {
      ignoredArticleQueue.current = [];
    }
  }, [selectedArticleId]);

  useEffect(() => {
    if (appStage.type !== "reader" || hasLoadedSettingsForSession.current) {
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
  }, [appStage.type, applySettings, t.errors.api]);

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
      (appStage.type !== "reader" || appPage.type !== "settings") &&
      appStage.type !== "setup-provider"
    ) {
      return;
    }

    void loadEmbeddingSettings({ includeIndexes: false });
  }, [appPage.type, appStage.type, loadEmbeddingSettings]);

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
      const [status, lexicon, candidates] = await Promise.all([
        dibaoApi.getRecommendationTransparency(),
        dibaoApi.getClusterLabelLexicon(),
        dibaoApi.listRecommendationClusterMergeCandidates("all")
      ]);
      setRecommendationStatus(status);
      setClusterLabelLexicon(lexicon);
      setMergeCandidates(candidates.candidates);
    } catch (error) {
      setRecommendationStatus(null);
      setClusterLabelLexicon(null);
      setMergeCandidates([]);
      setRecommendationStatusError(userMessageForError(error, t.errors.api));
    } finally {
      setIsRecommendationStatusLoading(false);
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
      const result = await dibaoApi.listRecommendationClusters("all");
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

    try {
      const nextFeeds = await dibaoApi.listFeeds();
      setFeeds(nextFeeds);
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
  }, [t.errors.api]);

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
    try {
      const nextFolders = await dibaoApi.listFeedFolders();
      setFeedFolders(nextFolders);
      setSourceSelection((current) =>
        current.type === "folder" &&
        !nextFolders.some((folder) => folder.id === current.folderId)
          ? { type: "all" }
          : current
      );
    } catch (error) {
      setFeedError(userMessageForError(error, t.errors.api));
    }
  }, [t.errors.api]);

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
    setLoadMoreError(null);
    setNextArticleCursor(null);
    setArticles([]);
    if (view !== "recommended" && appPage.type !== "algorithm-transparency") {
      setRecommendationStatus(null);
      setIsRecommendationStatusLoading(false);
      setRecommendationStatusError(null);
    }
    setDetailError(null);
    setExplanationError(null);

    try {
      const response = await dibaoApi.listArticles({
        ...articleQueryFor(selection),
        view,
        limit: 50,
        unreadOnly: supportsUnreadOnly(view) ? onlyUnread : false,
        timeWindow: supportsQuickFilters(view) ? selectedTimeWindow : "all",
        sort: articleSortForView(view, sort, laterSort)
      });
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      const responseArticles = articleListWithKnownLocalStates(
        response.data,
        articleStateById.current,
        locallyUpdatedArticleIds.current
      );
      rememberArticleStates(responseArticles, articleStateById.current);
      setArticles(
        articlesVisibleForUnreadFilter(responseArticles, supportsUnreadOnly(view) && onlyUnread)
      );
      setUnreadCount(
        unreadCountWithKnownLocalStates(
          response.meta.unreadCount,
          response.data,
          articleStateById.current,
          locallyUpdatedArticleIds.current
        )
      );
      setNextArticleCursor(response.page.nextCursor);
    } catch (error) {
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      setArticleError(userMessageForError(error, t.errors.api));
      setArticles([]);
      setUnreadCount(0);
      articleStateById.current.clear();
      locallyUpdatedArticleIds.current.clear();
      setNextArticleCursor(null);
    } finally {
      if (requestVersion === articleRequestVersion.current) {
        setIsArticlesLoading(false);
      }
    }
  }, [appPage.type, t.errors.api]);

  const loadSearchArticles = useCallback(async (form: SearchFormState) => {
    const requestVersion = articleRequestVersion.current + 1;
    articleRequestVersion.current = requestVersion;
    setIsArticlesLoading(true);
    setArticleError(null);
    setLoadMoreError(null);
    setNextArticleCursor(null);
    setArticles([]);
    setDetailError(null);
    setExplanationError(null);
    setRecommendationStatus(null);
    setIsRecommendationStatusLoading(false);
    setRecommendationStatusError(null);

    try {
      const response = await dibaoApi.searchArticles({
        ...articleQueryFor(form.sourceSelection),
        q: form.q.trim(),
        state: form.state,
        sort: form.sort,
        from: form.from || null,
        to: form.to || null,
        limit: 50
      });
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      const responseArticles = articleListWithKnownLocalStates(
        response.data,
        articleStateById.current,
        locallyUpdatedArticleIds.current
      );
      rememberArticleStates(responseArticles, articleStateById.current);
      setArticles(responseArticles);
      setUnreadCount(
        unreadCountWithKnownLocalStates(
          response.meta.unreadCount,
          response.data,
          articleStateById.current,
          locallyUpdatedArticleIds.current
        )
      );
      setNextArticleCursor(response.page.nextCursor);
    } catch (error) {
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      setArticleError(userMessageForError(error, t.errors.api));
      setArticles([]);
      setUnreadCount(0);
      articleStateById.current.clear();
      locallyUpdatedArticleIds.current.clear();
      setNextArticleCursor(null);
    } finally {
      if (requestVersion === articleRequestVersion.current) {
        setIsArticlesLoading(false);
      }
    }
  }, [t.errors.api]);

  useEffect(() => {
    if (appStage.type !== "reader") {
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
    favoriteSort,
    loadArticles,
    readLaterSort,
    sourceSelection,
    timeWindow,
    unreadOnly
  ]);

  useEffect(() => {
    if (appStage.type !== "reader" || appPage.type !== "search" || !hasSubmittedSearch) {
      return;
    }

    void loadSearchArticles(submittedSearchForm);
  }, [appPage.type, appStage.type, hasSubmittedSearch, loadSearchArticles, submittedSearchForm]);

  useEffect(() => {
    if (
      appStage.type !== "reader" ||
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
  }, [appPage.type, appStage.type, currentArticleView, sourceSelection, timeWindow, unreadOnly]);

  useEffect(() => {
    if (appStage.type !== "reader") {
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
    loadRecommendationStatus,
    loadRecommendationSummaryStatus
  ]);

  useEffect(() => {
    if (appStage.type !== "reader" || appPage.type !== "algorithm-clusters") {
      return;
    }

    void loadAllRecommendationClusters();
  }, [appPage.type, appStage.type, loadAllRecommendationClusters]);

  useEffect(() => {
    function handlePopState() {
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
        setHasSubmittedSearch(nextSearchForm.q.trim().length > 0);
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
    let cancelled = false;

    async function loadDetail(articleId: string) {
      setIsDetailLoading(true);
      setDetailError(null);
      detailExplanationRequestVersion.current += 1;
      setRankExplanation(null);
      setExplanationError(null);
      setIsExplanationOpen(false);

      try {
        const detail = await dibaoApi.getArticle(articleId);
        const knownState = locallyUpdatedArticleIds.current.has(articleId)
          ? articleStateById.current.get(articleId)
          : null;
        const detailWithKnownState = knownState ? { ...detail, state: knownState } : detail;
        if (!cancelled) {
          articleStateById.current.set(articleId, detailWithKnownState.state);
          setArticleDetail(detailWithKnownState);
          setArticleActionError(null);
          setIsDetailLoading(false);
        }
        if (!cancelled && !openedArticleIds.current.has(articleId)) {
          openedArticleIds.current.add(articleId);
          applyArticleState(articleId, optimisticOpenedState(detailWithKnownState.state));
          try {
            const result = await dibaoApi.postArticleAction(articleId, {
              type: "open",
              value: true
            });
            if (!cancelled) {
              applyArticleState(articleId, result.state);
            }
          } catch {
            openedArticleIds.current.delete(articleId);
            if (!cancelled) {
              setArticleActionError(t.actions.errors.open);
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          setArticleDetail(null);
          setDetailError(userMessageForError(error, t.errors.api));
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
    refreshArticleExplanation,
    selectedArticleId,
    submittedSearchForm.sort,
    t.actions.errors.open,
    t.errors.api
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
        resetReaderState();
        setAppStage({ type: "setup-sources" });
      } else {
        await dibaoApi.login(username, password);
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

    try {
      await dibaoApi.logout();
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
      setAppStage({ type: "setup-provider" });
      return;
    }

    setSetupSourceError(noFeedsMessage);
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
      setArticleDetail(await dibaoApi.getArticle(selectedArticleId));
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
      setNotice({ type: "settingsSaved" });
    } catch (error) {
      setSettingsError(userMessageForError(error, t.errors.api));
    } finally {
      setIsSavingSettings(false);
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
      await dibaoApi.updateRecommendationClusterLabel(clusterId, manualLabel);
      await loadRecommendationStatus();
      if (appPageRef.current.type === "algorithm-clusters") {
        await loadAllRecommendationClusters();
      }
    } catch (error) {
      const message = userMessageForError(error, t.errors.api);
      setRecommendationStatusError(message);
      setAllClustersError(message);
    } finally {
      setUpdatingClusterLabelId(null);
    }
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
    setIsLoadingMoreArticles(true);
    setLoadMoreError(null);

    try {
      const response =
        appPage.type === "search"
          ? await dibaoApi.searchArticles({
              ...articleQueryFor(submittedSearchForm.sourceSelection),
              q: submittedSearchForm.q.trim(),
              state: submittedSearchForm.state,
              sort: submittedSearchForm.sort,
              from: submittedSearchForm.from || null,
              to: submittedSearchForm.to || null,
              limit: 50,
              cursor: nextArticleCursor
            })
          : await dibaoApi.listArticles({
              ...articleQueryFor(sourceSelection),
              view: currentArticleView,
              limit: 50,
              cursor: nextArticleCursor,
              unreadOnly: supportsUnreadOnly(currentArticleView) ? unreadOnly : false,
              timeWindow: supportsQuickFilters(currentArticleView) ? timeWindow : "all",
              sort: articleSortForView(currentArticleView, favoriteSort, readLaterSort)
            });
      if (requestVersion !== articleRequestVersion.current) {
        return;
      }
      const responseArticles = articleListWithKnownLocalStates(
        response.data,
        articleStateById.current,
        locallyUpdatedArticleIds.current
      );
      rememberArticleStates(responseArticles, articleStateById.current);
      setArticles((current) =>
        appendUniqueArticles(
          current,
          appPage.type === "search"
            ? responseArticles
            : articlesVisibleForUnreadFilter(
                responseArticles,
                supportsUnreadOnly(currentArticleView) && unreadOnly
              )
        )
      );
      setUnreadCount(
        unreadCountWithKnownLocalStates(
          response.meta.unreadCount,
          response.data,
          articleStateById.current,
          locallyUpdatedArticleIds.current
        )
      );
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
    if (currentArticleView !== "latest" && currentArticleView !== "recommended") {
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
    if (currentArticleView !== "latest" && currentArticleView !== "recommended") {
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
    setIsMarkingScopeRead(true);
    setReaderCommandError(null);
    setNotice(null);

    try {
      const result = await dibaoApi.markScopeRead(scope);
      setNotice({ type: "readerCommandMarkScopeRead", count: result.markedReadCount });
      articleStateById.current.clear();
      locallyUpdatedArticleIds.current.clear();
      await reload();
    } catch {
      setReaderCommandError(t.readerCommands.markScopeRead.error);
    } finally {
      setIsMarkingScopeRead(false);
    }
  }

  async function handleArticleAction(article: ArticleActionTarget, intent: ArticleActionIntent) {
    setPendingArticleAction({ articleId: article.id, intent });
    setArticleActionError(null);
    const previousState =
      articleStateById.current.get(article.id) ??
      (articleDetail?.id === article.id ? articleDetail.state : article.state);
    applyArticleState(article.id, optimisticStateForArticleAction(intent, previousState));

    try {
      const result = await dibaoApi.postArticleAction(
        article.id,
        requestForArticleAction(intent, previousState)
      );
      applyArticleState(article.id, result.state);
      void refreshArticleExplanation(article.id);
    } catch {
      applyArticleState(article.id, previousState);
      setArticleActionError(actionErrorMessageFor(intent, t));
    } finally {
      setPendingArticleAction((current) =>
        current?.articleId === article.id && current.intent === intent ? null : current
      );
    }
  }

  function handleIgnoreArticle(articleId: string) {
    if (
      ignoredArticleIds.current.has(articleId) ||
      ignoredArticleQueue.current.includes(articleId)
    ) {
      return;
    }

    ignoredArticleQueue.current.push(articleId);
    void drainIgnoredArticleQueue();
  }

  async function drainIgnoredArticleQueue() {
    if (isSendingIgnoredArticle.current) {
      return;
    }

    isSendingIgnoredArticle.current = true;
    try {
      while (ignoredArticleQueue.current.length > 0) {
        const articleId = ignoredArticleQueue.current.shift();
        if (articleId) {
          await postIgnoredArticle(articleId);
        }
      }
    } finally {
      isSendingIgnoredArticle.current = false;
    }
  }

  async function postIgnoredArticle(articleId: string) {
    const article = articlesRef.current.find((candidate) => candidate.id === articleId);
    const interactionStatus = article ? articleInteractionStatusForState(article.state) : "unseen";

    if (
      !article ||
      selectedArticleIdRef.current !== null ||
      openedArticleIds.current.has(articleId) ||
      ignoredArticleIds.current.has(articleId) ||
      interactionStatus !== "unseen"
    ) {
      return;
    }

    ignoredArticleIds.current.add(articleId);

    try {
      const result = await dibaoApi.postArticleAction(articleId, {
        type: "impression",
        metadata: {
          reason: "scrolled_past_unopened",
          view: currentArticleViewRef.current
        }
      });
      applyArticleState(articleId, result.state);
    } catch {
      ignoredArticleIds.current.delete(articleId);
      // Passive list telemetry should not interrupt browsing.
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
      dibaoApi.postArticleActionKeepalive(articleId, request);
      return;
    }

    try {
      const result = await dibaoApi.postArticleAction(articleId, request);
      applyArticleState(articleId, result.state);
    } catch {
      // Automatic reading telemetry should never interrupt the reader surface.
    }
  }

  function handleSelectArticle(articleId: string) {
    setIsExplanationOpen(false);
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

  function handleOpenExplanation() {
    if (!shouldLoadDetailRankExplanation(appPage, currentArticleView, submittedSearchForm.sort)) {
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
    if (!canLoadRankExplanation(appPageRef.current, currentArticleView)) {
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

  const noticeText = notice ? noticeTextFor(notice, t) : null;
  const pwaStatusBanner = (
    <PwaStatusBanner
      isOffline={isOffline}
      onApplyUpdate={pwaUpdateApply}
      onDismissUpdate={() => setPwaUpdateApply(null)}
    />
  );
  const pageTitle =
    appPage.type === "feed-management"
      ? t.feedManagement.pageTitle
      : appPage.type === "full-content-preview"
        ? t.fullContentPreview.pageTitle
      : appPage.type === "search"
        ? t.search.pageTitle
      : appPage.type === "settings"
        ? t.settings.pageTitle
        : appPage.type === "algorithm-transparency" || appPage.type === "algorithm-clusters"
          ? t.algorithmTransparency.pageTitle
          : t.shell.pageTitles[currentArticleView];
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
        <AuthGatePanel isSubmitting={false} mode="loading" />
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

  if (appStage.type === "setup-provider") {
    return (
      <main className={styles.authShell}>
        {pwaStatusBanner}
        <SetupProviderPanel
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

            return (
              <a
                aria-disabled={isPlaceholder ? "true" : undefined}
                aria-label={t.navigation.items[item]}
                className={classNames(
                  isNavigationItemActive(item, appPage) ? styles.navItemActive : styles.navItem,
                  utilityNavigationItems.includes(item) ? styles.navUtilityItem : null
                )}
                data-disabled={isPlaceholder ? "true" : undefined}
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
                title={t.navigation.items[item]}
              >
                <NavigationIcon item={item} />
                <span className={styles.navLabel}>{t.navigation.items[item]}</span>
              </a>
            );
          })}
          <button
            aria-controls="mobile-utility-menu"
            aria-expanded={isUtilityMenuOpen}
            aria-label={t.navigation.utilityMenuLabel}
            className={classNames(
              isUtilityNavigationActive(appPage) ? styles.navItemActive : styles.navItem,
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

                return (
                  <a
                    aria-disabled={isPlaceholder ? "true" : undefined}
                    className={styles.utilityMenuItem}
                    data-disabled={isPlaceholder ? "true" : undefined}
                    href={navigationPage ? urlForAppPage(navigationPage) : "#"}
                    key={item}
                    onClick={(event) => handleNavigationClick(event, item)}
                    role="menuitem"
                  >
                    <NavigationIcon item={item} />
                    <span>{t.navigation.items[item]}</span>
                  </a>
                );
              })}
            </div>
          ) : null}
        </nav>
      </aside>

      <section className={styles.content} aria-labelledby="page-title">
        <header className={styles.topbar}>
          <div>
            <p className={styles.kicker}>{t.shell.kicker}</p>
            <h1 id="page-title">{pageTitle}</h1>
          </div>
          <div className={styles.topbarMeta}>
            <span className={styles.statusText} aria-live="polite">
              {topbarStatus}
            </span>
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
            onRefreshFeed={handleRefreshFeed}
            onRefreshAllFeeds={handleRefreshAllFeeds}
            onPreviewFullContent={handlePreviewFullContent}
            onBackfillCurrentFeedFullContent={handleBackfillCurrentFeedFullContent}
            onUpdateFeedUrl={setFeedUrl}
            onUpdateFeed={handleUpdateManagedFeed}
            onUpdateFolder={handleUpdateManagedFolder}
            opmlSummary={opmlSummary}
            refreshingFeedId={refreshingFeedId}
          />
        ) : appPage.type === "full-content-preview" ? (
          <FullContentPreviewPage
            feed={feeds.find((feed) => feed.id === appPage.feedId) ?? null}
            feedId={appPage.feedId}
            onBack={() => navigateToAppPage({ type: "feed-management" })}
          />
        ) : appPage.type === "settings" ? (
          <SettingsWorkspace
            embeddingError={embeddingError}
            embeddingIndexes={embeddingIndexes}
            embeddingProviders={embeddingProviders}
            error={settingsError}
            isEmbeddingLoading={isEmbeddingLoading}
            isLoading={isSettingsLoading}
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
            onSaveSettings={handleSaveSettings}
            onSaveEmbeddingProvider={handleSaveEmbeddingProvider}
            onTestEmbeddingProvider={handleTestEmbeddingProvider}
            settings={appSettings}
          />
        ) : appPage.type === "algorithm-transparency" ? (
          <AlgorithmTransparencyPage
            error={recommendationStatusError}
            isLoading={isRecommendationStatusLoading}
            onBack={() => navigateToAppPage({ type: "settings" })}
            onOpenAllClusters={() => navigateToAppPage({ type: "algorithm-clusters" })}
            onRunMaintenanceTask={handleRunRecommendationMaintenanceTask}
            onUpdateClusterLabelLexicon={handleUpdateClusterLabelLexicon}
            onUpdateClusterLabel={handleUpdateRecommendationClusterLabel}
            onMergeCandidate={handleMergeClusterCandidate}
            onIgnoreCandidate={handleIgnoreClusterCandidate}
            clusterLabelLexicon={clusterLabelLexicon}
            mergeCandidates={mergeCandidates}
            runningMaintenanceTask={runningMaintenanceTask}
            status={recommendationStatus}
            updatingClusterLexicon={updatingClusterLexicon}
            updatingClusterLabelId={updatingClusterLabelId}
            updatingMergeCandidateId={updatingMergeCandidateId}
          />
        ) : appPage.type === "algorithm-clusters" ? (
          <AlgorithmClustersPage
            clusters={allRecommendationClusters}
            error={allClustersError}
            isLoading={isAllClustersLoading}
            onBack={() => navigateToAppPage({ type: "algorithm-transparency" })}
            onUpdateClusterLabel={handleUpdateRecommendationClusterLabel}
            total={allRecommendationClusterTotal}
            updatingClusterLabelId={updatingClusterLabelId}
          />
        ) : appPage.type === "search" ? (
          <div
            className={classNames(
              styles.workspace,
              selectedArticleId ? styles.workspaceReading : null
            )}
          >
            <SearchResultsPanel
              articleError={articleError}
              articles={articles}
              feedFolders={feedFolders}
              feeds={feeds}
              form={searchForm}
              hasSubmitted={hasSubmittedSearch}
              isArticlesLoading={isArticlesLoading}
              isMarkingScopeRead={isMarkingScopeRead}
              isLoadingMore={isLoadingMoreArticles}
              loadMoreError={loadMoreError}
              nextCursor={nextArticleCursor}
              onArticleAction={handleArticleAction}
              onChange={handleSearchFormChange}
              onExplainArticle={(articleId) => {
                void handleOpenListExplanation(articleId);
              }}
              onLoadMore={handleLoadMoreArticles}
              onMarkScopeRead={handleMarkCurrentSearchScopeRead}
              onSelectArticle={handleSelectArticle}
              onSubmit={handleSearchSubmit}
              pendingAction={pendingArticleAction}
              readerCommandError={readerCommandError}
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
              onArticleAction={handleArticleAction}
              onBackToList={handleBackToArticleList}
              onCloseExplanation={handleCloseExplanation}
              onOpenExplanation={handleOpenExplanation}
              onReadProgress={handleReadProgress}
              pendingAction={
                articleDetail && pendingArticleAction?.articleId === articleDetail.id
                  ? pendingArticleAction.intent
                  : null
              }
              readerSettings={appSettings.reader}
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
              onRefreshFeed={handleRefreshFeed}
              onCloseSources={() => setIsSourceDrawerOpen(false)}
              onSelectSource={handleSelectSource}
              refreshingFeedId={refreshingFeedId}
              sourceSelection={sourceSelection}
            />

            <ArticleListPanel
              articleError={articleError}
              articleView={currentArticleView}
              articles={articles}
              feedCount={feeds.length}
              isIgnoreTelemetryEnabled={
                appSettings.behavior.markScrolledArticlesIgnored &&
                (currentArticleView === "latest" || currentArticleView === "recommended") &&
                selectedArticleId === null
              }
              isArticlesLoading={isArticlesLoading}
              isMarkingScopeRead={isMarkingScopeRead}
              isLoadingMore={isLoadingMoreArticles}
              listScrollKey={articleListScrollKey}
              loadMoreError={loadMoreError}
              nextCursor={nextArticleCursor}
              onIgnoreArticle={handleIgnoreArticle}
              onLoadMore={handleLoadMoreArticles}
              onMarkScopeRead={handleMarkCurrentArticleListScopeRead}
              onPreviewMarkScopeRead={previewCurrentArticleListScopeRead}
              onOpenSources={() => setIsSourceDrawerOpen(true)}
              onArticleAction={handleArticleAction}
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
              recommendationStatus={
                currentArticleView === "recommended" ? recommendationStatus : null
              }
              recommendationStatusError={
                currentArticleView === "recommended" ? recommendationStatusError : null
              }
              readerCommandError={readerCommandError}
              selectedArticleId={selectedArticleId}
              selectedFeed={selectedFeed}
              selectedFolder={selectedFolder}
              showRecommendationStatus={currentArticleView === "recommended"}
              showQuickFilters={supportsQuickFilters(currentArticleView)}
              isRecommendationStatusLoading={isRecommendationStatusLoading}
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
              onArticleAction={handleArticleAction}
              onBackToList={handleBackToArticleList}
              onCloseExplanation={handleCloseExplanation}
              onOpenExplanation={handleOpenExplanation}
              onReadProgress={handleReadProgress}
              pendingAction={
                articleDetail && pendingArticleAction?.articleId === articleDetail.id
                  ? pendingArticleAction.intent
                  : null
              }
              readerSettings={appSettings.reader}
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

function PwaStatusBanner(props: {
  isOffline: boolean;
  onApplyUpdate: (() => void) | null;
  onDismissUpdate: () => void;
}) {
  const { t } = useI18n();

  if (!props.isOffline && !props.onApplyUpdate) {
    return null;
  }

  return (
    <div className={styles.pwaStatusStack} aria-live="polite">
      {props.isOffline ? (
        <div className={styles.pwaStatusBanner} role="status">
          <span>{t.pwa.offline}</span>
        </div>
      ) : null}
      {props.onApplyUpdate ? (
        <div className={styles.pwaStatusBanner} role="status">
          <span>{t.pwa.updateAvailable}</span>
          <div className={styles.pwaStatusActions}>
            <button
              className={styles.pwaStatusButton}
              onClick={props.onApplyUpdate}
              type="button"
            >
              {t.pwa.updateNow}
            </button>
            <button
              className={styles.pwaStatusButtonSecondary}
              onClick={props.onDismissUpdate}
              type="button"
            >
              {t.pwa.dismiss}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SetupWelcomePanel(props: { onStart: () => void }) {
  const { t } = useI18n();

  return (
    <section className={styles.authPanel} aria-labelledby="setup-welcome-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.setup.kicker}</p>
        <h1 id="setup-welcome-title">{t.setup.welcome.title}</h1>
        <p>{t.setup.welcome.body}</p>
      </div>
      <button className={styles.primaryButton} onClick={props.onStart} type="button">
        {t.setup.welcome.start}
      </button>
    </section>
  );
}

export function AuthGatePanel(props: {
  error?: string | null;
  isSubmitting: boolean;
  mode: AuthMode | "loading";
  onTelemetryEnabledChange?: (enabled: boolean) => void;
  onSubmit?: (mode: AuthMode, username: string, password: string) => void;
  telemetryEnabled?: boolean;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (props.mode === "loading") {
    return (
      <section className={styles.authPanel} aria-live="polite">
        <div className={styles.brand}>
          <img alt="" className={styles.brandMark} src="/logo-64.png" />
          <span>
            <strong>{t.common.brandName}</strong>
            <small>{t.common.brandSubtitle}</small>
          </span>
        </div>
        <p>{t.auth.loading}</p>
      </section>
    );
  }

  const title = props.mode === "setup" ? t.auth.setupTitle : t.auth.loginTitle;
  const body = props.mode === "setup" ? t.auth.setupBody : t.auth.loginBody;
  const submitLabel = props.mode === "setup" ? t.auth.setupSubmit : t.auth.loginSubmit;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onSubmit?.(props.mode as AuthMode, username, password);
  }

  return (
    <section className={styles.authPanel} aria-labelledby="auth-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.shell.kicker}</p>
        <h1 id="auth-title">{title}</h1>
        <p>{body}</p>
      </div>

      <form className={styles.authForm} onSubmit={handleSubmit}>
        <label htmlFor="auth-username">{t.auth.usernameLabel}</label>
        <input
          autoComplete="username"
          id="auth-username"
          onChange={(event) => setUsername(event.target.value)}
          placeholder={t.auth.usernamePlaceholder}
          type="text"
          value={username}
        />
        <label htmlFor="auth-password">{t.auth.passwordLabel}</label>
        <input
          autoComplete={props.mode === "setup" ? "new-password" : "current-password"}
          id="auth-password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder={t.auth.passwordPlaceholder}
          type="password"
          value={password}
        />
        {props.mode === "setup" ? (
          <label className={styles.telemetrySwitch} htmlFor="auth-telemetry-enabled">
            <input
              checked={props.telemetryEnabled ?? true}
              id="auth-telemetry-enabled"
              onChange={(event) => props.onTelemetryEnabledChange?.(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>{t.auth.telemetryLabel}</strong>
              <small>{t.auth.telemetryBody}</small>
            </span>
          </label>
        ) : null}
        <button className={styles.primaryButton} disabled={props.isSubmitting} type="submit">
          {props.isSubmitting ? t.auth.submitting : submitLabel}
        </button>
      </form>

      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
    </section>
  );
}

function DerivedDataUpgradePanel(props: {
  error: string | null;
  isRetrying: boolean;
  onRetry: () => void;
  status: DerivedDataUpgradeStatus | null;
}) {
  const { t } = useI18n();
  const progress = props.status?.progress;
  const percent = progress ? Math.max(0, Math.min(100, Math.round(progress.percent * 100))) : 0;
  const step = props.status?.step ?? "detecting";
  const isFailed = props.status?.state === "failed";
  const articleTotal = progress?.total ?? 0;
  const articleCurrent = progress?.current ?? 0;

  return (
    <section className={styles.authPanel} aria-labelledby="derived-data-upgrade-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.upgrade.kicker}</p>
        <h1 id="derived-data-upgrade-title">{t.upgrade.title}</h1>
        <p>{isFailed ? t.upgrade.failedBody : t.upgrade.body}</p>
      </div>
      <div className={styles.setupStatusBox} aria-live="polite">
        <strong>{t.upgrade.steps[step]}</strong>
        <p>{t.upgrade.progress(articleCurrent, articleTotal, percent)}</p>
        <p>{t.upgrade.costNote}</p>
        <progress
          aria-label={t.upgrade.progressLabel}
          className={styles.upgradeProgress}
          max={100}
          value={percent}
        />
      </div>
      {props.status?.error ? <p className={styles.errorText}>{props.status.error}</p> : null}
      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
      {isFailed ? (
        <button
          className={styles.primaryButton}
          disabled={props.isRetrying}
          onClick={props.onRetry}
          type="button"
        >
          {props.isRetrying ? t.upgrade.retrying : t.upgrade.retry}
        </button>
      ) : null}
    </section>
  );
}

export function SetupSourcesPanel(props: {
  discovery: FeedDiscoveryResponse | null;
  discoveryError: string | null;
  error: string | null;
  feedUrl: string;
  isAddingFeed: boolean;
  isDiscoveringFeeds: boolean;
  isImportingOpml: boolean;
  onAddCandidate: (candidate: FeedDiscoveryCandidate) => void;
  onAddFeed: (event: FormEvent<HTMLFormElement>) => void;
  onImportOpml: (event: ChangeEvent<HTMLInputElement>) => void;
  onUpdateFeedUrl: (value: string) => void;
  opmlSummary: OpmlImportResponse | null;
}) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <section className={styles.authPanel} aria-labelledby="setup-sources-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.setup.kicker}</p>
        <h1 id="setup-sources-title">{t.setup.sources.title}</h1>
        <p>{t.setup.sources.body}</p>
      </div>

      <div className={styles.setupSourceActions}>
        <input
          accept=".opml,.xml,text/xml,application/xml"
          className={styles.fileInput}
          onChange={props.onImportOpml}
          ref={fileInputRef}
          type="file"
        />
        <button
          className={styles.secondaryButton}
          disabled={props.isImportingOpml || props.isAddingFeed}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          {props.isImportingOpml ? t.opml.importing : t.setup.sources.importOpml}
        </button>
      </div>

      <form className={styles.authForm} onSubmit={props.onAddFeed}>
        <label htmlFor="setup-feed-url">{t.feeds.inputLabel}</label>
        <input
          id="setup-feed-url"
          inputMode="url"
          onChange={(event) => props.onUpdateFeedUrl(event.target.value)}
          placeholder={t.feeds.inputPlaceholder}
          type="url"
          value={props.feedUrl}
        />
        <button
          className={styles.primaryButton}
          disabled={props.isAddingFeed || props.isDiscoveringFeeds || props.isImportingOpml}
          type="submit"
        >
          {props.isDiscoveringFeeds ? t.feedDiscovery.checking : t.feedDiscovery.check}
        </button>
      </form>

      <FeedDiscoveryPanel
        discovery={props.discovery}
        error={props.discoveryError}
        isAddingFeed={props.isAddingFeed}
        onAddCandidate={props.onAddCandidate}
      />

      {props.opmlSummary ? (
        <div className={styles.opmlSummary}>
          <p>
            {t.opml.importSummary(
              props.opmlSummary.feedsCreated,
              props.opmlSummary.feedsSkipped,
              props.opmlSummary.foldersCreated
            )}
          </p>
          {props.opmlSummary.errors.length > 0 ? (
            <>
              <p>{t.opml.importErrors(props.opmlSummary.errors.length)}</p>
              <ul>
                {props.opmlSummary.errors.map((error, index) => (
                  <li key={`${error}-${index}`}>{error}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
    </section>
  );
}

export function FeedDiscoveryPanel(props: {
  discovery: FeedDiscoveryResponse | null;
  error: string | null;
  isAddingFeed: boolean;
  onAddCandidate: (candidate: FeedDiscoveryCandidate) => void;
}) {
  const { t, formatDate } = useI18n();

  if (!props.discovery && !props.error) {
    return null;
  }

  return (
    <section className={styles.feedDiscoveryPanel} aria-live="polite">
      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
      {props.discovery ? (
        <>
          <div className={styles.feedDiscoveryHeader}>
            <strong>
              {props.discovery.candidates.length > 0
                ? t.feedDiscovery.candidatesTitle
                : t.feedDiscovery.noCandidatesTitle}
            </strong>
            <small>{props.discovery.normalizedUrl}</small>
          </div>
          {props.discovery.warnings.length > 0 ? (
            <div className={styles.feedDiscoveryWarnings}>
              <strong>{t.feedDiscovery.warningsTitle}</strong>
              <ul>
                {props.discovery.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {props.discovery.candidates.length === 0 ? (
            <p className={styles.feedDiscoveryEmpty}>{t.feedDiscovery.noCandidatesBody}</p>
          ) : (
            <div className={styles.feedDiscoveryCandidates}>
              {props.discovery.candidates.map((candidate) => (
                <article className={styles.feedDiscoveryCandidate} key={candidate.feedUrl}>
                  <div className={styles.feedDiscoveryCandidateHeader}>
                    <div>
                      <h3>{candidate.title ?? candidate.feedUrl}</h3>
                      <p>{candidate.description ?? candidate.siteUrl ?? candidate.feedUrl}</p>
                    </div>
                    <span
                      className={classNames(
                        styles.feedHealthBadge,
                        candidate.status === "valid"
                          ? styles.feedHealthBadgeOk
                          : candidate.status === "duplicate"
                            ? styles.feedHealthBadgeInfo
                            : styles.feedHealthBadgeError
                      )}
                    >
                      {t.feedDiscovery.statuses[candidate.status]}
                    </span>
                  </div>
                  <dl className={styles.feedDiscoveryMeta}>
                    <div>
                      <dt>URL</dt>
                      <dd>{candidate.feedUrl}</dd>
                    </div>
                    <div>
                      <dt>{candidate.format.toUpperCase()}</dt>
                      <dd>{t.feedDiscovery.itemCount(candidate.itemCount)}</dd>
                    </div>
                  </dl>
                  {candidate.recentItems.length > 0 ? (
                    <div className={styles.feedDiscoveryRecent}>
                      <strong>{t.feedDiscovery.recentItems}</strong>
                      <ul>
                        {candidate.recentItems.map((item, index) => (
                          <li key={`${candidate.feedUrl}-${item.url ?? item.title}-${index}`}>
                            <span>{item.title}</span>
                            <small>
                              {item.publishedAt ? formatDate(item.publishedAt) : candidate.siteUrl}
                            </small>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {candidate.error ? (
                    <p className={styles.feedDiscoveryError}>{candidate.error}</p>
                  ) : null}
                  <button
                    className={styles.primaryButton}
                    disabled={candidate.status !== "valid" || props.isAddingFeed}
                    onClick={() => props.onAddCandidate(candidate)}
                    type="button"
                  >
                    {props.isAddingFeed
                      ? t.feedDiscovery.addingCandidate
                      : candidate.status === "duplicate"
                        ? t.feedDiscovery.duplicate
                        : t.feedDiscovery.addCandidate}
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

export function SetupProviderPanel(props: {
  activatingProviderId: string | null;
  embeddingError: string | null;
  embeddingProviders: EmbeddingProvider[];
  isEmbeddingLoading: boolean;
  isSavingEmbeddingProvider: boolean;
  testingProviderId: string | null;
  onActivateEmbeddingProvider: (providerId: string) => Promise<boolean>;
  onContinue: () => void;
  onSaveEmbeddingProvider: (
    providerId: string | null,
    input: CreateEmbeddingProviderInput | UpdateEmbeddingProviderInput
  ) => Promise<string | null>;
  onTestEmbeddingProvider: (providerId: string) => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const initialProvider =
    props.embeddingProviders.find((provider) => provider.enabled) ??
    props.embeddingProviders[0] ??
    null;
  const [providerDraft, setProviderDraft] = useState<EmbeddingProviderDraft>(() =>
    draftForEmbeddingProvider(initialProvider)
  );
  const [pendingProviderSelectionId, setPendingProviderSelectionId] = useState<string | null>(null);
  const [providerLocalError, setProviderLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (pendingProviderSelectionId) {
      const pendingProvider = props.embeddingProviders.find(
        (provider) => provider.id === pendingProviderSelectionId
      );
      if (pendingProvider) {
        setProviderDraft(draftForEmbeddingProvider(pendingProvider));
        setPendingProviderSelectionId(null);
        setProviderLocalError(null);
        return;
      }
    }

    const selectedProvider = props.embeddingProviders.find(
      (provider) => provider.id === providerDraft.providerId
    );
    if (selectedProvider) {
      setProviderDraft(draftForEmbeddingProvider(selectedProvider));
      setProviderLocalError(null);
      return;
    }

    const activeProvider =
      props.embeddingProviders.find((provider) => provider.enabled) ??
      props.embeddingProviders[0] ??
      null;
    setProviderDraft(draftForEmbeddingProvider(activeProvider));
    setProviderLocalError(null);
  }, [pendingProviderSelectionId, props.embeddingProviders]);

  async function handleProviderTestSubmit() {
    const parsed = parseEmbeddingProviderDraft(providerDraft, t);

    if (!parsed.ok) {
      setProviderLocalError(parsed.error);
      return;
    }

    setProviderLocalError(null);
    const savedProviderId = await props.onSaveEmbeddingProvider(
      providerDraft.providerId === newEmbeddingProviderId ? null : providerDraft.providerId,
      {
        ...parsed.input,
        enabled: selectedProvider?.enabled ?? false
      }
    );
    if (savedProviderId) {
      setPendingProviderSelectionId(savedProviderId);
      await props.onTestEmbeddingProvider(savedProviderId);
    }
  }

  async function handleProviderEnableSubmit() {
    if (!selectedProvider || !canFinalizeSelectedProvider) {
      setProviderLocalError(t.setup.provider.testRequired);
      return;
    }

    setProviderLocalError(null);
    if (selectedProvider.enabled) {
      props.onContinue();
      return;
    }

    const activated = await props.onActivateEmbeddingProvider(selectedProvider.id);
    if (activated) {
      props.onContinue();
    }
  }

  const selectedProvider =
    providerDraft.providerId === newEmbeddingProviderId
      ? null
      : props.embeddingProviders.find((provider) => provider.id === providerDraft.providerId) ??
        null;
  const selectedProviderDraftMatches =
    selectedProvider !== null && embeddingProviderDraftMatchesProvider(providerDraft, selectedProvider);
  const canFinalizeSelectedProvider =
    selectedProvider !== null &&
    selectedProvider.lastTestStatus === "success" &&
    selectedProviderDraftMatches;
  const isActivatingSelectedProvider =
    selectedProvider !== null && props.activatingProviderId === selectedProvider.id;
  const isTestingSelectedProvider =
    selectedProvider !== null && props.testingProviderId === selectedProvider.id;
  const isPrimaryProviderActionBusy =
    props.isSavingEmbeddingProvider || isTestingSelectedProvider || isActivatingSelectedProvider;

  return (
    <section
      className={classNames(styles.authPanel, styles.setupProviderPanel)}
      aria-labelledby="setup-provider-title"
    >
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.setup.kicker}</p>
        <h1 id="setup-provider-title">{t.setup.provider.title}</h1>
        <p>{t.setup.provider.body}</p>
        <a
          className={styles.textLink}
          href={providerRecommendationReadmeUrl(locale)}
          rel="noreferrer"
          target="_blank"
        >
          {t.setup.provider.recommendationLink}
        </a>
      </div>

      {props.isEmbeddingLoading ? (
        <p className={styles.settingsNotice}>{t.settings.sections.provider.loading}</p>
      ) : null}
      {props.embeddingError ? <p className={styles.errorText}>{props.embeddingError}</p> : null}
      {providerLocalError ? <p className={styles.errorText}>{providerLocalError}</p> : null}

      {props.embeddingProviders.length > 0 ? (
        <div
          aria-label={t.settings.sections.provider.profileListLabel}
          className={styles.providerProfileList}
        >
          {props.embeddingProviders.map((provider) => (
            <button
              className={
                provider.id === providerDraft.providerId
                  ? styles.providerProfileCardActive
                  : styles.providerProfileCard
              }
              key={provider.id}
              onClick={() => {
                setProviderDraft(draftForEmbeddingProvider(provider));
                setProviderLocalError(null);
              }}
              type="button"
            >
              <span>
                <strong>{provider.name}</strong>
                <small>
                  {provider.type} · {provider.model} / {provider.dimension}
                </small>
              </span>
              <em>
                {provider.enabled
                  ? t.settings.sections.provider.currentBadge
                  : t.settings.sections.provider.profileBadge}
              </em>
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.settingsGrid}>
        <label className={styles.settingsField} htmlFor="setup-provider-select">
          <span>{t.settings.sections.provider.providerLabel}</span>
          <select
            id="setup-provider-select"
            onChange={(event) => {
              const provider =
                props.embeddingProviders.find(
                  (candidate) => candidate.id === event.target.value
                ) ?? null;
              setProviderDraft(draftForEmbeddingProvider(provider));
              setProviderLocalError(null);
            }}
            value={providerDraft.providerId}
          >
            <option value={newEmbeddingProviderId}>
              {t.settings.sections.provider.newProvider}
            </option>
            {props.embeddingProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.settingsField} htmlFor="setup-provider-type">
          <span>{t.settings.sections.provider.typeLabel}</span>
          <select
            id="setup-provider-type"
            onChange={(event) => {
              const nextType =
                event.target.value === "ollama"
                  ? "ollama"
                  : event.target.value === "gemini"
                    ? "gemini"
                    : "openai_compatible";
              setProviderDraft(draftWithProviderType(providerDraft, nextType));
              setProviderLocalError(null);
            }}
            value={providerDraft.type}
          >
            <option value="openai_compatible">
              {t.settings.sections.provider.openaiCompatible}
            </option>
            <option value="gemini">{t.settings.sections.provider.gemini}</option>
            <option value="ollama">{t.settings.sections.provider.ollama}</option>
          </select>
        </label>

        <label className={styles.settingsField} htmlFor="setup-provider-name">
          <span>{t.settings.sections.provider.nameLabel}</span>
          <input
            id="setup-provider-name"
            onChange={(event) =>
              setProviderDraft({ ...providerDraft, name: event.target.value })
            }
            value={providerDraft.name}
          />
        </label>

        <label className={styles.settingsField} htmlFor="setup-provider-base-url">
          <span>{t.settings.sections.provider.baseUrlLabel}</span>
          <input
            id="setup-provider-base-url"
            inputMode="url"
            onChange={(event) =>
              setProviderDraft({ ...providerDraft, baseUrl: event.target.value })
            }
            placeholder={
              providerDraft.type === "ollama"
                ? t.settings.sections.provider.ollamaBaseUrlPlaceholder
                : providerDraft.type === "gemini"
                  ? t.settings.sections.provider.geminiBaseUrlPlaceholder
                  : t.settings.sections.provider.baseUrlPlaceholder
            }
            type="url"
            value={providerDraft.baseUrl}
          />
        </label>

        <label className={styles.settingsField} htmlFor="setup-provider-model">
          <span>{t.settings.sections.provider.modelLabel}</span>
          <input
            id="setup-provider-model"
            onChange={(event) =>
              setProviderDraft({ ...providerDraft, model: event.target.value })
            }
            placeholder={
              providerDraft.type === "ollama"
                ? t.settings.sections.provider.ollamaModelPlaceholder
                : providerDraft.type === "gemini"
                  ? t.settings.sections.provider.geminiModelPlaceholder
                  : t.settings.sections.provider.modelPlaceholder
            }
            value={providerDraft.model}
          />
        </label>

        <NumberSettingField
          id="setup-provider-dimension"
          label={t.settings.sections.provider.dimensionLabel}
          max={20000}
          min={1}
          onChange={(value) => setProviderDraft({ ...providerDraft, dimension: value })}
          step={1}
          value={providerDraft.dimension}
        />

        <NumberSettingField
          id="setup-provider-text-max-chars"
          label={t.settings.sections.provider.textMaxCharsLabel}
          max={200000}
          min={1000}
          onChange={(value) => setProviderDraft({ ...providerDraft, textMaxChars: value })}
          step={500}
          value={providerDraft.textMaxChars}
        />

        <NumberSettingField
          id="setup-provider-qpm"
          label={t.settings.sections.provider.requestsPerMinuteLabel}
          max={1000000}
          min={1}
          onChange={(value) =>
            setProviderDraft({ ...providerDraft, requestsPerMinute: value })
          }
          placeholder={t.settings.sections.provider.unlimitedPlaceholder}
          step={1}
          value={providerDraft.requestsPerMinute}
        />

        <NumberSettingField
          id="setup-provider-qpd"
          label={t.settings.sections.provider.requestsPerDayLabel}
          max={100000000}
          min={1}
          onChange={(value) => setProviderDraft({ ...providerDraft, requestsPerDay: value })}
          placeholder={t.settings.sections.provider.unlimitedPlaceholder}
          step={1}
          value={providerDraft.requestsPerDay}
        />

        {providerDraft.type !== "ollama" ? (
          <label className={styles.settingsField} htmlFor="setup-provider-api-key">
            <span>{t.settings.sections.provider.apiKeyLabel}</span>
            <input
              autoComplete="off"
              id="setup-provider-api-key"
              onChange={(event) =>
                setProviderDraft({ ...providerDraft, apiKey: event.target.value })
              }
              placeholder={
                selectedProvider?.hasApiKey
                  ? t.settings.sections.provider.apiKeyRetainPlaceholder
                  : t.settings.sections.provider.apiKeyPlaceholder
              }
              type="password"
              value={providerDraft.apiKey}
            />
          </label>
        ) : (
          <p className={styles.managementHint}>
            {t.settings.sections.provider.ollamaApiKeyHint}
          </p>
        )}

        <label className={styles.settingsField} htmlFor="setup-provider-quality">
          <span>{t.settings.sections.provider.qualityTierLabel}</span>
          <select
            id="setup-provider-quality"
            onChange={(event) =>
              setProviderDraft({
                ...providerDraft,
                qualityTier: event.target.value as EmbeddingProviderDraft["qualityTier"]
              })
            }
            value={providerDraft.qualityTier}
          >
            <option value="basic">{t.settings.sections.provider.quality.basic}</option>
            <option value="recommended">
              {t.settings.sections.provider.quality.recommended}
            </option>
            <option value="best_quality">
              {t.settings.sections.provider.quality.bestQuality}
            </option>
          </select>
        </label>
      </div>

      <p className={styles.providerWarning}>{t.settings.sections.provider.modelHint}</p>
      <p className={styles.providerWarning}>{t.settings.sections.provider.rateLimitHint}</p>

      <div className={styles.setupStatusBox}>
        <strong>{t.setup.provider.currentTitle}</strong>
        <p>{t.setup.provider.currentBody}</p>
      </div>

      {selectedProvider ? (
        <div className={styles.setupStatusBox}>
          <strong>{t.settings.sections.provider.connectionStatusTitle}</strong>
          <p>
            {selectedProvider.lastTestStatus === "success"
              ? t.settings.sections.provider.lastTestSuccess(
                  selectedProvider.lastTestAt ?? t.feedManagement.na
                )
              : selectedProvider.lastTestStatus === "failed"
                ? t.settings.sections.provider.lastTestFailed(
                    selectedProvider.lastTestError ?? t.feedManagement.na
                  )
                : t.settings.sections.provider.lastTestUnknown}
          </p>
          {selectedProvider.lastTestStatus === "success" && !selectedProviderDraftMatches ? (
            <p>{t.setup.provider.testStale}</p>
          ) : null}
        </div>
      ) : null}

      <div className={styles.managementActions}>
        <button
          className={styles.primaryButton}
          disabled={isPrimaryProviderActionBusy}
          onClick={() =>
            void (canFinalizeSelectedProvider
              ? handleProviderEnableSubmit()
              : handleProviderTestSubmit())
          }
          type="button"
        >
          {isActivatingSelectedProvider
            ? t.settings.sections.provider.activating
            : props.isSavingEmbeddingProvider
              ? t.setup.provider.saving
              : isTestingSelectedProvider
                ? t.settings.sections.provider.testing
                : canFinalizeSelectedProvider
                  ? selectedProvider?.enabled
                    ? t.setup.provider.useProviderAndContinue
                    : t.setup.provider.enableAndContinue
                  : t.setup.provider.saveAndTest}
        </button>
        <button className={styles.secondaryButton} onClick={props.onContinue} type="button">
          {t.setup.provider.continue}
        </button>
      </div>
    </section>
  );
}

function FullContentPreviewPage(props: {
  feed: Feed | null;
  feedId: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<FullContentPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadPreview = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setResult(await dibaoApi.previewFeedFullContent(props.feedId));
    } catch (caught) {
      setError(userMessageForError(caught, t.errors.api));
    } finally {
      setIsLoading(false);
    }
  }, [props.feedId, t.errors.api]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const safeHtml = useMemo(
    () => (result?.contentHtml ? sanitizeArticleHtml(result.contentHtml, result.articleUrl) : null),
    [result]
  );

  return (
    <section className={styles.settingsWorkspace} aria-labelledby="full-content-preview-title">
      <div className={styles.settingsHeader}>
        <div>
          <p className={styles.kicker}>{t.fullContentPreview.kicker}</p>
          <h2 id="full-content-preview-title">
            {props.feed?.title ?? t.fullContentPreview.pageTitle}
          </h2>
        </div>
        <div className={styles.managementActions}>
          <button className={styles.secondaryButton} onClick={props.onBack} type="button">
            {t.fullContentPreview.back}
          </button>
          <button
            className={styles.primaryButton}
            disabled={isLoading}
            onClick={() => void loadPreview()}
            type="button"
          >
            {isLoading ? t.fullContentPreview.loading : t.fullContentPreview.reload}
          </button>
        </div>
      </div>
      <section className={styles.settingsSection}>
        {error ? <p className={styles.errorText}>{error}</p> : null}
        {isLoading ? <p className={styles.settingsNotice}>{t.fullContentPreview.loading}</p> : null}
        {result ? (
          <>
            <dl className={styles.managementStatusRows}>
              <div>
                <dt>{t.fullContentPreview.articleUrl}</dt>
                <dd>{result.articleUrl}</dd>
              </div>
              <div>
                <dt>{t.fullContentPreview.resultStatus}</dt>
                <dd>{t.fullContentPreview.statuses[result.status]}</dd>
              </div>
              <div>
                <dt>{t.fullContentPreview.extractedTitle}</dt>
                <dd>{result.title ?? t.feedManagement.na}</dd>
              </div>
            </dl>
            {result.status === "success" ? (
              <article className={styles.reader}>
                {safeHtml ? (
                  <div
                    className={styles.readerBody}
                    dangerouslySetInnerHTML={{ __html: safeHtml }}
                  />
                ) : (
                  <div className={styles.readerBody}>
                    <p>{result.contentText ?? result.excerpt}</p>
                  </div>
                )}
              </article>
            ) : (
              <p className={styles.settingsNotice}>
                {result.error ?? t.fullContentPreview.noPreview} {t.fullContentPreview.noDbWrite}
              </p>
            )}
          </>
        ) : null}
      </section>
    </section>
  );
}

type SettingsDraft = {
  locale: AppSettings["ui"]["locale"];
  defaultHomeView: AppSettings["ui"]["defaultHomeView"];
  markScrolledArticlesIgnored: boolean;
  removeReadLaterOnReadComplete: boolean;
  telemetryEnabled: boolean;
  fontSize: string;
  lineHeight: string;
  paragraphGap: string;
  readerWidth: string;
  retentionDays: string;
  keepFavorites: boolean;
  keepReadLater: boolean;
  cocoonLevel: string;
  maxPositiveInterestClusters: string;
  maxNegativeInterestClusters: string;
  maxPositiveInterestFamilies: string;
  maxNegativeInterestFamilies: string;
};

const interestClusterLimitPresets = [
  {
    maxPositiveInterestClusters: 24,
    maxNegativeInterestClusters: 16,
    maxPositiveInterestFamilies: 8,
    maxNegativeInterestFamilies: 6
  },
  {
    maxPositiveInterestClusters: 48,
    maxNegativeInterestClusters: 32,
    maxPositiveInterestFamilies: 16,
    maxNegativeInterestFamilies: 12
  },
  {
    maxPositiveInterestClusters: 96,
    maxNegativeInterestClusters: 64,
    maxPositiveInterestFamilies: 28,
    maxNegativeInterestFamilies: 20
  }
] as const;

type SupportedEmbeddingProviderType = Extract<
  EmbeddingProviderType,
  "openai_compatible" | "gemini" | "ollama"
>;

type EmbeddingProviderDraft = {
  providerId: string;
  type: SupportedEmbeddingProviderType;
  name: string;
  baseUrl: string;
  model: string;
  dimension: string;
  textMaxChars: string;
  requestsPerMinute: string;
  requestsPerDay: string;
  apiKey: string;
  enabled: boolean;
  qualityTier: "basic" | "recommended" | "best_quality";
};

const newEmbeddingProviderId = "__new_provider__";

export function SettingsWorkspace(props: {
  backfillingIndexId: string | null;
  deletingProviderId: string | null;
  embeddingError: string | null;
  embeddingIndexes: EmbeddingIndex[];
  embeddingProviders: EmbeddingProvider[];
  error: string | null;
  isEmbeddingLoading: boolean;
  isLoading: boolean;
  activatingProviderId: string | null;
  isSavingEmbeddingProvider: boolean;
  isSaving: boolean;
  rebuildingIndexId: string | null;
  testingProviderId: string | null;
  onActivateEmbeddingProvider: (providerId: string) => Promise<void>;
  onBackfillEmbeddingIndex: (indexId: string) => Promise<void>;
  onDeleteEmbeddingProvider: (providerId: string) => Promise<void>;
  onOpenAlgorithmTransparency: () => void;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onPreviewSettings: (settings: AppSettings) => void;
  onRebuildEmbeddingIndex: (indexId: string) => Promise<void>;
  onSaveSettings: (input: UpdateSettingsInput) => Promise<void>;
  onSaveEmbeddingProvider: (
    providerId: string | null,
    input: CreateEmbeddingProviderInput | UpdateEmbeddingProviderInput
  ) => Promise<string | null>;
  onTestEmbeddingProvider: (providerId: string) => Promise<void>;
  settings: AppSettings;
}) {
  const { t, formatDate } = useI18n();
  const initialProvider =
    props.embeddingProviders.find((provider) => provider.enabled) ??
    props.embeddingProviders[0] ??
    null;
  const [draft, setDraft] = useState<SettingsDraft>(() => draftForSettings(props.settings));
  const [lastInterestClusterPresetIndex, setLastInterestClusterPresetIndex] = useState(() =>
    presetIndexForInterestClusterLimits(props.settings.ranking) ??
    closestInterestClusterPresetIndex(props.settings.ranking)
  );
  const [providerDraft, setProviderDraft] = useState<EmbeddingProviderDraft>(() =>
    draftForEmbeddingProvider(initialProvider)
  );
  const [pendingProviderSelectionId, setPendingProviderSelectionId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [providerLocalError, setProviderLocalError] = useState<string | null>(null);
  const [usageWindow, setUsageWindow] = useState<"24h" | "7d" | "30d">("24h");
  const [passwordDraft, setPasswordDraft] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  });
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [latestRelease, setLatestRelease] = useState<LatestReleaseStatus | null>(null);
  const [latestReleaseError, setLatestReleaseError] = useState<string | null>(null);
  const [isLoadingLatestRelease, setIsLoadingLatestRelease] = useState(false);
  const [isCheckingLatestRelease, setIsCheckingLatestRelease] = useState(false);
  const savedSettingsRef = useRef(props.settings);
  const hasUnsavedSettingsDraftRef = useRef(false);

  useEffect(() => {
    if (!hasUnsavedSettingsDraftRef.current) {
      savedSettingsRef.current = props.settings;
    }
    const nextDraft = draftForSettings(props.settings);
    setDraft(nextDraft);
    setLastInterestClusterPresetIndex(
      presetIndexForInterestClusterLimits(props.settings.ranking) ??
        closestInterestClusterPresetIndex(props.settings.ranking)
    );
  }, [props.settings]);

  useEffect(() => {
    if (pendingProviderSelectionId) {
      const pendingProvider = props.embeddingProviders.find(
        (provider) => provider.id === pendingProviderSelectionId
      );
      if (pendingProvider) {
        setProviderDraft(draftForEmbeddingProvider(pendingProvider));
        setPendingProviderSelectionId(null);
        setProviderLocalError(null);
        return;
      }
    }

    const selectedProvider = props.embeddingProviders.find(
      (provider) => provider.id === providerDraft.providerId
    );
    if (selectedProvider) {
      setProviderDraft(draftForEmbeddingProvider(selectedProvider));
      setProviderLocalError(null);
      return;
    }

    const activeProvider =
      props.embeddingProviders.find((provider) => provider.enabled) ??
      props.embeddingProviders[0] ??
      null;
    setProviderDraft(draftForEmbeddingProvider(activeProvider));
    setProviderLocalError(null);
  }, [pendingProviderSelectionId, props.embeddingProviders]);

  useEffect(() => {
    let cancelled = false;

    async function loadLatestRelease() {
      setIsLoadingLatestRelease(true);
      setLatestReleaseError(null);

      try {
        const result = await dibaoApi.getLatestRelease();
        if (!cancelled) {
          setLatestRelease(result);
        }
      } catch (error) {
        if (!cancelled) {
          setLatestReleaseError(userMessageForError(error, t.errors.api));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingLatestRelease(false);
        }
      }
    }

    void loadLatestRelease();

    return () => {
      cancelled = true;
    };
  }, [t.errors.api]);

  function applyDraft(nextDraft: SettingsDraft) {
    hasUnsavedSettingsDraftRef.current = true;
    setDraft(nextDraft);
    setLocalError(null);

    const parsed = parseSettingsDraft(nextDraft, props.settings, t);
    if (parsed.ok) {
      props.onPreviewSettings(parsed.settings);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseSettingsDraft(draft, props.settings, t);

    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }

    if (
      retentionSettingsRequireCleanupConfirmation(
        savedSettingsRef.current.retention,
        parsed.settings.retention
      ) &&
      !window.confirm(t.settings.sections.retention.cleanupConfirm)
    ) {
      return;
    }

    await props.onSaveSettings(parsed.input);
    savedSettingsRef.current = parsed.settings;
    hasUnsavedSettingsDraftRef.current = false;
  }

  async function handleProviderSubmit() {
    const parsed = parseEmbeddingProviderDraft(providerDraft, t);

    if (!parsed.ok) {
      setProviderLocalError(parsed.error);
      return;
    }

    setProviderLocalError(null);
    const savedProviderId = await props.onSaveEmbeddingProvider(
      providerDraft.providerId === newEmbeddingProviderId ? null : providerDraft.providerId,
      parsed.input
    );
    if (savedProviderId) {
      setPendingProviderSelectionId(savedProviderId);
    }
  }

  async function handleChangePassword() {
    if (!passwordDraft.currentPassword.trim()) {
      setPasswordError(t.settings.sections.account.errors.currentRequired);
      return;
    }
    if (!passwordDraft.newPassword.trim()) {
      setPasswordError(t.settings.sections.account.errors.newRequired);
      return;
    }
    if (!passwordDraft.confirmPassword.trim()) {
      setPasswordError(t.settings.sections.account.errors.confirmRequired);
      return;
    }
    if (passwordDraft.newPassword !== passwordDraft.confirmPassword) {
      setPasswordError(t.settings.sections.account.errors.mismatch);
      return;
    }

    setIsChangingPassword(true);
    setPasswordError(null);
    setPasswordNotice(null);
    try {
      await props.onChangePassword(passwordDraft.currentPassword, passwordDraft.newPassword);
      setPasswordDraft({
        currentPassword: "",
        newPassword: "",
        confirmPassword: ""
      });
      setPasswordNotice(t.settings.sections.account.saved);
    } catch (error) {
      setPasswordError(userMessageForError(error, t.errors.api));
    } finally {
      setIsChangingPassword(false);
    }
  }

  async function handleCheckLatestRelease() {
    setIsCheckingLatestRelease(true);
    setLatestReleaseError(null);

    try {
      setLatestRelease(await dibaoApi.checkLatestRelease());
    } catch (error) {
      setLatestReleaseError(userMessageForError(error, t.errors.api));
    } finally {
      setIsCheckingLatestRelease(false);
    }
  }

  const selectedProvider =
    providerDraft.providerId === newEmbeddingProviderId
      ? null
      : props.embeddingProviders.find((provider) => provider.id === providerDraft.providerId) ??
        null;
  const activeProvider = props.embeddingProviders.find((provider) => provider.enabled) ?? null;
  const activeProviderIndex = activeProvider
    ? props.embeddingIndexes.find(
        (index) => index.providerId === activeProvider.id && index.status === "active"
      ) ?? null
    : null;
  const selectedProviderIndexes = selectedProvider
    ? props.embeddingIndexes.filter((index) => index.providerId === selectedProvider.id)
    : [];
  const canActivateSelectedProvider = selectedProvider !== null && !selectedProvider.enabled;
  const isActivatingSelectedProvider =
    selectedProvider !== null && props.activatingProviderId === selectedProvider.id;
  const exactInterestClusterPresetIndex = presetIndexForInterestClusterLimitDraft(draft);
  const interestClusterPresetIndex =
    exactInterestClusterPresetIndex ?? lastInterestClusterPresetIndex;

  return (
    <form
      className={classNames(styles.settingsWorkspace, "settings-board-page")}
      onSubmit={(event) => void handleSubmit(event)}
      aria-labelledby="settings-title"
    >
      <div className={classNames(styles.settingsHeader, "settings-content-head")}>
        <div>
          <p className={styles.kicker}>{t.navigation.items.settings}</p>
          <h2 id="settings-title">{t.settings.pageTitle}</h2>
        </div>
        <button className={styles.primaryButton} disabled={props.isSaving} type="submit">
          {props.isSaving ? t.settings.actions.saving : t.settings.actions.save}
        </button>
      </div>

      <div className={classNames(styles.settingsContent, "settings-content-board")}>
        {props.isLoading ? <p className={styles.settingsNotice}>{t.settings.loading}</p> : null}
        {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
        {localError ? <p className={styles.errorText}>{localError}</p> : null}

        <section className={classNames(styles.settingsSection, "settings-card")} aria-labelledby="settings-language-title">
          <div>
            <h3 id="settings-language-title">{t.settings.sections.language.title}</h3>
            <p>{t.settings.sections.language.body}</p>
          </div>
          <label className={styles.settingsField} htmlFor="settings-locale">
            <span>{t.settings.sections.language.localeLabel}</span>
            <select
              id="settings-locale"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  locale:
                    event.target.value === "en-US" || event.target.value === "ja-JP"
                      ? event.target.value
                      : "zh-CN"
                })
              }
              value={draft.locale}
            >
              <option value="zh-CN">{t.settings.sections.language.zhCN}</option>
              <option value="en-US">{t.settings.sections.language.enUS}</option>
              <option value="ja-JP">{t.settings.sections.language.jaJP}</option>
            </select>
          </label>
          <label className={styles.settingsField} htmlFor="settings-default-home-view">
            <span>{t.settings.sections.language.defaultHomeViewLabel}</span>
            <select
              id="settings-default-home-view"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  defaultHomeView:
                    event.target.value === "latest" ? "latest" : "recommended"
                })
              }
              value={draft.defaultHomeView}
            >
              <option value="recommended">
                {t.settings.sections.language.defaultHomeViewRecommended}
              </option>
              <option value="latest">{t.settings.sections.language.defaultHomeViewLatest}</option>
            </select>
          </label>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card")} aria-labelledby="settings-account-title">
          <div>
            <h3 id="settings-account-title">{t.settings.sections.account.title}</h3>
            <p>{t.settings.sections.account.body}</p>
          </div>
          <div className={styles.settingsGrid}>
            <label className={styles.settingsField} htmlFor="settings-current-password">
              <span>{t.settings.sections.account.currentPasswordLabel}</span>
              <input
                autoComplete="current-password"
                id="settings-current-password"
                onChange={(event) => {
                  setPasswordDraft({ ...passwordDraft, currentPassword: event.target.value });
                  setPasswordError(null);
                  setPasswordNotice(null);
                }}
                placeholder={t.settings.sections.account.currentPasswordPlaceholder}
                type="password"
                value={passwordDraft.currentPassword}
              />
            </label>
            <label className={styles.settingsField} htmlFor="settings-new-password">
              <span>{t.settings.sections.account.newPasswordLabel}</span>
              <input
                autoComplete="new-password"
                id="settings-new-password"
                onChange={(event) => {
                  setPasswordDraft({ ...passwordDraft, newPassword: event.target.value });
                  setPasswordError(null);
                  setPasswordNotice(null);
                }}
                placeholder={t.settings.sections.account.newPasswordPlaceholder}
                type="password"
                value={passwordDraft.newPassword}
              />
            </label>
            <label className={styles.settingsField} htmlFor="settings-confirm-password">
              <span>{t.settings.sections.account.confirmPasswordLabel}</span>
              <input
                autoComplete="new-password"
                id="settings-confirm-password"
                onChange={(event) => {
                  setPasswordDraft({ ...passwordDraft, confirmPassword: event.target.value });
                  setPasswordError(null);
                  setPasswordNotice(null);
                }}
                placeholder={t.settings.sections.account.confirmPasswordPlaceholder}
                type="password"
                value={passwordDraft.confirmPassword}
              />
            </label>
          </div>
          <button
            className={styles.secondaryButton}
            disabled={isChangingPassword}
            onClick={() => void handleChangePassword()}
            type="button"
          >
            {isChangingPassword
              ? t.settings.sections.account.submitting
              : t.settings.sections.account.submit}
          </button>
          {passwordNotice ? <p className={styles.settingsNotice}>{passwordNotice}</p> : null}
          {passwordError ? <p className={styles.errorText}>{passwordError}</p> : null}
        </section>

        <section className={classNames(styles.settingsSection, "settings-card")} aria-labelledby="settings-behavior-title">
          <div>
            <h3 id="settings-behavior-title">{t.settings.sections.behavior.title}</h3>
            <p>{t.settings.sections.behavior.body}</p>
            <a
              className={styles.textLink}
              href={urlForAppPage({ type: "algorithm-transparency" })}
              onClick={(event) => {
                if (shouldLetBrowserHandleLinkClick(event)) {
                  return;
                }
                event.preventDefault();
                props.onOpenAlgorithmTransparency();
              }}
            >
              {t.settings.sections.behavior.algorithmTransparencyLink}
            </a>
          </div>
          <label className={styles.managementCheckbox} htmlFor="settings-ignore-scrolled">
            <input
              checked={draft.markScrolledArticlesIgnored}
              id="settings-ignore-scrolled"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  markScrolledArticlesIgnored: event.target.checked
                })
              }
              type="checkbox"
            />
            <span>{t.settings.sections.behavior.markScrolledArticlesIgnored}</span>
          </label>
          <label
            className={styles.managementCheckbox}
            htmlFor="settings-remove-read-later-on-complete"
          >
            <input
              checked={draft.removeReadLaterOnReadComplete}
              id="settings-remove-read-later-on-complete"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  removeReadLaterOnReadComplete: event.target.checked
                })
              }
              type="checkbox"
            />
            <span>{t.settings.sections.behavior.removeReadLaterOnReadComplete}</span>
          </label>
          <RangeSettingField
            id="settings-cocoon-level"
            label={t.settings.sections.behavior.cocoonLevel}
            max={10}
            min={1}
            onChange={(value) => applyDraft({ ...draft, cocoonLevel: value })}
            step={1}
            unit={t.settings.units.level}
            value={draft.cocoonLevel}
          />
          <p className={styles.managementHint}>{t.settings.sections.behavior.cocoonLevelHint}</p>
          <div className={styles.settingsSubsection}>
            <div>
              <h4>{t.settings.sections.behavior.interestClusterLimits.title}</h4>
              <p>{t.settings.sections.behavior.interestClusterLimits.body}</p>
              <p>{t.settings.sections.behavior.interestClusterLimits.embeddingCostHint}</p>
            </div>
            <label className={styles.settingsField} htmlFor="settings-interest-cluster-preset">
              <span>{t.settings.sections.behavior.interestClusterLimits.performancePreset}</span>
              <div className={styles.settingsRangeRow}>
                <input
                  id="settings-interest-cluster-preset"
                  max={2}
                  min={0}
                  onChange={(event) => {
                    const presetIndex = interestClusterPresetIndexFromSliderValue(
                      event.target.value
                    );
                    const preset = interestClusterLimitPresets[presetIndex];
                    setLastInterestClusterPresetIndex(presetIndex);
                    applyDraft({
                      ...draft,
                      maxPositiveInterestClusters: String(preset.maxPositiveInterestClusters),
                      maxNegativeInterestClusters: String(preset.maxNegativeInterestClusters),
                      maxPositiveInterestFamilies: String(preset.maxPositiveInterestFamilies),
                      maxNegativeInterestFamilies: String(preset.maxNegativeInterestFamilies)
                    });
                  }}
                  step={1}
                  type="range"
                  value={interestClusterPresetIndex}
                />
                <strong>
                  {t.settings.sections.behavior.interestClusterLimits.presets[
                    interestClusterPresetIndex
                  ] ?? t.settings.sections.behavior.interestClusterLimits.customPreset}
                </strong>
              </div>
              <div className={styles.settingsPresetScale} aria-hidden="true">
                {t.settings.sections.behavior.interestClusterLimits.presets.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            </label>
            <div className={styles.settingsGrid}>
              <NumberSettingField
                id="settings-max-positive-interest-clusters"
                label={t.settings.sections.behavior.interestClusterLimits.positiveLabel}
                max={192}
                min={8}
                onChange={(value) =>
                  applyDraft({ ...draft, maxPositiveInterestClusters: value })
                }
                step={1}
                value={draft.maxPositiveInterestClusters}
              />
              <NumberSettingField
                id="settings-max-negative-interest-clusters"
                label={t.settings.sections.behavior.interestClusterLimits.negativeLabel}
                max={128}
                min={4}
                onChange={(value) =>
                  applyDraft({ ...draft, maxNegativeInterestClusters: value })
                }
                step={1}
                value={draft.maxNegativeInterestClusters}
              />
              <NumberSettingField
                id="settings-max-positive-interest-families"
                label={t.settings.sections.behavior.interestClusterLimits.positiveFamilyLabel}
                max={64}
                min={2}
                onChange={(value) =>
                  applyDraft({ ...draft, maxPositiveInterestFamilies: value })
                }
                step={1}
                value={draft.maxPositiveInterestFamilies}
              />
              <NumberSettingField
                id="settings-max-negative-interest-families"
                label={t.settings.sections.behavior.interestClusterLimits.negativeFamilyLabel}
                max={48}
                min={1}
                onChange={(value) =>
                  applyDraft({ ...draft, maxNegativeInterestFamilies: value })
                }
                step={1}
                value={draft.maxNegativeInterestFamilies}
              />
            </div>
            <p className={styles.managementHint}>
              {t.settings.sections.behavior.interestClusterLimits.fieldHint}
            </p>
          </div>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card", "reader-settings-card")} aria-labelledby="settings-reader-title">
          <div>
            <h3 id="settings-reader-title">{t.settings.sections.reader.title}</h3>
            <p>{t.settings.sections.reader.body}</p>
          </div>
          <div className={styles.settingsGrid}>
            <NumberSettingField
              id="settings-font-size"
              label={t.settings.sections.reader.fontSize}
              max={24}
              min={16}
              onChange={(value) => applyDraft({ ...draft, fontSize: value })}
              step={1}
              unit={t.settings.units.px}
              value={draft.fontSize}
            />
            <NumberSettingField
              id="settings-line-height"
              label={t.settings.sections.reader.lineHeight}
              max={2.1}
              min={1.45}
              onChange={(value) => applyDraft({ ...draft, lineHeight: value })}
              step={0.05}
              value={draft.lineHeight}
            />
            <NumberSettingField
              id="settings-paragraph-gap"
              label={t.settings.sections.reader.paragraphGap}
              max={1.6}
              min={0.6}
              onChange={(value) => applyDraft({ ...draft, paragraphGap: value })}
              step={0.1}
              value={draft.paragraphGap}
            />
            <NumberSettingField
              id="settings-reader-width"
              label={t.settings.sections.reader.readerWidth}
              max={860}
              min={560}
              onChange={(value) => applyDraft({ ...draft, readerWidth: value })}
              step={40}
              unit={t.settings.units.px}
              value={draft.readerWidth}
            />
          </div>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card", "retention-card")} aria-labelledby="settings-retention-title">
          <div>
            <h3 id="settings-retention-title">{t.settings.sections.retention.title}</h3>
            <p>{t.settings.sections.retention.body}</p>
          </div>
          <NumberSettingField
            id="settings-retention-days"
            label={t.settings.sections.retention.retentionDays}
            max={3650}
            min={0}
            onChange={(value) => applyDraft({ ...draft, retentionDays: value })}
            step={1}
            unit={t.settings.units.days}
            value={draft.retentionDays}
          />
          <label className={styles.settingsInlineStatus} htmlFor="settings-keep-favorites">
            <span>{t.settings.sections.retention.keepFavorites}</span>
            <input
              checked={draft.keepFavorites}
              id="settings-keep-favorites"
              onChange={(event) =>
                applyDraft({ ...draft, keepFavorites: event.target.checked })
              }
              type="checkbox"
            />
          </label>
          <label className={styles.settingsInlineStatus} htmlFor="settings-keep-read-later">
            <span>{t.settings.sections.retention.keepReadLater}</span>
            <input
              checked={draft.keepReadLater}
              id="settings-keep-read-later"
              onChange={(event) =>
                applyDraft({ ...draft, keepReadLater: event.target.checked })
              }
              type="checkbox"
            />
          </label>
          <p className={styles.managementHint}>{t.settings.sections.retention.mappingHint}</p>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card", "provider-settings-card")} aria-labelledby="settings-provider-title">
          <div>
            <h3 id="settings-provider-title">{t.settings.sections.provider.title}</h3>
            <p>{t.settings.sections.provider.body}</p>
          </div>
          {props.isEmbeddingLoading ? (
            <p className={styles.settingsNotice}>{t.settings.sections.provider.loading}</p>
          ) : null}
          {props.embeddingError ? <p className={styles.errorText}>{props.embeddingError}</p> : null}
          {providerLocalError ? <p className={styles.errorText}>{providerLocalError}</p> : null}

          <div className={styles.providerActiveStatus}>
            <div>
              <strong>
                {activeProvider
                  ? t.settings.sections.provider.activeTitle
                  : t.settings.sections.provider.activeEmptyTitle}
              </strong>
              <p>
                {activeProvider
                  ? t.settings.sections.provider.activeBody(
                      activeProvider.name,
                      activeProvider.model,
                      activeProvider.dimension
                    )
                  : t.settings.sections.provider.activeEmptyBody}
              </p>
              {activeProviderIndex ? (
                <p>{embeddingCoverageText(activeProviderIndex, t)}</p>
              ) : null}
            </div>
          </div>

          {props.embeddingProviders.length > 0 ? (
            <div
              aria-label={t.settings.sections.provider.profileListLabel}
              className={styles.providerProfileList}
            >
              {props.embeddingProviders.map((provider) => (
                <button
                  className={
                    provider.id === providerDraft.providerId
                      ? styles.providerProfileCardActive
                      : styles.providerProfileCard
                  }
                  key={provider.id}
                  onClick={() => {
                    setProviderDraft(draftForEmbeddingProvider(provider));
                    setProviderLocalError(null);
                  }}
                  type="button"
                >
                  <span>
                    <strong>{provider.name}</strong>
                    <small>
                      {provider.type} · {provider.model} / {provider.dimension}
                    </small>
                  </span>
                  <em>
                    {provider.enabled
                      ? t.settings.sections.provider.currentBadge
                      : t.settings.sections.provider.profileBadge}
                  </em>
                </button>
              ))}
            </div>
          ) : null}

          <div className={styles.settingsGrid}>
            <label className={styles.settingsField} htmlFor="settings-provider-select">
              <span>{t.settings.sections.provider.providerLabel}</span>
              <select
                id="settings-provider-select"
                onChange={(event) => {
                  const provider =
                    props.embeddingProviders.find(
                      (candidate) => candidate.id === event.target.value
                    ) ?? null;
                  setProviderDraft(draftForEmbeddingProvider(provider));
                  setProviderLocalError(null);
                }}
                value={providerDraft.providerId}
              >
                <option value={newEmbeddingProviderId}>
                  {t.settings.sections.provider.newProvider}
                </option>
                {props.embeddingProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.settingsField} htmlFor="settings-provider-type">
              <span>{t.settings.sections.provider.typeLabel}</span>
              <select
                id="settings-provider-type"
                onChange={(event) => {
                  const nextType =
                    event.target.value === "ollama"
                      ? "ollama"
                      : event.target.value === "gemini"
                        ? "gemini"
                        : "openai_compatible";
                  setProviderDraft(draftWithProviderType(providerDraft, nextType));
                  setProviderLocalError(null);
                }}
                value={providerDraft.type}
              >
                <option value="openai_compatible">
                  {t.settings.sections.provider.openaiCompatible}
                </option>
                <option value="gemini">{t.settings.sections.provider.gemini}</option>
                <option value="ollama">{t.settings.sections.provider.ollama}</option>
              </select>
            </label>

            <label className={styles.settingsField} htmlFor="settings-provider-name">
              <span>{t.settings.sections.provider.nameLabel}</span>
              <input
                id="settings-provider-name"
                onChange={(event) =>
                  setProviderDraft({ ...providerDraft, name: event.target.value })
                }
                value={providerDraft.name}
              />
            </label>

            <label className={styles.settingsField} htmlFor="settings-provider-base-url">
              <span>{t.settings.sections.provider.baseUrlLabel}</span>
              <input
                id="settings-provider-base-url"
                inputMode="url"
                onChange={(event) =>
                  setProviderDraft({ ...providerDraft, baseUrl: event.target.value })
                }
                placeholder={
                  providerDraft.type === "ollama"
                    ? t.settings.sections.provider.ollamaBaseUrlPlaceholder
                    : providerDraft.type === "gemini"
                      ? t.settings.sections.provider.geminiBaseUrlPlaceholder
                    : t.settings.sections.provider.baseUrlPlaceholder
                }
                type="url"
                value={providerDraft.baseUrl}
              />
            </label>

            <label className={styles.settingsField} htmlFor="settings-provider-model">
              <span>{t.settings.sections.provider.modelLabel}</span>
              <input
                id="settings-provider-model"
                onChange={(event) =>
                  setProviderDraft({ ...providerDraft, model: event.target.value })
                }
                placeholder={
                  providerDraft.type === "ollama"
                    ? t.settings.sections.provider.ollamaModelPlaceholder
                    : providerDraft.type === "gemini"
                      ? t.settings.sections.provider.geminiModelPlaceholder
                    : t.settings.sections.provider.modelPlaceholder
                }
                value={providerDraft.model}
              />
            </label>

            <NumberSettingField
              id="settings-provider-dimension"
              label={t.settings.sections.provider.dimensionLabel}
              max={20000}
              min={1}
              onChange={(value) => setProviderDraft({ ...providerDraft, dimension: value })}
              step={1}
              value={providerDraft.dimension}
            />

            <NumberSettingField
              id="settings-provider-text-max-chars"
              label={t.settings.sections.provider.textMaxCharsLabel}
              max={200000}
              min={1000}
              onChange={(value) => setProviderDraft({ ...providerDraft, textMaxChars: value })}
              step={500}
              value={providerDraft.textMaxChars}
            />

            <NumberSettingField
              id="settings-provider-qpm"
              label={t.settings.sections.provider.requestsPerMinuteLabel}
              max={1000000}
              min={1}
              onChange={(value) =>
                setProviderDraft({ ...providerDraft, requestsPerMinute: value })
              }
              placeholder={t.settings.sections.provider.unlimitedPlaceholder}
              step={1}
              value={providerDraft.requestsPerMinute}
            />

            <NumberSettingField
              id="settings-provider-qpd"
              label={t.settings.sections.provider.requestsPerDayLabel}
              max={100000000}
              min={1}
              onChange={(value) => setProviderDraft({ ...providerDraft, requestsPerDay: value })}
              placeholder={t.settings.sections.provider.unlimitedPlaceholder}
              step={1}
              value={providerDraft.requestsPerDay}
            />

            {providerDraft.type !== "ollama" ? (
              <label className={styles.settingsField} htmlFor="settings-provider-api-key">
                <span>{t.settings.sections.provider.apiKeyLabel}</span>
                <input
                  autoComplete="off"
                  id="settings-provider-api-key"
                  onChange={(event) =>
                    setProviderDraft({ ...providerDraft, apiKey: event.target.value })
                  }
                  placeholder={
                    selectedProvider?.hasApiKey
                      ? t.settings.sections.provider.apiKeyRetainPlaceholder
                      : t.settings.sections.provider.apiKeyPlaceholder
                  }
                  type="password"
                  value={providerDraft.apiKey}
                />
              </label>
            ) : (
              <p className={styles.managementHint}>
                {t.settings.sections.provider.ollamaApiKeyHint}
              </p>
            )}
            {providerDraft.type === "gemini" ? (
              <p className={styles.managementHint}>
                {t.settings.sections.provider.geminiApiKeyHint}
              </p>
            ) : null}

            <label className={styles.settingsField} htmlFor="settings-provider-quality">
              <span>{t.settings.sections.provider.qualityTierLabel}</span>
              <select
                id="settings-provider-quality"
                onChange={(event) =>
                  setProviderDraft({
                    ...providerDraft,
                    qualityTier: event.target.value as EmbeddingProviderDraft["qualityTier"]
                  })
                }
                value={providerDraft.qualityTier}
              >
                <option value="basic">{t.settings.sections.provider.quality.basic}</option>
                <option value="recommended">
                  {t.settings.sections.provider.quality.recommended}
                </option>
                <option value="best_quality">
                  {t.settings.sections.provider.quality.bestQuality}
                </option>
              </select>
            </label>
          </div>

          <p className={styles.providerWarning}>{t.settings.sections.provider.modelHint}</p>
          <p className={styles.providerWarning}>{t.settings.sections.provider.textMaxCharsHint}</p>
          <p className={styles.managementHint}>{t.settings.sections.provider.rateLimitHint}</p>
          <p className={styles.managementHint}>{t.settings.sections.provider.activateHint}</p>

          {selectedProvider ? (
            <div className={styles.setupStatusBox}>
              <strong>{t.settings.sections.provider.connectionStatusTitle}</strong>
              <p>
                {selectedProvider.enabled
                  ? t.settings.sections.provider.enabledStatus
                  : t.settings.sections.provider.disabledStatus}
                {" · "}
                {selectedProvider.lastTestStatus === "success"
                  ? t.settings.sections.provider.lastTestSuccess(
                      selectedProvider.lastTestAt ?? t.feedManagement.na
                    )
                  : selectedProvider.lastTestStatus === "failed"
                    ? t.settings.sections.provider.lastTestFailed(
                        selectedProvider.lastTestError ?? t.feedManagement.na
                      )
                    : t.settings.sections.provider.lastTestUnknown}
              </p>
            </div>
          ) : null}

          <div className={styles.managementActions}>
            <button
              className={styles.primaryButton}
              disabled={props.isSavingEmbeddingProvider}
              onClick={() => void handleProviderSubmit()}
              type="button"
            >
              {props.isSavingEmbeddingProvider
                ? t.settings.sections.provider.saving
                : t.settings.sections.provider.save}
            </button>
            <button
              className={styles.primaryButton}
              disabled={
                !canActivateSelectedProvider ||
                isActivatingSelectedProvider ||
                props.isSavingEmbeddingProvider
              }
              onClick={() =>
                selectedProvider
                  ? void props.onActivateEmbeddingProvider(selectedProvider.id)
                  : undefined
              }
              type="button"
            >
              {isActivatingSelectedProvider
                ? t.settings.sections.provider.activating
                : selectedProvider?.enabled
                  ? t.settings.sections.provider.activeActionCurrent
                  : t.settings.sections.provider.activate}
            </button>
            <button
              className={styles.secondaryButton}
              disabled={!selectedProvider || props.testingProviderId === selectedProvider.id}
              onClick={() =>
                selectedProvider ? void props.onTestEmbeddingProvider(selectedProvider.id) : undefined
              }
              type="button"
            >
              {selectedProvider && props.testingProviderId === selectedProvider.id
                ? t.settings.sections.provider.testing
                : t.settings.sections.provider.test}
            </button>
            <button
              className={styles.dangerButton}
              disabled={!selectedProvider || props.deletingProviderId === selectedProvider.id}
              onClick={() =>
                selectedProvider
                  ? void props.onDeleteEmbeddingProvider(selectedProvider.id)
                  : undefined
              }
              type="button"
            >
              {selectedProvider && props.deletingProviderId === selectedProvider.id
                ? t.settings.sections.provider.deleting
                : t.settings.sections.provider.delete}
            </button>
          </div>

          <p className={styles.managementHint}>{t.settings.sections.provider.deleteHint}</p>

          <div className={classNames(styles.settingsSection, "settings-card", "index-settings-card")} aria-labelledby="settings-indexes-title">
            <div>
              <h3 id="settings-indexes-title">{t.settings.sections.provider.indexesTitle}</h3>
              <p>{t.settings.sections.provider.indexesBody}</p>
              <div className={styles.segmentedControl} aria-label={t.settings.sections.provider.usageWindowLabel}>
                {(["24h", "7d", "30d"] as const).map((windowKey) => (
                  <button
                    aria-pressed={usageWindow === windowKey}
                    className={
                      usageWindow === windowKey
                        ? styles.segmentedControlActive
                        : styles.segmentedControlButton
                    }
                    key={windowKey}
                    onClick={() => setUsageWindow(windowKey)}
                    type="button"
                  >
                    {t.settings.sections.provider.usageWindows[windowKey]}
                  </button>
                ))}
              </div>
            </div>
            {selectedProviderIndexes.length === 0 ? (
              <div className={styles.setupStatusBox}>
                <strong>{t.settings.sections.provider.noIndexes}</strong>
              </div>
            ) : (
              selectedProviderIndexes.map((index) => (
                <div className={styles.settingsIndexStatus} key={index.id}>
                  <div>
                    <strong>
                      {t.settings.sections.provider.indexStatus(
                        index.model,
                        index.status,
                        index.embeddingCount
                      )}
                    </strong>
                    <p>{embeddingCoverageText(index, t)}</p>
                    <p>{t.settings.sections.provider.indexTotal(index.embeddingCount)}</p>
                    <p>
                      {t.settings.sections.provider.embeddingJobStatusTitle}:{" "}
                      {t.settings.sections.provider.pendingJobs(index.pendingJobs)}
                      {" · "}
                      {t.settings.sections.provider.failedJobs(index.failedJobs)}
                    </p>
                    {index.lastFailedAt ? (
                      <p>
                        {t.settings.sections.provider.lastFailedAt(
                          formatDate(index.lastFailedAt)
                        )}
                      </p>
                    ) : null}
                    {index.lastError ? (
                      <p>{t.settings.sections.provider.lastError(index.lastError)}</p>
                    ) : index.failedJobs > 0 ? null : (
                      <p>{t.settings.sections.provider.noJobFailures}</p>
                    )}
                    <p className={styles.embeddingUsageLine}>
                      <ActionIcon name="sparkle" />
                      {t.settings.sections.provider.usage(
                        index.usage.windows[usageWindow].itemCount,
                        index.usage.windows[usageWindow].requestCount,
                        index.usage.windows[usageWindow].estimatedTokens
                      )}
                    </p>
                  </div>
                  <button
                    className={styles.secondaryButton}
                    disabled={props.backfillingIndexId === index.id || index.status !== "active"}
                    onClick={() => void props.onBackfillEmbeddingIndex(index.id)}
                    type="button"
                  >
                    {props.backfillingIndexId === index.id
                      ? t.settings.sections.provider.backfilling
                      : t.settings.sections.provider.backfill}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    disabled={props.rebuildingIndexId === index.id}
                    onClick={() => void props.onRebuildEmbeddingIndex(index.id)}
                    type="button"
                  >
                    {props.rebuildingIndexId === index.id
                      ? t.settings.sections.provider.rebuilding
                      : t.settings.sections.provider.rebuild}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card", "about-settings-card")} aria-labelledby="settings-about-title">
          <div>
            <h3 id="settings-about-title">{t.settings.sections.about.title}</h3>
            <p>{t.settings.sections.about.body}</p>
          </div>
          <label className={styles.settingsInlineStatus} htmlFor="settings-telemetry-enabled">
            <span>
              <strong>{t.settings.sections.about.telemetryLabel}</strong>
              <small>{t.settings.sections.about.telemetryBody}</small>
            </span>
            <input
              checked={draft.telemetryEnabled}
              id="settings-telemetry-enabled"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  telemetryEnabled: event.target.checked
                })
              }
              type="checkbox"
            />
          </label>
          <dl className={styles.aboutList}>
            <div>
              <dt>{t.settings.sections.about.version}</dt>
              <dd>{t.common.version(dibaoVersion)}</dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.latestVersion}</dt>
              <dd>
                <div className={styles.latestReleaseStatus}>
                  <span>
                    {latestReleaseText(
                      latestRelease,
                      isLoadingLatestRelease,
                      latestReleaseError,
                      t
                    )}
                  </span>
                  {latestRelease?.updateAvailable && latestRelease.releaseUrl ? (
                    <a href={latestRelease.releaseUrl} rel="noreferrer" target="_blank">
                      {t.settings.sections.about.releaseLink}
                    </a>
                  ) : null}
                  <button
                    className={styles.secondaryButton}
                    disabled={isCheckingLatestRelease}
                    onClick={() => void handleCheckLatestRelease()}
                    type="button"
                  >
                    {isCheckingLatestRelease
                      ? t.settings.sections.about.checkingRelease
                      : t.settings.sections.about.checkRelease}
                  </button>
                  <small>
                    {latestRelease?.checkedAt
                      ? t.settings.sections.about.latestCheckedAt(
                          formatDate(latestRelease.checkedAt)
                        )
                      : t.settings.sections.about.latestNeverChecked}
                  </small>
                </div>
              </dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.author}</dt>
              <dd>{t.settings.sections.about.authorName}</dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.xAccount}</dt>
              <dd>
                <a href="https://x.com/JeffreyCalm" rel="noreferrer" target="_blank">
                  @JeffreyCalm
                </a>
              </dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.blog}</dt>
              <dd>
                <a href="https://1q43.blog" rel="noreferrer" target="_blank">
                  1q43.blog
                </a>
              </dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.homepage}</dt>
              <dd>
                <a href="https://dibao.app" rel="noreferrer" target="_blank">
                  dibao.app
                </a>
              </dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.github}</dt>
              <dd>
                <a href="https://github.com/Pls-1q43/Dibao" rel="noreferrer" target="_blank">
                  Pls-1q43/Dibao
                </a>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </form>
  );
}

function latestReleaseText(
  latestRelease: LatestReleaseStatus | null,
  isLoading: boolean,
  error: string | null,
  t: Dictionary
): string {
  if (isLoading && latestRelease === null) {
    return t.settings.sections.about.latestLoading;
  }
  if (error) {
    return error;
  }
  if (!latestRelease) {
    return t.settings.sections.about.latestUnknown;
  }
  if (latestRelease.status === "error" && latestRelease.error) {
    return t.settings.sections.about.latestError(latestRelease.error);
  }
  if (!latestRelease.latestVersion) {
    return latestRelease.checkedAt
      ? t.settings.sections.about.latestUnavailable
      : t.settings.sections.about.latestUnknown;
  }
  if (latestRelease.updateAvailable) {
    return t.settings.sections.about.latestUpdateAvailable(latestRelease.latestVersion);
  }
  return t.settings.sections.about.latestCurrent(latestRelease.latestVersion);
}

export function AlgorithmTransparencyPage(props: {
  clusterLabelLexicon: ClusterLabelLexiconResponse | null;
  error: string | null;
  isLoading: boolean;
  mergeCandidates: RecommendationClusterMergeCandidate[];
  onBack: () => void;
  onIgnoreCandidate: (candidateId: string) => Promise<void>;
  onMergeCandidate: (candidateId: string) => Promise<void>;
  onOpenAllClusters: () => void;
  onRunMaintenanceTask: (task: RecommendationMaintenanceTask, label: string) => Promise<void>;
  onUpdateClusterLabelLexicon: (
    overrides: Partial<ClusterLabelLexiconOverrides>
  ) => Promise<void>;
  onUpdateClusterLabel: (clusterId: string, manualLabel: string | null) => Promise<void>;
  runningMaintenanceTask: RecommendationMaintenanceTask | null;
  status: RecommendationStatus | null;
  updatingClusterLexicon: boolean;
  updatingClusterLabelId: string | null;
  updatingMergeCandidateId: string | null;
}) {
  const { t, formatDate } = useI18n();
  const transparency =
    props.status && "transparency" in props.status
      ? (props.status as RecommendationTransparency).transparency
      : null;
  const statusText = props.error
    ? t.recommendationStatus.fallback
    : props.status
      ? t.recommendationStatus.modes[props.status.mode]
      : props.isLoading
        ? t.recommendationStatus.loading
        : t.recommendationStatus.fallback;
  const behaviorEntries = props.status ? Object.entries(props.status.behaviorCounts) : [];
  const recommendationStatusRows: Array<{ label: string; value: string }> = props.status
    ? [
        {
          label: t.algorithmTransparency.fields.provider,
          value: props.status.activeProvider
            ? `${props.status.activeProvider.name} · ${props.status.activeProvider.model}`
            : t.settings.sections.provider.disabled
        },
        {
          label: t.algorithmTransparency.fields.index,
          value: props.status.activeIndex
            ? `${props.status.activeIndex.model} · ${props.status.activeIndex.status}`
            : t.settings.sections.provider.coverageUnavailable
        },
        {
          label: t.algorithmTransparency.fields.coverage,
          value: t.settings.sections.provider.coverage(
            props.status.coverage.coveredArticleCount ?? props.status.coverage.embeddingCount,
            props.status.coverage.candidateCount,
            formatPercent(props.status.coverage.coverageRatio)
          )
        },
        {
          label: t.algorithmTransparency.fields.behaviorCounts,
          value:
            behaviorEntries.length > 0
              ? behaviorEntries.map(([name, count]) => `${name}: ${count}`).join(" · ")
              : t.recommendationStatus.metrics.unknown
        },
        {
          label: t.algorithmTransparency.fields.clusters,
          value: t.recommendationStatus.metrics.clusters(
            props.status.clusters.positive,
            props.status.clusters.negative
          )
        },
        {
          label: t.algorithmTransparency.fields.lastUpdates,
          value: t.recommendationStatus.metrics.lastUpdate(
            props.status.lastRankingUpdate
              ? formatDate(props.status.lastRankingUpdate)
              : t.recommendationStatus.metrics.unknown,
            props.status.lastProfileUpdate
              ? formatDate(props.status.lastProfileUpdate)
              : t.recommendationStatus.metrics.unknown
          )
        },
        {
          label: t.algorithmTransparency.fields.warnings,
          value:
            props.status.warnings.length > 0
              ? props.status.warnings
                  .map((warning) => `${warning.code}: ${warning.message}`)
                  .join(" · ")
              : t.algorithmTransparency.noWarnings
        },
        ...(props.status.algorithm
          ? [
              {
                label: t.algorithmTransparency.fields.cocoon,
                value: `${props.status.algorithm.cocoonLevel} · MMR λ ${
                  props.status.algorithm.cocoonParameters.mmrLambda
                } · ${t.algorithmTransparency.fields.exploration}: ${
                  props.status.algorithm.exploration.enabled
                    ? t.settings.sections.retention.enabled
                    : t.settings.sections.retention.disabled
                }`
              }
            ]
          : []),
        ...(transparency
          ? [
              {
                label: t.algorithmTransparency.fields.formula,
                value: transparency.currentFormula
              },
              ...(transparency.maintenance
                ? [
                    {
                      label: t.algorithmTransparency.fields.automaticMaintenance,
                      value: formatMaintenanceSchedule(transparency.maintenance)
                    }
                  ]
                : []),
              {
                label: t.algorithmTransparency.fields.failureStates,
                value:
                  Object.entries(transparency.failureStates)
                    .filter(([, active]) => active)
                    .map(([name]) => name)
                    .join(" · ") || t.algorithmTransparency.noWarnings
              }
            ]
          : [])
      ]
    : [];

  return (
    <section
      className={classNames(styles.settingsWorkspace, "algorithm-board-page")}
      aria-label={t.algorithmTransparency.pageTitle}
    >
      <div className={classNames(styles.settingsHeader, "algorithm-hero")}>
        <button className={styles.secondaryButton} onClick={props.onBack} type="button">
          {t.algorithmTransparency.backToSettings}
        </button>
      </div>

      <div className={classNames(styles.settingsContent, "algorithm-board")}>
        {props.isLoading ? (
          <p className={styles.settingsNotice}>{t.recommendationStatus.loading}</p>
        ) : null}
        {props.error ? <p className={styles.errorText}>{props.error}</p> : null}

        <section className={classNames(styles.settingsSection, "algorithm-card", "diagnostics-card")}>
          <div>
            <h3>{t.algorithmTransparency.sections.currentStatus}</h3>
            <p>{statusText}</p>
          </div>
          {recommendationStatusRows.length > 0 ? (
            <div className={styles.algorithmStatusTableWrap}>
              <table className={styles.algorithmStatusTable}>
                <tbody>
                  {recommendationStatusRows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      <td>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {transparency?.algorithmModules ? (
            <div className={styles.algorithmStatusTableWrap}>
              <table className={styles.algorithmStatusTable}>
                <thead>
                  <tr>
                    <th>{t.algorithmTransparency.statusTable.module}</th>
                    <th>{t.algorithmTransparency.statusTable.status}</th>
                    <th>{t.algorithmTransparency.statusTable.summary}</th>
                  </tr>
                </thead>
                <tbody>
                  {transparency.algorithmModules.map((module) => (
                    <tr key={module.id}>
                      <th scope="row">{module.name}</th>
                      <td>
                        <span className={algorithmStatusClassName(module.status)}>
                          {t.algorithmTransparency.statusTones[module.status]}
                        </span>
                      </td>
                      <td>{module.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <FamilySummaryPanel families={props.status?.clusters.families ?? null} />

        <section className={classNames(styles.settingsSection, "algorithm-card")}>
          <div>
            <h3>{t.algorithmTransparency.sections.currentClusters}</h3>
            <p>{t.algorithmTransparency.clusters.generated}</p>
          </div>
          {props.status?.clusters.items && props.status.clusters.items.length > 0 ? (
            <div className={styles.algorithmClusterGrid}>
              {props.status.clusters.items.map((cluster, index) => (
                <ClusterCard
                  cluster={cluster}
                  index={index}
                  key={cluster.id}
                  onUpdateLabel={props.onUpdateClusterLabel}
                  updating={props.updatingClusterLabelId === cluster.id}
                />
              ))}
            </div>
          ) : (
            <p>{t.algorithmTransparency.clusters.empty}</p>
          )}
          {props.status?.clusters.items && props.status.clusters.items.length >= 12 ? (
            <a
              className={styles.textLink}
              href={urlForAppPage({ type: "algorithm-clusters" })}
              onClick={(event) => {
                if (shouldLetBrowserHandleLinkClick(event)) {
                  return;
                }
                event.preventDefault();
                props.onOpenAllClusters();
              }}
            >
              {t.algorithmTransparency.clusters.openAll}
            </a>
          ) : null}
        </section>

        <ClusterMergeCandidatesPanel
          candidates={props.mergeCandidates}
          onIgnoreCandidate={props.onIgnoreCandidate}
          onMergeCandidate={props.onMergeCandidate}
          updatingCandidateId={props.updatingMergeCandidateId}
        />

        <ClusterLabelLexiconPanel
          lexicon={props.clusterLabelLexicon}
          onSave={props.onUpdateClusterLabelLexicon}
          saving={props.updatingClusterLexicon}
        />

        <section className={classNames(styles.settingsSection, "algorithm-card")}>
          <div>
            <h3>{t.algorithmTransparency.sections.terms}</h3>
          </div>
          <dl className={styles.algorithmTermList}>
            {t.algorithmTransparency.terms.map((item) => (
              <div key={item.term}>
                <dt>{item.term}</dt>
                <dd>{item.description}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className={classNames(styles.settingsSection, "algorithm-card")}>
          <div>
            <h3>{t.algorithmTransparency.sections.algorithmExplanation}</h3>
          </div>
          <div className={styles.algorithmExplanationList}>
            {t.algorithmTransparency.algorithmExplanation.map((item) => (
              <article key={item.name}>
                <strong>{item.name}</strong>
                <p>{item.role}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={classNames(styles.settingsSection, "algorithm-card")}>
          <div>
            <h3>{t.algorithmTransparency.sections.scoreTable}</h3>
          </div>
          <div className={styles.algorithmScoreTableWrap}>
            <table className={styles.algorithmScoreTable}>
              <thead>
                <tr>
                  <th>{t.algorithmTransparency.scoreTable.columns.behavior}</th>
                  <th>{t.algorithmTransparency.scoreTable.columns.modelCard}</th>
                  <th>{t.algorithmTransparency.scoreTable.columns.source}</th>
                  <th>{t.algorithmTransparency.scoreTable.columns.ranking}</th>
                  <th>{t.algorithmTransparency.scoreTable.columns.notes}</th>
                </tr>
              </thead>
              <tbody>
                {t.algorithmTransparency.scoreTable.rows.map((row) => (
                  <tr key={row.behavior}>
                    <th scope="row">{row.behavior}</th>
                    <td>{row.modelCard}</td>
                    <td>{row.source}</td>
                    <td>{row.ranking}</td>
                    <td>{row.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={classNames(styles.settingsSection, "algorithm-card")}>
          <div>
            <h3>{t.algorithmTransparency.sections.channelRules}</h3>
          </div>
          <ul className={styles.algorithmBulletList}>
            {t.algorithmTransparency.channelRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </section>

        <section className={classNames(styles.settingsSection, "algorithm-card")}>
          <div>
            <h3>{t.algorithmTransparency.sections.dataAndFallback}</h3>
          </div>
          <p>{t.algorithmTransparency.copy.localData}</p>
          <p>{t.algorithmTransparency.copy.fallback}</p>
        </section>

        {transparency ? (
          <section className={classNames(styles.settingsSection, "algorithm-card")}>
            <details className={styles.maintenanceDisclosure}>
              <summary>
                <span className={styles.maintenanceSummaryText}>
                  <span className={styles.maintenanceSummaryTitle}>
                    {t.algorithmTransparency.sections.maintenance}
                  </span>
                  <span>{t.algorithmTransparency.maintenance.disclosureHint}</span>
                </span>
              </summary>
              <p className={styles.settingsNotice}>{t.algorithmTransparency.maintenance.body}</p>
              <div className={styles.maintenanceTaskList}>
                {maintenanceTasks(t).map((task) => {
                  const schedule = transparency.maintenance.schedule?.find(
                    (state) => state.taskKey === task.scheduleKey
                  );
                  return (
                    <div className={styles.maintenanceTaskRow} key={task.key}>
                      <div className={styles.maintenanceTaskMain}>
                        <strong>{task.label}</strong>
                        <p>{task.description}</p>
                      </div>
                      <dl className={styles.maintenanceTaskMeta}>
                        <div>
                          <dt>{t.algorithmTransparency.maintenance.remoteUse}</dt>
                          <dd>{task.remoteUse}</dd>
                        </div>
                        <div>
                          <dt>{t.algorithmTransparency.maintenance.lastState}</dt>
                          <dd>{formatMaintenanceTaskSchedule(schedule, t)}</dd>
                        </div>
                      </dl>
                      <button
                        className={styles.secondaryButton}
                        disabled={props.runningMaintenanceTask === task.key}
                        onClick={() => void props.onRunMaintenanceTask(task.key, task.label)}
                        type="button"
                      >
                        {props.runningMaintenanceTask === task.key
                          ? t.algorithmTransparency.maintenance.running
                          : t.algorithmTransparency.maintenance.run}
                      </button>
                    </div>
                  );
                })}
              </div>
            </details>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function ClusterMergeCandidatesPanel(props: {
  candidates: RecommendationClusterMergeCandidate[];
  onIgnoreCandidate: (candidateId: string) => Promise<void>;
  onMergeCandidate: (candidateId: string) => Promise<void>;
  updatingCandidateId: string | null;
}) {
  const { t } = useI18n();
  const visibleCandidates = props.candidates
    .filter((candidate) => candidate.status === "open")
    .slice(0, 8);

  return (
    <section className={classNames(styles.settingsSection, "algorithm-card")}>
      <div>
        <h3>{t.algorithmTransparency.mergeCandidates.title}</h3>
        <p>{t.algorithmTransparency.mergeCandidates.body}</p>
      </div>
      {visibleCandidates.length > 0 ? (
        <div className={styles.algorithmStatusTableWrap}>
          <table className={styles.algorithmStatusTable}>
            <thead>
              <tr>
                <th>{t.algorithmTransparency.mergeCandidates.left}</th>
                <th>{t.algorithmTransparency.mergeCandidates.right}</th>
                <th>{t.algorithmTransparency.mergeCandidates.metrics}</th>
                <th>{t.algorithmTransparency.mergeCandidates.recommendation}</th>
                <th>{t.algorithmTransparency.mergeCandidates.actions}</th>
              </tr>
            </thead>
            <tbody>
              {visibleCandidates.map((candidate) => (
                <tr key={candidate.id}>
                  <td>{candidate.leftLabel}</td>
                  <td>{candidate.rightLabel}</td>
                  <td>
                    {t.algorithmTransparency.mergeCandidates.metricSummary(
                      formatPercent(candidate.centroidSimilarity),
                      formatPercent(candidate.labelJaccard),
                      formatPercent(candidate.evidenceOverlap),
                      formatPercent(candidate.mergeScore)
                    )}
                  </td>
                  <td>
                    {candidate.polarity} ·{" "}
                    {t.algorithmTransparency.mergeCandidates.recommendations[candidate.recommendation]}
                  </td>
                  <td>
                    <div className={styles.clusterLabelActions}>
                      <button
                        className={styles.secondaryButton}
                        disabled={props.updatingCandidateId === candidate.id}
                        onClick={() => void props.onMergeCandidate(candidate.id)}
                        type="button"
                      >
                        {t.algorithmTransparency.mergeCandidates.merge}
                      </button>
                      <button
                        className={styles.secondaryButton}
                        disabled={props.updatingCandidateId === candidate.id}
                        onClick={() => void props.onIgnoreCandidate(candidate.id)}
                        type="button"
                      >
                        {t.algorithmTransparency.mergeCandidates.ignore}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.settingsNotice}>{t.algorithmTransparency.mergeCandidates.empty}</p>
      )}
    </section>
  );
}

function ClusterLabelLexiconPanel(props: {
  lexicon: ClusterLabelLexiconResponse | null;
  onSave: (overrides: Partial<ClusterLabelLexiconOverrides>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useI18n();
  const [draftStopword, setDraftStopword] = useState("");
  const [stopwordsAdd, setStopwordsAdd] = useState<string[]>([]);

  useEffect(() => {
    setStopwordsAdd(props.lexicon?.overrides.stopwordsAdd ?? []);
  }, [props.lexicon?.overrides.stopwordsAdd]);

  function addDraftStopword() {
    const next = draftStopword.trim();
    if (!next || stopwordsAdd.includes(next)) {
      setDraftStopword("");
      return;
    }
    setStopwordsAdd([...stopwordsAdd, next]);
    setDraftStopword("");
  }

  function removeStopword(term: string) {
    setStopwordsAdd(stopwordsAdd.filter((item) => item !== term));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSave({ stopwordsAdd });
  }

  return (
    <section className={classNames(styles.settingsSection, "algorithm-card")}>
      <div>
        <h3>{t.algorithmTransparency.lexicon.title}</h3>
        <p>{t.algorithmTransparency.lexicon.body}</p>
      </div>
      {props.lexicon?.warnings.length ? (
        <p className={styles.errorText}>{props.lexicon.warnings.join(" / ")}</p>
      ) : null}
      <form className={styles.clusterLabelForm} onSubmit={handleSubmit}>
        <label>
          {t.algorithmTransparency.lexicon.stopwordsAdd}
          <input
            maxLength={64}
            onChange={(event) => setDraftStopword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addDraftStopword();
              }
            }}
            placeholder={t.algorithmTransparency.lexicon.stopwordPlaceholder}
            value={draftStopword}
          />
        </label>
        <div className={styles.clusterLabelActions}>
          <button className={styles.secondaryButton} onClick={addDraftStopword} type="button">
            {t.algorithmTransparency.lexicon.addStopword}
          </button>
          <button className={styles.primaryButton} disabled={props.saving} type="submit">
            {props.saving
              ? t.algorithmTransparency.maintenance.running
              : t.algorithmTransparency.lexicon.saveAndRebuild}
          </button>
        </div>
      </form>
      {stopwordsAdd.length > 0 ? (
        <div className={styles.clusterLabelActions}>
          {stopwordsAdd.map((term) => (
            <button
              className={styles.secondaryButton}
              key={term}
              onClick={() => removeStopword(term)}
              type="button"
            >
              {term} ×
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.settingsNotice}>{t.algorithmTransparency.lexicon.noStopwords}</p>
      )}
      {props.lexicon?.overrides.protectedTermsAdd.length ? (
        <p>
          <strong>{t.algorithmTransparency.lexicon.protectedTermsAdd}</strong>
          <br />
          {props.lexicon.overrides.protectedTermsAdd.join(" / ")}
        </p>
      ) : null}
    </section>
  );
}

function FamilySummaryPanel(props: {
  families: RecommendationStatus["clusters"]["families"] | null;
}) {
  const { t } = useI18n();
  const families = props.families?.topFamilies ?? [];

  return (
    <section className={classNames(styles.settingsSection, "algorithm-card")}>
      <div>
        <h3>{t.algorithmTransparency.sections.topicFamilies}</h3>
        <p>
          {props.families
            ? t.algorithmTransparency.families.summary(
                props.families.positive,
                props.families.negative,
                t.algorithmTransparency.families.risk[props.families.concentrationRisk]
              )
            : t.algorithmTransparency.families.empty}
        </p>
      </div>
      {families.length > 0 ? (
        <div className={styles.algorithmFamilyList}>
          {families.slice(0, 6).map((family) => (
            <FamilySummaryRow family={family} key={family.id} />
          ))}
        </div>
      ) : (
        <p>{t.algorithmTransparency.families.empty}</p>
      )}
    </section>
  );
}

function FamilySummaryRow(props: { family: RecommendationFamilySummaryItem }) {
  const { t } = useI18n();
  return (
    <div className={styles.algorithmFamilyRow}>
      <div>
        <strong>{props.family.displayLabel}</strong>
        <p>
          {t.algorithmTransparency.families.rowMeta(
            props.family.clusterCount,
            props.family.supportArticleCount,
            props.family.sourceCount,
            formatPercent(props.family.dominanceRatio),
            formatPercent(props.family.maturity)
          )}
        </p>
      </div>
      <span className={styles.algorithmFamilyPill}>
        {t.algorithmTransparency.families.risk[props.family.diagnostics.concentrationRisk]}
      </span>
    </div>
  );
}

function groupClustersByFamily(
  clusters: RecommendationClusterItem[],
  fallbackLabels: { positive: string; negative: string }
): Array<{
  id: string;
  label: string;
  clusters: RecommendationClusterItem[];
}> {
  const groups = new Map<string, { id: string; label: string; clusters: RecommendationClusterItem[] }>();
  clusters.forEach((cluster, index) => {
    const id = cluster.family?.id ?? `ungrouped:${cluster.polarity}`;
    const label =
      cluster.family?.displayLabel ??
      (cluster.polarity === "positive" ? fallbackLabels.positive : fallbackLabels.negative);
    const group = groups.get(id) ?? { id, label, clusters: [] };
    group.clusters.push({ ...cluster, displayIndex: cluster.displayIndex ?? index + 1 });
    groups.set(id, group);
  });
  return Array.from(groups.values()).sort(
    (left, right) =>
      right.clusters.length - left.clusters.length ||
      left.label.localeCompare(right.label)
  );
}

function AlgorithmClustersPage(props: {
  clusters: RecommendationClusterItem[];
  error: string | null;
  isLoading: boolean;
  onBack: () => void;
  onUpdateClusterLabel: (clusterId: string, manualLabel: string | null) => Promise<void>;
  total: number;
  updatingClusterLabelId: string | null;
}) {
  const { t } = useI18n();
  const familyGroups = groupClustersByFamily(props.clusters, {
    positive: t.algorithmTransparency.families.positiveFallback,
    negative: t.algorithmTransparency.families.negativeFallback
  });

  return (
    <section
      className={classNames(styles.settingsWorkspace, "algorithm-board-page")}
      aria-labelledby="algorithm-clusters-title"
    >
      <div className={classNames(styles.settingsHeader, "algorithm-hero")}>
        <div>
          <p className={styles.kicker}>{t.algorithmTransparency.pageTitle}</p>
          <h2 id="algorithm-clusters-title">{t.algorithmTransparency.clusters.allTitle}</h2>
        </div>
        <button className={styles.secondaryButton} onClick={props.onBack} type="button">
          {t.algorithmTransparency.clusters.back}
        </button>
      </div>
      <div className={classNames(styles.settingsContent, "algorithm-board")}>
        <section className={classNames(styles.settingsSection, "algorithm-card")}>
          <div>
            <h3>{t.algorithmTransparency.clusters.allTitle}</h3>
            <p>{t.algorithmTransparency.clusters.allSummary(props.total)}</p>
          </div>
          {props.isLoading ? (
            <p className={styles.settingsNotice}>{t.recommendationStatus.loading}</p>
          ) : null}
          {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
          {!props.isLoading && !props.error && familyGroups.length > 0 ? (
            <div className={styles.algorithmFamilyList}>
              {familyGroups.map((group, groupIndex) => (
                <details
                  className={styles.algorithmFamilyGroup}
                  key={group.id}
                  open={groupIndex < 3}
                >
                  <summary>
                    {group.label} · {t.algorithmTransparency.families.clusterCount(group.clusters.length)}
                  </summary>
                  <div className={styles.algorithmClusterGrid}>
                    {group.clusters.map((cluster) => (
                      <ClusterCard
                        cluster={cluster}
                        index={cluster.displayIndex ?? props.clusters.indexOf(cluster) + 1}
                        key={cluster.id}
                        onUpdateLabel={props.onUpdateClusterLabel}
                        updating={props.updatingClusterLabelId === cluster.id}
                      />
                    ))}
                  </div>
                </details>
              ))}
            </div>
          ) : null}
          {!props.isLoading && !props.error && props.clusters.length === 0 ? (
            <p>{t.algorithmTransparency.clusters.empty}</p>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function ClusterCard(props: {
  cluster: RecommendationClusterItem;
  index: number;
  onUpdateLabel: (clusterId: string, manualLabel: string | null) => Promise<void>;
  updating: boolean;
}) {
  const { t, formatDate } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(
    props.cluster.manualLabel ?? props.cluster.displayLabel ?? props.cluster.label ?? ""
  );
  const source = props.cluster.labelSource ?? "fallback";
  const confidence = props.cluster.confidence ?? 0;
  const evidenceCount =
    props.cluster.evidenceCount ?? props.cluster.diagnostics?.supportArticleCount ?? 0;
  const topTerms = props.cluster.topTerms ?? [];
  const representativeArticles = props.cluster.representativeArticles ?? [];
  const feedTitles = props.cluster.feedTitles ?? [];

  useEffect(() => {
    if (!isEditing) {
      setDraftLabel(
        props.cluster.manualLabel ?? props.cluster.displayLabel ?? props.cluster.label ?? ""
      );
    }
  }, [isEditing, props.cluster.displayLabel, props.cluster.label, props.cluster.manualLabel]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onUpdateLabel(props.cluster.id, draftLabel.trim() || null);
    setIsEditing(false);
  }

  async function handleClearManualLabel() {
    await props.onUpdateLabel(props.cluster.id, null);
    setIsEditing(false);
  }

  return (
    <article className={styles.algorithmClusterCard} data-polarity={props.cluster.polarity}>
      <span>
        {props.cluster.polarity === "positive"
          ? t.algorithmTransparency.clusters.positive
          : t.algorithmTransparency.clusters.negative}
      </span>
      <strong>{clusterDisplayName(props.cluster, props.index, t)}</strong>
      {props.cluster.family ? (
        <p>
          {t.algorithmTransparency.families.clusterFamily}:{" "}
          {props.cluster.family.displayLabel}
        </p>
      ) : null}
      <p>
        {t.algorithmTransparency.clusters.sourceLabel}:{" "}
        {t.algorithmTransparency.clusters.source[source]} ·{" "}
        {t.algorithmTransparency.clusters.confidenceLabel}:{" "}
        {t.algorithmTransparency.clusters.confidence[confidenceBucket(confidence)]}
        {confidence < 0.4 ? ` · ${t.algorithmTransparency.clusters.lowConfidence}` : ""}
      </p>
      {props.cluster.manualLabel && props.cluster.autoLabel ? (
        <p>{t.algorithmTransparency.clusters.autoInference(props.cluster.autoLabel)}</p>
      ) : null}
      {props.cluster.labelDiagnostics?.collision ? (
        <p>{t.algorithmTransparency.clusters.collisionResolved}</p>
      ) : null}
      {props.cluster.labelDiagnostics?.lowConfidence ? (
        <p>{t.algorithmTransparency.clusters.lowConfidenceAdvice}</p>
      ) : null}
      {props.cluster.mergeDiagnostics?.topCandidate ? (
        <p>
          {t.algorithmTransparency.clusters.possibleDuplicate(
            props.cluster.mergeDiagnostics.topCandidate.otherLabel,
            formatPercent(props.cluster.mergeDiagnostics.topCandidate.centroidSimilarity)
          )}
        </p>
      ) : null}
      <p>
        {t.algorithmTransparency.clusters.details(
          formatCompactNumber(props.cluster.weight),
          props.cluster.sampleCount,
          formatDate(props.cluster.updatedAt)
        )}
        {evidenceCount > 0 ? ` · ${t.algorithmTransparency.clusters.evidence(evidenceCount)}` : ""}
        {props.cluster.lastGeneratedAt
          ? ` · ${t.algorithmTransparency.clusters.generatedAt(formatDate(props.cluster.lastGeneratedAt))}`
          : ""}
      </p>
      {topTerms.length > 0 ? (
        <p>
          <strong>{t.algorithmTransparency.clusters.topTerms}</strong>
          <br />
          {topTerms.slice(0, 5).join(" / ")}
        </p>
      ) : null}
      {representativeArticles.length > 0 ? (
        <div className={styles.clusterEvidenceList}>
          <strong>{t.algorithmTransparency.clusters.representativeArticles}</strong>
          <ul>
            {representativeArticles.slice(0, 3).map((article) => (
              <li key={article.articleId}>{article.title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {feedTitles.length > 0 ? (
        <p>
          <strong>{t.algorithmTransparency.clusters.feedTitles}</strong>
          <br />
          {feedTitles.slice(0, 3).join(" / ")}
        </p>
      ) : null}
      {props.cluster.diagnostics ? (
        <p>
          <strong>
            {t.algorithmTransparency.clusters.risk[props.cluster.diagnostics.overfitRisk]}
          </strong>
          <br />
          {t.algorithmTransparency.clusters.diagnostics(
            props.cluster.diagnostics.supportArticleCount,
            props.cluster.diagnostics.sourceCount,
            formatPercent(props.cluster.diagnostics.strongSignalRatio),
            formatPercent(props.cluster.diagnostics.topSourceShare),
            formatPercent(props.cluster.diagnostics.averageSimilarity)
          )}
          {props.cluster.diagnostics.warnings.length > 0
            ? ` · ${props.cluster.diagnostics.warnings.join(" / ")}`
            : ""}
        </p>
      ) : null}
      {isEditing ? (
        <form className={styles.clusterLabelForm} onSubmit={handleSubmit}>
          <label>
            {t.algorithmTransparency.clusters.renameLabel}
            <input
              maxLength={30}
              onChange={(event) => setDraftLabel(event.target.value)}
              placeholder={t.algorithmTransparency.clusters.renamePlaceholder}
              value={draftLabel}
            />
          </label>
          <div className={styles.clusterLabelActions}>
            <button className={styles.primaryButton} disabled={props.updating} type="submit">
              {t.algorithmTransparency.clusters.saveLabel}
            </button>
            <button
              className={styles.secondaryButton}
              disabled={props.updating}
              onClick={() => setIsEditing(false)}
              type="button"
            >
              {t.algorithmTransparency.clusters.cancelRename}
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.clusterLabelActions}>
          <button
            className={styles.secondaryButton}
            disabled={props.updating}
            onClick={() => setIsEditing(true)}
            type="button"
          >
            {t.algorithmTransparency.clusters.rename}
          </button>
          {props.cluster.manualLabel ? (
            <button
              className={styles.secondaryButton}
              disabled={props.updating}
              onClick={() => void handleClearManualLabel()}
              type="button"
            >
              {t.algorithmTransparency.clusters.clearManualLabel}
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}

function NumberSettingField(props: {
  id: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  placeholder?: string;
  step: number;
  unit?: string;
  value: string;
}) {
  return (
    <label className={styles.settingsField} htmlFor={props.id}>
      <span>{props.label}</span>
      <div className={styles.settingsNumberRow}>
        <input
          id={props.id}
          max={props.max}
          min={props.min}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          step={props.step}
          type="number"
          value={props.value}
        />
        {props.unit ? <small>{props.unit}</small> : null}
      </div>
    </label>
  );
}

function RangeSettingField(props: {
  id: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  step: number;
  unit?: string;
  value: string;
}) {
  return (
    <label className={styles.settingsField} htmlFor={props.id}>
      <span>{props.label}</span>
      <div className={styles.settingsRangeRow}>
        <input
          id={props.id}
          max={props.max}
          min={props.min}
          onChange={(event) => props.onChange(event.target.value)}
          step={props.step}
          type="range"
          value={props.value}
        />
        <strong>
          {props.value}
          {props.unit ? ` ${props.unit}` : ""}
        </strong>
      </div>
      <div className={styles.settingsRangeScale} aria-hidden="true">
        <span>{props.min}</span>
        <span>{props.max}</span>
      </div>
    </label>
  );
}

export function FeedPanel(props: {
  diagnosticsByFeedId: FeedDiagnosticsByFeedId;
  feedError: string | null;
  feedFolders: FeedFolder[];
  feeds: Feed[];
  isOpen: boolean;
  isFeedsLoading: boolean;
  onRefreshFeed: (feed: Feed) => void;
  onCloseSources: () => void;
  onSelectSource: (source: SourceSelection) => void;
  refreshingFeedId: string | null;
  sourceSelection: SourceSelection;
}) {
  const { t, formatDate } = useI18n();
  const feedCountByFolder = useMemo(() => countFeedsByFolder(props.feeds), [props.feeds]);

  return (
    <section
      className={classNames(styles.feedPanel, props.isOpen ? styles.feedPanelOpen : null)}
      data-testid="feed-scroll-container"
      aria-label={t.feeds.title}
    >
      {props.feedError ? <p className={styles.errorText}>{props.feedError}</p> : null}

      <div className={styles.feedList}>
        <button
          className={styles.mobileSourceCloseButton}
          onClick={props.onCloseSources}
          type="button"
        >
          {t.feeds.closeSources}
        </button>
        <button
          className={
            props.sourceSelection.type === "all" ? styles.feedItemActive : styles.feedItem
          }
          onClick={() => props.onSelectSource({ type: "all" })}
          type="button"
        >
          <span>{t.feeds.allFeeds}</span>
          <small>{t.feeds.sourceCount(props.feeds.length)}</small>
        </button>

        {props.isFeedsLoading ? <SkeletonRows count={5} /> : null}

        {!props.isFeedsLoading && props.feedFolders.length > 0 ? (
          <>
            <span className={styles.folderSectionLabel}>{t.folders.title}</span>
            {props.feedFolders.map((folder) => (
              <button
                className={
                  props.sourceSelection.type === "folder" &&
                  props.sourceSelection.folderId === folder.id
                    ? styles.feedItemActive
                    : styles.feedItem
                }
                key={folder.id}
                onClick={() => props.onSelectSource({ type: "folder", folderId: folder.id })}
                type="button"
              >
                <span>{folder.title}</span>
                <small>{t.folders.feedCount(feedCountByFolder.get(folder.id) ?? 0)}</small>
              </button>
            ))}
          </>
        ) : null}

        {!props.isFeedsLoading &&
          props.feeds.map((feed) => {
            const diagnostic = props.diagnosticsByFeedId[feed.id] ?? null;
            return (
            <div className={styles.feedRow} key={feed.id}>
              <button
                className={
                  props.sourceSelection.type === "feed" &&
                  props.sourceSelection.feedId === feed.id
                    ? styles.feedItemActive
                    : styles.feedItem
                }
                onClick={() => props.onSelectSource({ type: "feed", feedId: feed.id })}
                type="button"
              >
                <span className={styles.feedTitleLine}>
                  <span>{feed.title}</span>
                  {diagnostic?.severity === "error" ? (
                    <span className={styles.feedFailureDot}>{t.feedDiagnostics.statuses.failing}</span>
                  ) : null}
                </span>
                <small>
                  {feed.lastSuccessAt
                    ? t.feeds.successAt(formatDate(feed.lastSuccessAt))
                    : feed.feedUrl}
                </small>
                <small>
                  {t.feeds.nextRefreshAt(
                    feed.nextRefreshAt ? formatDate(feed.nextRefreshAt) : t.feedManagement.na
                  )}
                </small>
              </button>
              <button
                className={styles.iconButton}
                disabled={props.refreshingFeedId === feed.id}
                onClick={() => props.onRefreshFeed(feed)}
                title={t.feeds.refreshTitle(feed.title)}
                type="button"
              >
                {props.refreshingFeedId === feed.id ? t.feeds.refreshing : t.feeds.refresh}
              </button>
            </div>
            );
          })}
      </div>
    </section>
  );
}

export function ArticleListPanel(props: {
  articleError: string | null;
  articleView: ArticleView;
  articles: ArticleListItem[];
  favoriteSort: FavoriteArticleSort;
  readLaterSort: ReadLaterArticleSort;
  feedCount: number;
  isIgnoreTelemetryEnabled: boolean;
  isArticlesLoading: boolean;
  isLoadingMore: boolean;
  isMarkingScopeRead: boolean;
  isRecommendationStatusLoading: boolean;
  listScrollKey?: string;
  loadMoreError: string | null;
  nextCursor: string | null;
  onArticleAction?: (article: ArticleActionTarget, intent: ArticleActionIntent) => void;
  onFavoriteSortChange: (sort: FavoriteArticleSort) => void;
  onReadLaterSortChange: (sort: ReadLaterArticleSort) => void;
  onIgnoreArticle: (articleId: string) => void;
  onLoadMore: () => void;
  onMarkScopeRead: () => void;
  onPreviewMarkScopeRead: () => Promise<number>;
  onOpenSources: () => void;
  onExplainArticle: (articleId: string) => void;
  onSelectArticle: (articleId: string) => void;
  onTimeWindowChange: (timeWindow: ArticleTimeWindow) => void;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  pendingAction?: PendingArticleAction | null;
  recommendationStatus: RecommendationStatus | null;
  recommendationStatusError: string | null;
  readerCommandError: string | null;
  selectedArticleId: string | null;
  selectedFeed: Feed | null;
  selectedFolder: FeedFolder | null;
  showRecommendationStatus: boolean;
  showQuickFilters: boolean;
  timeWindow: ArticleTimeWindow;
  unreadCount: number;
  unreadOnly: boolean;
}) {
  const { t, formatDate } = useI18n();
  const scrollContainerRef = useRef<HTMLElement>(null);
  const listScrollKey = props.listScrollKey ?? `dibao:list-scroll:${props.articleView}`;
  const sourceTitle =
    props.selectedFeed?.title ?? props.selectedFolder?.title ?? t.articles.allSources;

  useArticleListIgnoreTelemetry({
    articles: props.articles,
    enabled: props.isIgnoreTelemetryEnabled,
    onIgnoreArticle: props.onIgnoreArticle,
    rootRef: scrollContainerRef,
    selectedArticleId: props.selectedArticleId
  });

  usePersistedArticleListScroll({
    enabled: !props.selectedArticleId,
    storageKey: listScrollKey,
    rootRef: scrollContainerRef
  });

  return (
    <section
      className={styles.articlePanel}
      data-testid="article-list-scroll-container"
      ref={scrollContainerRef}
      aria-labelledby="articles-title"
    >
      <div className={styles.panelHeader}>
        <div>
          <p className={styles.kicker}>{sourceTitle}</p>
          <h2 id="articles-title">{t.articles.views[props.articleView]}</h2>
        </div>
        <div className={styles.panelHeaderActions}>
          <button
            aria-label={t.feeds.openSourcesLabel}
            className={styles.mobileSourceButton}
            onClick={props.onOpenSources}
            type="button"
          >
            {t.feeds.openSources}
          </button>
          {props.articleView === "favorites" || props.articleView === "read_later" ? (
            <label
              className={styles.articleSortControl}
              htmlFor={`${props.articleView}-article-sort`}
            >
              <span>{t.articles.sort.label}</span>
              <select
                id={`${props.articleView}-article-sort`}
                onChange={(event) => {
                  if (props.articleView === "favorites") {
                    props.onFavoriteSortChange(event.target.value as FavoriteArticleSort);
                    return;
                  }
                  props.onReadLaterSortChange(event.target.value as ReadLaterArticleSort);
                }}
                value={
                  props.articleView === "favorites" ? props.favoriteSort : props.readLaterSort
                }
              >
                {props.articleView === "favorites" ? (
                  <>
                    <option value="favorited_desc">{t.articles.sort.favorited_desc}</option>
                    <option value="favorited_asc">{t.articles.sort.favorited_asc}</option>
                  </>
                ) : (
                  <>
                    <option value="ranked">{t.articles.sort.ranked}</option>
                    <option value="read_later_desc">{t.articles.sort.read_later_desc}</option>
                    <option value="read_later_asc">{t.articles.sort.read_later_asc}</option>
                  </>
                )}
                <option value="published_desc">{t.articles.sort.published_desc}</option>
                <option value="published_asc">{t.articles.sort.published_asc}</option>
              </select>
            </label>
          ) : null}
          {props.showQuickFilters ? (
            <div className={styles.articleFilterBar} aria-label={t.articles.filters.label}>
              <TimeWindowFilter
                onChange={props.onTimeWindowChange}
                timeWindow={props.timeWindow}
              />
              <UnreadDebtControl
                clearWindow={props.timeWindow}
                isClearing={props.isMarkingScopeRead}
                onConfirmClear={props.onMarkScopeRead}
                onPreviewClear={props.onPreviewMarkScopeRead}
                onToggleUnreadOnly={() => props.onUnreadOnlyChange(!props.unreadOnly)}
                unreadCount={props.unreadCount}
                unreadOnly={props.unreadOnly}
              />
            </div>
          ) : null}
        </div>
      </div>

      {props.showRecommendationStatus ? (
        <RecommendationStatusBar
          error={props.recommendationStatusError}
          isLoading={props.isRecommendationStatusLoading}
          status={props.recommendationStatus}
        />
      ) : null}

      {props.articleError ? <p className={styles.errorText}>{props.articleError}</p> : null}
      {props.readerCommandError ? (
        <p className={styles.errorText}>{props.readerCommandError}</p>
      ) : null}

      <div className={styles.list} aria-live="polite">
        {props.isArticlesLoading ? <SkeletonRows count={10} /> : null}

        {!props.isArticlesLoading && props.articles.length === 0 ? (
          <EmptyState
            title={
              props.feedCount === 0
                ? t.articles.emptyNoFeedsTitle
                : props.showQuickFilters && props.unreadOnly
                  ? t.articles.emptyNoUnreadTitle
                : t.articles.emptyNoArticlesTitle
            }
            body={
              props.feedCount === 0
                ? t.articles.emptyNoFeedsBody
                : props.showQuickFilters && props.unreadOnly
                  ? t.articles.emptyNoUnreadBody
                : t.articles.emptyNoArticlesBody
            }
          />
        ) : null}

        {!props.isArticlesLoading &&
          props.articles.map((article) => (
            <article
              className={articleItemClassName(article, props.selectedArticleId)}
              data-article-id={article.id}
              data-interaction-status={articleInteractionStatusForState(article.state)}
              data-favorited={article.state.favorited ? "true" : undefined}
              data-liked={article.state.liked ? "true" : undefined}
              data-read-later={article.state.readLater ? "true" : undefined}
              key={article.id}
            >
              <a
                className={styles.articleMain}
                href={urlForArticle(props.articleView, article.id, {
                  favoriteSort: props.favoriteSort,
                  readLaterSort: props.readLaterSort,
                  timeWindow: props.timeWindow,
                  unreadOnly: props.unreadOnly
                })}
                onClick={(event) => {
                  if (shouldLetBrowserHandleLinkClick(event)) {
                    return;
                  }
                  event.preventDefault();
                  props.onSelectArticle(article.id);
                }}
              >
                <span className={styles.meta}>
                  {t.articles.itemMeta(
                    formatDate(article.publishedAt ?? article.discoveredAt),
                    article.feedTitle
                  )}
                </span>
                <strong>{article.title}</strong>
                {article.summary ? (
                  <span className={styles.summary}>{plainTextSummary(article.summary)}</span>
                ) : null}
              </a>
              <ArticleRowActions
                article={article}
                onAction={(intent) => props.onArticleAction?.(article, intent)}
                canExplain={shouldLoadRankExplanation(props.articleView)}
                onExplain={() => props.onExplainArticle(article.id)}
                pendingAction={
                  props.pendingAction?.articleId === article.id
                    ? props.pendingAction.intent
                    : null
                }
              />
            </article>
          ))}

        {!props.isArticlesLoading && props.nextCursor ? (
          <div className={styles.loadMoreBar}>
            <button
              className={styles.secondaryButton}
              disabled={props.isLoadingMore}
              onClick={props.onLoadMore}
              type="button"
            >
              {props.isLoadingMore ? t.articles.loadingMore : t.articles.loadMore}
            </button>
          </div>
        ) : null}

        {!props.isArticlesLoading && props.loadMoreError ? (
          <p className={styles.paginationError}>{props.loadMoreError}</p>
        ) : null}
      </div>
    </section>
  );
}

function UnreadDebtControl(props: {
  clearWindow: ArticleTimeWindow;
  unreadCount: number;
  unreadOnly: boolean;
  isClearing: boolean;
  onToggleUnreadOnly: () => void;
  onPreviewClear: () => Promise<number>;
  onConfirmClear: () => void;
}) {
  const { t } = useI18n();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const canOpenClear = props.clearWindow !== "all" || props.unreadCount > 0;

  async function openConfirm() {
    setIsConfirmOpen(true);
    setPreviewCount(null);
    setPreviewError(null);
    setIsPreviewLoading(true);

    try {
      setPreviewCount(await props.onPreviewClear());
    } catch {
      setPreviewError(t.readerCommands.markScopeRead.error);
    } finally {
      setIsPreviewLoading(false);
    }
  }

  return (
    <div className={styles.unreadDebtControl}>
      <button
        aria-pressed={props.unreadOnly}
        className={props.unreadOnly ? styles.unreadDebtToggleActive : styles.unreadDebtToggle}
        onClick={props.onToggleUnreadOnly}
        title={t.readerCommands.markScopeRead.toggleUnread}
        type="button"
      >
        {t.readerCommands.markScopeRead.unreadWithCount(props.unreadCount)}
      </button>
      <button
        className={styles.unreadDebtClear}
        disabled={!canOpenClear || props.isClearing}
        onClick={openConfirm}
        title={t.readerCommands.markScopeRead.clearTitleForWindow(props.clearWindow)}
        type="button"
      >
        <span className={styles.unreadDebtClearLabel}>
          {props.isClearing
            ? t.readerCommands.markScopeRead.clearing
            : t.readerCommands.markScopeRead.clearForWindow(props.clearWindow)}
        </span>
        <span className={styles.unreadDebtClearShort}>
          {t.readerCommands.markScopeRead.clearShort}
        </span>
      </button>
      <MarkScopeReadConfirmDialog
        isOpen={isConfirmOpen}
        onCancel={() => setIsConfirmOpen(false)}
        onConfirm={() => {
          setIsConfirmOpen(false);
          props.onConfirmClear();
        }}
        clearWindow={props.clearWindow}
        isLoading={isPreviewLoading}
        error={previewError}
        unreadCount={previewCount}
      />
    </div>
  );
}

function SearchUnreadDebtControl(props: {
  unreadCount: number;
  isClearing: boolean;
  onConfirmClear: () => void;
}) {
  const { t } = useI18n();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  return (
    <span className={styles.searchUnreadDebtControl}>
      <button
        className={styles.searchUnreadDebtButton}
        disabled={props.unreadCount === 0 || props.isClearing}
        onClick={() => setIsConfirmOpen(true)}
        title={t.readerCommands.markScopeRead.clearTitle}
        type="button"
      >
        {t.readerCommands.markScopeRead.unreadWithCount(props.unreadCount)}
      </button>
      <MarkScopeReadConfirmDialog
        isOpen={isConfirmOpen}
        onCancel={() => setIsConfirmOpen(false)}
        onConfirm={() => {
          setIsConfirmOpen(false);
          props.onConfirmClear();
        }}
        unreadCount={props.unreadCount}
      />
    </span>
  );
}

function MarkScopeReadConfirmDialog(props: {
  isOpen: boolean;
  unreadCount: number | null;
  clearWindow?: ArticleTimeWindow;
  isLoading?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  if (!props.isOpen) {
    return null;
  }

  return (
    <div className={styles.readerCommandDialogBackdrop}>
      <div
        aria-modal="true"
        className={styles.readerCommandDialog}
        role="dialog"
        aria-labelledby="reader-command-dialog-title"
      >
        <h3 id="reader-command-dialog-title">
          {t.readerCommands.markScopeRead.confirmTitle}
        </h3>
        <p>
          {props.isLoading
            ? t.readerCommands.markScopeRead.confirmBodyLoading
            : props.unreadCount === null
              ? t.readerCommands.markScopeRead.confirmBodyUnknown
              : props.clearWindow
                ? t.readerCommands.markScopeRead.confirmBodyForWindow(
                    props.unreadCount,
                    props.clearWindow
                  )
                : t.readerCommands.markScopeRead.confirmBody(props.unreadCount)}
        </p>
        <p className={styles.readerCommandDialogHint}>
          {t.readerCommands.markScopeRead.confirmHint}
        </p>
        {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
        <div className={styles.readerCommandDialogActions}>
          <button className={styles.secondaryButton} onClick={props.onCancel} type="button">
            {t.readerCommands.markScopeRead.cancel}
          </button>
          <button
            className={styles.primaryButton}
            disabled={props.isLoading || Boolean(props.error) || props.unreadCount === 0}
            onClick={props.onConfirm}
            type="button"
          >
            {t.readerCommands.markScopeRead.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SearchResultsPanel(props: {
  articleError: string | null;
  articles: ArticleListItem[];
  feedFolders: FeedFolder[];
  feeds: Feed[];
  form: SearchFormState;
  hasSubmitted: boolean;
  isArticlesLoading: boolean;
  isLoadingMore: boolean;
  isMarkingScopeRead: boolean;
  loadMoreError: string | null;
  nextCursor: string | null;
  onArticleAction?: (article: ArticleActionTarget, intent: ArticleActionIntent) => void;
  onChange: (form: SearchFormState) => void;
  onExplainArticle: (articleId: string) => void;
  onLoadMore: () => void;
  onMarkScopeRead: () => void;
  onSelectArticle: (articleId: string) => void;
  onSubmit: (form: SearchFormState) => void;
  pendingAction?: PendingArticleAction | null;
  readerCommandError: string | null;
  resultUrlForm: SearchFormState;
  selectedArticleId: string | null;
  unreadCount: number;
}) {
  const { t, formatDate } = useI18n();
  const [isAdvancedSearchOpen, setIsAdvancedSearchOpen] = useState(false);

  function update(patch: Partial<SearchFormState>) {
    props.onChange({
      ...props.form,
      ...patch
    });
  }

  return (
    <section className={styles.articlePanel} aria-labelledby="search-title">
      <form
        className={styles.searchForm}
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit(props.form);
        }}
      >
        <div className={styles.searchIntro}>
          <p className={styles.kicker}>{t.search.pageTitle}</p>
          <h2 id="search-title">{t.search.title}</h2>
          <p>{t.search.body}</p>
        </div>
        <label className={styles.searchField}>
          <span>{t.search.inputLabel}</span>
          <input
            autoComplete="off"
            onChange={(event) => update({ q: event.target.value })}
            placeholder={t.search.inputPlaceholder}
            type="search"
            value={props.form.q}
          />
        </label>
        <div className={styles.searchActions}>
          <label className={styles.searchField}>
            <span>{t.search.sortLabel}</span>
            <select
              onChange={(event) => update({ sort: event.target.value as ArticleSearchSort })}
              value={props.form.sort}
            >
              <option value="relevance">{t.search.sorts.relevance}</option>
              <option value="recommended">{t.search.sorts.recommended}</option>
              <option value="latest">{t.search.sorts.latest}</option>
            </select>
          </label>
          <label className={styles.searchField}>
            <span>{t.search.stateLabel}</span>
            <select
              onChange={(event) => update({ state: event.target.value as ArticleSearchState })}
              value={props.form.state}
            >
              <option value="all">{t.search.states.all}</option>
              <option value="unread">{t.search.states.unread}</option>
              <option value="read">{t.search.states.read}</option>
              <option value="favorites">{t.search.states.favorites}</option>
              <option value="read_later">{t.search.states.read_later}</option>
            </select>
          </label>
          <button
            className={styles.primaryButton}
            disabled={props.isArticlesLoading || props.form.q.trim().length === 0}
            type="submit"
          >
            {props.isArticlesLoading ? t.search.submitting : t.search.submit}
          </button>
        </div>
        {props.form.sort === "recommended" ? (
          <p className={styles.searchHint}>{t.search.recommendedSortHint}</p>
        ) : null}
        <button
          aria-controls="search-advanced-filters"
          aria-expanded={isAdvancedSearchOpen}
          className={styles.searchAdvancedToggle}
          onClick={() => setIsAdvancedSearchOpen((value) => !value)}
          type="button"
        >
          <ActionIcon name="more" />
          <span>
            {isAdvancedSearchOpen ? t.search.hideAdvancedSearch : t.search.advancedSearch}
          </span>
        </button>
        <div
          className={`${styles.searchAdvanced} ${
            isAdvancedSearchOpen ? styles.searchAdvancedOpen : ""
          }`}
          id="search-advanced-filters"
        >
          <div className={styles.searchFilters} aria-label={t.search.sourceLabel}>
            <label className={styles.searchField}>
              <span>{t.search.folderLabel}</span>
              <select
                onChange={(event) =>
                  update({
                    sourceSelection: event.target.value
                      ? { type: "folder", folderId: event.target.value }
                      : { type: "all" }
                  })
                }
                value={
                  props.form.sourceSelection.type === "folder"
                    ? props.form.sourceSelection.folderId
                    : ""
                }
              >
                <option value="">{t.search.allFolders}</option>
                {props.feedFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.title}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.searchField}>
              <span>{t.search.feedLabel}</span>
              <select
                onChange={(event) =>
                  update({
                    sourceSelection: event.target.value
                      ? { type: "feed", feedId: event.target.value }
                      : { type: "all" }
                  })
                }
                value={
                  props.form.sourceSelection.type === "feed" ? props.form.sourceSelection.feedId : ""
                }
              >
                <option value="">{t.search.allFeeds}</option>
                {props.feeds.map((feed) => (
                  <option key={feed.id} value={feed.id}>
                    {feed.title}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.searchField}>
              <span>{t.search.dateFromLabel}</span>
              <input
                onChange={(event) => update({ from: event.target.value })}
                type="date"
                value={props.form.from}
              />
            </label>
            <label className={styles.searchField}>
              <span>{t.search.dateToLabel}</span>
              <input
                onChange={(event) => update({ to: event.target.value })}
                type="date"
                value={props.form.to}
              />
            </label>
          </div>
        </div>
      </form>

      {props.articleError ? <p className={styles.errorText}>{props.articleError}</p> : null}
      {props.readerCommandError ? (
        <p className={styles.errorText}>{props.readerCommandError}</p>
      ) : null}

      <div className={styles.list} aria-live="polite">
        {props.isArticlesLoading ? <SkeletonRows count={10} /> : null}

        {!props.isArticlesLoading && !props.hasSubmitted ? (
          <EmptyState title={t.search.initialTitle} body={t.search.initialBody} />
        ) : null}

        {!props.isArticlesLoading && props.hasSubmitted && props.articles.length === 0 ? (
          <EmptyState title={t.search.emptyTitle} body={t.search.emptyBody} />
        ) : null}

        {!props.isArticlesLoading && props.articles.length > 0 ? (
          <div className={styles.searchResultCount}>
            <span>{t.search.resultsCount(props.articles.length)}</span>
            <span aria-hidden="true">·</span>
            <SearchUnreadDebtControl
              isClearing={props.isMarkingScopeRead}
              onConfirmClear={props.onMarkScopeRead}
              unreadCount={props.unreadCount}
            />
          </div>
        ) : null}

        {!props.isArticlesLoading &&
          props.articles.map((article) => (
            <article
              className={articleItemClassName(article, props.selectedArticleId)}
              data-article-id={article.id}
              data-interaction-status={articleInteractionStatusForState(article.state)}
              data-favorited={article.state.favorited ? "true" : undefined}
              data-liked={article.state.liked ? "true" : undefined}
              data-read-later={article.state.readLater ? "true" : undefined}
              key={article.id}
            >
              <a
                className={styles.articleMain}
                href={urlForSearchPage(props.resultUrlForm, article.id)}
                onClick={(event) => {
                  if (shouldLetBrowserHandleLinkClick(event)) {
                    return;
                  }
                  event.preventDefault();
                  props.onSelectArticle(article.id);
                }}
              >
                <span className={styles.meta}>
                  {t.articles.itemMeta(
                    formatDate(article.publishedAt ?? article.discoveredAt),
                    article.feedTitle
                  )}
                </span>
                <strong>{article.title}</strong>
                {article.summary ? (
                  <span className={styles.summary}>{plainTextSummary(article.summary)}</span>
                ) : null}
              </a>
              <ArticleRowActions
                article={article}
                canExplain={true}
                onAction={(intent) => props.onArticleAction?.(article, intent)}
                onExplain={() => props.onExplainArticle(article.id)}
                pendingAction={
                  props.pendingAction?.articleId === article.id
                    ? props.pendingAction.intent
                    : null
                }
              />
            </article>
          ))}

        {!props.isArticlesLoading && props.nextCursor ? (
          <div className={styles.loadMoreBar}>
            <button
              className={styles.secondaryButton}
              disabled={props.isLoadingMore}
              onClick={props.onLoadMore}
              type="button"
            >
              {props.isLoadingMore ? t.articles.loadingMore : t.search.loadMore}
            </button>
          </div>
        ) : null}

        {!props.isArticlesLoading && props.loadMoreError ? (
          <p className={styles.paginationError}>{props.loadMoreError}</p>
        ) : null}
      </div>
    </section>
  );
}

function TimeWindowFilter(props: {
  onChange: (timeWindow: ArticleTimeWindow) => void;
  timeWindow: ArticleTimeWindow;
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const active = props.timeWindow !== "all";
  const label = t.articles.filters.timeWindows[props.timeWindow];

  return (
    <div className={styles.timeFilterMenu}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-pressed={active}
        className={active ? styles.articleFilterActive : styles.articleFilter}
        onClick={() => setIsOpen((open) => !open)}
        title={t.articles.filters.timeWindowTitle}
        type="button"
      >
        {label}
      </button>
      {isOpen ? (
        <div className={styles.timeFilterMenuItems} role="menu">
          {(["all", "24h", "7d", "30d"] as const).map((windowKey) => (
            <button
              aria-checked={props.timeWindow === windowKey}
              className={
                props.timeWindow === windowKey
                  ? styles.timeFilterMenuItemActive
                  : styles.timeFilterMenuItem
              }
              key={windowKey}
              onClick={() => {
                props.onChange(windowKey);
                setIsOpen(false);
              }}
              role="menuitemradio"
              type="button"
            >
              {t.articles.filters.timeWindows[windowKey]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RecommendationStatusBar(props: {
  error: string | null;
  isLoading: boolean;
  status: RecommendationStatus | null;
}) {
  const { t, formatDate } = useI18n();
  const statusText = props.error
    ? t.recommendationStatus.fallback
    : props.status
      ? t.recommendationStatus.modes[props.status.mode]
      : props.isLoading
        ? t.recommendationStatus.loading
        : t.recommendationStatus.fallback;
  const metrics = props.status ? recommendationStatusMetrics(props.status, t, formatDate) : [];
  const showWarmupNotice = props.status ? hasProfileWarmupWarning(props.status) : false;

  return (
    <section className={styles.recommendationStatusBar} aria-live="polite">
      <div>
        <span className={styles.recommendationStatusLabel}>{t.recommendationStatus.title}</span>
        <strong>{statusText}</strong>
      </div>
      {showWarmupNotice ? (
        <p className={styles.recommendationStatusNotice}>
          {t.recommendationStatus.warmupNotice}
        </p>
      ) : null}
      {metrics.length > 0 ? (
        <dl className={styles.recommendationStatusMetrics}>
          {metrics.map((metric) => (
            <div key={metric}>
              <dd>{metric}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function hasProfileWarmupWarning(status: RecommendationStatus): boolean {
  return status.warnings.some((warning) => warning.code === "PROFILE_WARMUP");
}

function useArticleListIgnoreTelemetry(props: {
  articles: ArticleListItem[];
  enabled: boolean;
  onIgnoreArticle: (articleId: string) => void;
  rootRef: RefObject<HTMLElement | null>;
  selectedArticleId: string | null;
}) {
  const onIgnoreArticleRef = useRef(props.onIgnoreArticle);
  const selectedArticleIdRef = useRef(props.selectedArticleId);
  const seenVisibleIds = useRef(new Set<string>());
  const sentIds = useRef(new Set<string>());

  useEffect(() => {
    onIgnoreArticleRef.current = props.onIgnoreArticle;
  }, [props.onIgnoreArticle]);

  useEffect(() => {
    selectedArticleIdRef.current = props.selectedArticleId;
    if (props.selectedArticleId) {
      seenVisibleIds.current.clear();
    }
  }, [props.selectedArticleId]);

  useEffect(() => {
    const root = props.rootRef.current;
    if (!props.enabled || !root || typeof IntersectionObserver === "undefined") {
      return;
    }

    const visibleCandidates = props.articles.filter(
      (article) => articleInteractionStatusForState(article.state) === "unseen"
    );
    const candidateIds = new Set(visibleCandidates.map((article) => article.id));

    for (const id of Array.from(seenVisibleIds.current)) {
      if (!candidateIds.has(id)) {
        seenVisibleIds.current.delete(id);
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const articleId = target.dataset.articleId;
          if (
            !articleId ||
            !candidateIds.has(articleId) ||
            sentIds.current.has(articleId) ||
            selectedArticleIdRef.current === articleId
          ) {
            continue;
          }

          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            seenVisibleIds.current.add(articleId);
            continue;
          }

          const rootTop = entry.rootBounds?.top ?? root.getBoundingClientRect().top;
          const hasScrolledPast = entry.boundingClientRect.bottom <= rootTop;
          if (seenVisibleIds.current.has(articleId) && hasScrolledPast) {
            sentIds.current.add(articleId);
            onIgnoreArticleRef.current(articleId);
          }
        }
      },
      {
        root,
        threshold: [0, 0.6]
      }
    );

    for (const article of visibleCandidates) {
      const element = root.querySelector<HTMLElement>(
        `[data-article-id="${cssEscape(article.id)}"]`
      );
      if (element) {
        observer.observe(element);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [props.articles, props.enabled, props.rootRef]);
}

function usePersistedArticleListScroll(props: {
  enabled: boolean;
  rootRef: RefObject<HTMLElement | null>;
  storageKey: string;
}) {
  useEffect(() => {
    const root = props.rootRef.current;
    if (!root || typeof window === "undefined") {
      return;
    }
    const scrollRoot = root;

    if (props.enabled) {
      const stored = window.sessionStorage.getItem(props.storageKey);
      const scrollTop = stored ? Number(stored) : NaN;
      if (Number.isFinite(scrollTop) && scrollTop > 0) {
        window.requestAnimationFrame(() => {
          scrollRoot.scrollTop = scrollTop;
        });
      }
    }

    function handleScroll() {
      window.sessionStorage.setItem(props.storageKey, String(scrollRoot.scrollTop));
    }

    scrollRoot.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollRoot.removeEventListener("scroll", handleScroll);
    };
  }, [props.enabled, props.rootRef, props.storageKey]);
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

function articleItemClassName(article: ArticleListItem, selectedArticleId: string | null): string {
  if (selectedArticleId === article.id) {
    return styles.articleItemActive;
  }

  const status = articleInteractionStatusForState(article.state);
  return status === "read" || status === "ignored" ? styles.articleItemRead : styles.articleItem;
}

const ArticleHtmlBody = memo(function ArticleHtmlBody(props: {
  safeHtml: string | null;
  fallback: string;
}) {
  if (props.safeHtml) {
    return (
      <div
        className={styles.readerBody}
        dangerouslySetInnerHTML={{ __html: props.safeHtml }}
        onErrorCapture={handleReaderMediaError}
      />
    );
  }

  return (
    <div className={styles.readerBody}>
      <p>{props.fallback}</p>
    </div>
  );
});

function handleReaderMediaError(event: SyntheticEvent<HTMLDivElement>): void {
  if (!(event.target instanceof HTMLImageElement)) {
    return;
  }

  event.target.dataset.dibaoLoadState = "failed";
  event.target.removeAttribute("src");
  event.target.removeAttribute("srcset");
}

function ArticleDetailPanel(props: {
  actionError: string | null;
  article: ArticleDetail | null;
  articleView: ArticleView;
  detailError: string | null;
  explanation: RankExplanation | null;
  explanationError: string | null;
  isExplanationOpen: boolean;
  isDetailLoading: boolean;
  isExplanationLoading: boolean;
  onArticleAction: (article: ArticleDetail, intent: ArticleActionIntent) => void;
  onBackToList: () => void;
  onCloseExplanation: () => void;
  onOpenExplanation: () => void;
  onReadProgress: (
    articleId: string,
    progress: number,
    metadata: ReadProgressMetadata,
    options?: ReadProgressPostOptions
  ) => void;
  pendingAction: ArticleActionIntent | null;
  readerSettings: ReaderSettings;
}) {
  const { t, formatDate } = useI18n();
  const readerPanelRef = useRef<HTMLElement>(null);
  const safeHtml = useMemo(
    () =>
      props.article?.contentHtml
        ? sanitizeArticleHtml(props.article.contentHtml, props.article.url)
        : null,
    [props.article?.contentHtml, props.article?.url]
  );
  const sourceNotice = props.article ? contentSourceNotice(props.article, t) : null;
  const showReaderActions = useReaderActionVisibility(readerPanelRef, props.article?.id ?? null);
  const canExplainDetail = shouldLoadRankExplanation(props.articleView);

  useReaderReadProgress({
    article: props.article,
    onReadProgress: props.onReadProgress,
    scrollContainerRef: readerPanelRef
  });

  return (
    <section
      className={styles.readerPanel}
      data-testid="reader-scroll-container"
      ref={readerPanelRef}
      style={readerStyleFor(props.readerSettings)}
      aria-labelledby="reader-title"
    >
      {props.isDetailLoading ? <ReaderSkeleton /> : null}

      {!props.isDetailLoading && props.detailError ? (
        <p className={styles.errorText}>{props.detailError}</p>
      ) : null}

      {!props.isDetailLoading && !props.detailError && !props.article ? (
        <EmptyState title={t.reader.selectArticleTitle} body={t.reader.selectArticleBody} />
      ) : null}

      {!props.isDetailLoading && !props.detailError && props.article ? (
        <article className={styles.reader} data-reader-theme={props.readerSettings.theme}>
          <button
            className={styles.mobileBackButton}
            onClick={props.onBackToList}
            type="button"
          >
            {t.reader.backToList}
          </button>
          <header className={styles.readerHeader}>
            <a href={props.article.url} rel="noreferrer" target="_blank">
              {t.reader.originalLink}
            </a>
            <h2 id="reader-title">{props.article.title}</h2>
            <p>
              {t.reader.meta(
                props.article.feedTitle,
                props.article.publishedAt ? formatDate(props.article.publishedAt) : undefined,
                props.article.author
              )}
            </p>
            {sourceNotice ? (
              <span className={styles.inlineNotice}>{sourceNotice}</span>
            ) : null}
            <ArticleActionControls
              actionError={props.actionError}
              article={props.article}
              canExplain={canExplainDetail}
              onExplain={props.onOpenExplanation}
              onAction={(intent) => props.onArticleAction(props.article as ArticleDetail, intent)}
              pendingAction={props.pendingAction}
              placement="top"
            />
          </header>

          <ArticleHtmlBody
            fallback={props.article.contentText ?? props.article.summary ?? t.reader.noContent}
            safeHtml={safeHtml}
          />
          <ArticleActionControls
            actionError={null}
            article={props.article}
            hidden={!showReaderActions}
            onAction={(intent) => props.onArticleAction(props.article as ArticleDetail, intent)}
            pendingAction={props.pendingAction}
            placement="bottom"
          />
          <ArticleExplanationEntry
            articleView={props.articleView}
            error={props.explanationError}
            explanation={props.explanation}
            isOpen={props.isExplanationOpen}
            isLoading={props.isExplanationLoading}
            onClose={props.onCloseExplanation}
            onOpen={props.onOpenExplanation}
          />
        </article>
      ) : null}
    </section>
  );
}

function ArticleRowActions(props: {
  article: ArticleActionTarget;
  canExplain: boolean;
  onAction: (intent: ArticleActionIntent) => void;
  onExplain: () => void;
  pendingAction: ArticleActionIntent | null;
}) {
  const { t } = useI18n();
  const { state } = props.article;
  const isBusy = props.pendingAction !== null;

  return (
    <div className={classNames(styles.actionButtonRow, styles.articleRowActions)} aria-live="polite">
      <ActionButton
        ariaLabel={state.favorited ? t.actions.aria.unfavorite : t.actions.aria.favorite}
        busy={props.pendingAction === "favorite"}
        disabled={isBusy}
        icon={state.favorited ? "starFilled" : "star"}
        label={state.favorited ? t.actions.unfavorite : t.actions.favorite}
        onClick={() => props.onAction("favorite")}
        selected={state.favorited}
      />
      <ActionButton
        ariaLabel={state.liked ? t.actions.aria.unlike : t.actions.aria.like}
        busy={props.pendingAction === "like"}
        disabled={isBusy}
        icon="like"
        label={state.liked ? t.actions.unlike : t.actions.like}
        onClick={() => props.onAction("like")}
        selected={state.liked}
      />
      <ActionButton
        ariaLabel={state.readLater ? t.actions.aria.removeReadLater : t.actions.aria.readLater}
        busy={props.pendingAction === "readLater"}
        disabled={isBusy}
        icon="bookmark"
        label={state.readLater ? t.actions.removeReadLater : t.actions.readLater}
        onClick={() => props.onAction("readLater")}
        selected={state.readLater}
      />
      <ActionButton
        ariaLabel={
          state.notInterested ? t.actions.aria.notInterestedActive : t.actions.aria.notInterested
        }
        busy={props.pendingAction === "notInterested"}
        danger
        disabled={isBusy || state.notInterested}
        icon="dismiss"
        label={state.notInterested ? t.actions.notInterestedActive : t.actions.notInterested}
        onClick={() => props.onAction("notInterested")}
        selected={state.notInterested}
      />
      {props.canExplain ? (
        <button
          aria-label={t.explanation.title}
          className={classNames(styles.actionButton, styles.actionExplain)}
          onClick={props.onExplain}
          title={t.explanation.title}
          type="button"
        >
          <ActionIcon name="sparkle" />
        </button>
      ) : null}
    </div>
  );
}

function contentSourceNotice(article: ArticleDetail, t: Dictionary): string {
  if (!article.contentHtml && !article.contentText) {
    return t.reader.contentSource.noContent;
  }
  switch (article.extractionStatus) {
    case "success":
      return t.reader.contentSource.success;
    case "feed_only":
      return t.reader.contentSource.feed_only;
    case "failed":
      return article.extractionError
        ? t.reader.contentSource.failedWithError(shortError(article.extractionError))
        : t.reader.contentSource.failed;
    case "skipped":
      return t.reader.contentSource.skipped;
    case "pending":
      return t.reader.contentSource.pending;
  }
}

function shortError(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}...` : value;
}

export function ArticleActionControls(props: {
  actionError: string | null;
  article: Pick<ArticleDetail, "id" | "state">;
  canExplain?: boolean;
  hidden?: boolean;
  onAction: (intent: ArticleActionIntent) => void;
  onExplain?: () => void;
  pendingAction: ArticleActionIntent | null;
  placement?: "top" | "bottom";
}) {
  const { t } = useI18n();
  const { state } = props.article;
  const isBusy = props.pendingAction !== null;

  return (
    <div
      className={classNames(
        styles.readerActions,
        props.placement === "top" ? styles.readerActionsTop : null,
        props.placement === "bottom" ? styles.readerActionsBottom : null,
        props.hidden ? styles.readerActionsHidden : null
      )}
      aria-label={t.actions.aria.group}
      aria-live="polite"
    >
      <div className={styles.actionButtonRow}>
        <ActionButton
          ariaLabel={state.favorited ? t.actions.aria.unfavorite : t.actions.aria.favorite}
          busy={props.pendingAction === "favorite"}
          disabled={isBusy}
          icon={state.favorited ? "starFilled" : "star"}
          label={state.favorited ? t.actions.unfavorite : t.actions.favorite}
          onClick={() => props.onAction("favorite")}
          selected={state.favorited}
        />
        <ActionButton
          ariaLabel={state.liked ? t.actions.aria.unlike : t.actions.aria.like}
          busy={props.pendingAction === "like"}
          disabled={isBusy}
          icon="like"
          label={state.liked ? t.actions.unlike : t.actions.like}
          onClick={() => props.onAction("like")}
          selected={state.liked}
        />
        <ActionButton
          ariaLabel={
            state.readLater ? t.actions.aria.removeReadLater : t.actions.aria.readLater
          }
          busy={props.pendingAction === "readLater"}
          disabled={isBusy}
          icon="bookmark"
          label={state.readLater ? t.actions.removeReadLater : t.actions.readLater}
          onClick={() => props.onAction("readLater")}
          selected={state.readLater}
        />
        <ActionButton
          ariaLabel={
            state.notInterested
              ? t.actions.aria.notInterestedActive
              : t.actions.aria.notInterested
          }
          busy={props.pendingAction === "notInterested"}
          danger
          disabled={isBusy || state.notInterested}
          icon="dismiss"
          label={
            state.notInterested ? t.actions.notInterestedActive : t.actions.notInterested
          }
          onClick={() => props.onAction("notInterested")}
          selected={state.notInterested}
        />
        {props.canExplain && props.onExplain ? (
          <button
            aria-label={t.explanation.title}
            className={classNames(styles.actionButton, styles.actionExplain)}
            onClick={props.onExplain}
            title={t.explanation.title}
            type="button"
          >
            <ActionIcon name="sparkle" />
          </button>
        ) : null}
      </div>
      {props.actionError ? <p className={styles.actionError}>{props.actionError}</p> : null}
    </div>
  );
}

export function RankExplanationPanel(props: {
  error: string | null;
  explanation: RankExplanation | null;
  idleMessage?: string | null;
  isLoading: boolean;
}) {
  const { t, formatDate } = useI18n();

  return (
    <section
      className={classNames(styles.explanationBox, styles.explanationInlineCard)}
      aria-labelledby="rank-explanation-title"
    >
      <div className={styles.explanationHeader}>
        <h3 id="rank-explanation-title">
          <ActionIcon name="sparkle" /> {t.explanation.title}
        </h3>
        {props.explanation ? (
          <span>{t.explanation.generatedAt(formatDate(props.explanation.generatedAt))}</span>
        ) : null}
      </div>

      {props.isLoading ? <p className={styles.explanationMeta}>{t.explanation.loading}</p> : null}
      {!props.isLoading && props.error ? (
        <p className={styles.explanationError}>{props.error}</p>
      ) : null}
      {!props.isLoading && !props.error && props.explanation ? (
        props.explanation.reasons.length > 0 ? (
          <ul className={styles.explanationList}>
            {props.explanation.reasons.map((reason, index) => (
              <li className={styles.explanationReason} key={`${reason.type}-${index}`}>
                <span className={styles.explanationType}>
                  {t.explanation.types[reason.type]}
                </span>
                <span>{explanationReasonText(reason, t)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.explanationMeta}>{t.explanation.empty}</p>
        )
      ) : null}
      {!props.isLoading && !props.error && !props.explanation && props.idleMessage ? (
        <p className={styles.explanationMeta}>{props.idleMessage}</p>
      ) : null}
    </section>
  );
}

export function ArticleExplanationEntry(props: {
  articleView: ArticleView;
  error: string | null;
  explanation: RankExplanation | null;
  isOpen: boolean;
  isLoading: boolean;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();

  if (!shouldLoadRankExplanation(props.articleView)) {
    return (
      <section className={styles.sortExplanationCard} aria-label={t.explanation.sortLabel}>
        <div>
          <h3>{t.explanation.sortTitle}</h3>
          <p>{sortExplanationForView(props.articleView, t)}</p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className={styles.reasonInline} aria-label={t.explanation.title}>
        <RankExplanationPanel
          error={props.error}
          explanation={props.explanation}
          idleMessage={t.explanation.lazy}
          isLoading={props.isLoading}
        />
      </section>

      <button
        className={styles.mobileExplainAnchor}
        onClick={props.onOpen}
        type="button"
        aria-label={t.explanation.open}
        title={t.explanation.open}
      >
        <ActionIcon name="sparkle" />
        <span>{t.explanation.title}</span>
      </button>

      <ArticleExplanationDialog
        error={props.error}
        explanation={props.explanation}
        isLoading={props.isLoading}
        isOpen={props.isOpen}
        onClose={props.onClose}
      />
    </>
  );
}

function ArticleExplanationDialog(props: {
  error: string | null;
  explanation: RankExplanation | null;
  isLoading: boolean;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();

  if (!props.isOpen) {
    return null;
  }

  return (
    <div
      className={styles.explanationOverlay}
      onClick={props.onClose}
      role="presentation"
    >
      <div
        className={styles.explanationPopover}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rank-explanation-title"
      >
        <div className={styles.sheetHandle} aria-hidden="true" />
        <RankExplanationPanel
          error={props.error}
          explanation={props.explanation}
          isLoading={props.isLoading}
        />
        <div className={styles.overlayActions}>
          <button className={styles.secondaryButton} onClick={props.onClose} type="button">
            {t.common.close}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionButton(props: {
  ariaLabel: string;
  busy: boolean;
  danger?: boolean;
  disabled: boolean;
  icon: ActionIconName;
  label: string;
  onClick: () => void;
  selected: boolean;
}) {
  const className = props.danger
    ? styles.actionButtonDanger
    : props.selected
      ? styles.actionButtonSelected
      : styles.actionButton;

  return (
    <button
      aria-busy={props.busy}
      aria-label={props.ariaLabel}
      aria-pressed={props.selected}
      className={className}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.label}
      type="button"
    >
      {props.busy ? <span aria-hidden="true">...</span> : <ActionIcon name={props.icon} />}
    </button>
  );
}

type ActionIconName =
  | "bookmark"
  | "dismiss"
  | "feed"
  | "gear"
  | "like"
  | "more"
  | "search"
  | "sparkle"
  | "star"
  | "starFilled";

function NavigationIcon(props: { item: NavigationItemKey }) {
  const iconByItem: Record<NavigationItemKey, ActionIconName> = {
    latest: "feed",
    recommended: "sparkle",
    favorites: "star",
    read_later: "bookmark",
    search: "search",
    feeds: "feed",
    settings: "gear"
  };

  return <ActionIcon name={iconByItem[props.item]} />;
}

function ActionIcon(props: { name: ActionIconName }) {
  if (props.name === "sparkle") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
        <path d="m12 3 1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3Z" fill="currentColor" />
        <path d="m19 15 .7 2.1 2.1.7-2.1.7L19 21l-.7-2.5-2.1-.7 2.1-.7L19 15Z" fill="currentColor" />
      </svg>
    );
  }

  if (props.name === "star" || props.name === "starFilled") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
        <path
          d="m12 4 2.35 4.76 5.25.76-3.8 3.7.9 5.23L12 16l-4.7 2.45.9-5.23-3.8-3.7 5.25-.76L12 4Z"
          fill={props.name === "starFilled" ? "currentColor" : "none"}
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      </svg>
    );
  }

  if (props.name === "like") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
        <path d="M7 10v10H4V10h3Zm4.2-6L9 10v10h8.8l2.2-8.2A2 2 0 0 0 18.1 9H14l.6-3.4A1.7 1.7 0 0 0 11.2 4Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      </svg>
    );
  }

  if (props.name === "bookmark") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
        <path d="M7 4h10v16l-5-3-5 3V4Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      </svg>
    );
  }

  if (props.name === "dismiss") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
        <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (props.name === "search") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
        <path d="M10.8 17.2a6.4 6.4 0 1 1 0-12.8 6.4 6.4 0 0 1 0 12.8Zm4.7-1.7L20 20" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (props.name === "gear") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
        <path d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="M4.8 13.4v-2.8l2-.7.7-1.6-.9-1.9 2-2 1.9.9 1.5-.6.8-2h2.8l.8 2 1.5.6 1.9-.9 2 2-.9 1.9.7 1.6 2 .7v2.8l-2 .7-.7 1.6.9 1.9-2 2-1.9-.9-1.5.6-.8 2h-2.8l-.8-2-1.5-.6-1.9.9-2-2 .9-1.9-.7-1.6-2-.7Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2" />
      </svg>
    );
  }

  if (props.name === "more") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
        <path d="M5 12h.01M12 12h.01M19 12h.01" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18">
      <path d="M5 5h10a4 4 0 0 1 4 4v10H9a4 4 0 0 1-4-4V5Z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M8 9h7M8 13h5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <div className={styles.emptyState}>
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </div>
  );
}

function SkeletonRows(props: { count: number }) {
  return (
    <div className={styles.skeletonStack} aria-hidden="true">
      {Array.from({ length: props.count }).map((_, index) => (
        <span className={styles.skeletonRow} key={index} />
      ))}
    </div>
  );
}

function ReaderSkeleton() {
  return (
    <div className={styles.readerSkeleton} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function useReaderActionVisibility(
  scrollContainerRef: RefObject<HTMLElement | null>,
  articleId: string | null
): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const element = scrollContainerRef.current;
    if (!element || !articleId) {
      return;
    }
    const scrollElement: HTMLElement = element;

    let lastScrollTop = scrollElement.scrollTop;
    function handleScroll() {
      const nextScrollTop = scrollElement.scrollTop;
      const delta = nextScrollTop - lastScrollTop;
      const nearTop = nextScrollTop < 72;
      const nearBottom =
        scrollElement.scrollHeight - scrollElement.clientHeight - nextScrollTop < 160;

      if (nearTop || nearBottom || delta < -8) {
        setVisible(true);
      } else if (delta > 12 && nextScrollTop > 96) {
        setVisible(false);
      }

      lastScrollTop = nextScrollTop;
    }

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [articleId, scrollContainerRef]);

  return visible;
}

const readProgressThresholds = [0.25, 0.5, 0.75, 0.9] as const;
const readProgressMinIntervalMs = 5_000;

type ReadProgressThreshold = (typeof readProgressThresholds)[number];

type ReadProgressSession = {
  activeDurationMs: number;
  activeSince: number | null;
  articleId: string;
  highestReached: ReadProgressThreshold | null;
  lastSentAt: number | null;
  pendingProgress: ReadProgressThreshold | null;
  sentThresholds: Set<ReadProgressThreshold>;
  startedAt: number;
  throttleTimer: number | null;
};

function useReaderReadProgress(props: {
  article: ArticleDetail | null;
  onReadProgress: (
    articleId: string,
    progress: number,
    metadata: ReadProgressMetadata,
    options?: ReadProgressPostOptions
  ) => void;
  scrollContainerRef: RefObject<HTMLElement | null>;
}) {
  const onReadProgressRef = useRef(props.onReadProgress);

  useEffect(() => {
    onReadProgressRef.current = props.onReadProgress;
  }, [props.onReadProgress]);

  useEffect(() => {
    const article = props.article;
    const container = props.scrollContainerRef.current;
    if (!article || !container) {
      return;
    }
    const scrollContainer = container;

    const now = Date.now();
    const session: ReadProgressSession = {
      activeDurationMs: 0,
      activeSince: isReaderTimingActive() ? now : null,
      articleId: article.id,
      highestReached: thresholdForProgress(article.state.readingProgress),
      lastSentAt: null,
      pendingProgress: null,
      sentThresholds: sentThresholdsForProgress(article.state.readingProgress),
      startedAt: now,
      throttleTimer: null
    };

    scrollContainer.scrollTop = 0;

    function handleScroll() {
      updateReadProgressActiveDuration(session);
      const progress = progressForScrollContainer(scrollContainer);
      const threshold = thresholdForProgress(progress);
      if (threshold) {
        session.highestReached = maxThreshold(session.highestReached, threshold);
        queueReadProgress(session, threshold, false, onReadProgressRef.current);
      }
    }

    function handleFocusChange() {
      updateReadProgressActiveDuration(session);
    }

    function handleVisibilityChange() {
      updateReadProgressActiveDuration(session);
      if (document.visibilityState === "hidden") {
        flushReadProgress(session, true, onReadProgressRef.current);
      }
    }

    function handlePageHide() {
      updateReadProgressActiveDuration(session);
      flushReadProgress(session, true, onReadProgressRef.current);
    }

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("focus", handleFocusChange);
    window.addEventListener("blur", handleFocusChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      window.removeEventListener("focus", handleFocusChange);
      window.removeEventListener("blur", handleFocusChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      updateReadProgressActiveDuration(session);
      flushReadProgress(session, true, onReadProgressRef.current);
      clearReadProgressTimer(session);
    };
  }, [props.article?.id, props.scrollContainerRef]);
}

function progressForScrollContainer(container: HTMLElement): number {
  if (container.scrollHeight <= container.clientHeight) {
    return 1;
  }

  return clampNumber(
    (container.scrollTop + container.clientHeight) / container.scrollHeight,
    0,
    1
  );
}

function sentThresholdsForProgress(progress: number): Set<ReadProgressThreshold> {
  return new Set(readProgressThresholds.filter((threshold) => progress >= threshold));
}

function thresholdForProgress(progress: number): ReadProgressThreshold | null {
  let matched: ReadProgressThreshold | null = null;
  for (const threshold of readProgressThresholds) {
    if (progress >= threshold) {
      matched = threshold;
    }
  }
  return matched;
}

function maxThreshold(
  left: ReadProgressThreshold | null,
  right: ReadProgressThreshold
): ReadProgressThreshold {
  return left === null || right > left ? right : left;
}

function queueReadProgress(
  session: ReadProgressSession,
  progress: ReadProgressThreshold,
  keepalive: boolean,
  onReadProgress: (
    articleId: string,
    progress: number,
    metadata: ReadProgressMetadata,
    options?: ReadProgressPostOptions
  ) => void
): void {
  if (session.sentThresholds.has(progress)) {
    return;
  }

  const now = Date.now();
  if (
    session.lastSentAt !== null &&
    now - session.lastSentAt < readProgressMinIntervalMs &&
    !keepalive
  ) {
    session.pendingProgress = maxThreshold(session.pendingProgress, progress);
    schedulePendingReadProgress(session, onReadProgress);
    return;
  }

  sendReadProgress(session, progress, keepalive, onReadProgress);
}

function schedulePendingReadProgress(
  session: ReadProgressSession,
  onReadProgress: (
    articleId: string,
    progress: number,
    metadata: ReadProgressMetadata,
    options?: ReadProgressPostOptions
  ) => void
): void {
  if (session.throttleTimer || session.lastSentAt === null) {
    return;
  }

  const remaining = Math.max(0, readProgressMinIntervalMs - (Date.now() - session.lastSentAt));
  session.throttleTimer = window.setTimeout(() => {
    session.throttleTimer = null;
    const pending = session.pendingProgress;
    if (pending) {
      sendReadProgress(session, pending, false, onReadProgress);
    }
  }, remaining);
}

function flushReadProgress(
  session: ReadProgressSession,
  keepalive: boolean,
  onReadProgress: (
    articleId: string,
    progress: number,
    metadata: ReadProgressMetadata,
    options?: ReadProgressPostOptions
  ) => void
): void {
  const progress =
    session.pendingProgress ??
    session.highestReached ??
    thresholdForProgress(session.sentThresholds.size > 0 ? Math.max(...session.sentThresholds) : 0);

  if (progress && !session.sentThresholds.has(progress)) {
    sendReadProgress(session, progress, keepalive, onReadProgress);
  }
}

function sendReadProgress(
  session: ReadProgressSession,
  progress: ReadProgressThreshold,
  keepalive: boolean,
  onReadProgress: (
    articleId: string,
    progress: number,
    metadata: ReadProgressMetadata,
    options?: ReadProgressPostOptions
  ) => void
): void {
  const now = Date.now();
  updateReadProgressActiveDuration(session, now);
  session.lastSentAt = now;
  session.pendingProgress = null;
  markSentThresholds(session, progress);
  onReadProgress(session.articleId, progress, readProgressMetadata(session, now), {
    keepalive
  });
}

function markSentThresholds(session: ReadProgressSession, progress: ReadProgressThreshold): void {
  for (const threshold of readProgressThresholds) {
    if (threshold <= progress) {
      session.sentThresholds.add(threshold);
    }
  }
}

function readProgressMetadata(session: ReadProgressSession, now: number): ReadProgressMetadata {
  return {
    durationMs: Math.max(0, now - session.startedAt),
    activeDurationMs: Math.max(0, activeDurationFor(session, now)),
    scrollSource: "reader"
  };
}

function activeDurationFor(session: ReadProgressSession, now: number): number {
  return session.activeDurationMs + (session.activeSince === null ? 0 : now - session.activeSince);
}

function updateReadProgressActiveDuration(
  session: ReadProgressSession,
  now = Date.now()
): void {
  const isActive = isReaderTimingActive();

  if (session.activeSince !== null && !isActive) {
    session.activeDurationMs += now - session.activeSince;
    session.activeSince = null;
    return;
  }

  if (session.activeSince === null && isActive) {
    session.activeSince = now;
  }
}

function isReaderTimingActive(): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    (typeof document.hasFocus !== "function" || document.hasFocus())
  );
}

function clearReadProgressTimer(session: ReadProgressSession): void {
  if (session.throttleTimer) {
    window.clearTimeout(session.throttleTimer);
    session.throttleTimer = null;
  }
}

function draftForSettings(settings: AppSettings): SettingsDraft {
  return {
    locale: settings.ui.locale,
    defaultHomeView: settings.ui.defaultHomeView,
    markScrolledArticlesIgnored: settings.behavior.markScrolledArticlesIgnored,
    removeReadLaterOnReadComplete: settings.behavior.removeReadLaterOnReadComplete,
    telemetryEnabled: settings.telemetry.enabled,
    fontSize: String(settings.reader.fontSize),
    lineHeight: String(settings.reader.lineHeight),
    paragraphGap: String(settings.reader.paragraphGap),
    readerWidth: String(settings.reader.readerWidth),
    retentionDays: String(settings.retention.retentionDays),
    keepFavorites: settings.retention.keepFavorites,
    keepReadLater: settings.retention.keepReadLater,
    cocoonLevel: String(settings.ranking.cocoonLevel),
    maxPositiveInterestClusters: String(settings.ranking.maxPositiveInterestClusters),
    maxNegativeInterestClusters: String(settings.ranking.maxNegativeInterestClusters),
    maxPositiveInterestFamilies: String(settings.ranking.maxPositiveInterestFamilies),
    maxNegativeInterestFamilies: String(settings.ranking.maxNegativeInterestFamilies)
  };
}

function presetIndexForInterestClusterLimits(
  ranking: Pick<
    AppSettings["ranking"],
    | "maxPositiveInterestClusters"
    | "maxNegativeInterestClusters"
    | "maxPositiveInterestFamilies"
    | "maxNegativeInterestFamilies"
  >
): number | null {
  const index = interestClusterLimitPresets.findIndex(
    (preset) =>
      preset.maxPositiveInterestClusters === ranking.maxPositiveInterestClusters &&
      preset.maxNegativeInterestClusters === ranking.maxNegativeInterestClusters &&
      preset.maxPositiveInterestFamilies === ranking.maxPositiveInterestFamilies &&
      preset.maxNegativeInterestFamilies === ranking.maxNegativeInterestFamilies
  );
  return index >= 0 ? index : null;
}

function presetIndexForInterestClusterLimitDraft(draft: SettingsDraft): number | null {
  const maxPositiveInterestClusters = Number(draft.maxPositiveInterestClusters);
  const maxNegativeInterestClusters = Number(draft.maxNegativeInterestClusters);
  const maxPositiveInterestFamilies = Number(draft.maxPositiveInterestFamilies);
  const maxNegativeInterestFamilies = Number(draft.maxNegativeInterestFamilies);
  if (
    !Number.isInteger(maxPositiveInterestClusters) ||
    !Number.isInteger(maxNegativeInterestClusters) ||
    !Number.isInteger(maxPositiveInterestFamilies) ||
    !Number.isInteger(maxNegativeInterestFamilies)
  ) {
    return null;
  }
  return presetIndexForInterestClusterLimits({
    maxPositiveInterestClusters,
    maxNegativeInterestClusters,
    maxPositiveInterestFamilies,
    maxNegativeInterestFamilies
  });
}

function interestClusterPresetIndexFromSliderValue(value: string): 0 | 1 | 2 {
  if (value === "2") {
    return 2;
  }
  if (value === "1") {
    return 1;
  }
  return 0;
}

function closestInterestClusterPresetIndex(
  ranking: Pick<
    AppSettings["ranking"],
    | "maxPositiveInterestClusters"
    | "maxNegativeInterestClusters"
    | "maxPositiveInterestFamilies"
    | "maxNegativeInterestFamilies"
  >
): number {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  interestClusterLimitPresets.forEach((preset, index) => {
    const distance =
      Math.abs(preset.maxPositiveInterestClusters - ranking.maxPositiveInterestClusters) +
      Math.abs(preset.maxNegativeInterestClusters - ranking.maxNegativeInterestClusters) +
      Math.abs(preset.maxPositiveInterestFamilies - ranking.maxPositiveInterestFamilies) +
      Math.abs(preset.maxNegativeInterestFamilies - ranking.maxNegativeInterestFamilies);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  });
  return closestIndex;
}

function draftForEmbeddingProvider(provider: EmbeddingProvider | null): EmbeddingProviderDraft {
  const supportedType = supportedProviderType(provider?.type);
  const defaults = defaultEmbeddingProviderDraft(supportedType);
  return {
    providerId: provider?.id ?? newEmbeddingProviderId,
    type: supportedType,
    name: provider?.name ?? defaults.name,
    baseUrl: provider?.baseUrl ?? defaults.baseUrl,
    model: provider?.model ?? defaults.model,
    dimension: String(provider?.dimension ?? defaults.dimension),
    textMaxChars: String(provider?.textMaxChars ?? defaults.textMaxChars),
    requestsPerMinute: provider?.requestsPerMinute === null || provider?.requestsPerMinute === undefined
      ? ""
      : String(provider.requestsPerMinute),
    requestsPerDay: provider?.requestsPerDay === null || provider?.requestsPerDay === undefined
      ? ""
      : String(provider.requestsPerDay),
    apiKey: "",
    enabled: provider?.enabled ?? false,
    qualityTier: provider?.qualityTier ?? "recommended"
  };
}

function draftWithProviderType(
  draft: EmbeddingProviderDraft,
  type: SupportedEmbeddingProviderType
): EmbeddingProviderDraft {
  const defaults = defaultEmbeddingProviderDraft(type);
  const previousDefaults = defaultEmbeddingProviderDraft(draft.type);

  return {
    ...draft,
    type,
    name:
      draft.name === previousDefaults.name || draft.name.trim() === ""
        ? defaults.name
        : draft.name,
    baseUrl:
      draft.baseUrl === previousDefaults.baseUrl || draft.baseUrl.trim() === ""
        ? defaults.baseUrl
        : draft.baseUrl,
    model:
      draft.model === previousDefaults.model || draft.model.trim() === ""
        ? defaults.model
        : draft.model,
    dimension:
      draft.dimension === String(previousDefaults.dimension) || draft.dimension.trim() === ""
        ? String(defaults.dimension)
        : draft.dimension,
    textMaxChars:
      draft.textMaxChars === String(previousDefaults.textMaxChars) ||
      draft.textMaxChars.trim() === ""
        ? String(defaults.textMaxChars)
        : draft.textMaxChars,
    apiKey: type === "ollama" ? "" : draft.apiKey
  };
}

function embeddingProviderDraftMatchesProvider(
  draft: EmbeddingProviderDraft,
  provider: EmbeddingProvider
): boolean {
  return (
    draft.providerId === provider.id &&
    draft.type === supportedProviderType(provider.type) &&
    draft.name.trim() === provider.name &&
    draft.baseUrl.trim() === provider.baseUrl &&
    draft.model.trim() === provider.model &&
    Number(draft.dimension) === provider.dimension &&
    Number(draft.textMaxChars) === provider.textMaxChars &&
    optionalNumberDraftMatches(draft.requestsPerMinute, provider.requestsPerMinute) &&
    optionalNumberDraftMatches(draft.requestsPerDay, provider.requestsPerDay) &&
    draft.apiKey.trim() === "" &&
    draft.qualityTier === provider.qualityTier
  );
}

function optionalNumberDraftMatches(
  draft: string,
  value: number | null | undefined
): boolean {
  if (draft.trim() === "") {
    return value === null || value === undefined;
  }

  return Number(draft) === value;
}

function defaultEmbeddingProviderDraft(type: SupportedEmbeddingProviderType) {
  if (type === "ollama") {
    return {
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimension: 768,
      textMaxChars: 8000
    };
  }

  if (type === "gemini") {
    return {
      name: "Gemini AI Studio",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-embedding-001",
      dimension: 3072,
      textMaxChars: 8000
    };
  }

  return {
    name: "OpenAI Compatible",
    baseUrl: "",
    model: "text-embedding-3-small",
    dimension: 1536,
    textMaxChars: 8000
  };
}

function supportedProviderType(
  type: EmbeddingProviderType | undefined
): SupportedEmbeddingProviderType {
  return type === "ollama" || type === "gemini" ? type : "openai_compatible";
}

function providerRecommendationReadmeUrl(locale: Locale): string {
  if (locale === "en-US") {
    return "https://github.com/Pls-1q43/Dibao/tree/main?tab=readme-ov-file#%E6%8E%A8%E8%8D%90-provider";
  }

  if (locale === "ja-JP") {
    return "https://github.com/Pls-1q43/Dibao/blob/main/README.ja.md";
  }

  return "https://github.com/Pls-1q43/Dibao/tree/main?tab=readme-ov-file#%E6%8E%A8%E8%8D%90-provider";
}

function parseSettingsDraft(
  draft: SettingsDraft,
  current: AppSettings,
  t: Dictionary
):
  | { ok: true; input: UpdateSettingsInput; settings: AppSettings }
  | { ok: false; error: string } {
  const fontSize = parseNumberDraft(draft.fontSize, 16, 24, true);
  if (fontSize === null) {
    return { ok: false, error: t.settings.errors.fontSize };
  }

  const lineHeight = parseNumberDraft(draft.lineHeight, 1.45, 2.1);
  if (lineHeight === null) {
    return { ok: false, error: t.settings.errors.lineHeight };
  }

  const paragraphGap = parseNumberDraft(draft.paragraphGap, 0.6, 1.6);
  if (paragraphGap === null) {
    return { ok: false, error: t.settings.errors.paragraphGap };
  }

  const readerWidth = parseNumberDraft(draft.readerWidth, 560, 860, true);
  if (readerWidth === null) {
    return { ok: false, error: t.settings.errors.readerWidth };
  }

  const retentionDays = parseNumberDraft(draft.retentionDays, 0, 3650, true);
  if (retentionDays === null) {
    return { ok: false, error: t.settings.errors.retentionDays };
  }
  const cocoonLevel = parseNumberDraft(draft.cocoonLevel, 1, 10, true);
  if (cocoonLevel === null) {
    return { ok: false, error: t.settings.errors.cocoonLevel };
  }
  const maxPositiveInterestClusters = parseNumberDraft(
    draft.maxPositiveInterestClusters,
    8,
    192,
    true
  );
  if (maxPositiveInterestClusters === null) {
    return { ok: false, error: t.settings.errors.maxPositiveInterestClusters };
  }
  const maxNegativeInterestClusters = parseNumberDraft(
    draft.maxNegativeInterestClusters,
    4,
    128,
    true
  );
  if (maxNegativeInterestClusters === null) {
    return { ok: false, error: t.settings.errors.maxNegativeInterestClusters };
  }
  const maxPositiveInterestFamilies = parseNumberDraft(
    draft.maxPositiveInterestFamilies,
    2,
    64,
    true
  );
  if (maxPositiveInterestFamilies === null) {
    return { ok: false, error: t.settings.errors.maxPositiveInterestFamilies };
  }
  const maxNegativeInterestFamilies = parseNumberDraft(
    draft.maxNegativeInterestFamilies,
    1,
    48,
    true
  );
  if (maxNegativeInterestFamilies === null) {
    return { ok: false, error: t.settings.errors.maxNegativeInterestFamilies };
  }

  const settings: AppSettings = {
    ...current,
    ui: {
      locale: draft.locale,
      defaultHomeView: draft.defaultHomeView
    },
    reader: {
      ...current.reader,
      fontSize,
      lineHeight,
      paragraphGap,
      readerWidth
    },
    behavior: {
      ...current.behavior,
      markScrolledArticlesIgnored: draft.markScrolledArticlesIgnored,
      removeReadLaterOnReadComplete: draft.removeReadLaterOnReadComplete
    },
    telemetry: {
      ...current.telemetry,
      enabled: draft.telemetryEnabled
    },
    retention: {
      ...current.retention,
      retentionDays,
      keepFavorites: draft.keepFavorites,
      keepReadLater: draft.keepReadLater
    },
    ranking: {
      ...current.ranking,
      cocoonLevel,
      maxPositiveInterestClusters,
      maxNegativeInterestClusters,
      maxPositiveInterestFamilies,
      maxNegativeInterestFamilies
    }
  };

  return {
    ok: true,
    settings,
    input: {
      ui: {
        locale: draft.locale,
        defaultHomeView: draft.defaultHomeView
      },
      reader: {
        fontSize,
        lineHeight,
        paragraphGap,
        readerWidth
      },
      behavior: {
        markScrolledArticlesIgnored: draft.markScrolledArticlesIgnored,
        removeReadLaterOnReadComplete: draft.removeReadLaterOnReadComplete
      },
      telemetry: {
        enabled: draft.telemetryEnabled
      },
      retention: {
        retentionDays,
        keepFavorites: draft.keepFavorites,
        keepReadLater: draft.keepReadLater
      },
      ranking: {
        cocoonLevel,
        maxPositiveInterestClusters,
        maxNegativeInterestClusters,
        maxPositiveInterestFamilies,
        maxNegativeInterestFamilies
      }
    }
  };
}

function retentionSettingsRequireCleanupConfirmation(
  before: AppSettings["retention"],
  after: AppSettings["retention"]
): boolean {
  if (after.retentionDays === 0) {
    return false;
  }

  return (
    before.retentionDays === 0 ||
    after.retentionDays < before.retentionDays ||
    (before.keepFavorites && !after.keepFavorites) ||
    (before.keepReadLater && !after.keepReadLater)
  );
}

function parseEmbeddingProviderDraft(
  draft: EmbeddingProviderDraft,
  t: Dictionary
):
  | { ok: true; input: CreateEmbeddingProviderInput | UpdateEmbeddingProviderInput }
  | { ok: false; error: string } {
  const name = draft.name.trim();
  if (!name) {
    return { ok: false, error: t.settings.sections.provider.errors.nameRequired };
  }

  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl) {
    return { ok: false, error: t.settings.sections.provider.errors.baseUrlRequired };
  }

  const model = draft.model.trim();
  if (!model) {
    return { ok: false, error: t.settings.sections.provider.errors.modelRequired };
  }

  const dimension = parseNumberDraft(draft.dimension, 1, 20000, true);
  if (dimension === null) {
    return { ok: false, error: t.settings.sections.provider.errors.dimension };
  }
  const textMaxChars = parseNumberDraft(draft.textMaxChars, 1000, 200000, true);
  if (textMaxChars === null) {
    return { ok: false, error: t.settings.sections.provider.errors.textMaxChars };
  }
  const requestsPerMinute = parseOptionalNumberDraft(draft.requestsPerMinute, 1, 1_000_000);
  if (requestsPerMinute === undefined) {
    return { ok: false, error: t.settings.sections.provider.errors.requestsPerMinute };
  }
  const requestsPerDay = parseOptionalNumberDraft(draft.requestsPerDay, 1, 100_000_000);
  if (requestsPerDay === undefined) {
    return { ok: false, error: t.settings.sections.provider.errors.requestsPerDay };
  }

  return {
    ok: true,
    input: {
      type: draft.type,
      name,
      baseUrl,
      model,
      dimension,
      textMaxChars,
      requestsPerMinute,
      requestsPerDay,
      enabled: draft.enabled,
      qualityTier: draft.qualityTier,
      ...(draft.type !== "ollama" && draft.apiKey.trim()
        ? { apiKey: draft.apiKey.trim() }
        : {})
    }
  };
}

function parseNumberDraft(
  value: string,
  min: number,
  max: number,
  integer = false
): number | null {
  if (value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  ) {
    return null;
  }

  return parsed;
}

function parseOptionalNumberDraft(
  value: string,
  min: number,
  max: number
): number | null | undefined {
  if (value.trim() === "") {
    return null;
  }

  const parsed = parseNumberDraft(value, min, max, true);
  return parsed === null ? undefined : parsed;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type ReaderStyle = CSSProperties & {
  "--reader-font-size": string;
  "--reader-line-height": string;
  "--reader-paragraph-gap": string;
  "--reader-width": string;
};

export function readerStyleFor(settings: ReaderSettings): ReaderStyle {
  return {
    "--reader-font-size": `${settings.fontSize}px`,
    "--reader-line-height": String(settings.lineHeight),
    "--reader-paragraph-gap": `${settings.paragraphGap}em`,
    "--reader-width": `${settings.readerWidth}px`
  };
}

function articleQueryFor(source: SourceSelection): { feedId?: string; folderId?: string } {
  if (source.type === "feed") {
    return { feedId: source.feedId };
  }

  if (source.type === "folder") {
    return { folderId: source.folderId };
  }

  return {};
}

function supportsUnreadOnly(view: ArticleView): boolean {
  return view === "latest" || view === "recommended";
}

function supportsQuickFilters(view: ArticleView): boolean {
  return view === "latest" || view === "recommended";
}

function articleSortForView(
  view: ArticleView,
  favoriteSort: FavoriteArticleSort,
  readLaterSort: ReadLaterArticleSort
): FavoriteArticleSort | ReadLaterArticleSort | undefined {
  if (view === "favorites") {
    return favoriteSort;
  }

  if (view === "read_later") {
    return readLaterSort;
  }

  return undefined;
}

function shouldLoadRankExplanation(view: ArticleView): boolean {
  return view === "recommended" || view === "read_later";
}

function shouldLoadDetailRankExplanation(
  page: AppPage,
  view: ArticleView,
  searchSort: ArticleSearchSort
): boolean {
  return page.type === "search"
    ? searchSort === "recommended"
    : shouldLoadRankExplanation(view);
}

function canLoadRankExplanation(page: AppPage, view: ArticleView): boolean {
  return page.type === "search" || shouldLoadRankExplanation(view);
}

function sortExplanationForView(view: ArticleView, t: Dictionary): string {
  switch (view) {
    case "latest":
      return t.explanation.sorting.latest;
    case "favorites":
      return t.explanation.sorting.favorites;
    case "read_later":
      return t.explanation.sorting.read_later;
    case "recommended":
      return t.explanation.sorting.recommended;
  }
}

type UrlState = {
  favoriteSort?: FavoriteArticleSort;
  readLaterSort?: ReadLaterArticleSort;
  timeWindow?: ArticleTimeWindow;
  unreadOnly?: boolean;
};

function routeFromLocation(defaultView: ArticleView): AppRoute {
  if (typeof window === "undefined") {
    return {
      page: { type: "reader", view: defaultView },
      articleId: null,
      hasExplicitPage: false
    };
  }

  const pathname = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const view = parseUrlView(params.get("view"));
  const page = pathname === "/search"
    ? { type: "search" } satisfies AppPage
    : parseUrlPage(params.get("page"), view ?? defaultView, params);
  const articleId =
    page.type === "reader" || page.type === "search" ? params.get("article") : null;
  return {
    page,
    articleId: articleId && articleId.trim() ? articleId : null,
    hasExplicitPage:
      pathname === "/search" || params.has("page") || params.has("view") || params.has("article")
  };
}

function readerFiltersForView(view: ArticleView): PersistedReaderFilters {
  const stored = readPersistedReaderFilters(view);
  return {
    sourceSelection: stored.sourceSelection,
    unreadOnly: urlBooleanParam("unread") || stored.unreadOnly,
    timeWindow: urlTimeWindowParam() ?? stored.timeWindow
  };
}

function persistedReaderFiltersKey(view: ArticleView): string {
  return `dibao:reader-filters:${view}`;
}

function readPersistedReaderFilters(view: ArticleView): PersistedReaderFilters {
  if (typeof window === "undefined" || !supportsQuickFilters(view)) {
    return defaultReaderFilters;
  }

  try {
    const raw = window.localStorage.getItem(persistedReaderFiltersKey(view));
    if (!raw) {
      return defaultReaderFilters;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedReaderFilters>;
    return {
      sourceSelection: parsePersistedSourceSelection(parsed.sourceSelection),
      unreadOnly: parsed.unreadOnly === true,
      timeWindow: parseArticleTimeWindowValue(parsed.timeWindow) ?? "all"
    };
  } catch {
    return defaultReaderFilters;
  }
}

function persistReaderFilters(view: ArticleView, filters: PersistedReaderFilters): void {
  if (typeof window === "undefined" || !supportsQuickFilters(view)) {
    return;
  }

  try {
    window.localStorage.setItem(persistedReaderFiltersKey(view), JSON.stringify(filters));
  } catch {
    // Local storage is a convenience only; browsing must continue if it is unavailable.
  }
}

function parsePersistedSourceSelection(value: unknown): SourceSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: "all" };
  }

  const input = value as Partial<SourceSelection>;
  if (input.type === "feed" && typeof input.feedId === "string") {
    return { type: "feed", feedId: input.feedId };
  }
  if (input.type === "folder" && typeof input.folderId === "string") {
    return { type: "folder", folderId: input.folderId };
  }
  return { type: "all" };
}

function urlForNavigationItem(item: NavigationItemKey, state: UrlState = {}): string {
  const page = pageForNavigationItem(item);
  return page ? urlForAppPage(page, state) : "#";
}

function urlForArticle(articleView: ArticleView, articleId: string, state: UrlState = {}): string {
  const params = paramsForReaderView(articleView, state);
  params.set("article", articleId);
  return `/?${params.toString()}`;
}

function urlForAppPage(page: AppPage, state: UrlState = {}): string {
  if (page.type === "reader") {
    return `/?${paramsForReaderView(page.view, state).toString()}`;
  }

  if (page.type === "search") {
    return urlForSearchPage(defaultSearchForm());
  }

  const params = new URLSearchParams();
  params.set("page", page.type);
  if (page.type === "full-content-preview") {
    params.set("feedId", page.feedId);
  }
  return `/?${params.toString()}`;
}

function urlForSearchPage(form: SearchFormState, articleId?: string): string {
  const params = paramsForSearchForm(form);
  if (articleId) {
    params.set("article", articleId);
  }
  const query = params.toString();
  return query ? `/search?${query}` : "/search";
}

function paramsForSearchForm(form: SearchFormState): URLSearchParams {
  const params = new URLSearchParams();
  if (form.q.trim()) {
    params.set("q", form.q.trim());
  }
  if (form.sort !== "relevance") {
    params.set("sort", form.sort);
  }
  if (form.state !== "all") {
    params.set("state", form.state);
  }
  if (form.sourceSelection.type === "feed") {
    params.set("feedId", form.sourceSelection.feedId);
  }
  if (form.sourceSelection.type === "folder") {
    params.set("folderId", form.sourceSelection.folderId);
  }
  if (form.from) {
    params.set("from", form.from);
  }
  if (form.to) {
    params.set("to", form.to);
  }
  return params;
}

function paramsForReaderView(view: ArticleView, state: UrlState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("view", view);
  if (view === "favorites" && state.favoriteSort && state.favoriteSort !== defaultFavoriteArticleSort) {
    params.set("sort", state.favoriteSort);
  }
  if (view === "read_later" && state.readLaterSort && state.readLaterSort !== defaultReadLaterArticleSort) {
    params.set("sort", state.readLaterSort);
  }
  if (supportsQuickFilters(view) && state.timeWindow && state.timeWindow !== "all") {
    params.set("time", state.timeWindow);
  }
  if (supportsUnreadOnly(view) && state.unreadOnly) {
    params.set("unread", "1");
  }
  return params;
}

function parseUrlPage(
  value: string | null,
  view: ArticleView,
  params: URLSearchParams = new URLSearchParams()
): AppPage {
  switch (value) {
    case "search":
      return { type: "search" };
    case "feeds":
    case "feed-management":
      return { type: "feed-management" };
    case "full-content-preview":
      return { type: "full-content-preview", feedId: params.get("feedId") ?? "" };
    case "settings":
      return { type: "settings" };
    case "algorithm":
    case "algorithm-transparency":
      return { type: "algorithm-transparency" };
    case "algorithm-clusters":
      return { type: "algorithm-clusters" };
    default:
      return { type: "reader", view };
  }
}

function defaultSearchForm(): SearchFormState {
  return {
    q: "",
    sourceSelection: { type: "all" },
    state: "all",
    sort: "relevance",
    from: "",
    to: ""
  };
}

function searchFormFromLocation(): SearchFormState {
  if (typeof window === "undefined") {
    return defaultSearchForm();
  }

  const params = new URLSearchParams(window.location.search);
  const feedId = params.get("feedId");
  const folderId = params.get("folderId");
  return {
    q: params.get("q") ?? "",
    sourceSelection: feedId
      ? { type: "feed", feedId }
      : folderId
        ? { type: "folder", folderId }
        : { type: "all" },
    state: parseArticleSearchStateValue(params.get("state")) ?? "all",
    sort: parseArticleSearchSortValue(params.get("sort")) ?? "relevance",
    from: params.get("from") ?? "",
    to: params.get("to") ?? ""
  };
}

function parseArticleSearchStateValue(value: unknown): ArticleSearchState | null {
  return value === "all" ||
    value === "unread" ||
    value === "read" ||
    value === "favorites" ||
    value === "read_later"
    ? value
    : null;
}

function parseArticleSearchSortValue(value: unknown): ArticleSearchSort | null {
  return value === "relevance" || value === "recommended" || value === "latest"
    ? value
    : null;
}

function parseUrlView(value: string | null): ArticleView | null {
  return value === "latest" ||
    value === "recommended" ||
    value === "favorites" ||
    value === "read_later"
    ? value
    : null;
}

function urlBooleanParam(name: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const value = new URLSearchParams(window.location.search).get(name);
  return value === "1" || value === "true";
}

function urlTimeWindowParam(): ArticleTimeWindow | null {
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  return parseArticleTimeWindowValue(params.get("time")) ?? (urlBooleanParam("today") ? "24h" : null);
}

function parseArticleTimeWindowValue(value: unknown): ArticleTimeWindow | null {
  return value === "all" || value === "24h" || value === "7d" || value === "30d"
    ? value
    : null;
}

function urlFavoriteSortParam(): FavoriteArticleSort | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get("sort");
  return value === "favorited_desc" ||
    value === "favorited_asc" ||
    value === "published_desc" ||
    value === "published_asc"
    ? value
    : null;
}

function urlReadLaterSortParam(): ReadLaterArticleSort | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get("sort");
  return value === "ranked" ||
    value === "read_later_desc" ||
    value === "read_later_asc" ||
    value === "published_desc" ||
    value === "published_asc"
    ? value
    : null;
}

function shouldLetBrowserHandleLinkClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

function classNames(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

function rememberArticleStates(
  articles: Pick<ArticleListItem, "id" | "state">[],
  target: Map<string, ArticleState>
): void {
  for (const article of articles) {
    target.set(article.id, article.state);
  }
}

function sameSourceSelection(left: SourceSelection, right: SourceSelection): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "feed" && right.type === "feed") {
    return left.feedId === right.feedId;
  }

  if (left.type === "folder" && right.type === "folder") {
    return left.folderId === right.folderId;
  }

  return true;
}

function appendUniqueArticles(
  current: ArticleListItem[],
  next: ArticleListItem[]
): ArticleListItem[] {
  const seen = new Set(current.map((article) => article.id));
  return [
    ...current,
    ...next.filter((article) => {
      if (seen.has(article.id)) {
        return false;
      }
      seen.add(article.id);
      return true;
    })
  ];
}

function countFeedsByFolder(feeds: Feed[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const feed of feeds) {
    if (feed.folderId) {
      counts.set(feed.folderId, (counts.get(feed.folderId) ?? 0) + 1);
    }
  }

  return counts;
}

export function pageForNavigationItem(item: NavigationItemKey): AppPage | null {
  if (
    item === "latest" ||
    item === "recommended" ||
    item === "favorites" ||
    item === "read_later"
  ) {
    return { type: "reader", view: item };
  }

  if (item === "feeds") {
    return { type: "feed-management" };
  }

  if (item === "search") {
    return { type: "search" };
  }

  if (item === "settings") {
    return { type: "settings" };
  }

  return null;
}

function isNavigationItemActive(item: NavigationItemKey, page: AppPage): boolean {
  if (page.type === "reader") {
    return item === page.view;
  }

  if (page.type === "feed-management") {
    return item === "feeds";
  }

  if (page.type === "search") {
    return item === "search";
  }

  if (page.type === "algorithm-transparency" || page.type === "algorithm-clusters") {
    return item === "settings";
  }

  return item === "settings";
}

function isUtilityNavigationActive(page: AppPage): boolean {
  return (
    page.type === "feed-management" ||
    page.type === "search" ||
    page.type === "settings" ||
    page.type === "algorithm-transparency" ||
    page.type === "algorithm-clusters"
  );
}

function noticeTextFor(notice: Notice, t: Dictionary): string {
  switch (notice.type) {
    case "feedAddedAndRefreshed":
      return t.notices.feedAddedAndRefreshed(notice.feedTitle);
    case "feedRefreshed":
      return t.notices.feedRefreshed(notice.feedTitle);
    case "allFeedsRefreshQueued":
      return t.notices.allFeedsRefreshQueued(notice.jobCount);
    case "opmlImported":
      return t.notices.opmlImported(
        notice.result.feedsCreated,
        notice.result.feedsSkipped,
        notice.result.foldersCreated
      );
    case "opmlExported":
      return t.notices.opmlExported;
    case "settingsSaved":
      return t.settings.notices.saved;
    case "embeddingProviderSaved":
      return t.settings.sections.provider.notices.saved;
    case "embeddingProviderActivated":
      return t.settings.sections.provider.notices.activated;
    case "embeddingProviderTested":
      return t.settings.sections.provider.notices.tested;
    case "embeddingProviderDeleted":
      return t.settings.sections.provider.notices.deleted;
    case "embeddingIndexRebuildQueued":
      return t.settings.sections.provider.notices.rebuildQueued;
    case "embeddingIndexBackfillQueued":
      return t.settings.sections.provider.notices.backfillQueued;
    case "recommendationMaintenanceQueued":
      return t.algorithmTransparency.maintenance.notice(notice.label, notice.existing);
    case "readerCommandMarkScopeRead":
      return notice.count > 0
        ? t.readerCommands.markScopeRead.cleared(notice.count)
        : t.readerCommands.markScopeRead.nothingToClear;
  }
}

function recommendationStatusMetrics(
  status: RecommendationStatus,
  t: Dictionary,
  formatDate: (value: string | Date) => string
): string[] {
  const behaviorCount = Object.values(status.behaviorCounts).reduce((sum, count) => sum + count, 0);
  const coverageRatio =
    typeof status.coverage.coverageRatio === "number"
      ? formatPercent(status.coverage.coverageRatio)
      : t.recommendationStatus.metrics.unknown;
  const lastRanking = status.lastRankingUpdate
    ? formatDate(status.lastRankingUpdate)
    : t.recommendationStatus.metrics.unknown;
  const lastProfile = status.lastProfileUpdate
    ? formatDate(status.lastProfileUpdate)
    : t.recommendationStatus.metrics.unknown;

  return [
    t.recommendationStatus.metrics.behaviorCount(behaviorCount),
    t.recommendationStatus.metrics.coverage(coverageRatio),
    t.recommendationStatus.metrics.clusters(status.clusters.positive, status.clusters.negative),
    t.recommendationStatus.metrics.lastUpdate(lastRanking, lastProfile)
  ];
}

function algorithmStatusClassName(
  status: "normal" | "warning" | "stopped" | "disabled"
): string {
  switch (status) {
    case "normal":
      return styles.algorithmStatusNormal;
    case "warning":
      return styles.algorithmStatusWarning;
    case "stopped":
      return styles.algorithmStatusStopped;
    case "disabled":
      return styles.algorithmStatusDisabled;
  }
}

function embeddingCoverageText(index: EmbeddingIndex, t: Dictionary): string {
  if (
    typeof index.candidateCount !== "number" ||
    typeof index.coveredArticleCount !== "number" ||
    typeof index.coverageRatio !== "number"
  ) {
    return t.settings.sections.provider.coverageUnavailable;
  }

  return t.settings.sections.provider.coverage(
    index.coveredArticleCount,
    index.candidateCount,
    formatPercent(index.coverageRatio)
  );
}

function formatPercent(value: number): string {
  return `${Math.round(clampNumber(value, 0, 1) * 100)}%`;
}

function formatMaintenanceSchedule(
  maintenance: RecommendationTransparency["transparency"]["maintenance"]
): string {
  const enabled = maintenance.automaticMaintenanceEnabled === false ? "off" : "on";
  const schedule = maintenance.schedule ?? [];
  if (schedule.length === 0) {
    return `${enabled} · no schedule runs recorded`;
  }

  const latest = schedule
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 4)
    .map((item) => {
      const last =
        item.lastCompletedAt ?? item.lastEnqueuedAt ?? item.lastSkippedReason ?? "pending";
      return `${item.taskKey}: ${last}`;
    });
  return `${enabled} · ${latest.join(" · ")}`;
}

type MaintenanceScheduleItem = NonNullable<
  RecommendationTransparency["transparency"]["maintenance"]["schedule"]
>[number];

function formatMaintenanceTaskSchedule(
  schedule: MaintenanceScheduleItem | undefined,
  t: Dictionary
): string {
  if (!schedule) {
    return t.algorithmTransparency.maintenance.neverRun;
  }

  if (schedule.lastSkippedReason) {
    return `${t.algorithmTransparency.maintenance.skipped}: ${schedule.lastSkippedReason}`;
  }

  const last = schedule.lastCompletedAt ?? schedule.lastEnqueuedAt ?? schedule.updatedAt;
  return last ? last : t.algorithmTransparency.maintenance.neverRun;
}

function maintenanceResultWasExisting(result: RecommendationMaintenanceTaskResponse): boolean {
  return "existing" in result ? result.existing : false;
}

function maintenanceTasks(t: Dictionary): Array<{
  key: RecommendationMaintenanceTask;
  scheduleKey: string;
  label: string;
  description: string;
  remoteUse: string;
}> {
  const copy = t.algorithmTransparency.maintenance.tasks;
  return [
    {
      key: "ranking_recalculate",
      scheduleKey: "ranking_recalculate_daily",
      ...copy.ranking_recalculate
    },
    {
      key: "fingerprint_backfill",
      scheduleKey: "duplicate_hourly",
      ...copy.fingerprint_backfill
    },
    {
      key: "duplicate_rebuild",
      scheduleKey: "duplicate_daily",
      ...copy.duplicate_rebuild
    },
    {
      key: "keyword_rebuild",
      scheduleKey: "keyword_profile_daily",
      ...copy.keyword_rebuild
    },
    {
      key: "cluster_label_rebuild",
      scheduleKey: "cluster_label_daily",
      ...copy.cluster_label_rebuild
    },
    {
      key: "cluster_merge_diagnostics",
      scheduleKey: "cluster_merge_diagnostics_daily",
      ...copy.cluster_merge_diagnostics
    },
    {
      key: "interest_family_rebuild",
      scheduleKey: "interest_family_daily",
      ...copy.interest_family_rebuild
    },
    {
      key: "cluster_auto_merge",
      scheduleKey: "cluster_auto_merge_daily",
      ...copy.cluster_auto_merge
    },
    {
      key: "recent_intent_rebuild",
      scheduleKey: "recent_intent_daily",
      ...copy.recent_intent_rebuild
    },
    {
      key: "ftrl_train",
      scheduleKey: "ftrl_train_daily",
      ...copy.ftrl_train
    },
    {
      key: "evaluation",
      scheduleKey: "evaluation_periodic",
      ...copy.evaluation
    },
    {
      key: "ftrl_promote",
      scheduleKey: "ftrl_promote_daily",
      ...copy.ftrl_promote
    },
    {
      key: "ftrl_reset",
      scheduleKey: "ftrl_reset_manual",
      ...copy.ftrl_reset
    }
  ];
}

function plainTextSummary(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function downloadTextFile(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function requestForArticleAction(
  intent: ArticleActionIntent,
  state: ArticleState
): ArticleActionRequest {
  switch (intent) {
    case "favorite":
      return {
        type: "favorite",
        value: !state.favorited
      };
    case "like":
      return {
        type: "like",
        value: !state.liked
      };
    case "readLater":
      return {
        type: "read_later",
        value: !state.readLater
      };
    case "notInterested":
      return {
        type: "not_interested",
        value: true
      };
  }
}

function optimisticStateForArticleAction(
  intent: ArticleActionIntent,
  state: ArticleState
): ArticleState {
  switch (intent) {
    case "favorite":
      return savedOptimisticState({ ...state, favorited: !state.favorited });
    case "like":
      return savedOptimisticState({ ...state, liked: !state.liked });
    case "readLater":
      return savedOptimisticState({ ...state, readLater: !state.readLater });
    case "notInterested":
      return {
        ...state,
        read: false,
        favorited: false,
        liked: false,
        readLater: false,
        hidden: false,
        notInterested: true,
        readingProgress: 0,
        interactionStatus: "ignored",
        ignoredAt: Date.now()
      };
  }
}

function optimisticOpenedState(state: ArticleState): ArticleState {
  if (state.read || state.readingProgress >= 0.9) {
    return { ...state, interactionStatus: "read", openedAt: Date.now(), ignoredAt: null };
  }

  if (state.readingProgress >= 0.25) {
    return { ...state, interactionStatus: "reading", openedAt: Date.now(), ignoredAt: null };
  }

  return { ...state, interactionStatus: "opened", openedAt: Date.now(), ignoredAt: null };
}

function optimisticReadProgressState(state: ArticleState, progress: number): ArticleState {
  const readingProgress = Math.max(state.readingProgress, progress);
  return {
    ...state,
    read: state.read || readingProgress >= 0.9,
    readingProgress,
    openedAt: state.openedAt ?? Date.now(),
    ignoredAt: null,
    interactionStatus:
      state.read || readingProgress >= 0.9
        ? "read"
        : readingProgress >= 0.25
          ? "reading"
          : "opened"
  };
}

function savedOptimisticState(state: ArticleState): ArticleState {
  if (state.read || state.readingProgress >= 0.9) {
    return { ...state, interactionStatus: "read", ignoredAt: null };
  }
  if (state.readingProgress >= 0.25) {
    return { ...state, interactionStatus: "reading", ignoredAt: null };
  }
  if (state.openedAt !== null && state.openedAt !== undefined) {
    return { ...state, interactionStatus: "opened", ignoredAt: null };
  }
  if (state.favorited || state.liked || state.readLater) {
    return { ...state, interactionStatus: "saved", ignoredAt: null };
  }
  return { ...state, interactionStatus: "seen", ignoredAt: null };
}

function actionErrorMessageFor(intent: ArticleActionIntent, t: Dictionary) {
  switch (intent) {
    case "favorite":
      return t.actions.errors.favorite;
    case "like":
      return t.actions.errors.like;
    case "readLater":
      return t.actions.errors.readLater;
    case "notInterested":
      return t.actions.errors.notInterested;
  }
}

function explanationReasonText(reason: RankExplanationReason, t: Dictionary): string {
  switch (reason.type) {
    case "interest":
      if (reason.clusters && reason.clusters.length > 0) {
        return t.explanation.reasons.interestCluster(
          reason.clusters
            .map((cluster, index) =>
              t.algorithmTransparency.clusters.matched(
                clusterDisplayName(cluster, index, t),
                formatPercent(Math.max(0, cluster.similarity)),
                formatCompactNumber(cluster.weight),
                cluster.sampleCount
              )
            )
            .join("；")
        );
      }
      if (reason.cluster) {
        return t.explanation.reasons.interestCluster(
          t.algorithmTransparency.clusters.matched(
            clusterDisplayName(reason.cluster, 0, t),
            formatPercent(Math.max(0, reason.cluster.similarity)),
            formatCompactNumber(reason.cluster.weight),
            reason.cluster.sampleCount
          )
        );
      }
      if (reason.family) {
        return t.explanation.reasons.interestFamily(reason.family.label);
      }
      if (reason.recentIntent) {
        return t.explanation.reasons.recentIntent;
      }
      return t.explanation.reasons.interest;
    case "source":
      return reason.impact === "negative"
        ? t.explanation.reasons.sourceNegative(reason.label)
        : t.explanation.reasons.sourcePositive(reason.label);
    case "freshness":
      return t.explanation.reasons.freshness;
    case "state":
      return reason.impact === "negative"
        ? t.explanation.reasons.stateNegative
        : t.explanation.reasons.statePositive;
    case "fallback":
      return t.explanation.reasons.fallback;
    case "negative":
      return t.explanation.reasons.negative;
    case "penalty":
      return t.explanation.reasons.penalty;
    case "exploration":
      return t.explanation.reasons.exploration;
  }
}

function clusterDisplayName(
  cluster: {
    label: string | null;
    displayLabel?: string;
    polarity: "positive" | "negative";
    id: string;
    displayIndex?: number;
  },
  index: number,
  t: Dictionary
): string {
  if (cluster.displayLabel) {
    return cluster.displayLabel;
  }
  if (cluster.label) {
    return cluster.label;
  }
  return t.algorithmTransparency.clusters.fallbackName(cluster.displayIndex ?? index + 1);
}

function confidenceBucket(value: number): "high" | "medium" | "low" {
  if (value >= 0.7) {
    return "high";
  }
  if (value >= 0.4) {
    return "medium";
  }
  return "low";
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function sanitizeArticleHtml(html: string, baseUrl?: string | null): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(`<main>${html}</main>`, "text/html");
  const allowedTags = new Set([
    "A",
    "B",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "EM",
    "H2",
    "H3",
    "H4",
    "I",
    "IMG",
    "LI",
    "OL",
    "P",
    "PRE",
    "STRONG",
    "UL"
  ]);

  function clean(node: Node): Node | null {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.cloneNode();
    }

    if (!(node instanceof Element)) {
      return null;
    }

    if (!allowedTags.has(node.tagName)) {
      const fragment = document.createDocumentFragment();
      for (const child of Array.from(node.childNodes)) {
        const cleaned = clean(child);
        if (cleaned) {
          fragment.appendChild(cleaned);
        }
      }
      return fragment;
    }

    const element = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === "A") {
      const href = node.getAttribute("href");
      const safeHref = safeArticleUrl(href, baseUrl, ["http:", "https:", "mailto:"]);
      if (safeHref) {
        element.setAttribute("href", safeHref);
        element.setAttribute("rel", "noreferrer");
        element.setAttribute("target", "_blank");
      }
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src");
      const safeSrc = safeArticleUrl(src, baseUrl, ["http:", "https:", "data:"]);
      if (!safeSrc || (safeSrc.startsWith("data:") && !safeSrc.startsWith("data:image/"))) {
        return null;
      }
      element.setAttribute("src", safeSrc);
      element.setAttribute("alt", node.getAttribute("alt") ?? "");
      element.setAttribute("loading", "lazy");
      element.setAttribute("decoding", "async");
      for (const attribute of ["title", "width", "height"]) {
        const value = node.getAttribute(attribute);
        if (value) {
          element.setAttribute(attribute, value);
        }
      }
    }

    for (const child of Array.from(node.childNodes)) {
      const cleaned = clean(child);
      if (cleaned) {
        element.appendChild(cleaned);
      }
    }

    return element;
  }

  const output = document.createElement("main");
  for (const child of Array.from(document.body.firstElementChild?.childNodes ?? [])) {
    const cleaned = clean(child);
    if (cleaned) {
      output.appendChild(cleaned);
    }
  }

  return output.innerHTML;
}

function safeArticleUrl(
  value: string | null,
  baseUrl: string | null | undefined,
  protocols: string[]
): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value, baseUrl ?? window.location.origin);
    return protocols.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
