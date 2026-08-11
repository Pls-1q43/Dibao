import type { CSSProperties, FormEvent, MouseEvent, RefObject, SyntheticEvent } from "react";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ArticleDetail, ArticleListItem, ArticleSearchSort, ArticleSearchState, ArticleState, ArticleTimeWindow, ArticleView, FavoriteArticleSort, Feed, FeedDiagnosticItem, FeedFolder, PluginContributions, RankExplanation, RankExplanationReason, ReaderCommandMarkScopeReadPreviewResponse, ReaderDiscoveryUnavailableReason, ReaderSettings, ReadLaterArticleSort, RecommendationInventory, RecommendationInventoryStatus, RecommendationStatus } from "../api.js";
import { useI18n, type Dictionary, type NavigationItemKey } from "../i18n.js";
import styles from "../design-system/AppShell/AppShell.module.css";
import { articleInteractionStatusForState } from "../articleListState.js";
import { articleSortForView, canLoadRankExplanation, classNames, clusterDisplayName, confidenceBucket, countFeedsByFolder, explanationReasonText, formatCompactNumber, formatPercent, pageForNavigationItem, plainTextSummary, readerStyleFor, recommendationStatusMetrics, safeArticleUrl, sanitizeArticleHtml, shouldLetBrowserHandleLinkClick, shouldLoadRankExplanation, sortExplanationForView, supportsQuickFilters, supportsUnreadOnly, urlForAppPage, urlForArticle, urlForSearchPage, clampNumber, type ArticleActionIntent, type ArticleActionTarget, type AppPage, type FeedDiagnosticsByFeedId, type PendingArticleAction, type ReadProgressMetadata, type ReadProgressPostOptions, type SearchFormState, type SourceSelection } from "../app/shared.js";

const ARTICLE_ROW_ESTIMATED_HEIGHT = 164;
const ARTICLE_ROW_OVERSCAN = 8;
const ARTICLE_LIST_VIRTUALIZATION_THRESHOLD = 80;
const PASSIVE_IGNORE_SCROLL_DELTA_PX = 24;
const sanitizedArticleHtmlCache = new Map<string, string>();

export type PluginActionButton = PluginContributions["actions"][number] & {
  pluginId: string;
  pluginName: string;
};

export type ReaderDiscoveryPanelState = {
  status: "idle" | "loading" | "ready" | "unavailable" | "error";
  items: ArticleListItem[];
  reason?: ReaderDiscoveryUnavailableReason;
};

const idleReaderDiscoveryState: ReaderDiscoveryPanelState = {
  status: "idle",
  items: []
};

export type PluginActionContext = {
  articleId?: string;
  slot: string;
};

export function safeOriginalArticleUrl(articleUrl: string | null): string | null {
  return safeArticleUrl(articleUrl, null, ["http:", "https:"]);
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
  articleLoadingNotice?: string | null;
  articleView: ArticleView;
  articles: ArticleListItem[];
  favoriteSort: FavoriteArticleSort;
  readLaterSort: ReadLaterArticleSort;
  feedCount: number;
  infiniteArticleLoading?: boolean;
  isIgnoreTelemetryEnabled: boolean;
  isArticlesLoading: boolean;
  isLoadingMore: boolean;
  isMarkingScopeRead: boolean;
  isRecommendationInventoryLoading?: boolean;
  isRecommendationStatusLoading: boolean;
  listScrollKey?: string;
  loadMoreError: string | null;
  nextCursor: string | null;
  onArticleAction?: (article: ArticleActionTarget, intent: ArticleActionIntent) => void;
  onPluginAction?: (action: PluginActionButton, context: PluginActionContext) => void;
  onFavoriteSortChange: (sort: FavoriteArticleSort) => void;
  onReadLaterSortChange: (sort: ReadLaterArticleSort) => void;
  onIgnoreArticle: (articleId: string) => void;
  onLoadMore: () => void | Promise<void>;
  onMarkScopeRead: () => void;
  onPreviewMarkScopeRead: () => Promise<number>;
  onRecordRecommendationExposures?: (input: { clientSessionId: string; articleIds: string[]; exposedAt: number }) => void;
  onOpenSources: () => void;
  onExplainArticle: (articleId: string) => void;
  onSelectArticle: (articleId: string) => void;
  onTimeWindowChange: (timeWindow: ArticleTimeWindow) => void;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  pendingAction?: PendingArticleAction | null;
  pluginListToolbarEndActions?: PluginActionButton[];
  pluginListToolbarStartActions?: PluginActionButton[];
  pluginRowActions?: PluginActionButton[];
  recommendationStatus: RecommendationStatus | null;
  recommendationStatusError: string | null;
  recommendationInventory?: RecommendationInventory | null;
  recommendationInventoryError?: string | null;
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
  const { t, formatDate, formatArticleDate } = useI18n();
  const scrollContainerRef = useRef<HTMLElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const [virtualViewport, setVirtualViewport] = useState({ scrollTop: 0, height: 800 });
  const [rowHeightRevision, setRowHeightRevision] = useState(0);
  const measuredRowHeights = useRef(new Map<string, number>());
  const pendingLoadMoreAnchor = useRef<ArticleListScrollAnchor | null>(null);
  const listScrollKey = props.listScrollKey ?? `dibao:list-scroll:${props.articleView}`;
  const sourceTitle =
    props.selectedFeed?.title ?? props.selectedFolder?.title ?? t.articles.allSources;
  const isSourceFiltered = props.selectedFeed !== null || props.selectedFolder !== null;

  useArticleListIgnoreTelemetry({
    articles: props.articles,
    enabled: props.isIgnoreTelemetryEnabled,
    onIgnoreArticle: props.onIgnoreArticle,
    rootRef: scrollContainerRef,
    selectedArticleId: props.selectedArticleId
  });
  useRecommendationExposureTelemetry({
    articleView: props.articleView,
    articles: props.articles,
    onRecord: props.onRecordRecommendationExposures,
    rootRef: scrollContainerRef
  });

  usePersistedArticleListScroll({
    enabled: !props.selectedArticleId,
    storageKey: listScrollKey,
    rootRef: scrollContainerRef
  });

  const isInfiniteLoadingAvailable = supportsInfiniteArticleLoading();
  const isInfiniteLoadingEnabled = Boolean(props.infiniteArticleLoading) && isInfiniteLoadingAvailable;
  useInfiniteArticleLoading({
    enabled:
      isInfiniteLoadingEnabled &&
      !props.isArticlesLoading &&
      !props.isLoadingMore &&
      props.loadMoreError === null &&
      props.nextCursor !== null,
    hasMore: props.nextCursor !== null,
    isLoadingMore: props.isLoadingMore,
    loadMoreError: props.loadMoreError,
    onLoadMore: props.onLoadMore,
    rootRef: scrollContainerRef,
    sentinelRef: loadMoreSentinelRef
  });

  useEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) {
      return;
    }

    function updateViewport() {
      setVirtualViewport({
        scrollTop: element?.scrollTop ?? 0,
        height: element?.clientHeight ?? 800
      });
    }

    updateViewport();
    element.addEventListener("scroll", updateViewport, { passive: true });
    window.addEventListener("resize", updateViewport);
    return () => {
      element.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  const shouldVirtualize =
    !props.isArticlesLoading &&
    props.articles.length > ARTICLE_LIST_VIRTUALIZATION_THRESHOLD;
  const articleIds = useMemo(() => props.articles.map((article) => article.id), [props.articles]);
  const virtualWindow = useMemo(
    () =>
      measuredVirtualArticleWindow({
        articleIds,
        estimatedHeight: ARTICLE_ROW_ESTIMATED_HEIGHT,
        overscan: ARTICLE_ROW_OVERSCAN,
        rowHeights: measuredRowHeights.current,
        scrollTop: virtualViewport.scrollTop,
        viewportHeight: virtualViewport.height
      }),
    [articleIds, rowHeightRevision, virtualViewport.height, virtualViewport.scrollTop]
  );
  const virtualStartIndex = shouldVirtualize ? virtualWindow.startIndex : 0;
  const virtualEndIndex = shouldVirtualize ? virtualWindow.endIndex : props.articles.length;
  const visibleArticles = props.articles.slice(virtualStartIndex, virtualEndIndex);

  useEffect(() => {
    const articleIdSet = new Set(articleIds);
    let changed = false;
    for (const id of Array.from(measuredRowHeights.current.keys())) {
      if (!articleIdSet.has(id)) {
        measuredRowHeights.current.delete(id);
        changed = true;
      }
    }
    if (changed) {
      setRowHeightRevision((current) => current + 1);
    }
  }, [articleIds]);

  useLayoutEffect(() => {
    const anchor = pendingLoadMoreAnchor.current;
    const root = scrollContainerRef.current;
    if (!anchor || !root || props.isLoadingMore) {
      return;
    }

    restoreArticleListScrollAnchor(root, anchor);
    if (typeof window === "undefined") {
      pendingLoadMoreAnchor.current = null;
      return;
    }

    const firstFrame = window.requestAnimationFrame(() => {
      restoreArticleListScrollAnchor(root, anchor);
      const secondFrame = window.requestAnimationFrame(() => {
        restoreArticleListScrollAnchor(root, anchor);
        if (pendingLoadMoreAnchor.current === anchor) {
          pendingLoadMoreAnchor.current = null;
        }
      });
      anchor.animationFrames.push(secondFrame);
    });
    anchor.animationFrames.push(firstFrame);

    return () => {
      for (const frame of anchor.animationFrames.splice(0)) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [props.articles.length, props.isLoadingMore, rowHeightRevision]);

  const handleMeasuredArticleRowHeight = useCallback((articleId: string, height: number) => {
    const nextHeight = Math.ceil(height);
    if (nextHeight <= 0) {
      return;
    }
    const previousHeight = measuredRowHeights.current.get(articleId);
    if (previousHeight !== nextHeight) {
      measuredRowHeights.current.set(articleId, nextHeight);
      setRowHeightRevision((current) => current + 1);
    }
  }, []);

  async function handleLoadMoreClick(event: MouseEvent<HTMLButtonElement>) {
    const root = scrollContainerRef.current;
    pendingLoadMoreAnchor.current = root ? articleListScrollAnchorForRoot(root) : null;
    event.currentTarget.blur();
    await props.onLoadMore();
  }

  return (
    <section
      className={styles.articlePanel}
      data-article-count={props.articles.length}
      data-mounted-row-count={visibleArticles.length}
      data-testid="article-list-scroll-container"
      ref={scrollContainerRef}
      aria-labelledby="articles-title"
    >
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleGroup}>
          <p className={styles.kicker}>{sourceTitle}</p>
          <div className={styles.articleTitleLine}>
            <h2 id="articles-title">{t.articles.views[props.articleView]}</h2>
            {props.showRecommendationStatus ? (
              <RecommendationInventoryControl
                error={props.recommendationInventoryError ?? null}
                inventory={props.recommendationInventory ?? null}
                isLoading={Boolean(props.isRecommendationInventoryLoading)}
                isRecommendationStatusLoading={props.isRecommendationStatusLoading}
                recommendationStatus={props.recommendationStatus}
                recommendationStatusError={props.recommendationStatusError}
              />
            ) : null}
          </div>
        </div>
        <div className={styles.panelHeaderActions}>
          <PluginActionButtons
            actions={props.pluginListToolbarStartActions ?? []}
            onRun={(action) => props.onPluginAction?.(action, { slot: action.slot })}
          />
          <button
            aria-label={
              isSourceFiltered
                ? `${t.feeds.openSourcesLabel}: ${sourceTitle}`
                : t.feeds.openSourcesLabel
            }
            aria-pressed={isSourceFiltered}
            className={classNames(
              styles.mobileSourceButton,
              isSourceFiltered ? styles.mobileSourceButtonActive : null
            )}
            onClick={props.onOpenSources}
            title={isSourceFiltered ? sourceTitle : undefined}
            type="button"
          >
            <span className={styles.mobileSourceButtonText}>{t.feeds.openSources}</span>
            {isSourceFiltered ? (
              <span className={styles.mobileSourceButtonStatus}>{sourceTitle}</span>
            ) : null}
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
          <PluginActionButtons
            actions={props.pluginListToolbarEndActions ?? []}
            onRun={(action) => props.onPluginAction?.(action, { slot: action.slot })}
          />
        </div>
      </div>

      {props.articleError ? <p className={styles.errorText}>{props.articleError}</p> : null}
      {props.articleLoadingNotice ? (
        <p className={styles.settingsNotice}>{props.articleLoadingNotice}</p>
      ) : null}
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

        {!props.isArticlesLoading && shouldVirtualize ? (
          <div
            className={styles.listVirtualWindow}
            style={{ height: virtualWindow.totalHeight }}
          >
            {visibleArticles.map((article, visibleIndex) => {
              const articleIndex = virtualStartIndex + visibleIndex;
              return (
                <ArticleListRow
                  article={article}
                  articleView={props.articleView}
                  favoriteSort={props.favoriteSort}
                  formatArticleDate={formatArticleDate}
                  key={article.id}
                  onArticleAction={props.onArticleAction}
                  onExplainArticle={props.onExplainArticle}
                  onPluginAction={props.onPluginAction}
                  onSelectArticle={props.onSelectArticle}
                  onMeasuredHeight={handleMeasuredArticleRowHeight}
                  pendingAction={props.pendingAction}
                  pluginActions={props.pluginRowActions ?? []}
                  readLaterSort={props.readLaterSort}
                  selectedArticleId={props.selectedArticleId}
                  style={{
                    left: 0,
                    position: "absolute",
                    right: 0,
                    top: 0,
                    transform: `translateY(${virtualWindow.offsets[articleIndex] ?? 0}px)`
                  }}
                  timeWindow={props.timeWindow}
                  t={t}
                  unreadOnly={props.unreadOnly}
                />
              );
            })}
          </div>
        ) : null}

        {!props.isArticlesLoading && !shouldVirtualize
          ? props.articles.map((article) => (
              <ArticleListRow
                article={article}
                articleView={props.articleView}
                favoriteSort={props.favoriteSort}
                formatArticleDate={formatArticleDate}
                key={article.id}
                onArticleAction={props.onArticleAction}
                onExplainArticle={props.onExplainArticle}
                onPluginAction={props.onPluginAction}
                onSelectArticle={props.onSelectArticle}
                pendingAction={props.pendingAction}
                pluginActions={props.pluginRowActions ?? []}
                readLaterSort={props.readLaterSort}
                selectedArticleId={props.selectedArticleId}
                timeWindow={props.timeWindow}
                t={t}
                unreadOnly={props.unreadOnly}
              />
            ))
          : null}

        {!props.isArticlesLoading && props.nextCursor && isInfiniteLoadingEnabled && !props.loadMoreError ? (
          <div
            className={classNames(
              styles.loadMoreBar,
              props.isLoadingMore ? styles.loadMoreBarLoading : null
            )}
            aria-live="polite"
          >
            <div className={styles.paginationSentinel} ref={loadMoreSentinelRef} />
            {props.isLoadingMore ? <InfiniteLoadStatus label={t.articles.loadingMore} /> : null}
          </div>
        ) : null}

        {!props.isArticlesLoading && props.nextCursor && (!isInfiniteLoadingEnabled || props.loadMoreError) ? (
          <div className={styles.loadMoreBar}>
            <button
              className={styles.secondaryButton}
              disabled={props.isLoadingMore}
              onClick={(event) => {
                void handleLoadMoreClick(event);
              }}
              type="button"
            >
              {props.isLoadingMore
                ? t.articles.loadingMore
                : props.loadMoreError
                  ? t.articles.retryLoadMore
                  : t.articles.loadMore}
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

function ArticleListRow(props: {
  article: ArticleListItem;
  articleView: ArticleView;
  favoriteSort: FavoriteArticleSort;
  formatArticleDate: (value: string | Date) => string;
  onArticleAction?: (article: ArticleListItem, intent: ArticleActionIntent) => void;
  onExplainArticle: (articleId: string) => void;
  onMeasuredHeight?: (articleId: string, height: number) => void;
  onPluginAction?: (action: PluginActionButton, context: PluginActionContext) => void;
  onSelectArticle: (articleId: string) => void;
  pendingAction?: PendingArticleAction | null;
  pluginActions: PluginActionButton[];
  readLaterSort: ReadLaterArticleSort;
  selectedArticleId: string | null;
  style?: CSSProperties;
  timeWindow: ArticleTimeWindow;
  t: Dictionary;
  unreadOnly: boolean;
}) {
  const article = props.article;
  const rowRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!props.onMeasuredHeight) {
      return;
    }
    const element = rowRef.current;
    if (!element) {
      return;
    }

    const measure = () => {
      props.onMeasuredHeight?.(article.id, element.getBoundingClientRect().height);
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [article.id, props.onMeasuredHeight]);

  return (
    <article
      className={articleItemClassName(article, props.selectedArticleId)}
      data-article-id={article.id}
      data-interaction-status={articleInteractionStatusForState(article.state)}
      data-favorited={article.state.favorited ? "true" : undefined}
      data-liked={article.state.liked ? "true" : undefined}
      data-read-later={article.state.readLater ? "true" : undefined}
      ref={rowRef}
      style={props.style}
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
          {props.t.articles.itemMeta(
            props.formatArticleDate(article.publishedAt ?? article.discoveredAt),
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
        canExplain={shouldLoadRankExplanation(props.articleView)}
        onAction={(intent) => props.onArticleAction?.(article, intent)}
        onExplain={() => props.onExplainArticle(article.id)}
        onPluginAction={(action) =>
          props.onPluginAction?.(action, { articleId: article.id, slot: action.slot })
        }
        pendingAction={
          props.pendingAction?.articleId === article.id ? props.pendingAction.intent : null
        }
        pluginActions={props.pluginActions}
      />
    </article>
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
  articleLoadingNotice?: string | null;
  articles: ArticleListItem[];
  feedFolders: FeedFolder[];
  feeds: Feed[];
  form: SearchFormState;
  hasSubmitted: boolean;
  infiniteArticleLoading?: boolean;
  isArticlesLoading: boolean;
  isLoadingMore: boolean;
  isMarkingScopeRead: boolean;
  loadMoreError: string | null;
  nextCursor: string | null;
  onArticleAction?: (article: ArticleActionTarget, intent: ArticleActionIntent) => void;
  onPluginAction?: (action: PluginActionButton, context: PluginActionContext) => void;
  onChange: (form: SearchFormState) => void;
  onExplainArticle: (articleId: string) => void;
  onLoadMore: () => void;
  onMarkScopeRead: () => void;
  onSelectArticle: (articleId: string) => void;
  onSubmit: (form: SearchFormState) => void;
  pendingAction?: PendingArticleAction | null;
  pluginRowActions?: PluginActionButton[];
  readerCommandError: string | null;
  resultUrlForm: SearchFormState;
  selectedArticleId: string | null;
  unreadCount: number;
}) {
  const { t, formatDate, formatArticleDate } = useI18n();
  const [isAdvancedSearchOpen, setIsAdvancedSearchOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const isInfiniteLoadingAvailable = supportsInfiniteArticleLoading();
  const isInfiniteLoadingEnabled = Boolean(props.infiniteArticleLoading) && isInfiniteLoadingAvailable;
  useInfiniteArticleLoading({
    enabled:
      isInfiniteLoadingEnabled &&
      !props.isArticlesLoading &&
      !props.isLoadingMore &&
      props.loadMoreError === null &&
      props.nextCursor !== null,
    hasMore: props.nextCursor !== null,
    isLoadingMore: props.isLoadingMore,
    loadMoreError: props.loadMoreError,
    onLoadMore: props.onLoadMore,
    rootRef: scrollContainerRef,
    sentinelRef: loadMoreSentinelRef
  });

  function update(patch: Partial<SearchFormState>) {
    props.onChange({
      ...props.form,
      ...patch
    });
  }

  return (
    <section className={styles.articlePanel} aria-labelledby="search-title" ref={scrollContainerRef}>
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
        <label className={styles.searchInlineOption}>
          <input
            checked={props.form.fullText}
            onChange={(event) => update({ fullText: event.target.checked })}
            type="checkbox"
          />
          <span>{t.search.fullTextLabel}</span>
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
        {isAdvancedSearchOpen ? (
          <div
            className={`${styles.searchAdvanced} ${styles.searchAdvancedOpen}`}
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
        ) : null}
      </form>

      {props.articleError ? <p className={styles.errorText}>{props.articleError}</p> : null}
      {props.articleLoadingNotice ? (
        <p className={styles.settingsNotice}>{props.articleLoadingNotice}</p>
      ) : null}
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
                    formatArticleDate(article.publishedAt ?? article.discoveredAt),
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
                onPluginAction={(action) =>
                  props.onPluginAction?.(action, { articleId: article.id, slot: action.slot })
                }
                pendingAction={
                  props.pendingAction?.articleId === article.id
                    ? props.pendingAction.intent
                    : null
                }
                pluginActions={props.pluginRowActions ?? []}
              />
            </article>
          ))}

        {!props.isArticlesLoading && props.nextCursor && isInfiniteLoadingEnabled && !props.loadMoreError ? (
          <div
            className={classNames(
              styles.loadMoreBar,
              props.isLoadingMore ? styles.loadMoreBarLoading : null
            )}
            aria-live="polite"
          >
            <div className={styles.paginationSentinel} ref={loadMoreSentinelRef} />
            {props.isLoadingMore ? <InfiniteLoadStatus label={t.articles.loadingMore} /> : null}
          </div>
        ) : null}

        {!props.isArticlesLoading && props.nextCursor && (!isInfiniteLoadingEnabled || props.loadMoreError) ? (
          <div className={styles.loadMoreBar}>
            <button
              className={styles.secondaryButton}
              disabled={props.isLoadingMore}
              onClick={props.onLoadMore}
              type="button"
            >
              {props.isLoadingMore
                ? t.articles.loadingMore
                : props.loadMoreError
                  ? t.articles.retryLoadMore
                  : t.search.loadMore}
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

function InfiniteLoadStatus(props: { label: string }) {
  return (
    <span className={styles.infiniteLoadStatus}>
      <span aria-hidden="true" className={styles.infiniteLoadSpinner} />
      <span>{props.label}</span>
    </span>
  );
}

type RecommendationInventoryDisplayStatus = RecommendationInventoryStatus | "loading" | "unavailable";

function RecommendationInventoryControl(props: {
  error: string | null;
  inventory: RecommendationInventory | null;
  isLoading: boolean;
  isRecommendationStatusLoading: boolean;
  recommendationStatus: RecommendationStatus | null;
  recommendationStatusError: string | null;
}) {
  const { t, formatDate } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const displayStatus: RecommendationInventoryDisplayStatus = props.inventory
    ? props.inventory.status
    : props.isLoading
      ? "loading"
      : "unavailable";
  const statusText = t.recommendationInventory.statuses[displayStatus];
  const statusSummary = inventoryStatusSummary(displayStatus, props.inventory, t);
  const statusClass = recommendationInventoryStatusClass(displayStatus);
  const metrics = props.recommendationStatus
    ? recommendationStatusMetrics(props.recommendationStatus, t, formatDate)
    : [];
  const showWarmupNotice = props.recommendationStatus
    ? hasProfileWarmupWarning(props.recommendationStatus)
    : false;
  const rankingJobCount = props.inventory
    ? props.inventory.rankingJob.queued + props.inventory.rankingJob.running
    : 0;
  const inventoryRows = props.inventory
    ? [
        {
          label: t.recommendationInventory.metrics.remainingSorted,
          value: formatCompactNumber(props.inventory.remainingSortedCount)
        },
        {
          label: t.recommendationInventory.metrics.sortedTotal,
          value: formatCompactNumber(props.inventory.sortedCount)
        },
        {
          label: t.recommendationInventory.metrics.latestActive,
          value: formatCompactNumber(props.inventory.latestActiveCount)
        },
        {
          label: t.recommendationInventory.metrics.staleActive,
          value: formatCompactNumber(props.inventory.staleActiveCount)
        },
        {
          label: t.recommendationInventory.metrics.loaded,
          value: formatCompactNumber(props.inventory.loadedCount)
        },
        {
          label: t.recommendationInventory.metrics.fallback,
          value: formatCompactNumber(props.inventory.fallbackCount)
        },
        {
          label: t.recommendationInventory.metrics.unrankedFallback,
          value: formatCompactNumber(props.inventory.unrankedFallbackCount)
        },
        {
          label: t.recommendationInventory.metrics.rankingJobs,
          value: t.recommendationInventory.metrics.rankingJobValue(
            props.inventory.rankingJob.running,
            props.inventory.rankingJob.queued
          )
        }
      ]
    : [];

  useEffect(() => {
    if (!isOpen || typeof document === "undefined") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className={styles.recommendationInventoryControl} ref={rootRef}>
      <button
        aria-controls={isOpen ? popoverId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={t.recommendationInventory.open(statusText)}
        className={classNames(styles.recommendationInventoryButton, statusClass)}
        onClick={() => setIsOpen((open) => !open)}
        title={statusSummary}
        type="button"
      >
        <span className={styles.recommendationInventoryDot} aria-hidden="true" />
        <span>{statusText}</span>
      </button>

      {isOpen ? (
        <>
          <button
            aria-label={t.recommendationInventory.close}
            className={styles.recommendationInventoryOverlay}
            onClick={() => setIsOpen(false)}
            type="button"
          />
          <section
            aria-labelledby={`${popoverId}-title`}
            className={styles.recommendationInventoryPopover}
            id={popoverId}
            role="dialog"
          >
            <div className={styles.recommendationInventoryHeader}>
              <div>
                <span className={styles.recommendationInventoryEyebrow}>
                  {t.recommendationInventory.eyebrow}
                </span>
                <h3 id={`${popoverId}-title`}>{statusText}</h3>
              </div>
              <button
                aria-label={t.recommendationInventory.close}
                className={styles.iconButton}
                onClick={() => setIsOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <p className={styles.recommendationInventorySummary}>{statusSummary}</p>
            {props.error ? (
              <p className={styles.recommendationInventoryWarning}>{props.error}</p>
            ) : null}
            {props.inventory && props.inventory.remainingSortedCount <= 0 ? (
              <p className={styles.recommendationInventoryWarning}>
                {rankingJobCount > 0
                  ? t.recommendationInventory.rankingNotice
                  : t.recommendationInventory.emptyNotice}
              </p>
            ) : null}
            {inventoryRows.length > 0 ? (
              <dl className={styles.recommendationInventoryMetrics}>
                {inventoryRows.map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {props.inventory ? (
              <dl className={styles.recommendationInventoryMeta}>
                <div>
                  <dt>{t.recommendationInventory.metrics.rankContext}</dt>
                  <dd>{props.inventory.activeRankContext}</dd>
                </div>
                <div>
                  <dt>{t.recommendationInventory.metrics.lastRankedAt}</dt>
                  <dd>
                    {props.inventory.lastRankedAt
                      ? formatDate(props.inventory.lastRankedAt)
                      : t.recommendationStatus.metrics.unknown}
                  </dd>
                </div>
                <div>
                  <dt>{t.recommendationInventory.metrics.updatedAt}</dt>
                  <dd>{formatDate(props.inventory.updatedAt)}</dd>
                </div>
              </dl>
            ) : null}
            {showWarmupNotice ? (
              <p className={styles.recommendationInventoryNotice}>
                {t.recommendationStatus.warmupNotice}
              </p>
            ) : null}
            {props.recommendationStatusError ? (
              <p className={styles.recommendationInventoryNotice}>
                {props.recommendationStatusError}
              </p>
            ) : null}
            {props.isRecommendationStatusLoading ? (
              <p className={styles.recommendationInventoryNotice}>
                {t.recommendationStatus.loading}
              </p>
            ) : null}
            {metrics.length > 0 ? (
              <div className={styles.recommendationInventorySystem}>
                <h4>{t.recommendationInventory.systemTitle}</h4>
                <dl className={styles.recommendationStatusMetrics}>
                  {metrics.map((metric) => (
                    <div key={metric}>
                      <dd>{metric}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function recommendationInventoryStatusClass(status: RecommendationInventoryDisplayStatus): string {
  switch (status) {
    case "available":
      return styles.recommendationInventoryAvailable;
    case "empty":
      return styles.recommendationInventoryEmpty;
    case "ranking":
      return styles.recommendationInventoryRanking;
    case "loading":
      return styles.recommendationInventoryLoading;
    case "unavailable":
    default:
      return styles.recommendationInventoryUnavailable;
  }
}

function inventoryStatusSummary(
  status: RecommendationInventoryDisplayStatus,
  inventory: RecommendationInventory | null,
  t: Dictionary
): string {
  if (!inventory) {
    return status === "loading"
      ? t.recommendationInventory.summaries.loading
      : t.recommendationInventory.summaries.unavailable;
  }
  switch (status) {
    case "available":
      return t.recommendationInventory.summaries.available(
        inventory.remainingSortedCount,
        inventory.sortedCount
      );
    case "ranking":
      return t.recommendationInventory.summaries.ranking(
        inventory.remainingSortedCount,
        inventory.rankingJob.running,
        inventory.rankingJob.queued
      );
    case "empty":
      return t.recommendationInventory.summaries.empty(inventory.fallbackCount);
    case "loading":
      return t.recommendationInventory.summaries.loading;
    case "unavailable":
    default:
      return t.recommendationInventory.summaries.unavailable;
  }
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
  const firstVisibleScrollTopById = useRef(new Map<string, number>());
  const sentIds = useRef(new Set<string>());

  useEffect(() => {
    onIgnoreArticleRef.current = props.onIgnoreArticle;
  }, [props.onIgnoreArticle]);

  useEffect(() => {
    selectedArticleIdRef.current = props.selectedArticleId;
    if (props.selectedArticleId) {
      firstVisibleScrollTopById.current.delete(props.selectedArticleId);
    }
  }, [props.selectedArticleId]);

  useEffect(() => {
    const root = props.rootRef.current;
    if (!props.enabled || !root || typeof IntersectionObserver === "undefined") {
      return;
    }
    const scrollRoot = root;

    const visibleCandidates = props.articles.filter(
      (article) => articleInteractionStatusForState(article.state) === "unseen"
    );
    const candidateIds = new Set(visibleCandidates.map((article) => article.id));

    for (const id of Array.from(firstVisibleScrollTopById.current.keys())) {
      if (!candidateIds.has(id)) {
        firstVisibleScrollTopById.current.delete(id);
      }
    }
    for (const id of Array.from(sentIds.current)) {
      if (!candidateIds.has(id)) {
        sentIds.current.delete(id);
      }
    }

    function sendIgnoredArticle(articleId: string) {
      if (
        !candidateIds.has(articleId) ||
        sentIds.current.has(articleId) ||
        selectedArticleIdRef.current === articleId
      ) {
        return;
      }

      sentIds.current.add(articleId);
      onIgnoreArticleRef.current(articleId);
    }

    let scanAnimationFrame: number | null = null;

    function scanScrolledPastArticles() {
      const rootRect = scrollRoot.getBoundingClientRect();
      const rootTop = rootRect.top;
      const rootBottom = rootRect.bottom;
      const currentScrollTop = scrollRoot.scrollTop;
      for (const article of visibleCandidates) {
        if (
          sentIds.current.has(article.id) ||
          selectedArticleIdRef.current === article.id ||
          firstVisibleScrollTopById.current.has(article.id)
        ) {
          continue;
        }
        const element = scrollRoot.querySelector<HTMLElement>(
          `[data-article-id="${cssEscape(article.id)}"]`
        );
        if (element && elementVisibilityRatioInRoot(element, rootTop, rootBottom) >= 0.6) {
          firstVisibleScrollTopById.current.set(article.id, currentScrollTop);
        }
      }

      const snapshots = Array.from(firstVisibleScrollTopById.current).map(
        ([articleId, firstVisibleScrollTop]) => {
        const element = scrollRoot.querySelector<HTMLElement>(
          `[data-article-id="${cssEscape(articleId)}"]`
        );
        return {
          articleId,
          bottom: element?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
          currentScrollTop,
          firstVisibleScrollTop,
          hasBeenSent: sentIds.current.has(articleId),
          hasBeenVisible: true
        };
        }
      );

      for (const articleId of scrolledPastArticleIdsForIgnoreTelemetry(
        snapshots,
        rootTop,
        PASSIVE_IGNORE_SCROLL_DELTA_PX
      )) {
        sendIgnoredArticle(articleId);
      }
    }

    function scheduleScrolledPastScan() {
      if (typeof window === "undefined") {
        scanScrolledPastArticles();
        return;
      }
      if (scanAnimationFrame !== null) {
        return;
      }

      scanAnimationFrame = window.requestAnimationFrame(() => {
        scanAnimationFrame = null;
        scanScrolledPastArticles();
      });
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
            if (!firstVisibleScrollTopById.current.has(articleId)) {
              firstVisibleScrollTopById.current.set(articleId, scrollRoot.scrollTop);
            }
            continue;
          }

          const rootTop = entry.rootBounds?.top ?? scrollRoot.getBoundingClientRect().top;
          const firstVisibleScrollTop = firstVisibleScrollTopById.current.get(articleId);
          const ignoredIds = scrolledPastArticleIdsForIgnoreTelemetry(
            [
              {
                articleId,
                bottom: entry.boundingClientRect.bottom,
                currentScrollTop: scrollRoot.scrollTop,
                firstVisibleScrollTop: firstVisibleScrollTop ?? Number.POSITIVE_INFINITY,
                hasBeenSent: sentIds.current.has(articleId),
                hasBeenVisible: firstVisibleScrollTop !== undefined
              }
            ],
            rootTop,
            PASSIVE_IGNORE_SCROLL_DELTA_PX
          );
          if (ignoredIds.includes(articleId)) {
            sendIgnoredArticle(articleId);
          }
        }
        scheduleScrolledPastScan();
      },
      {
        root: scrollRoot,
        threshold: [0, 0.6]
      }
    );

    for (const article of visibleCandidates) {
      const element = scrollRoot.querySelector<HTMLElement>(
        `[data-article-id="${cssEscape(article.id)}"]`
      );
      if (element) {
        observer.observe(element);
      }
    }

    scheduleScrolledPastScan();
    scrollRoot.addEventListener("scroll", scheduleScrolledPastScan, { passive: true });

    return () => {
      if (scanAnimationFrame !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(scanAnimationFrame);
      }
      scrollRoot.removeEventListener("scroll", scheduleScrolledPastScan);
      observer.disconnect();
    };
  }, [props.articles, props.enabled, props.rootRef]);
}

function useRecommendationExposureTelemetry(props: {
  articleView: ArticleView;
  articles: ArticleListItem[];
  onRecord?: (input: { clientSessionId: string; articleIds: string[]; exposedAt: number }) => void;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const onRecordRef = useRef(props.onRecord);
  const sessionIdRef = useRef(createRecommendationExposureSessionId());
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    onRecordRef.current = props.onRecord;
  }, [props.onRecord]);

  useEffect(() => {
    const root = props.rootRef.current;
    if (
      props.articleView !== "recommended" ||
      !root ||
      !onRecordRef.current ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const articleIds = new Set(props.articles.map((article) => article.id));
    const observer = new IntersectionObserver(
      (entries) => {
        const newlyVisible: string[] = [];
        for (const entry of entries) {
          const articleId = entry.target.getAttribute("data-article-id");
          if (
            entry.isIntersecting &&
            entry.intersectionRatio >= 0.6 &&
            articleId &&
            articleIds.has(articleId) &&
            !seenIds.current.has(articleId)
          ) {
            seenIds.current.add(articleId);
            newlyVisible.push(articleId);
          }
        }
        if (newlyVisible.length > 0) {
          onRecordRef.current?.({
            clientSessionId: sessionIdRef.current,
            articleIds: newlyVisible,
            exposedAt: Date.now()
          });
        }
      },
      { root, threshold: [0.6] }
    );
    for (const articleId of articleIds) {
      const element = root.querySelector<HTMLElement>(`[data-article-id="${cssEscape(articleId)}"]`);
      if (element) {
        observer.observe(element);
      }
    }
    return () => observer.disconnect();
  }, [props.articleView, props.articles, props.rootRef]);
}

function createRecommendationExposureSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `exposure_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function scrolledPastArticleIdsForIgnoreTelemetry(
  candidates: Array<{
    articleId: string;
    bottom: number;
    currentScrollTop: number;
    firstVisibleScrollTop: number;
    hasBeenSent: boolean;
    hasBeenVisible: boolean;
  }>,
  rootTop: number,
  minimumScrollDeltaPx: number = PASSIVE_IGNORE_SCROLL_DELTA_PX
): string[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.hasBeenVisible &&
        !candidate.hasBeenSent &&
        candidate.bottom <= rootTop &&
        candidate.currentScrollTop - candidate.firstVisibleScrollTop >= minimumScrollDeltaPx
    )
    .map((candidate) => candidate.articleId);
}

function elementVisibilityRatioInRoot(
  element: HTMLElement,
  rootTop: number,
  rootBottom: number
): number {
  const rect = element.getBoundingClientRect();
  const height = rect.height;
  if (height <= 0) {
    return 0;
  }

  const visibleHeight = Math.max(0, Math.min(rect.bottom, rootBottom) - Math.max(rect.top, rootTop));
  return visibleHeight / height;
}

type ArticleListScrollAnchor = {
  animationFrames: number[];
  articleId: string;
  offsetTop: number;
  scrollTop: number;
};

function articleListScrollAnchorForRoot(root: HTMLElement): ArticleListScrollAnchor | null {
  const rootTop = root.getBoundingClientRect().top;
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-article-id]"));
  for (const row of rows) {
    const articleId = row.dataset.articleId;
    if (!articleId) {
      continue;
    }
    const rect = row.getBoundingClientRect();
    if (rect.bottom > rootTop) {
      return {
        animationFrames: [],
        articleId,
        offsetTop: rect.top - rootTop,
        scrollTop: root.scrollTop
      };
    }
  }
  return null;
}

function restoreArticleListScrollAnchor(root: HTMLElement, anchor: ArticleListScrollAnchor): void {
  const anchoredElement = root.querySelector<HTMLElement>(
    `[data-article-id="${cssEscape(anchor.articleId)}"]`
  );
  if (anchoredElement) {
    const rootTop = root.getBoundingClientRect().top;
    const delta = anchoredElement.getBoundingClientRect().top - rootTop - anchor.offsetTop;
    if (Math.abs(delta) >= 1) {
      root.scrollTop += delta;
    }
    return;
  }
  root.scrollTop = anchor.scrollTop;
}

export function measuredVirtualArticleWindow(input: {
  articleIds: string[];
  rowHeights: ReadonlyMap<string, number>;
  estimatedHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}): {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  offsets: number[];
} {
  const heights = input.articleIds.map((articleId) =>
    Math.max(1, Math.ceil(input.rowHeights.get(articleId) ?? input.estimatedHeight))
  );
  const offsets: number[] = [];
  let totalHeight = 0;
  for (const height of heights) {
    offsets.push(totalHeight);
    totalHeight += height;
  }

  const viewportTop = Math.max(0, input.scrollTop);
  const viewportBottom = viewportTop + Math.max(0, input.viewportHeight);
  const firstVisibleIndex = heights.findIndex(
    (height, index) => offsets[index] + height >= viewportTop
  );
  const visibleStart = firstVisibleIndex === -1 ? Math.max(0, input.articleIds.length - 1) : firstVisibleIndex;
  const firstAfterViewport = offsets.findIndex((offset) => offset > viewportBottom);
  const visibleEnd =
    firstAfterViewport === -1 ? input.articleIds.length : Math.max(visibleStart + 1, firstAfterViewport);

  return {
    startIndex: Math.max(0, visibleStart - input.overscan),
    endIndex: Math.min(input.articleIds.length, visibleEnd + input.overscan),
    totalHeight,
    offsets
  };
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

function supportsInfiniteArticleLoading(): boolean {
  return typeof IntersectionObserver !== "undefined";
}

function useInfiniteArticleLoading(props: {
  enabled: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void | Promise<void>;
  rootRef: RefObject<HTMLElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
}) {
  const onLoadMoreRef = useRef(props.onLoadMore);
  const isRequestingRef = useRef(false);

  useEffect(() => {
    onLoadMoreRef.current = props.onLoadMore;
  }, [props.onLoadMore]);

  useEffect(() => {
    if (!props.isLoadingMore) {
      isRequestingRef.current = false;
    }
  }, [props.hasMore, props.isLoadingMore, props.loadMoreError]);

  useEffect(() => {
    const root = props.rootRef.current;
    const sentinel = props.sentinelRef.current;
    if (!props.enabled || !props.hasMore || props.loadMoreError || !root || !sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || isRequestingRef.current) {
          return;
        }
        isRequestingRef.current = true;
        void onLoadMoreRef.current();
      },
      {
        root,
        rootMargin: "0px 0px 240px",
        threshold: 0
      }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [props.enabled, props.hasMore, props.loadMoreError, props.rootRef, props.sentinelRef]);
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

export function ArticleDetailPanel(props: {
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
  onPluginAction?: (action: PluginActionButton, context: PluginActionContext) => void;
  onBackToList: () => void;
  onCloseExplanation: () => void;
  onLoadRelatedArticles?: () => void;
  onOpenExplanation: () => void;
  onRetryPersonalizedRelated?: () => void;
  onSelectDiscoveryArticle?: (articleId: string) => void;
  onReadProgress: (
    articleId: string,
    progress: number,
    metadata: ReadProgressMetadata,
    options?: ReadProgressPostOptions
  ) => void;
  onRetryDetail?: () => void;
  pendingAction: ArticleActionIntent | null;
  pluginBottomActions?: PluginActionButton[];
  pluginToolbarActions?: PluginActionButton[];
  readerSettings: ReaderSettings;
  relatedDiscovery?: ReaderDiscoveryPanelState;
  personalizedDiscovery?: ReaderDiscoveryPanelState;
}) {
  const { t, formatArticleDate } = useI18n();
  const readerPanelRef = useRef<HTMLElement>(null);
  const [safeHtml, setSafeHtml] = useState<string | null>(null);
  const sourceNotice = props.article ? contentSourceNotice(props.article, t) : null;
  const showReaderActions = useReaderActionVisibility(readerPanelRef, props.article?.id ?? null);
  const canExplainDetail = shouldLoadRankExplanation(props.articleView);
  const originalArticleUrl = safeOriginalArticleUrl(props.article?.url ?? null);

  useReaderReadProgress({
    article: props.article,
    onReadProgress: props.onReadProgress,
    scrollContainerRef: readerPanelRef
  });

  useEffect(() => {
    const article = props.article;
    if (!article?.contentHtml) {
      setSafeHtml(null);
      return;
    }

    const cacheKey = `${article.id}:${article.contentHtml.length}:${article.url}`;
    const cached = sanitizedArticleHtmlCache.get(cacheKey);
    if (cached) {
      setSafeHtml(cached);
      return;
    }

    let cancelled = false;
    setSafeHtml(null);
    const timeoutId = window.setTimeout(() => {
      const nextSafeHtml = sanitizeArticleHtml(article.contentHtml ?? "", article.url);
      sanitizedArticleHtmlCache.set(cacheKey, nextSafeHtml);
      if (!cancelled) {
        setSafeHtml(nextSafeHtml);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [props.article?.contentHtml, props.article?.id, props.article?.url]);

  return (
    <section
      className={styles.readerPanel}
      data-testid="reader-scroll-container"
      ref={readerPanelRef}
      style={readerStyleFor(props.readerSettings)}
      aria-labelledby="reader-title"
    >
      {props.isDetailLoading && !props.article ? <ReaderSkeleton /> : null}

      {!props.isDetailLoading && props.detailError ? (
        <div className={styles.readerDetailError}>
          <p className={styles.errorText}>{props.detailError}</p>
          <div className={styles.readerDetailErrorActions}>
            <button
              className={styles.secondaryButton}
              onClick={props.onRetryDetail}
              type="button"
            >
              {t.reader.reload}
            </button>
            {originalArticleUrl ? (
              <a
                className={styles.secondaryButton}
                href={originalArticleUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t.reader.originalLink}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {!props.isDetailLoading && !props.detailError && !props.article ? (
        <EmptyState title={t.reader.selectArticleTitle} body={t.reader.selectArticleBody} />
      ) : null}

      {!props.detailError && props.article ? (
        <article className={styles.reader} data-reader-theme={props.readerSettings.theme}>
          <header className={styles.readerHeader}>
            <div className={styles.readerHeaderActions}>
              <button className={styles.secondaryButton} onClick={props.onBackToList} type="button">
                {t.reader.backToList}
              </button>
              {originalArticleUrl ? (
                <a
                  className={styles.secondaryButton}
                  href={originalArticleUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t.reader.originalLink}
                </a>
              ) : null}
            </div>
            <h2 id="reader-title">{props.article.title}</h2>
            <p>
              {t.reader.meta(
                props.article.feedTitle,
                props.article.publishedAt
                  ? formatArticleDate(props.article.publishedAt)
                  : undefined,
                props.article.author
              )}
            </p>
            <div className={styles.readerHeaderToolbar}>
              {sourceNotice ? (
                <span className={styles.inlineNotice}>{sourceNotice}</span>
              ) : <span />}
              <ArticleActionControls
                actionError={props.actionError}
                article={props.article}
                canExplain={canExplainDetail}
                onExplain={props.onOpenExplanation}
                onAction={(intent) => props.onArticleAction(props.article as ArticleDetail, intent)}
                onPluginAction={(action) =>
                  props.onPluginAction?.(action, { articleId: props.article?.id, slot: action.slot })
                }
                pendingAction={props.pendingAction}
                placement="top"
                pluginActions={props.pluginToolbarActions ?? []}
              />
            </div>
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
            onPluginAction={(action) =>
              props.onPluginAction?.(action, { articleId: props.article?.id, slot: action.slot })
            }
            pendingAction={props.pendingAction}
            placement="bottom"
            pluginActions={props.pluginBottomActions ?? []}
          />
          <ReaderDiscoverySections
            onLoadRelatedArticles={props.onLoadRelatedArticles}
            onRetryPersonalizedRelated={props.onRetryPersonalizedRelated}
            onSelectArticle={props.onSelectDiscoveryArticle}
            personalized={props.personalizedDiscovery ?? idleReaderDiscoveryState}
            related={props.relatedDiscovery ?? idleReaderDiscoveryState}
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

function ReaderDiscoverySections(props: {
  personalized: ReaderDiscoveryPanelState;
  related: ReaderDiscoveryPanelState;
  onLoadRelatedArticles?: () => void;
  onRetryPersonalizedRelated?: () => void;
  onSelectArticle?: (articleId: string) => void;
}) {
  return (
    <section className={styles.readerDiscovery} aria-label="Reader discovery">
      <PersonalizedDiscoverySection
        onRetry={props.onRetryPersonalizedRelated}
        onSelectArticle={props.onSelectArticle}
        state={props.personalized}
      />
      <RelatedDiscoverySection
        onLoad={props.onLoadRelatedArticles}
        onSelectArticle={props.onSelectArticle}
        state={props.related}
      />
    </section>
  );
}

function PersonalizedDiscoverySection(props: {
  state: ReaderDiscoveryPanelState;
  onRetry?: () => void;
  onSelectArticle?: (articleId: string) => void;
}) {
  const { t } = useI18n();
  const { discovery } = t.reader;

  if (props.state.status === "idle") {
    return null;
  }

  return (
    <section className={styles.readerDiscoveryBlock} aria-live="polite">
      <div className={styles.readerDiscoveryHeader}>
        <h3>{discovery.personalizedTitle}</h3>
      </div>
      {props.state.status === "loading" ? (
        <p className={styles.readerDiscoveryMeta}>{discovery.personalizedLoading}</p>
      ) : null}
      {props.state.status === "error" ? (
        <ReaderDiscoveryRetryMessage
          message={discovery.personalizedError}
          onRetry={props.onRetry}
        />
      ) : null}
      {props.state.status === "unavailable" ? (
        <p className={styles.readerDiscoveryMeta}>
          {discoveryUnavailableMessage(props.state.reason, t)}
        </p>
      ) : null}
      {props.state.status === "ready" ? (
        props.state.items.length > 0 ? (
          <ReaderDiscoveryArticleList
            items={props.state.items}
            onSelectArticle={props.onSelectArticle}
          />
        ) : (
          <p className={styles.readerDiscoveryMeta}>{discovery.personalizedEmpty}</p>
        )
      ) : null}
    </section>
  );
}

function RelatedDiscoverySection(props: {
  state: ReaderDiscoveryPanelState;
  onLoad?: () => void;
  onSelectArticle?: (articleId: string) => void;
}) {
  const { t } = useI18n();
  const { discovery } = t.reader;

  return (
    <section className={styles.readerDiscoveryBlock} aria-live="polite">
      <div className={styles.readerDiscoveryHeader}>
        <div>
          <h3>
            {props.state.status === "ready" && props.state.items.length > 0
              ? discovery.relatedTitle
              : discovery.relatedPrompt}
          </h3>
          {props.state.status === "idle" || props.state.status === "error" ? (
            <p>{discovery.relatedIntro}</p>
          ) : null}
        </div>
        {props.state.status === "idle" || props.state.status === "error" ? (
          <button
            className={styles.secondaryButton}
            onClick={props.onLoad}
            type="button"
          >
            <ActionIcon name="search" />
            <span>{props.state.status === "error" ? discovery.retry : discovery.relatedButton}</span>
          </button>
        ) : null}
      </div>
      {props.state.status === "loading" ? (
        <p className={styles.readerDiscoveryMeta}>{discovery.relatedLoading}</p>
      ) : null}
      {props.state.status === "error" ? (
        <p className={styles.readerDiscoveryError}>{discovery.relatedError}</p>
      ) : null}
      {props.state.status === "unavailable" ? (
        <p className={styles.readerDiscoveryMeta}>
          {discoveryUnavailableMessage(props.state.reason, t)}
        </p>
      ) : null}
      {props.state.status === "ready" ? (
        props.state.items.length > 0 ? (
          <ReaderDiscoveryArticleList
            items={props.state.items}
            onSelectArticle={props.onSelectArticle}
          />
        ) : (
          <p className={styles.readerDiscoveryMeta}>{discovery.relatedEmpty}</p>
        )
      ) : null}
    </section>
  );
}

function ReaderDiscoveryRetryMessage(props: {
  message: string;
  onRetry?: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className={styles.readerDiscoveryRetry}>
      <p className={styles.readerDiscoveryError}>{props.message}</p>
      <button className={styles.secondaryButton} onClick={props.onRetry} type="button">
        {t.reader.discovery.retry}
      </button>
    </div>
  );
}

function ReaderDiscoveryArticleList(props: {
  items: ArticleListItem[];
  onSelectArticle?: (articleId: string) => void;
}) {
  const { formatArticleDate } = useI18n();

  return (
    <div className={styles.readerDiscoveryList}>
      {props.items.map((item) => (
        <button
          className={styles.readerDiscoveryItem}
          key={item.id}
          onClick={() => props.onSelectArticle?.(item.id)}
          type="button"
        >
          <span className={styles.readerDiscoveryItemTitle}>{item.title}</span>
          <span className={styles.readerDiscoveryItemMeta}>
            {[item.feedTitle, item.publishedAt ? formatArticleDate(item.publishedAt) : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {item.summary ? (
            <span className={styles.readerDiscoveryItemSummary}>
              {truncateDiscoverySummary(plainTextSummary(item.summary))}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function truncateDiscoverySummary(value: string): string {
  return value.length > 150 ? `${value.slice(0, 150)}...` : value;
}

function discoveryUnavailableMessage(
  reason: ReaderDiscoveryUnavailableReason | undefined,
  t: Dictionary
): string {
  return t.reader.discovery.unavailable[reason ?? "article_embedding_missing"];
}

function ArticleRowActions(props: {
  article: ArticleActionTarget;
  canExplain: boolean;
  onAction: (intent: ArticleActionIntent) => void;
  onExplain: () => void;
  onPluginAction?: (action: PluginActionButton) => void;
  pendingAction: ArticleActionIntent | null;
  pluginActions?: PluginActionButton[];
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
      <PluginActionButtons actions={props.pluginActions ?? []} onRun={props.onPluginAction} />
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
  onPluginAction?: (action: PluginActionButton) => void;
  pendingAction: ArticleActionIntent | null;
  placement?: "top" | "bottom";
  pluginActions?: PluginActionButton[];
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
        <PluginActionButtons actions={props.pluginActions ?? []} onRun={props.onPluginAction} />
      </div>
      {props.actionError ? <p className={styles.actionError}>{props.actionError}</p> : null}
    </div>
  );
}

function PluginActionButtons(props: {
  actions: PluginActionButton[];
  onRun?: (action: PluginActionButton) => void;
}) {
  if (props.actions.length === 0) {
    return null;
  }

  return (
    <>
      {props.actions.map((action) => (
        <button
          aria-label={action.label}
          className={classNames(styles.actionButton, styles.actionExplain)}
          key={`${action.pluginId}:${action.id}`}
          onClick={() => props.onRun?.(action)}
          title={`${action.pluginName}: ${action.label}`}
          type="button"
        >
          <ActionIcon name={iconNameForPluginAction(action.icon)} />
        </button>
      ))}
    </>
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

export function ArticleExplanationDialog(props: {
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

function iconNameForPluginAction(icon: string | undefined): ActionIconName {
  if (icon === "bookmark") {
    return "bookmark";
  }
  if (icon === "dismiss" || icon === "x") {
    return "dismiss";
  }
  if (icon === "gear" || icon === "settings") {
    return "gear";
  }
  if (icon === "like" || icon === "thumbs-up") {
    return "like";
  }
  if (icon === "search") {
    return "search";
  }
  if (icon === "sparkle" || icon === "sparkles") {
    return "sparkle";
  }
  if (icon === "star") {
    return "star";
  }
  return "feed";
}

export function NavigationIcon(props: { item: NavigationItemKey }) {
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

export function ActionIcon(props: { name: ActionIconName }) {
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
