import type { CSSProperties, MouseEvent } from "react";
import { defaultAppSettings, type ArticleActionRequest, type ArticleDetail, type ArticleListItem, type ArticleSearchSort, type ArticleSearchState, type ArticleState, type ArticleTimeWindow, type ArticleView, type AppSettings, type AuthSession, type CreateEmbeddingProviderInput, type DerivedDataUpgradeStatus, type EmbeddingIndex, type EmbeddingProvider, type EmbeddingProviderType, type FavoriteArticleSort, type Feed, type FeedDiagnosticItem, type FeedFolder, type OpmlImportResponse, type PluginListItem, type RankExplanationReason, type ReaderSettings, type ReadLaterArticleSort, type RecommendationMaintenanceTask, type RecommendationMaintenanceTaskResponse, type RecommendationStatus, type RecommendationTransparency, type SetupStatus, type UpdateEmbeddingProviderInput, type UpdateSettingsInput } from "../api.js";
import type { Dictionary, Locale, NavigationItemKey } from "../i18n.js";
import styles from "../design-system/AppShell/AppShell.module.css";

export const primaryNavigationItems: NavigationItemKey[] = [
  "recommended",
  "latest",
  "read_later",
  "favorites"
];

export const utilityNavigationItems: NavigationItemKey[] = [
  "search",
  "feeds",
  "settings"
];

export const navigationItems: NavigationItemKey[] = [
  ...primaryNavigationItems,
  ...utilityNavigationItems
];

export const defaultFavoriteArticleSort: FavoriteArticleSort = "favorited_desc";
export const defaultReadLaterArticleSort: ReadLaterArticleSort = "ranked";
export const defaultReaderFilters: PersistedReaderFilters = {
  sourceSelection: { type: "all" },
  unreadOnly: false,
  timeWindow: "all"
};

export type Notice =
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

export type PwaUpdateAvailableEvent = CustomEvent<{
  applyUpdate: () => void;
}>;

export type FeedDiagnosticsByFeedId = Record<string, FeedDiagnosticItem["diagnostic"]>;

export type SourceSelection =
  | { type: "all" }
  | { type: "folder"; folderId: string }
  | { type: "feed"; feedId: string };

export type AuthMode = "setup" | "login";

export type AppPage =
  | { type: "reader"; view: ArticleView }
  | { type: "search" }
  | { type: "feed-management" }
  | { type: "full-content-preview"; feedId: string }
  | { type: "settings" }
  | { type: "plugin"; pluginId: string; route: string }
  | { type: "algorithm-transparency" }
  | { type: "algorithm-clusters" };

export type AppRoute = {
  page: AppPage;
  articleId: string | null;
  hasExplicitPage: boolean;
};

export type PersistedReaderFilters = {
  sourceSelection: SourceSelection;
  unreadOnly: boolean;
  timeWindow: ArticleTimeWindow;
};

export type SearchFormState = {
  q: string;
  fullText: boolean;
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
  | { type: "setup-optional-plugins"; plugins: PluginListItem[] }
  | { type: "setup-provider" }
  | { type: "reader" };

export type ArticleActionIntent = "favorite" | "like" | "readLater" | "notInterested";

export type ArticleActionTarget = Pick<ArticleDetail, "id" | "state">;

export type PendingArticleAction = {
  articleId: string;
  intent: ArticleActionIntent;
};

export type ReadProgressMetadata = {
  durationMs: number;
  activeDurationMs: number;
  scrollSource: "reader";
};

export type ReadProgressPostOptions = {
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

  if (status.coreDatabaseMigration?.blocking || status.derivedDataUpgrade?.blocking) {
    return { type: "derived-data-upgrade" };
  }

  if (status.hasFeeds && status.optionalPluginSteps && status.optionalPluginSteps.length > 0) {
    return { type: "setup-optional-plugins", plugins: status.optionalPluginSteps };
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

export function sameAppPage(left: AppPage, right: AppPage): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "reader" && right.type === "reader") {
    return left.view === right.view;
  }

  if (left.type === "full-content-preview" && right.type === "full-content-preview") {
    return left.feedId === right.feedId;
  }

  if (left.type === "plugin" && right.type === "plugin") {
    return left.pluginId === right.pluginId && left.route === right.route;
  }

  return true;
}

export type SettingsDraft = {
  locale: AppSettings["ui"]["locale"];
  defaultHomeView: AppSettings["ui"]["defaultHomeView"];
  markScrolledArticlesIgnored: boolean;
  removeReadLaterOnReadComplete: boolean;
  infiniteArticleLoading: boolean;
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

export const interestClusterLimitPresets = [
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

export type SupportedEmbeddingProviderType = Extract<
  EmbeddingProviderType,
  "openai_compatible" | "gemini" | "ollama"
>;

export type EmbeddingProviderDraft = {
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

export const newEmbeddingProviderId = "__new_provider__";

export const readProgressThresholds = [0.25, 0.5, 0.75, 0.9] as const;
export const readProgressMinIntervalMs = 5_000;

export type ReadProgressThreshold = (typeof readProgressThresholds)[number];

export type ReadProgressSession = {
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


export function draftForSettings(settings: AppSettings): SettingsDraft {
  return {
    locale: settings.ui.locale,
    defaultHomeView: settings.ui.defaultHomeView,
    markScrolledArticlesIgnored: settings.behavior.markScrolledArticlesIgnored,
    removeReadLaterOnReadComplete: settings.behavior.removeReadLaterOnReadComplete,
    infiniteArticleLoading: settings.behavior.infiniteArticleLoading,
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

export function presetIndexForInterestClusterLimits(
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

export function presetIndexForInterestClusterLimitDraft(draft: SettingsDraft): number | null {
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

export function interestClusterPresetIndexFromSliderValue(value: string): 0 | 1 | 2 {
  if (value === "2") {
    return 2;
  }
  if (value === "1") {
    return 1;
  }
  return 0;
}

export function closestInterestClusterPresetIndex(
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

export function draftForEmbeddingProvider(provider: EmbeddingProvider | null): EmbeddingProviderDraft {
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

export function draftWithProviderType(
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

export function embeddingProviderDraftMatchesProvider(
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

export function optionalNumberDraftMatches(
  draft: string,
  value: number | null | undefined
): boolean {
  if (draft.trim() === "") {
    return value === null || value === undefined;
  }

  return Number(draft) === value;
}

export function defaultEmbeddingProviderDraft(type: SupportedEmbeddingProviderType) {
  if (type === "ollama") {
    return {
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      dimension: 768,
      textMaxChars: 4000
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

export function supportedProviderType(
  type: EmbeddingProviderType | undefined
): SupportedEmbeddingProviderType {
  return type === "ollama" || type === "gemini" ? type : "openai_compatible";
}

export function providerRecommendationReadmeUrl(locale: Locale): string {
  if (locale === "en-US") {
    return "https://docs.dibao.app/en/providers/";
  }

  if (locale === "ja-JP") {
    return "https://docs.dibao.app/ja/providers/";
  }

  return "https://docs.dibao.app/zh/providers/";
}

export function parseSettingsDraft(
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
      removeReadLaterOnReadComplete: draft.removeReadLaterOnReadComplete,
      infiniteArticleLoading: draft.infiniteArticleLoading
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
        removeReadLaterOnReadComplete: draft.removeReadLaterOnReadComplete,
        infiniteArticleLoading: draft.infiniteArticleLoading
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

export function retentionSettingsRequireCleanupConfirmation(
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

export function parseEmbeddingProviderDraft(
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

export function parseNumberDraft(
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

export function parseOptionalNumberDraft(
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

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type ReaderStyle = CSSProperties & {
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

export function articleQueryFor(source: SourceSelection): { feedId?: string; folderId?: string } {
  if (source.type === "feed") {
    return { feedId: source.feedId };
  }

  if (source.type === "folder") {
    return { folderId: source.folderId };
  }

  return {};
}

export function supportsUnreadOnly(view: ArticleView): boolean {
  return view === "latest" || view === "recommended";
}

export function supportsQuickFilters(view: ArticleView): boolean {
  return view === "latest" || view === "recommended";
}

export function articleSortForView(
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

export function shouldLoadRankExplanation(view: ArticleView): boolean {
  return view === "recommended" || view === "read_later";
}

export function shouldLoadDetailRankExplanation(
  page: AppPage,
  view: ArticleView,
  searchSort: ArticleSearchSort
): boolean {
  return page.type === "search"
    ? searchSort === "recommended"
    : shouldLoadRankExplanation(view);
}

export function canLoadRankExplanation(page: AppPage, view: ArticleView): boolean {
  return page.type === "search" || shouldLoadRankExplanation(view);
}

export function sortExplanationForView(view: ArticleView, t: Dictionary): string {
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

export type UrlState = {
  favoriteSort?: FavoriteArticleSort;
  readLaterSort?: ReadLaterArticleSort;
  timeWindow?: ArticleTimeWindow;
  unreadOnly?: boolean;
};

export function routeFromLocation(defaultView: ArticleView): AppRoute {
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

export function readerFiltersForView(view: ArticleView): PersistedReaderFilters {
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

export function readPersistedReaderFilters(view: ArticleView): PersistedReaderFilters {
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

export function persistReaderFilters(view: ArticleView, filters: PersistedReaderFilters): void {
  if (typeof window === "undefined" || !supportsQuickFilters(view)) {
    return;
  }

  try {
    window.localStorage.setItem(persistedReaderFiltersKey(view), JSON.stringify(filters));
  } catch {
    // Local storage is a convenience only; browsing must continue if it is unavailable.
  }
}

export function parsePersistedSourceSelection(value: unknown): SourceSelection {
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

export function urlForNavigationItem(item: NavigationItemKey, state: UrlState = {}): string {
  const page = pageForNavigationItem(item);
  return page ? urlForAppPage(page, state) : "#";
}

export function urlForArticle(articleView: ArticleView, articleId: string, state: UrlState = {}): string {
  const params = paramsForReaderView(articleView, state);
  params.set("article", articleId);
  return `/?${params.toString()}`;
}

export function urlForAppPage(page: AppPage, state: UrlState = {}): string {
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
  if (page.type === "plugin") {
    params.set("plugin", page.pluginId);
    params.set("route", page.route);
  }
  return `/?${params.toString()}`;
}

export function urlForSearchPage(form: SearchFormState, articleId?: string): string {
  const params = paramsForSearchForm(form);
  if (articleId) {
    params.set("article", articleId);
  }
  const query = params.toString();
  return query ? `/search?${query}` : "/search";
}

export function paramsForSearchForm(form: SearchFormState): URLSearchParams {
  const params = new URLSearchParams();
  if (form.q.trim()) {
    params.set("q", form.q.trim());
  }
  if (form.fullText) {
    params.set("scope", "full_text");
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

export function paramsForReaderView(view: ArticleView, state: UrlState): URLSearchParams {
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

export function parseUrlPage(
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
    case "plugin":
      return {
        type: "plugin",
        pluginId: params.get("plugin") ?? "",
        route: params.get("route") ?? ""
      };
    case "algorithm":
    case "algorithm-transparency":
      return { type: "algorithm-transparency" };
    case "algorithm-clusters":
      return { type: "algorithm-clusters" };
    default:
      return { type: "reader", view };
  }
}

export function defaultSearchForm(): SearchFormState {
  return {
    q: "",
    fullText: false,
    sourceSelection: { type: "all" },
    state: "all",
    sort: "relevance",
    from: "",
    to: ""
  };
}

export function searchFormFromLocation(): SearchFormState {
  if (typeof window === "undefined") {
    return defaultSearchForm();
  }

  const params = new URLSearchParams(window.location.search);
  const feedId = params.get("feedId");
  const folderId = params.get("folderId");
  return {
    q: params.get("q") ?? "",
    fullText: params.get("scope") === "full_text",
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

export function parseArticleSearchStateValue(value: unknown): ArticleSearchState | null {
  return value === "all" ||
    value === "unread" ||
    value === "read" ||
    value === "favorites" ||
    value === "read_later"
    ? value
    : null;
}

export function parseArticleSearchSortValue(value: unknown): ArticleSearchSort | null {
  return value === "relevance" || value === "recommended" || value === "latest"
    ? value
    : null;
}

export function parseUrlView(value: string | null): ArticleView | null {
  return value === "latest" ||
    value === "recommended" ||
    value === "favorites" ||
    value === "read_later"
    ? value
    : null;
}

export function urlBooleanParam(name: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const value = new URLSearchParams(window.location.search).get(name);
  return value === "1" || value === "true";
}

export function urlTimeWindowParam(): ArticleTimeWindow | null {
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  return parseArticleTimeWindowValue(params.get("time")) ?? (urlBooleanParam("today") ? "24h" : null);
}

export function parseArticleTimeWindowValue(value: unknown): ArticleTimeWindow | null {
  return value === "all" || value === "24h" || value === "7d" || value === "30d"
    ? value
    : null;
}

export function urlFavoriteSortParam(): FavoriteArticleSort | null {
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

export function urlReadLaterSortParam(): ReadLaterArticleSort | null {
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

export function shouldLetBrowserHandleLinkClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

export function classNames(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

export function rememberArticleStates(
  articles: Pick<ArticleListItem, "id" | "state">[],
  target: Map<string, ArticleState>
): void {
  for (const article of articles) {
    target.set(article.id, article.state);
  }
}

export function sameSourceSelection(left: SourceSelection, right: SourceSelection): boolean {
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

export function appendUniqueArticles(
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

export function countFeedsByFolder(feeds: Feed[]): Map<string, number> {
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

export function isNavigationItemActive(item: NavigationItemKey, page: AppPage): boolean {
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

  if (page.type === "settings") {
    return item === "settings";
  }

  return false;
}

export function isUtilityNavigationActive(page: AppPage): boolean {
  return (
    page.type === "feed-management" ||
    page.type === "search" ||
    page.type === "settings" ||
    page.type === "algorithm-transparency" ||
    page.type === "algorithm-clusters"
  );
}

export function noticeTextFor(notice: Notice, t: Dictionary): string {
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

export function recommendationStatusMetrics(
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

export function algorithmStatusClassName(
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

export function embeddingCoverageText(index: EmbeddingIndex, t: Dictionary): string {
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

export function formatPercent(value: number): string {
  return `${Math.round(clampNumber(value, 0, 1) * 100)}%`;
}

export function formatMaintenanceSchedule(
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

export type MaintenanceScheduleItem = NonNullable<
  RecommendationTransparency["transparency"]["maintenance"]["schedule"]
>[number];

export function formatMaintenanceTaskSchedule(
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

export function maintenanceResultWasExisting(result: RecommendationMaintenanceTaskResponse): boolean {
  return "existing" in result ? result.existing : false;
}

export function maintenanceTasks(t: Dictionary): Array<{
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

export function plainTextSummary(value: string): string {
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

export function downloadTextFile(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function requestForArticleAction(
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

export function optimisticStateForArticleAction(
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

export function optimisticOpenedState(state: ArticleState): ArticleState {
  if (state.read || state.readingProgress >= 0.9) {
    return { ...state, interactionStatus: "read", openedAt: Date.now(), ignoredAt: null };
  }

  if (state.readingProgress >= 0.25) {
    return { ...state, interactionStatus: "reading", openedAt: Date.now(), ignoredAt: null };
  }

  return { ...state, interactionStatus: "opened", openedAt: Date.now(), ignoredAt: null };
}

export function optimisticReadProgressState(state: ArticleState, progress: number): ArticleState {
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

export function savedOptimisticState(state: ArticleState): ArticleState {
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

export function actionErrorMessageFor(intent: ArticleActionIntent, t: Dictionary) {
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

export function explanationReasonText(reason: RankExplanationReason, t: Dictionary): string {
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

export function clusterDisplayName(
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

export function confidenceBucket(value: number): "high" | "medium" | "low" {
  if (value >= 0.7) {
    return "high";
  }
  if (value >= 0.4) {
    return "medium";
  }
  return "low";
}

export function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function sanitizeArticleHtml(html: string, baseUrl?: string | null): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(
    `<main>${normalizeArticleCodeBlockHtml(html)}</main>`,
    "text/html"
  );
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

export function normalizeArticleCodeBlockHtml(html: string): string {
  return html
    .replace(
      /<td\b(?=[^>]*(?:class|id)=["'][^"']*\bgutter\b[^"']*["'])[^>]*>[\s\S]*?<\/td>/giu,
      ""
    )
    .replace(
      /<div\b(?=[^>]*(?:class|id)=["'][^"']*\bgutter\b[^"']*["'])[^>]*>[\s\S]*?<\/div>/giu,
      ""
    );
}

export function safeArticleUrl(
  value: string | null,
  baseUrl: string | null | undefined,
  protocols: string[]
): string | null {
  if (!value) {
    return null;
  }

  try {
    const fallbackBaseUrl =
      typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(value, baseUrl ?? fallbackBaseUrl);
    return protocols.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
