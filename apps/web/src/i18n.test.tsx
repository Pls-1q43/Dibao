import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  App,
  AlgorithmTransparencyPage,
  ArticleActionControls,
  ArticleDetailPanel,
  ArticleExplanationEntry,
  ArticleListPanel,
  AuthGatePanel,
  FeedPanel,
  pageForNavigationItem,
  RankExplanationPanel,
  SettingsWorkspace,
  SetupProviderPanel,
  SetupSourcesPanel,
  SetupWelcomePanel,
  correctSourceSelection,
  readerStyleFor,
  stageForAuthSession,
  stageForSetupStatus
} from "./App.js";
import {
  articleListAfterStateUpdate,
  articleListWithKnownLocalStates,
  articlesVisibleForUnreadFilter,
  unreadCountWithKnownLocalStates,
  unreadCountAfterStateChange
} from "./articleListState.js";
import { defaultAppSettings, type ArticleDetail, type ArticleListItem, type EmbeddingProvider } from "./api.js";
import { FeedManagementWorkspace } from "./FeedManagementPanel.js";
import {
  DibaoI18nProvider,
  browserPreferredLocale,
  createI18n,
  defaultLocale,
  dictionaries,
  supportedLocales
} from "./i18n.js";

describe("web i18n", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps dictionary key structure aligned across locales", () => {
    const [baseLocale, ...otherLocales] = supportedLocales;
    const baseShape = dictionaryShape(dictionaries[baseLocale]);

    for (const locale of otherLocales) {
      expect(dictionaryShape(dictionaries[locale])).toEqual(baseShape);
    }
  });

  it("uses zh-CN defaults for copy and date formatting", () => {
    const i18n = createI18n();

    expect(i18n.locale).toBe(defaultLocale);
    expect(i18n.t.errors.api.requestFailed).toBe("请求失败，请稍后重试。");
    expect(i18n.t.errors.api.requestTimeout).toBe("请求超时。系统可能正在处理后台维护，请稍后重试。");
    expect(i18n.formatDate("2026-05-14T08:00:00.000Z")).not.toBe("2026-05-14T08:00:00.000Z");
    expect(i18n.formatArticleDate("2026-05-14T08:00:00.000Z")).toContain("2026");
  });

  it("chooses the initial locale from browser languages when available", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      languages: ["ja-JP", "en-US"],
      language: "ja-JP"
    });

    expect(browserPreferredLocale()).toBe("ja-JP");
  });

  it("renders App auth loading with dictionary copy for a non-default locale", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider locale="en-US">
        <App />
      </DibaoI18nProvider>
    );

    expect(html).toContain("Checking your session");
    expect(html).toContain("Dibao");
    expect(html).not.toContain("正在检查登录状态");
  });

  it("maps auth and setup status to first-run stages", () => {
    expect(
      stageForAuthSession({
        setupCompleted: false,
        authenticated: false,
        username: null
      })
    ).toEqual({ type: "welcome" });
    expect(
      stageForAuthSession({
        setupCompleted: true,
        authenticated: false,
        username: null
      })
    ).toEqual({ type: "login" });
    expect(
      stageForSetupStatus({
        setupCompleted: true,
        hasFeeds: false,
        hasEmbeddingProvider: false,
        firstRefreshStatus: "idle"
      })
    ).toEqual({ type: "setup-sources" });
    expect(
      stageForSetupStatus({
        setupCompleted: true,
        hasFeeds: true,
        hasEmbeddingProvider: false,
        firstRefreshStatus: "idle"
      })
    ).toEqual({ type: "reader" });
  });

  it("corrects source selection when feeds or folders disappear", () => {
    expect(
      correctSourceSelection(
        { type: "feed", feedId: "feed_missing" },
        [{ id: "feed_design" }],
        [{ id: "folder_design" }]
      )
    ).toEqual({ type: "all" });
    expect(
      correctSourceSelection(
        { type: "folder", folderId: "folder_missing" },
        [{ id: "feed_design" }],
        [{ id: "folder_design" }]
      )
    ).toEqual({ type: "all" });
    expect(
      correctSourceSelection(
        { type: "feed", feedId: "feed_design" },
        [{ id: "feed_design" }],
        [{ id: "folder_design" }]
      )
    ).toEqual({ type: "feed", feedId: "feed_design" });
  });

  it("maps favorites and read-later navigation to article views", () => {
    expect(pageForNavigationItem("favorites")).toEqual({ type: "reader", view: "favorites" });
    expect(pageForNavigationItem("read_later")).toEqual({ type: "reader", view: "read_later" });
  });

  it("keeps unread-only initial loads strict while preserving the current queue after state updates", () => {
    const unreadArticle = articleListItem("article_unread", "unseen");
    const ignoredArticle = articleListItem("article_ignored", "ignored");

    expect(
      articlesVisibleForUnreadFilter([unreadArticle, ignoredArticle], true).map(
        (article) => article.id
      )
    ).toEqual(["article_unread"]);
    expect(
      articleListAfterStateUpdate(
        [unreadArticle],
        "article_unread",
        {
          ...unreadArticle.state,
          interactionStatus: "ignored",
          ignoredAt: Date.parse("2026-05-14T08:30:00.000Z")
        }
      )[0].state.interactionStatus
    ).toBe("ignored");
    expect(
      articleListAfterStateUpdate(
        [unreadArticle],
        "article_unread",
        {
          ...unreadArticle.state,
          interactionStatus: "ignored",
          ignoredAt: Date.parse("2026-05-14T08:30:00.000Z")
        }
      )[0].state.interactionStatus
    ).toBe("ignored");
    expect(
      unreadCountAfterStateChange(12, unreadArticle.state, {
        ...unreadArticle.state,
        interactionStatus: "opened",
        openedAt: Date.parse("2026-05-14T08:31:00.000Z")
      })
    ).toBe(11);
    expect(
      unreadCountAfterStateChange(11, unreadArticle.state, {
        ...unreadArticle.state,
        hidden: true
      })
    ).toBe(10);
  });

  it("preserves locally updated article states when a stale list response arrives late", () => {
    const staleUnreadArticle = articleListItem("article_unread", "unseen");
    const openedState = {
      ...staleUnreadArticle.state,
      interactionStatus: "opened" as const,
      openedAt: Date.parse("2026-05-14T08:31:00.000Z")
    };
    const knownStates = new Map([[staleUnreadArticle.id, openedState]]);
    const locallyUpdatedIds = new Set([staleUnreadArticle.id]);

    expect(
      articleListWithKnownLocalStates(
        [staleUnreadArticle],
        knownStates,
        locallyUpdatedIds
      )[0].state
    ).toMatchObject({
      interactionStatus: "opened",
      openedAt: openedState.openedAt
    });
    expect(
      unreadCountWithKnownLocalStates(
        12,
        [staleUnreadArticle],
        knownStates,
        locallyUpdatedIds
      )
    ).toBe(11);
  });

  it("keeps non-unseen article states from rendering the unread strip", () => {
    const css = readFileSync(
      new URL("./design-system/AppShell/AppShell.module.css", import.meta.url),
      "utf8"
    );
    const subtleStripRule = css.slice(
      css.indexOf(".articleItemRead,"),
      css.indexOf("--article-strip-background: var(--color-line-subtle);")
    );

    for (const status of ["opened", "reading", "saved", "seen", "read"]) {
      expect(subtleStripRule).toContain(`.articleItem[data-interaction-status="${status}"]`);
      expect(subtleStripRule).toContain(
        `.articleItemActive[data-interaction-status="${status}"]`
      );
    }
  });

  it("renders setup and login auth gate copy from the dictionary", () => {
    const setupHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <AuthGatePanel isSubmitting={false} mode="setup" onSubmit={() => undefined} />
      </DibaoI18nProvider>
    );
    const loginHtml = renderToStaticMarkup(
      <DibaoI18nProvider locale="en-US">
        <AuthGatePanel
          error="Invalid password"
          isSubmitting={false}
          mode="login"
          onSubmit={() => undefined}
        />
      </DibaoI18nProvider>
    );

    expect(setupHtml).toContain("设置用户名和访问密码");
    expect(setupHtml).toContain("用户名");
    expect(setupHtml).toContain("完成设置");
    expect(loginHtml).toContain("Log in to Dibao");
    expect(loginHtml).toContain("Invalid password");
  });

  it("renders localized auth loading errors with retry actions", () => {
    const zhHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <AuthGatePanel
          error="无法连接实例"
          isSubmitting={false}
          mode="loading"
          onRetryLoading={() => undefined}
        />
      </DibaoI18nProvider>
    );
    const enHtml = renderToStaticMarkup(
      <DibaoI18nProvider locale="en-US">
        <AuthGatePanel
          error="Network unavailable"
          isSubmitting={false}
          loadingLabel={dictionaries["en-US"].auth.setupStatusLoading}
          mode="loading"
          onRetryLoading={() => undefined}
          retryLoadingLabel={dictionaries["en-US"].auth.retry}
        />
      </DibaoI18nProvider>
    );
    const jaHtml = renderToStaticMarkup(
      <DibaoI18nProvider locale="ja-JP">
        <AuthGatePanel
          error="ネットワークに接続できません"
          isSubmitting={false}
          mode="loading"
          onRetryLoading={() => undefined}
        />
      </DibaoI18nProvider>
    );

    expect(zhHtml).toContain("正在检查登录状态");
    expect(zhHtml).toContain("无法连接实例");
    expect(zhHtml).toContain("重新检查");
    expect(enHtml).toContain("Checking instance status");
    expect(enHtml).toContain("Network unavailable");
    expect(enHtml).toContain("Retry check");
    expect(jaHtml).toContain("ログイン状態を確認しています");
    expect(jaHtml).toContain("ネットワークに接続できません");
    expect(jaHtml).toContain("再確認");
  });

  it("renders first-run wizard with provider configuration and skip fallback", () => {
    const welcomeHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <SetupWelcomePanel onStart={() => undefined} />
      </DibaoI18nProvider>
    );
    const sourcesHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <SetupSourcesPanel
          discovery={null}
          discoveryError={null}
          error={null}
          feedUrl=""
          isAddingFeed={false}
          isDiscoveringFeeds={false}
          isImportingOpml={false}
          onAddCandidate={() => undefined}
          onAddFeed={() => undefined}
          onImportOpml={() => undefined}
          onUpdateFeedUrl={() => undefined}
          opmlSummary={null}
        />
      </DibaoI18nProvider>
    );
    const providerHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <SetupProviderPanel
          activatingProviderId={null}
          embeddingError={null}
          embeddingProviders={[]}
          isEmbeddingLoading={false}
          isSavingEmbeddingProvider={false}
          testingProviderId={null}
          onActivateEmbeddingProvider={() => Promise.resolve(true)}
          onContinue={() => undefined}
          onSaveEmbeddingProvider={() => Promise.resolve(null)}
          onTestEmbeddingProvider={() => Promise.resolve()}
        />
      </DibaoI18nProvider>
    );
    const providerEnglishHtml = renderToStaticMarkup(
      <DibaoI18nProvider locale="en-US">
        <SetupProviderPanel
          activatingProviderId={null}
          embeddingError={null}
          embeddingProviders={[]}
          isEmbeddingLoading={false}
          isSavingEmbeddingProvider={false}
          testingProviderId={null}
          onActivateEmbeddingProvider={() => Promise.resolve(true)}
          onContinue={() => undefined}
          onSaveEmbeddingProvider={() => Promise.resolve(null)}
          onTestEmbeddingProvider={() => Promise.resolve()}
        />
      </DibaoI18nProvider>
    );
    const providerJapaneseHtml = renderToStaticMarkup(
      <DibaoI18nProvider locale="ja-JP">
        <SetupProviderPanel
          activatingProviderId={null}
          embeddingError={null}
          embeddingProviders={[]}
          isEmbeddingLoading={false}
          isSavingEmbeddingProvider={false}
          testingProviderId={null}
          onActivateEmbeddingProvider={() => Promise.resolve(true)}
          onContinue={() => undefined}
          onSaveEmbeddingProvider={() => Promise.resolve(null)}
          onTestEmbeddingProvider={() => Promise.resolve()}
        />
      </DibaoI18nProvider>
    );
    const testedProvider: EmbeddingProvider = {
      id: "provider_tested",
      type: "openai_compatible",
      name: "Test Provider",
      baseUrl: "https://example.com/v1",
      model: "text-embedding-3-small",
      dimension: 1536,
      textMaxChars: 8000,
      requestsPerMinute: null,
      requestsPerDay: null,
      enabled: false,
      qualityTier: "recommended",
      hasApiKey: true,
      lastTestStatus: "success",
      lastTestError: null,
      lastTestAt: "2026-05-28T06:44:11.354Z",
      createdAt: "2026-05-28T06:44:11.354Z",
      updatedAt: "2026-05-28T06:44:11.354Z"
    };
    const testedProviderHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <SetupProviderPanel
          activatingProviderId={null}
          embeddingError={null}
          embeddingProviders={[testedProvider]}
          isEmbeddingLoading={false}
          isSavingEmbeddingProvider={false}
          testingProviderId={null}
          onActivateEmbeddingProvider={() => Promise.resolve(true)}
          onContinue={() => undefined}
          onSaveEmbeddingProvider={() => Promise.resolve(null)}
          onTestEmbeddingProvider={() => Promise.resolve()}
        />
      </DibaoI18nProvider>
    );

    expect(welcomeHtml).toContain("欢迎使用邸报");
    expect(welcomeHtml).toContain("开始设置");
    expect(sourcesHtml).toContain("添加订阅源");
    expect(sourcesHtml).toContain("导入 OPML 文件");
    expect(sourcesHtml).toContain("网站或 RSS / Atom URL");
    expect(providerHtml).toContain("推荐能力");
    expect(providerHtml).toContain("查看这里选择合适的（免费）Provider。");
    expect(providerHtml).toContain("https://docs.dibao.app/zh/providers/");
    expect(providerHtml).toContain("跳过，使用基础排序");
    expect(providerHtml).toContain("保存配置并测试连接");
    expect(providerHtml).toContain("API Key");
    expect(providerHtml).toContain("Base URL");
    expect(providerHtml).toContain("模型");
    expect(providerHtml).toContain("切片长度");
    expect(testedProviderHtml).toContain("启用 Provider 并继续");
    expect(testedProviderHtml).not.toContain("保存配置并测试连接</button>");
    expect(testedProviderHtml).not.toContain("删除");
    expect(providerEnglishHtml).toContain("https://docs.dibao.app/en/providers/");
    expect(providerJapaneseHtml).toContain("https://docs.dibao.app/ja/providers/");
    expect(providerJapaneseHtml).not.toContain("README.ja.md");
  });

  it("renders OPML, folder, and pagination copy from the dictionary", () => {
    const feedPanel = renderToStaticMarkup(
      <DibaoI18nProvider>
        <FeedPanel
          diagnosticsByFeedId={{}}
          feedError={null}
          feedFolders={[
            {
              id: "folder_design",
              title: "设计",
              sortOrder: 0
            }
          ]}
          feeds={[
            {
              id: "feed_design",
              folderId: "folder_design",
              title: "Design Feed",
              siteUrl: null,
              feedUrl: "https://example.com/feed.xml",
              description: null,
              enabled: true,
              fullContentMode: "feed_only",
              sourceWeight: 0,
              lastFetchedAt: null,
              lastSuccessAt: null,
              nextRefreshAt: "2026-05-14T09:00:00.000Z",
              lastError: null,
              createdAt: "2026-05-14T08:00:00.000Z",
              updatedAt: "2026-05-14T08:00:00.000Z"
            }
          ]}
          isOpen={false}
          isFeedsLoading={false}
          onRefreshFeed={() => undefined}
          onCloseSources={() => undefined}
          onSelectSource={() => undefined}
          refreshingFeedId={null}
          sourceSelection={{ type: "all" }}
        />
      </DibaoI18nProvider>
    );
    const articlePanel = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleListPanel
          articleError={null}
          articleView="latest"
          articles={[]}
          favoriteSort="favorited_desc"
          readLaterSort="ranked"
          feedCount={1}
          isIgnoreTelemetryEnabled={true}
          isArticlesLoading={false}
          isLoadingMore={false}
          isMarkingScopeRead={false}
          isRecommendationStatusLoading={false}
          loadMoreError={null}
          nextCursor="cursor_1"
          onFavoriteSortChange={() => undefined}
          onReadLaterSortChange={() => undefined}
          onIgnoreArticle={() => undefined}
          onLoadMore={() => undefined}
          onMarkScopeRead={() => undefined}
          onPreviewMarkScopeRead={async () => 0}
          onOpenSources={() => undefined}
          onExplainArticle={() => undefined}
          onSelectArticle={() => undefined}
          onTimeWindowChange={() => undefined}
          onUnreadOnlyChange={() => undefined}
          recommendationStatus={null}
          recommendationStatusError={null}
          readerCommandError={null}
          selectedArticleId={null}
          selectedFeed={null}
          selectedFolder={{
            id: "folder_design",
            title: "设计",
            sortOrder: 0
          }}
          showRecommendationStatus={false}
          showQuickFilters={true}
          timeWindow="all"
          unreadCount={12}
          unreadOnly={false}
        />
      </DibaoI18nProvider>
    );

    expect(feedPanel).not.toContain("导入 OPML");
    expect(feedPanel).not.toContain("导出 OPML");
    expect(feedPanel).not.toContain("刷新全部");
    expect(feedPanel).toContain("下次抓取");
    expect(feedPanel).toContain("分组");
    expect(feedPanel).toContain('title="刷新 Design Feed"');
    expect(articlePanel).toContain("只看未读");
    expect(articlePanel).toContain("全部");
    expect(articlePanel).toContain("加载更多");
    expect(articlePanel).toContain("设计");
    expect(articlePanel).toContain('aria-label="打开来源: 设计"');
    expect(articlePanel).toContain('aria-pressed="true"');
  });

  it("renders recommendation inventory status trigger collapsed by default", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleListPanel
          articleError={null}
          articleView="recommended"
          articles={[]}
          favoriteSort="favorited_desc"
          readLaterSort="ranked"
          feedCount={1}
          isIgnoreTelemetryEnabled={true}
          isArticlesLoading={false}
          isLoadingMore={false}
          isMarkingScopeRead={false}
          isRecommendationStatusLoading={false}
          loadMoreError={null}
          nextCursor={null}
          onFavoriteSortChange={() => undefined}
          onReadLaterSortChange={() => undefined}
          onIgnoreArticle={() => undefined}
          onLoadMore={() => undefined}
          onMarkScopeRead={() => undefined}
          onPreviewMarkScopeRead={async () => 0}
          onOpenSources={() => undefined}
          onExplainArticle={() => undefined}
          onSelectArticle={() => undefined}
          onTimeWindowChange={() => undefined}
          onUnreadOnlyChange={() => undefined}
          recommendationStatus={{
            mode: "embedding",
            activeProvider: null,
            activeIndex: null,
            activeRankContext: "base",
            coverage: {
              candidateCount: 4,
              embeddingCount: 2,
              coverageRatio: 0.5,
              pendingJobs: 1,
              failedJobs: 0,
              lastFailedAt: null,
              lastError: null
            },
            behaviorCounts: {
              open: 2,
              read_progress: 1
            },
            clusters: {
              positive: 1,
              negative: 0
            },
            rankedArticles: {
              base: 4,
              active: 2
            },
            lastProfileUpdate: "2026-05-14T08:09:00.000Z",
            lastRankingUpdate: "2026-05-14T08:11:00.000Z",
            warnings: [
              {
                code: "PROFILE_WARMUP",
                message: "The recommendation profile still has limited behavior and interest signals."
              }
            ]
          }}
          recommendationInventory={{
            status: "available",
            activeRankContext: "rec_v3:test",
            latestRerankWindowId: "window:new",
            eligibleCount: 8,
            sortedCount: 6,
            remainingSortedCount: 4,
            latestActiveCount: 5,
            staleActiveCount: 1,
            fallbackCount: 2,
            baseFallbackCount: 1,
            unrankedFallbackCount: 1,
            loadedCount: 2,
            rankingJob: {
              queued: 0,
              running: 0
            },
            lastRankedAt: "2026-05-14T08:11:00.000Z",
            updatedAt: "2026-05-14T08:12:00.000Z"
          }}
          recommendationInventoryError={null}
          recommendationStatusError={null}
          readerCommandError={null}
          selectedArticleId={null}
          selectedFeed={null}
          selectedFolder={null}
          showRecommendationStatus
          showQuickFilters={true}
          timeWindow="all"
          unreadCount={3}
          unreadOnly={true}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("查看推荐库存：有库存");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("有库存");
    expect(html).not.toContain("<strong>4</strong>");
    expect(html).not.toContain("剩余已排序");
    expect(html).not.toContain("系统摘要");
    expect(html).not.toContain("行为 3");
    expect(html).not.toContain("Coverage 50%");
    expect(html).not.toContain("兴趣簇 +1 / -0");
    expect(html).not.toContain(
      "当前用户行为正在积累中，推荐可能不准确，建议在“最新”视图中当做普通 RSS 阅读器正常使用。"
    );
  });

  it("renders article summaries as plain text in the list", () => {
    const article: ArticleListItem = {
      id: "article_html_summary",
      feedId: "feed_design",
      feedTitle: "Design Feed",
      title: "HTML summary",
      url: "https://example.com/article",
      author: null,
      summary: "<p>摘要 <strong>正文</strong> &amp; 线索</p>",
      publishedAt: "2026-05-14T08:00:00.000Z",
      discoveredAt: "2026-05-14T08:00:00.000Z",
      state: {
        read: false,
        favorited: false,
        liked: false,
        readLater: false,
        hidden: false,
        notInterested: false,
        readingProgress: 0,
        interactionStatus: "unseen",
        openedAt: null,
        ignoredAt: null
      }
    };
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleListPanel
          articleError={null}
          articleView="latest"
          articles={[article]}
          favoriteSort="favorited_desc"
          readLaterSort="ranked"
          feedCount={1}
          isIgnoreTelemetryEnabled={false}
          isArticlesLoading={false}
          isLoadingMore={false}
          isMarkingScopeRead={false}
          isRecommendationStatusLoading={false}
          loadMoreError={null}
          nextCursor={null}
          onFavoriteSortChange={() => undefined}
          onReadLaterSortChange={() => undefined}
          onIgnoreArticle={() => undefined}
          onLoadMore={() => undefined}
          onMarkScopeRead={() => undefined}
          onPreviewMarkScopeRead={async () => 0}
          onOpenSources={() => undefined}
          onExplainArticle={() => undefined}
          onSelectArticle={() => undefined}
          onTimeWindowChange={() => undefined}
          onUnreadOnlyChange={() => undefined}
          recommendationStatus={null}
          recommendationStatusError={null}
          readerCommandError={null}
          selectedArticleId={null}
          selectedFeed={null}
          selectedFolder={null}
          showRecommendationStatus={false}
          showQuickFilters={true}
          timeWindow="all"
          unreadCount={1}
          unreadOnly={false}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("摘要 正文 &amp; 线索");
    expect(html).toContain("2026");
    expect(html).not.toContain("&lt;strong&gt;");
  });

  it("renders article detail metadata with the publication year", () => {
    const article: ArticleDetail = {
      ...articleListItem("article_detail_year", "unseen"),
      feedTitle: "Design Feed",
      title: "Detail with year",
      author: "Reporter",
      contentHtml: null,
      contentText: "Full text",
      extractionStatus: "success",
      extractionError: null
    };

    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleDetailPanel
          actionError={null}
          article={article}
          articleView="latest"
          detailError={null}
          explanation={null}
          explanationError={null}
          isDetailLoading={false}
          isExplanationLoading={false}
          isExplanationOpen={false}
          onArticleAction={() => undefined}
          onBackToList={() => undefined}
          onCloseExplanation={() => undefined}
          onOpenExplanation={() => undefined}
          onReadProgress={() => undefined}
          onRetryDetail={() => undefined}
          pendingAction={null}
          readerSettings={defaultAppSettings.reader}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("Design Feed");
    expect(html).toContain("2026");
    expect(html).toContain("Reporter");
    expect(html).toContain("返回列表");
    expect(html).toContain("原文");
  });

  it("renders a localized retry action when article detail loading fails", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleDetailPanel
          actionError={null}
          article={null}
          articleView="latest"
          detailError="请求超时"
          explanation={null}
          explanationError={null}
          isDetailLoading={false}
          isExplanationLoading={false}
          isExplanationOpen={false}
          onArticleAction={() => undefined}
          onBackToList={() => undefined}
          onCloseExplanation={() => undefined}
          onOpenExplanation={() => undefined}
          onReadProgress={() => undefined}
          onRetryDetail={() => undefined}
          pendingAction={null}
          readerSettings={defaultAppSettings.reader}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("请求超时");
    expect(html).toContain("重新加载");
  });

  it("only renders row recommendation explain actions for personalized views", () => {
    const article = articleListItem("article_fixture", "unseen");
    const latestHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleListPanel
          articleError={null}
          articleView="latest"
          articles={[article]}
          favoriteSort="favorited_desc"
          readLaterSort="ranked"
          feedCount={1}
          isIgnoreTelemetryEnabled={false}
          isArticlesLoading={false}
          isLoadingMore={false}
          isMarkingScopeRead={false}
          isRecommendationStatusLoading={false}
          loadMoreError={null}
          nextCursor={null}
          onFavoriteSortChange={() => undefined}
          onReadLaterSortChange={() => undefined}
          onIgnoreArticle={() => undefined}
          onLoadMore={() => undefined}
          onMarkScopeRead={() => undefined}
          onPreviewMarkScopeRead={async () => 0}
          onOpenSources={() => undefined}
          onExplainArticle={() => undefined}
          onSelectArticle={() => undefined}
          onTimeWindowChange={() => undefined}
          onUnreadOnlyChange={() => undefined}
          recommendationStatus={null}
          recommendationStatusError={null}
          readerCommandError={null}
          selectedArticleId={null}
          selectedFeed={null}
          selectedFolder={null}
          showRecommendationStatus={false}
          showQuickFilters={true}
          timeWindow="all"
          unreadCount={1}
          unreadOnly={false}
        />
      </DibaoI18nProvider>
    );
    const recommendedHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleListPanel
          articleError={null}
          articleView="recommended"
          articles={[article]}
          favoriteSort="favorited_desc"
          readLaterSort="ranked"
          feedCount={1}
          isIgnoreTelemetryEnabled={false}
          isArticlesLoading={false}
          isLoadingMore={false}
          isMarkingScopeRead={false}
          isRecommendationStatusLoading={false}
          loadMoreError={null}
          nextCursor={null}
          onFavoriteSortChange={() => undefined}
          onReadLaterSortChange={() => undefined}
          onIgnoreArticle={() => undefined}
          onLoadMore={() => undefined}
          onMarkScopeRead={() => undefined}
          onPreviewMarkScopeRead={async () => 0}
          onOpenSources={() => undefined}
          onExplainArticle={() => undefined}
          onSelectArticle={() => undefined}
          onTimeWindowChange={() => undefined}
          onUnreadOnlyChange={() => undefined}
          recommendationStatus={null}
          recommendationStatusError={null}
          readerCommandError={null}
          selectedArticleId={null}
          selectedFeed={null}
          selectedFolder={null}
          showRecommendationStatus={false}
          showQuickFilters={true}
          timeWindow="all"
          unreadCount={1}
          unreadOnly={false}
        />
      </DibaoI18nProvider>
    );

    expect(latestHtml).not.toContain("为什么推荐");
    expect(recommendedHtml).toContain("为什么推荐");
  });

  it("renders favorites and read-later sorting without unread-only controls", () => {
    const likedArticle = articleListItem("liked_article", "unseen");
    const favoriteHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleListPanel
          articleError={null}
          articleView="favorites"
          articles={[{ ...likedArticle, state: { ...likedArticle.state, liked: true } }]}
          favoriteSort="favorited_desc"
          readLaterSort="ranked"
          feedCount={1}
          isIgnoreTelemetryEnabled={false}
          isArticlesLoading={false}
          isLoadingMore={false}
          isMarkingScopeRead={false}
          isRecommendationStatusLoading={false}
          loadMoreError={null}
          nextCursor={null}
          onFavoriteSortChange={() => undefined}
          onReadLaterSortChange={() => undefined}
          onIgnoreArticle={() => undefined}
          onLoadMore={() => undefined}
          onMarkScopeRead={() => undefined}
          onPreviewMarkScopeRead={async () => 0}
          onOpenSources={() => undefined}
          onExplainArticle={() => undefined}
          onSelectArticle={() => undefined}
          onTimeWindowChange={() => undefined}
          onUnreadOnlyChange={() => undefined}
          recommendationStatus={null}
          recommendationStatusError={null}
          readerCommandError={null}
          selectedArticleId={null}
          selectedFeed={null}
          selectedFolder={null}
          showRecommendationStatus={false}
          showQuickFilters={false}
          timeWindow="all"
          unreadCount={1}
          unreadOnly={true}
        />
      </DibaoI18nProvider>
    );
    const readLaterHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleListPanel
          articleError={null}
          articleView="read_later"
          articles={[]}
          favoriteSort="favorited_desc"
          readLaterSort="ranked"
          feedCount={1}
          isIgnoreTelemetryEnabled={false}
          isArticlesLoading={false}
          isLoadingMore={false}
          isMarkingScopeRead={false}
          isRecommendationStatusLoading={false}
          loadMoreError={null}
          nextCursor={null}
          onFavoriteSortChange={() => undefined}
          onReadLaterSortChange={() => undefined}
          onIgnoreArticle={() => undefined}
          onLoadMore={() => undefined}
          onMarkScopeRead={() => undefined}
          onPreviewMarkScopeRead={async () => 0}
          onOpenSources={() => undefined}
          onExplainArticle={() => undefined}
          onSelectArticle={() => undefined}
          onTimeWindowChange={() => undefined}
          onUnreadOnlyChange={() => undefined}
          recommendationStatus={null}
          recommendationStatusError={null}
          readerCommandError={null}
          selectedArticleId={null}
          selectedFeed={null}
          selectedFolder={null}
          showRecommendationStatus={false}
          showQuickFilters={false}
          timeWindow="all"
          unreadCount={0}
          unreadOnly={true}
        />
      </DibaoI18nProvider>
    );

    expect(favoriteHtml).toContain("排序");
    expect(favoriteHtml).toContain("最近收藏");
    expect(favoriteHtml).not.toContain("已点赞");
    expect(favoriteHtml).not.toContain("只看未读");
    expect(readLaterHtml).toContain("稍后读");
    expect(readLaterHtml).toContain("排序");
    expect(readLaterHtml).toContain("个性化排序");
    expect(readLaterHtml).toContain("最近加入");
    expect(readLaterHtml).not.toContain("只看未读");
  });

  it("renders algorithm transparency diagnostics and standing explanation", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <AlgorithmTransparencyPage
          clusterLabelLexicon={null}
          error={null}
          isLoading={false}
          mergeCandidates={[]}
          onBack={() => undefined}
          onIgnoreCandidate={() => Promise.resolve()}
          onMergeCandidate={() => Promise.resolve()}
          onOpenAllClusters={() => undefined}
          onRunMaintenanceTask={() => Promise.resolve()}
          onUpdateClusterLabelLexicon={() => Promise.resolve()}
          onUpdateClusterLabel={() => Promise.resolve()}
          onUpdateFamilyLabel={() => Promise.resolve()}
          runningMaintenanceTask={null}
          status={{
            mode: "personalized",
            activeProvider: {
              id: "provider_1",
              type: "ollama",
              name: "Ollama",
              model: "bge-m3",
              dimension: 1024,
              lastTestStatus: "success",
              lastTestAt: "2026-05-14T08:00:00.000Z"
            },
            activeIndex: {
              id: "index_1",
              status: "active",
              model: "bge-m3",
              dimension: 1024
            },
            activeRankContext: "profile",
            coverage: {
              candidateCount: 10,
              embeddingCount: 8,
              coverageRatio: 0.8,
              pendingJobs: 0,
              failedJobs: 0,
              lastFailedAt: null,
              lastError: null
            },
            behaviorCounts: {
              like: 2,
              favorite: 1
            },
            clusters: {
              positive: 2,
              negative: 1,
              items: [
                {
                  id: "cluster_positive_design",
                  polarity: "positive",
                  label: null,
                  weight: 8,
                  sampleCount: 3,
                  diagnostics: {
                    supportArticleCount: 2,
                    supportEventCount: 3,
                    sourceCount: 1,
                    strongSignalCount: 1,
                    strongSignalRatio: 0.3333,
                    topSourceShare: 1,
                    averageSimilarity: 0.71,
                    maxSimilarity: 0.92,
                    overfitRisk: "high",
                    warnings: ["OVERFIT_RISK_HIGH", "SINGLE_SOURCE_DOMINANT"]
                  },
                  lastMatchedAt: "2026-05-14T08:08:00.000Z",
                  updatedAt: "2026-05-14T08:09:00.000Z"
                }
              ]
            },
            rankedArticles: {
              base: 10,
              active: 8
            },
            lastProfileUpdate: "2026-05-14T08:09:00.000Z",
            lastRankingUpdate: "2026-05-14T08:11:00.000Z",
            warnings: [
              {
                code: "LOW_COVERAGE",
                message: "Coverage is still warming up"
              }
            ]
          }}
          updatingClusterLexicon={false}
          updatingClusterLabelId={null}
          updatingFamilyLabelId={null}
          updatingMergeCandidateId={null}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("算法透明说明");
    expect(html).toContain("个性化推荐中");
    expect(html).toContain("当前推荐状态");
    expect(html).toContain("8 / 10 · 80%");
    expect(html).toContain("like: 2");
    expect(html).toContain("LOW_COVERAGE");
    expect(html).toContain("当前兴趣簇");
    expect(html).toContain("兴趣簇 #1");
    expect(html).toContain("权重 8");
    expect(html).toContain("过拟合风险高");
    expect(html).toContain("支撑文章 2");
    expect(html).toContain("SINGLE_SOURCE_DOMINANT");
    expect(html).toContain("用户模型卡");
    expect(html).toContain("Embedding");
    expect(html).toContain("MMR");
    expect(html).toContain("算法解释");
    expect(html).toContain("候选收集");
    expect(html).toContain("+8.0");
    expect(html).toContain("收藏：是资料库/书签");
    expect(html).toContain("fallback 到基础排序");
  });

  it("renders feed management fields without provider configuration copy", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <FeedManagementWorkspace
          diagnostics={null}
          diagnosticsByFeedId={{}}
          feedDiscovery={null}
          feedDiscoveryError={null}
          feedError={null}
          feedUrl=""
          feedFolders={[
            {
              id: "folder_design",
              title: "设计",
              sortOrder: 0
            }
          ]}
          feeds={[
            {
              id: "feed_design",
              folderId: "folder_design",
              title: "Design Feed",
              siteUrl: null,
              feedUrl: "https://example.com/feed.xml",
              description: null,
              enabled: true,
              fullContentMode: "feed_only",
              sourceWeight: 0.2,
              lastFetchedAt: "2026-05-14T08:00:00.000Z",
              lastSuccessAt: "2026-05-14T08:10:00.000Z",
              nextRefreshAt: "2026-05-14T09:00:00.000Z",
              lastError: "403 Forbidden",
              createdAt: "2026-05-14T08:00:00.000Z",
              updatedAt: "2026-05-14T08:00:00.000Z"
            }
          ]}
          isAddingFeed={false}
          isDiscoveringFeeds={false}
          isFeedDiagnosticsLoading={false}
          isExportingOpml={false}
          isImportingOpml={false}
          isLoading={false}
          isRefreshingAllFeeds={false}
          onAddCandidate={() => undefined}
          onAddFeed={() => Promise.resolve()}
          onCreateFolder={() => Promise.resolve()}
          onDeleteFeed={() => Promise.resolve()}
          onDeleteFolder={() => Promise.resolve()}
          onExportOpml={() => undefined}
          onImportOpml={() => undefined}
          onRefreshFeed={() => undefined}
          onRefreshAllFeeds={() => undefined}
          onPreviewFullContent={() => undefined}
          onBackfillCurrentFeedFullContent={() =>
            Promise.resolve({
              feedId: "feed_design",
              articlesSeen: 0,
              attempted: 0,
              succeeded: 0,
              failed: 0,
              skipped: 0,
              articleIds: [],
              effectiveContentChangedArticleIds: [],
              limited: false
            })
          }
          onUpdateFeed={() => Promise.resolve()}
          onUpdateFeedUrl={() => undefined}
          onUpdateFolder={() => Promise.resolve()}
          opmlSummary={null}
          refreshingFeedId={null}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("新建分组");
    expect(html).toContain("导入 OPML");
    expect(html).toContain("导出 OPML");
    expect(html).toContain("刷新全部");
    expect(html).toContain("添加订阅源");
    expect(html).toContain("订阅源健康");
    expect(html).toContain("导入、导出与刷新");
    expect(html).toContain("重命名");
    expect(html).toContain("删除");
    expect(html).toContain("Design Feed");
    expect(html).toContain("Feed URL");
    expect(html).toContain("https://example.com/feed.xml");
    expect(html).toContain("启用订阅源");
    expect(html).toContain("来源权重");
    expect(html).toContain("下次抓取");
    expect(html).toContain("最近错误");
    expect(html).toContain("403 Forbidden");
    expect(html).not.toContain("AutoTTL");
    expect(html).not.toContain("Provider URL");
    expect(html).not.toContain("API Key");
    expect(html).not.toContain("Embedding");
  });

  it("renders settings page controls and supported provider fields", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <SettingsWorkspace
          backfillingIndexId={null}
          deletingProviderId={null}
          embeddingError={null}
          embeddingIndexes={[]}
          embeddingProviders={[]}
          error={null}
          isEmbeddingLoading={false}
          isLoading={false}
          activatingProviderId={null}
          isSavingEmbeddingProvider={false}
          isSaving={false}
          rebuildingIndexId={null}
          testingProviderId={null}
          onActivateEmbeddingProvider={() => Promise.resolve()}
          onBackfillEmbeddingIndex={() => Promise.resolve()}
          onDeleteEmbeddingProvider={() => Promise.resolve()}
          onChangePassword={() => Promise.resolve()}
          onOpenAlgorithmTransparency={() => undefined}
          onPreviewSettings={() => undefined}
          onRebuildEmbeddingIndex={() => Promise.resolve()}
          onSaveEmbeddingProvider={() => Promise.resolve(null)}
          onSaveSettings={() => Promise.resolve()}
          onTestEmbeddingProvider={() => Promise.resolve()}
          settings={defaultAppSettings}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("设置");
    expect(html).toContain("基础设置");
    expect(html).toContain("算法");
    expect(html).toContain("插件");
    expect(html).toContain("界面语言");
    expect(html).toContain("首页默认打开");
    expect(html).toContain("账户安全");
    expect(html).toContain("修改密码");
    expect(html).toContain("查看算法透明说明");
    expect(html).toContain("稍后读中的文章读完后，自动移出稍后读");
    expect(html).toContain("无限加载：滚动到列表底部时自动加载下一批文章");
    expect(html).toContain("type=\"range\"");
    expect(html).toContain("兴趣簇上限");
    expect(html).toContain("低配 VPS：24 / 16");
    expect(html).toContain("中配 NAS：48 / 32");
    expect(html).toContain("正向兴趣簇");
    expect(html).toContain("负向兴趣簇");
    expect(html).toContain("不会按比例增加外部 Embedding 调用");
    expect(html).toContain("字号");
    expect(html).toContain("行高");
    expect(html).toContain("段距");
    expect(html).toContain("阅读宽度");
    expect(html).toContain("保留天数");
    expect(html).toContain("retention.retentionDays");
    expect(html).toContain("关于");
    expect(html).toContain("v0.3.0");
    expect(html).toContain("评论尸");
    expect(html).toContain("https://x.com/JeffreyCalm");
    expect(html).toContain("https://1q43.blog");
    expect(html).toContain("https://dibao.app");
    expect(html).toContain("https://github.com/Pls-1q43/Dibao");
    expect(html).toContain("控制是否向开发者发送用于优化邸报的错误、性能和体验反馈数据。");
    expect(html).not.toContain("反馈遥测");
    expect(html).toContain("智能能力");
    expect(html).toContain("当前未启用 Provider");
    expect(html).toContain("保存配置档");
    expect(html).toContain("设为当前 Provider");
    expect(html).toContain("OpenAI-compatible");
    expect(html).toContain("Ollama");
    expect(html).toContain("API Key");
    expect(html).toContain("Base URL");
    expect(html).toContain("模型");
    expect(html).toContain("切片长度");
    expect(html).toContain("QPM");
    expect(html).toContain("QPD");
    expect(html).toContain("新的向量空间");
    expect(html).toContain("测试连接");
    expect(html).toContain("查看插件安装说明");
    expect(html).toContain("https://docs.dibao.app/zh/plugins/installation/");
    expect(html).not.toContain("插件包 URL");
    expect(html).not.toContain("插件包 JSON");
    expect(html.indexOf("智能能力")).toBeLessThan(html.indexOf("关于"));
  });

  it("keeps plugin iframes sandboxed and bridge-scoped", () => {
    const appRuntime = readFileSync(new URL("./AppRuntime.tsx", import.meta.url), "utf8");
    const settingsWorkspace = readFileSync(new URL("./settings/SettingsWorkspace.tsx", import.meta.url), "utf8");
    const dailyBrief = readFileSync(
      new URL("../../../plugins/official/app.dibao.daily-brief/web/index.html", import.meta.url),
      "utf8"
    );

    expect(appRuntime).toContain('sandbox="allow-scripts allow-forms"');
    expect(settingsWorkspace).toContain('sandbox="allow-scripts allow-forms"');
    expect(appRuntime).toContain("event.source !== frameRef.current?.contentWindow");
    expect(settingsWorkspace).toContain("event.source !== frameRef.current?.contentWindow");
    expect(appRuntime).toContain("data.pluginId !== props.plugin.id");
    expect(settingsWorkspace).toContain("data.pluginId !== props.plugin.id");
    expect(appRuntime).toContain('case "getAuthSession"');
    expect(settingsWorkspace).toContain('case "getAuthSession"');
    expect(dailyBrief).toContain('bridge("getAuthSession"');
    expect(dailyBrief).toContain("article-title-link");
    expect(dailyBrief).not.toContain("在邸报中打开");
    expect(dailyBrief).not.toContain("打开原文");
  });

  it("renders provider connection and embedding job status separately", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <SettingsWorkspace
          backfillingIndexId={null}
          deletingProviderId={null}
          embeddingError={null}
          embeddingIndexes={[
            {
              id: "index_ollama",
              providerId: "provider_ollama",
              model: "bge-m3",
              dimension: 1024,
              textMaxChars: 8000,
              distanceMetric: "cosine",
              status: "active",
              candidateCount: 10,
              coveredArticleCount: 6,
              embeddingCount: 6,
              coverageRatio: 0.6,
              pendingJobs: 2,
              failedJobs: 1,
              lastFailedAt: "2026-05-14T08:10:00.000Z",
              lastError: "Provider request failed",
              usage: {
                windows: {
                  "24h": { requestCount: 3, itemCount: 6, estimatedTokens: 1200 },
                  "7d": { requestCount: 3, itemCount: 6, estimatedTokens: 1200 },
                  "30d": { requestCount: 3, itemCount: 6, estimatedTokens: 1200 }
                }
              },
              createdAt: "2026-05-14T08:00:00.000Z",
              updatedAt: "2026-05-14T08:00:00.000Z"
            }
          ]}
          embeddingProviders={[
            {
              id: "provider_ollama",
              type: "ollama",
              name: "Ollama",
              baseUrl: "http://127.0.0.1:11434",
              model: "bge-m3",
              dimension: 1024,
              textMaxChars: 8000,
              requestsPerMinute: 60,
              requestsPerDay: 1000,
              enabled: true,
              qualityTier: "recommended",
              hasApiKey: false,
              lastTestStatus: "success",
              lastTestError: null,
              lastTestAt: "2026-05-14T08:00:00.000Z",
              createdAt: "2026-05-14T08:00:00.000Z",
              updatedAt: "2026-05-14T08:00:00.000Z"
            }
          ]}
          error={null}
          isEmbeddingLoading={false}
          isLoading={false}
          activatingProviderId={null}
          isSavingEmbeddingProvider={false}
          isSaving={false}
          rebuildingIndexId={null}
          testingProviderId={null}
          onActivateEmbeddingProvider={() => Promise.resolve()}
          onBackfillEmbeddingIndex={() => Promise.resolve()}
          onDeleteEmbeddingProvider={() => Promise.resolve()}
          onChangePassword={() => Promise.resolve()}
          onOpenAlgorithmTransparency={() => undefined}
          onPreviewSettings={() => undefined}
          onRebuildEmbeddingIndex={() => Promise.resolve()}
          onSaveEmbeddingProvider={() => Promise.resolve(null)}
          onSaveSettings={() => Promise.resolve()}
          onTestEmbeddingProvider={() => Promise.resolve()}
          settings={defaultAppSettings}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("连接测试状态");
    expect(html).toContain("当前生效 Provider");
    expect(html).toContain("已是当前 Provider");
    expect(html).toContain("连接测试成功");
    expect(html).toContain("Embedding job 状态");
    expect(html).toContain("6 / 10 · 60%");
    expect(html).toContain("索引总量：6 条 embedding");
    expect(html).toContain("待处理 2");
    expect(html).toContain("失败 1");
    expect(html).toContain("错误：Provider request failed");
    expect(html).toContain("本地估算用量：6 篇/input · 3 次 batch 请求 · 1200 tokens");
    expect(html).toContain("补齐缺失向量");
    expect(html).toContain("重建向量索引");
    expect(html).toContain("bge-m3");
    expect(html).toContain("1024");
  });

  it("builds reader CSS variables from persisted reader settings", () => {
    expect(
      readerStyleFor({
        fontSize: 20,
        lineHeight: 1.8,
        paragraphGap: 1.2,
        readerWidth: 760,
        theme: "paper"
      })
    ).toEqual({
      "--reader-font-size": "20px",
      "--reader-line-height": "1.8",
      "--reader-paragraph-gap": "1.2em",
      "--reader-width": "760px"
    });
  });

  it("renders article action buttons from dictionary copy", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleActionControls
          actionError={null}
          article={{
            id: "article_fixture",
            state: {
              read: false,
              favorited: false,
              liked: false,
              readLater: false,
              hidden: false,
              notInterested: false,
              readingProgress: 0
            }
          }}
          onAction={() => undefined}
          pendingAction={null}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("收藏");
    expect(html).toContain("点赞");
    expect(html).toContain("稍后读");
    expect(html).toContain("不感兴趣");
    expect(html).toContain('aria-label="收藏这篇文章"');
    expect(html).toContain('aria-label="点赞这篇文章"');
    expect(html).toContain('aria-label="稍后读这篇文章"');
    expect(html).toContain('aria-label="不再推荐类似文章"');
    expect(html).not.toContain("标记已读");
  });

  it("renders rank explanation copy from the dictionary", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <RankExplanationPanel
          error={null}
          explanation={{
            articleId: "article_fixture",
            generatedAt: "2026-05-14T08:10:00.000Z",
            reasons: [
              {
                type: "freshness",
                label: "Recent article",
                impact: "positive"
              },
              {
                type: "source",
                label: "Fixture Feed",
                impact: "positive"
              },
              {
                type: "exploration",
                label: "Break-cocoon exploration",
                impact: "neutral"
              }
            ]
          }}
          isLoading={false}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("为什么推荐");
    expect(html).toContain("新鲜度");
    expect(html).toContain("文章较新");
    expect(html).toContain("来源 Fixture Feed");
    expect(html).toContain("本文由破茧算法打捞，你可在设置页调整算法信息茧房水平。");
  });

  it("renders sorting notes for non-personalized article detail views", () => {
    const latestHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleExplanationEntry
          articleView="latest"
          error={null}
          explanation={null}
          isLoading={false}
          isOpen={false}
          onClose={() => undefined}
          onOpen={() => undefined}
        />
      </DibaoI18nProvider>
    );
    const favoriteHtml = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleExplanationEntry
          articleView="favorites"
          error={null}
          explanation={null}
          isLoading={false}
          isOpen={false}
          onClose={() => undefined}
          onOpen={() => undefined}
        />
      </DibaoI18nProvider>
    );

    expect(latestHtml).toContain("当前视图正按照发布时间排序");
    expect(latestHtml).not.toContain("查看完整理由");
    expect(favoriteHtml).toContain("收藏视图默认按收藏时间排序");
  });

  it("renders personalized explanation entry inline on desktop", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleExplanationEntry
          articleView="recommended"
          error={null}
          explanation={{
            articleId: "article_fixture",
            generatedAt: "2026-05-14T08:10:00.000Z",
            reasons: [
              {
                type: "interest",
                label: "AI",
                impact: "positive"
              }
            ]
          }}
          isLoading={false}
          isOpen={false}
          onClose={() => undefined}
          onOpen={() => undefined}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("与你近期的正向兴趣相似");
    expect(html).not.toContain(">查看完整理由</button>");
    expect(html).not.toContain("关闭");
  });

  it("renders interest family and recent intent explanation copy", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleExplanationEntry
          articleView="recommended"
          error={null}
          explanation={{
            articleId: "article_fixture",
            generatedAt: "2026-05-14T08:10:00.000Z",
            reasons: [
              {
                type: "interest",
                label: "Interest family match",
                impact: "positive",
                family: {
                  id: "family_product_ai",
                  label: "产品 / AI",
                  maturity: 0.82,
                  dominanceRatio: 0.24,
                  matchedFamilyCount: 2
                }
              },
              {
                type: "interest",
                label: "Recent interest trend",
                impact: "positive",
                recentIntent: {
                  polarity: "positive"
                }
              }
            ]
          }}
          isLoading={false}
          isOpen={false}
          onClose={() => undefined}
          onOpen={() => undefined}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("与你的兴趣主题「产品 / AI」相近");
    expect(html).toContain("与你近期的阅读趋势相近");
  });

  it("renders lazy personalized explanation copy before reasons are loaded", () => {
    const html = renderToStaticMarkup(
      <DibaoI18nProvider>
        <ArticleExplanationEntry
          articleView="recommended"
          error={null}
          explanation={null}
          isLoading={false}
          isOpen={false}
          onClose={() => undefined}
          onOpen={() => undefined}
        />
      </DibaoI18nProvider>
    );

    expect(html).toContain("阅读过半后显示推荐解释");
    expect(html).not.toContain("与你近期的正向兴趣相似");
  });
});

function dictionaryShape(value: unknown, path = "$"): string[] {
  if (typeof value === "function") {
    return [`${path}:function:${value.length}`];
  }

  if (typeof value !== "object" || value === null) {
    return [`${path}:${typeof value}`];
  }

  return Object.entries(value).flatMap(([key, child]) => dictionaryShape(child, `${path}.${key}`));
}

function articleListItem(
  id: string,
  interactionStatus: ArticleListItem["state"]["interactionStatus"]
): ArticleListItem {
  return {
    id,
    feedId: "feed_fixture",
    feedTitle: "Fixture Feed",
    title: id,
    url: `https://example.com/${id}`,
    author: null,
    summary: null,
    publishedAt: "2026-05-14T08:00:00.000Z",
    discoveredAt: "2026-05-14T08:00:00.000Z",
    state: {
      read: false,
      favorited: false,
      liked: false,
      readLater: false,
      hidden: false,
      notInterested: false,
      readingProgress: 0,
      interactionStatus
    }
  };
}
