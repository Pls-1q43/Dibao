import type { AppSettingsRepository } from "@dibao/db";
import {
  DEFAULT_ARTICLE_RETENTION_DAYS,
  MAX_ARTICLE_RETENTION_DAYS,
  MIN_ARTICLE_RETENTION_DAYS,
  RETENTION_ARTICLE_DAYS_SETTING_KEY,
  RETENTION_SETTINGS_KEY,
  parseRetentionDays
} from "./article-retention-service.js";

export const UI_LOCALE_SETTING_KEY = "ui.locale";
export const UI_DEFAULT_HOME_VIEW_SETTING_KEY = "ui.defaultHomeView";
export const READER_SETTINGS_KEY = "reader.settings";
export const BEHAVIOR_SETTINGS_KEY = "behavior.settings";
export const TELEMETRY_SETTINGS_KEY = "telemetry.settings";
export const INSTALLATION_COMPLETED_AT_SETTING_KEY = "app.installationCompletedAt";
export const RECOMMENDATION_SETTINGS_KEY = "recommendation.settings";
export const RECOMMENDATION_MAINTENANCE_SETTINGS_KEY = "recommendation.maintenanceSettings";

export const supportedSettingsLocales = ["zh-CN", "en-US", "ja-JP"] as const;
export type SettingsLocale = (typeof supportedSettingsLocales)[number];
export type RecommendationV3ModuleMode = "disabled" | "shadow" | "active";
export const supportedDefaultHomeViews = ["recommended", "latest"] as const;
export type DefaultHomeView = (typeof supportedDefaultHomeViews)[number];

export type ReaderSettings = {
  fontSize: number;
  lineHeight: number;
  paragraphGap: number;
  readerWidth: number;
  theme: "paper";
};

export type AppSettings = {
  ui: {
    locale: SettingsLocale;
    defaultHomeView: DefaultHomeView;
  };
  reader: ReaderSettings;
  behavior: {
    markScrolledArticlesIgnored: boolean;
    removeReadLaterOnReadComplete: boolean;
    infiniteArticleLoading: boolean;
  };
  telemetry: {
    enabled: boolean;
  };
  retention: {
    retentionDays: number;
    keepFavorites: boolean;
    keepReadLater: boolean;
  };
  ranking: {
    preferFreshness: number;
    preferSource: number;
    preferDiversity: number;
    cocoonLevel: number;
    maxPositiveInterestClusters: number;
    maxNegativeInterestClusters: number;
    maxPositiveInterestFamilies: number;
    maxNegativeInterestFamilies: number;
    localLearningEnabled: boolean;
    localLearningShadowMode: boolean;
    explorationEnabled: boolean;
    evaluationEnabled: boolean;
    crossSessionFatigueMode: RecommendationV3ModuleMode;
    recentHistoryMode: RecommendationV3ModuleMode;
    learnedExplorationMode: RecommendationV3ModuleMode;
  };
  recommendationMaintenance: RecommendationMaintenanceSettings;
};

export type RecommendationMaintenanceSettings = {
  maintenanceEnabled: boolean;
  recentIntentAutoRebuildEnabled: boolean;
  keywordAutoRebuildEnabled: boolean;
  duplicateAutoRebuildEnabled: boolean;
  clusterLabelAutoRebuildEnabled: boolean;
  clusterMergeDiagnosticsEnabled: boolean;
  clusterAutoMergeEnabled: boolean;
  ftrlAutoTrainEnabled: boolean;
  ftrlAutoPromoteEnabled: boolean;
  evaluationAutoRunEnabled: boolean;
  evaluationAutoRunIntervalDays: number;
  embeddingHealthAutoBackfillEnabled: boolean;
};

export type UpdateSettingsResult = {
  ok: true;
  settings: AppSettings;
};

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.75,
  paragraphGap: 1.1,
  readerWidth: 720,
  theme: "paper"
};

const DEFAULT_LOCALE: SettingsLocale = "zh-CN";
const DEFAULT_HOME_VIEW: DefaultHomeView = "recommended";
const DEFAULT_BEHAVIOR_SETTINGS = {
  markScrolledArticlesIgnored: true,
  removeReadLaterOnReadComplete: false,
  infiniteArticleLoading: false
} as const;
const DEFAULT_TELEMETRY_SETTINGS = {
  enabled: true
} as const;
const DEFAULT_RETENTION_SETTINGS = {
  keepFavorites: true,
  keepReadLater: true
} as const;
const DEFAULT_RANKING_SETTINGS = {
  preferFreshness: 0.5,
  preferSource: 0.5,
  preferDiversity: 0.5,
  cocoonLevel: 5,
  maxPositiveInterestClusters: 48,
  maxNegativeInterestClusters: 32,
  maxPositiveInterestFamilies: 16,
  maxNegativeInterestFamilies: 12,
  localLearningEnabled: true,
  localLearningShadowMode: false,
  explorationEnabled: true,
  evaluationEnabled: false,
  crossSessionFatigueMode: "shadow",
  recentHistoryMode: "shadow",
  learnedExplorationMode: "shadow"
} as const;
export const DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS: RecommendationMaintenanceSettings = {
  maintenanceEnabled: true,
  recentIntentAutoRebuildEnabled: true,
  keywordAutoRebuildEnabled: true,
  duplicateAutoRebuildEnabled: true,
  clusterLabelAutoRebuildEnabled: true,
  clusterMergeDiagnosticsEnabled: true,
  clusterAutoMergeEnabled: false,
  ftrlAutoTrainEnabled: true,
  ftrlAutoPromoteEnabled: false,
  evaluationAutoRunEnabled: false,
  evaluationAutoRunIntervalDays: 7,
  embeddingHealthAutoBackfillEnabled: true
};

const READER_RANGES = {
  fontSize: { min: 16, max: 24 },
  lineHeight: { min: 1.45, max: 2.1 },
  paragraphGap: { min: 0.6, max: 1.6 },
  readerWidth: { min: 560, max: 860 }
} as const;

type ReaderSettingsPatch = Partial<
  Pick<ReaderSettings, "fontSize" | "lineHeight" | "paragraphGap" | "readerWidth">
>;

type SettingsPatch = {
  ui?: {
    locale?: SettingsLocale;
    defaultHomeView?: DefaultHomeView;
  };
  reader?: ReaderSettingsPatch;
  retention?: {
    retentionDays?: number;
    keepFavorites?: boolean;
    keepReadLater?: boolean;
  };
  behavior?: {
    markScrolledArticlesIgnored?: boolean;
    removeReadLaterOnReadComplete?: boolean;
    infiniteArticleLoading?: boolean;
  };
  telemetry?: {
    enabled?: boolean;
  };
  ranking?: {
    cocoonLevel?: number;
    maxPositiveInterestClusters?: number;
    maxNegativeInterestClusters?: number;
    maxPositiveInterestFamilies?: number;
    maxNegativeInterestFamilies?: number;
    localLearningEnabled?: boolean;
    localLearningShadowMode?: boolean;
    explorationEnabled?: boolean;
    evaluationEnabled?: boolean;
    crossSessionFatigueMode?: RecommendationV3ModuleMode;
    recentHistoryMode?: RecommendationV3ModuleMode;
    learnedExplorationMode?: RecommendationV3ModuleMode;
  };
  recommendationMaintenance?: Partial<RecommendationMaintenanceSettings>;
};

export class SettingsServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "SettingsServiceError";
  }
}

export type SettingsServiceOptions = {
  settings: AppSettingsRepository;
  now?: () => number;
  env?: Record<string, string | undefined>;
};

export class SettingsService {
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly options: SettingsServiceOptions) {
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
  }

  getSettings(): AppSettings {
    return {
      ui: {
        locale: this.readLocale(),
        defaultHomeView: this.readDefaultHomeView()
      },
      reader: this.readReaderSettings(),
      behavior: this.readBehaviorSettings(),
      telemetry: this.readTelemetrySettings(),
      retention: {
        retentionDays: this.readRetentionDays(),
        ...this.readRetentionSettings()
      },
      ranking: {
        ...this.readRecommendationSettings()
      },
      recommendationMaintenance: this.readRecommendationMaintenanceSettings()
    };
  }

  updateSettings(body: unknown): UpdateSettingsResult {
    const patch = parseSettingsPatch(body);
    const now = this.now();

    if (patch.ui?.locale !== undefined) {
      this.options.settings.setJson(UI_LOCALE_SETTING_KEY, patch.ui.locale, now);
    }

    if (patch.ui?.defaultHomeView !== undefined) {
      this.options.settings.setJson(
        UI_DEFAULT_HOME_VIEW_SETTING_KEY,
        patch.ui.defaultHomeView,
        now
      );
    }

    if (patch.reader !== undefined && Object.keys(patch.reader).length > 0) {
      this.options.settings.setJson(
        READER_SETTINGS_KEY,
        {
          ...this.readReaderSettings(),
          ...patch.reader
        },
        now
      );
    }

    if (patch.retention?.retentionDays !== undefined) {
      this.options.settings.setJson(
        RETENTION_ARTICLE_DAYS_SETTING_KEY,
        patch.retention.retentionDays,
        now
      );
    }

    if (
      patch.retention?.keepFavorites !== undefined ||
      patch.retention?.keepReadLater !== undefined
    ) {
      this.options.settings.setJson(
        RETENTION_SETTINGS_KEY,
        {
          ...this.readRetentionSettings(),
          ...(patch.retention.keepFavorites !== undefined
            ? { keepFavorites: patch.retention.keepFavorites }
            : {}),
          ...(patch.retention.keepReadLater !== undefined
            ? { keepReadLater: patch.retention.keepReadLater }
            : {})
        },
        now
      );
    }

    if (
      patch.behavior?.markScrolledArticlesIgnored !== undefined ||
      patch.behavior?.removeReadLaterOnReadComplete !== undefined ||
      patch.behavior?.infiniteArticleLoading !== undefined
    ) {
      this.options.settings.setJson(
        BEHAVIOR_SETTINGS_KEY,
        {
          ...this.readBehaviorSettings(),
          ...patch.behavior
        },
        now
      );
    }

    if (patch.telemetry?.enabled !== undefined) {
      this.options.settings.setJson(
        TELEMETRY_SETTINGS_KEY,
        {
          ...this.readTelemetrySettings(),
          enabled: patch.telemetry.enabled
        },
        now
      );
    }

    if (patch.ranking !== undefined && Object.keys(patch.ranking).length > 0) {
      this.options.settings.setJson(
        RECOMMENDATION_SETTINGS_KEY,
        {
          ...this.readRecommendationSettings(),
          ...patch.ranking
        },
        now
      );
    }

    if (
      patch.recommendationMaintenance !== undefined &&
      Object.keys(patch.recommendationMaintenance).length > 0
    ) {
      this.options.settings.setJson(
        RECOMMENDATION_MAINTENANCE_SETTINGS_KEY,
        {
          ...this.readRecommendationMaintenanceSettings(),
          ...patch.recommendationMaintenance
        },
        now
      );
    }

    return {
      ok: true,
      settings: this.getSettings()
    };
  }

  getInstallationCompletedAt(): number | null {
    const stored = this.options.settings.getJson<unknown>(INSTALLATION_COMPLETED_AT_SETTING_KEY);
    return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : null;
  }

  ensureInstallationCompletedAt(fallback?: number | null): number {
    const stored = this.getInstallationCompletedAt();
    if (stored !== null) {
      return stored;
    }

    const completedAt =
      typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0
        ? fallback
        : this.now();
    this.options.settings.setJson(INSTALLATION_COMPLETED_AT_SETTING_KEY, completedAt, this.now());
    return completedAt;
  }

  markInstallationCompleted(): number {
    return this.ensureInstallationCompletedAt(this.now());
  }

  private readLocale(): SettingsLocale {
    const locale = this.options.settings.getJson<unknown>(UI_LOCALE_SETTING_KEY);
    return isSettingsLocale(locale) ? locale : DEFAULT_LOCALE;
  }

  private readDefaultHomeView(): DefaultHomeView {
    const view = this.options.settings.getJson<unknown>(UI_DEFAULT_HOME_VIEW_SETTING_KEY);
    return isDefaultHomeView(view) ? view : DEFAULT_HOME_VIEW;
  }

  private readReaderSettings(): ReaderSettings {
    const stored = this.options.settings.getJson<unknown>(READER_SETTINGS_KEY);
    const input = isPlainObject(stored) ? stored : {};

    return {
      fontSize: readStoredNumber(input.fontSize, DEFAULT_READER_SETTINGS.fontSize, "fontSize"),
      lineHeight: readStoredNumber(
        input.lineHeight,
        DEFAULT_READER_SETTINGS.lineHeight,
        "lineHeight"
      ),
      paragraphGap: readStoredNumber(
        input.paragraphGap,
        DEFAULT_READER_SETTINGS.paragraphGap,
        "paragraphGap"
      ),
      readerWidth: readStoredNumber(
        input.readerWidth,
        DEFAULT_READER_SETTINGS.readerWidth,
        "readerWidth"
      ),
      theme: "paper"
    };
  }

  private readRetentionDays(): number {
    const setting = this.options.settings.getJson<unknown>(RETENTION_ARTICLE_DAYS_SETTING_KEY);
    if (setting !== null) {
      return parseRetentionDays(setting) ?? DEFAULT_ARTICLE_RETENTION_DAYS;
    }

    const envValue = this.env.DIBAO_ARTICLE_RETENTION_DAYS;
    if (envValue !== undefined) {
      return parseRetentionDays(envValue) ?? DEFAULT_ARTICLE_RETENTION_DAYS;
    }

    return DEFAULT_ARTICLE_RETENTION_DAYS;
  }

  private readBehaviorSettings(): AppSettings["behavior"] {
    const stored = this.options.settings.getJson<unknown>(BEHAVIOR_SETTINGS_KEY);
    const input = isPlainObject(stored) ? stored : {};

    return {
      markScrolledArticlesIgnored:
        typeof input.markScrolledArticlesIgnored === "boolean"
          ? input.markScrolledArticlesIgnored
          : DEFAULT_BEHAVIOR_SETTINGS.markScrolledArticlesIgnored,
      removeReadLaterOnReadComplete:
        typeof input.removeReadLaterOnReadComplete === "boolean"
          ? input.removeReadLaterOnReadComplete
          : DEFAULT_BEHAVIOR_SETTINGS.removeReadLaterOnReadComplete,
      infiniteArticleLoading:
        typeof input.infiniteArticleLoading === "boolean"
          ? input.infiniteArticleLoading
          : DEFAULT_BEHAVIOR_SETTINGS.infiniteArticleLoading
    };
  }

  private readTelemetrySettings(): AppSettings["telemetry"] {
    const stored = this.options.settings.getJson<unknown>(TELEMETRY_SETTINGS_KEY);
    const input = isPlainObject(stored) ? stored : {};

    return {
      enabled:
        typeof input.enabled === "boolean"
          ? input.enabled
          : DEFAULT_TELEMETRY_SETTINGS.enabled
    };
  }

  private readRetentionSettings(): Pick<AppSettings["retention"], "keepFavorites" | "keepReadLater"> {
    const stored = this.options.settings.getJson<unknown>(RETENTION_SETTINGS_KEY);
    const input = isPlainObject(stored) ? stored : {};

    return {
      keepFavorites:
        typeof input.keepFavorites === "boolean"
          ? input.keepFavorites
          : DEFAULT_RETENTION_SETTINGS.keepFavorites,
      keepReadLater:
        typeof input.keepReadLater === "boolean"
          ? input.keepReadLater
          : DEFAULT_RETENTION_SETTINGS.keepReadLater
    };
  }

  private readRecommendationSettings(): AppSettings["ranking"] {
    const stored = this.options.settings.getJson<unknown>(RECOMMENDATION_SETTINGS_KEY);
    const input = isPlainObject(stored) ? stored : {};

    return {
      preferFreshness: readOptionalStoredNumber(
        input.preferFreshness,
        DEFAULT_RANKING_SETTINGS.preferFreshness,
        0,
        1
      ),
      preferSource: readOptionalStoredNumber(
        input.preferSource,
        DEFAULT_RANKING_SETTINGS.preferSource,
        0,
        1
      ),
      preferDiversity: readOptionalStoredNumber(
        input.preferDiversity,
        DEFAULT_RANKING_SETTINGS.preferDiversity,
        0,
        1
      ),
      cocoonLevel: readIntegerInRange(
        input.cocoonLevel,
        DEFAULT_RANKING_SETTINGS.cocoonLevel,
        1,
        10
      ),
      maxPositiveInterestClusters: readIntegerInRange(
        input.maxPositiveInterestClusters,
        DEFAULT_RANKING_SETTINGS.maxPositiveInterestClusters,
        8,
        192
      ),
      maxNegativeInterestClusters: readIntegerInRange(
        input.maxNegativeInterestClusters,
        DEFAULT_RANKING_SETTINGS.maxNegativeInterestClusters,
        4,
        128
      ),
      maxPositiveInterestFamilies: readIntegerInRange(
        input.maxPositiveInterestFamilies,
        DEFAULT_RANKING_SETTINGS.maxPositiveInterestFamilies,
        2,
        64
      ),
      maxNegativeInterestFamilies: readIntegerInRange(
        input.maxNegativeInterestFamilies,
        DEFAULT_RANKING_SETTINGS.maxNegativeInterestFamilies,
        1,
        48
      ),
      localLearningEnabled:
        typeof input.localLearningEnabled === "boolean"
          ? input.localLearningEnabled
          : DEFAULT_RANKING_SETTINGS.localLearningEnabled,
      localLearningShadowMode:
        typeof input.localLearningShadowMode === "boolean"
          ? input.localLearningShadowMode
          : DEFAULT_RANKING_SETTINGS.localLearningShadowMode,
      explorationEnabled:
        typeof input.explorationEnabled === "boolean"
          ? input.explorationEnabled
          : DEFAULT_RANKING_SETTINGS.explorationEnabled,
      evaluationEnabled:
        typeof input.evaluationEnabled === "boolean"
          ? input.evaluationEnabled
          : DEFAULT_RANKING_SETTINGS.evaluationEnabled,
      crossSessionFatigueMode: readRecommendationV3ModuleMode(
        input.crossSessionFatigueMode,
        DEFAULT_RANKING_SETTINGS.crossSessionFatigueMode
      ),
      recentHistoryMode: readRecommendationV3ModuleMode(
        input.recentHistoryMode,
        DEFAULT_RANKING_SETTINGS.recentHistoryMode
      ),
      learnedExplorationMode: readRecommendationV3ModuleMode(
        input.learnedExplorationMode,
        DEFAULT_RANKING_SETTINGS.learnedExplorationMode
      )
    };
  }

  private readRecommendationMaintenanceSettings(): RecommendationMaintenanceSettings {
    const stored = this.options.settings.getJson<unknown>(RECOMMENDATION_MAINTENANCE_SETTINGS_KEY);
    const input = isPlainObject(stored) ? stored : {};

    return {
      maintenanceEnabled: readStoredBoolean(
        input.maintenanceEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.maintenanceEnabled
      ),
      recentIntentAutoRebuildEnabled: readStoredBoolean(
        input.recentIntentAutoRebuildEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.recentIntentAutoRebuildEnabled
      ),
      keywordAutoRebuildEnabled: readStoredBoolean(
        input.keywordAutoRebuildEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.keywordAutoRebuildEnabled
      ),
      duplicateAutoRebuildEnabled: readStoredBoolean(
        input.duplicateAutoRebuildEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.duplicateAutoRebuildEnabled
      ),
      clusterLabelAutoRebuildEnabled: readStoredBoolean(
        input.clusterLabelAutoRebuildEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.clusterLabelAutoRebuildEnabled
      ),
      clusterMergeDiagnosticsEnabled: readStoredBoolean(
        input.clusterMergeDiagnosticsEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.clusterMergeDiagnosticsEnabled
      ),
      clusterAutoMergeEnabled: readStoredBoolean(
        input.clusterAutoMergeEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.clusterAutoMergeEnabled
      ),
      ftrlAutoTrainEnabled: readStoredBoolean(
        input.ftrlAutoTrainEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.ftrlAutoTrainEnabled
      ),
      ftrlAutoPromoteEnabled: readStoredBoolean(
        input.ftrlAutoPromoteEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.ftrlAutoPromoteEnabled
      ),
      evaluationAutoRunEnabled: readStoredBoolean(
        input.evaluationAutoRunEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.evaluationAutoRunEnabled
      ),
      evaluationAutoRunIntervalDays: readIntegerInRange(
        input.evaluationAutoRunIntervalDays,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.evaluationAutoRunIntervalDays,
        1,
        30
      ),
      embeddingHealthAutoBackfillEnabled: readStoredBoolean(
        input.embeddingHealthAutoBackfillEnabled,
        DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS.embeddingHealthAutoBackfillEnabled
      )
    };
  }
}

function parseSettingsPatch(body: unknown): SettingsPatch {
  const input = readBodyObject(body);
  const patch: SettingsPatch = {};

  rejectUnknownKeys(input, [
    "ui",
    "reader",
    "retention",
    "behavior",
    "telemetry",
    "ranking",
    "recommendationMaintenance"
  ]);

  if (Object.hasOwn(input, "ui")) {
    patch.ui = parseUiPatch(input.ui);
  }

  if (Object.hasOwn(input, "reader")) {
    patch.reader = parseReaderPatch(input.reader);
  }

  if (Object.hasOwn(input, "retention")) {
    patch.retention = parseRetentionPatch(input.retention);
  }

  if (Object.hasOwn(input, "behavior")) {
    patch.behavior = parseBehaviorPatch(input.behavior);
  }

  if (Object.hasOwn(input, "telemetry")) {
    patch.telemetry = parseTelemetryPatch(input.telemetry);
  }

  if (Object.hasOwn(input, "ranking")) {
    patch.ranking = parseRankingPatch(input.ranking);
  }

  if (Object.hasOwn(input, "recommendationMaintenance")) {
    patch.recommendationMaintenance = parseRecommendationMaintenancePatch(
      input.recommendationMaintenance
    );
  }

  return patch;
}

function parseRecommendationMaintenancePatch(
  value: unknown
): NonNullable<SettingsPatch["recommendationMaintenance"]> {
  const input = readSectionObject(value, "recommendationMaintenance");
  rejectUnknownKeys(input, [
    "maintenanceEnabled",
    "recentIntentAutoRebuildEnabled",
    "keywordAutoRebuildEnabled",
    "duplicateAutoRebuildEnabled",
    "clusterLabelAutoRebuildEnabled",
    "clusterMergeDiagnosticsEnabled",
    "clusterAutoMergeEnabled",
    "ftrlAutoTrainEnabled",
    "ftrlAutoPromoteEnabled",
    "evaluationAutoRunEnabled",
    "evaluationAutoRunIntervalDays",
    "embeddingHealthAutoBackfillEnabled"
  ], "recommendationMaintenance");

  const patch: NonNullable<SettingsPatch["recommendationMaintenance"]> = {};
  for (const key of [
    "maintenanceEnabled",
    "recentIntentAutoRebuildEnabled",
    "keywordAutoRebuildEnabled",
    "duplicateAutoRebuildEnabled",
    "clusterLabelAutoRebuildEnabled",
    "clusterMergeDiagnosticsEnabled",
    "clusterAutoMergeEnabled",
    "ftrlAutoTrainEnabled",
    "ftrlAutoPromoteEnabled",
    "evaluationAutoRunEnabled",
    "embeddingHealthAutoBackfillEnabled"
  ] as const) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== "boolean") {
        throw validationError(`recommendationMaintenance.${key} must be a boolean`, {
          field: `recommendationMaintenance.${key}`
        });
      }
      patch[key] = input[key];
    }
  }

  if (Object.hasOwn(input, "evaluationAutoRunIntervalDays")) {
    patch.evaluationAutoRunIntervalDays = parseIntegerField(
      input.evaluationAutoRunIntervalDays,
      "recommendationMaintenance.evaluationAutoRunIntervalDays",
      1,
      30
    );
  }

  return patch;
}

function parseRankingPatch(value: unknown): NonNullable<SettingsPatch["ranking"]> {
  const input = readSectionObject(value, "ranking");
  rejectUnknownKeys(input, [
    "cocoonLevel",
    "maxPositiveInterestClusters",
    "maxNegativeInterestClusters",
    "maxPositiveInterestFamilies",
    "maxNegativeInterestFamilies",
    "localLearningEnabled",
    "localLearningShadowMode",
    "explorationEnabled",
    "evaluationEnabled",
    "crossSessionFatigueMode",
    "recentHistoryMode",
    "learnedExplorationMode"
  ]);

  const patch: NonNullable<SettingsPatch["ranking"]> = {};
  if (Object.hasOwn(input, "cocoonLevel")) {
    patch.cocoonLevel = parseIntegerField(input.cocoonLevel, "cocoonLevel", 1, 10);
  }
  if (Object.hasOwn(input, "maxPositiveInterestClusters")) {
    patch.maxPositiveInterestClusters = parseIntegerField(
      input.maxPositiveInterestClusters,
      "maxPositiveInterestClusters",
      8,
      192
    );
  }
  if (Object.hasOwn(input, "maxNegativeInterestClusters")) {
    patch.maxNegativeInterestClusters = parseIntegerField(
      input.maxNegativeInterestClusters,
      "maxNegativeInterestClusters",
      4,
      128
    );
  }
  if (Object.hasOwn(input, "maxPositiveInterestFamilies")) {
    patch.maxPositiveInterestFamilies = parseIntegerField(
      input.maxPositiveInterestFamilies,
      "maxPositiveInterestFamilies",
      2,
      64
    );
  }
  if (Object.hasOwn(input, "maxNegativeInterestFamilies")) {
    patch.maxNegativeInterestFamilies = parseIntegerField(
      input.maxNegativeInterestFamilies,
      "maxNegativeInterestFamilies",
      1,
      48
    );
  }
  for (const key of [
    "localLearningEnabled",
    "localLearningShadowMode",
    "explorationEnabled",
    "evaluationEnabled"
  ] as const) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== "boolean") {
        throw validationError(`${key} must be a boolean`, { field: key });
      }
      patch[key] = input[key];
    }
  }

  for (const key of ["crossSessionFatigueMode", "recentHistoryMode", "learnedExplorationMode"] as const) {
    if (Object.hasOwn(input, key)) {
      if (!isRecommendationV3ModuleMode(input[key])) {
        throw validationError(`${key} must be disabled, shadow, or active`, { field: key });
      }
      patch[key] = input[key];
    }
  }

  return patch;
}

function parseBehaviorPatch(value: unknown): SettingsPatch["behavior"] {
  const input = readSectionObject(value, "behavior");
  rejectUnknownKeys(
    input,
    ["markScrolledArticlesIgnored", "removeReadLaterOnReadComplete", "infiniteArticleLoading"],
    "behavior"
  );

  const patch: NonNullable<SettingsPatch["behavior"]> = {};

  if (Object.hasOwn(input, "markScrolledArticlesIgnored")) {
    if (typeof input.markScrolledArticlesIgnored !== "boolean") {
      throw validationError("behavior.markScrolledArticlesIgnored must be a boolean", {
        field: "behavior.markScrolledArticlesIgnored"
      });
    }
    patch.markScrolledArticlesIgnored = input.markScrolledArticlesIgnored;
  }

  if (Object.hasOwn(input, "removeReadLaterOnReadComplete")) {
    if (typeof input.removeReadLaterOnReadComplete !== "boolean") {
      throw validationError("behavior.removeReadLaterOnReadComplete must be a boolean", {
        field: "behavior.removeReadLaterOnReadComplete"
      });
    }
    patch.removeReadLaterOnReadComplete = input.removeReadLaterOnReadComplete;
  }

  if (Object.hasOwn(input, "infiniteArticleLoading")) {
    if (typeof input.infiniteArticleLoading !== "boolean") {
      throw validationError("behavior.infiniteArticleLoading must be a boolean", {
        field: "behavior.infiniteArticleLoading"
      });
    }
    patch.infiniteArticleLoading = input.infiniteArticleLoading;
  }

  return patch;
}

function parseTelemetryPatch(value: unknown): SettingsPatch["telemetry"] {
  const input = readSectionObject(value, "telemetry");
  rejectUnknownKeys(input, ["enabled"], "telemetry");

  const patch: NonNullable<SettingsPatch["telemetry"]> = {};

  if (Object.hasOwn(input, "enabled")) {
    if (typeof input.enabled !== "boolean") {
      throw validationError("telemetry.enabled must be a boolean", {
        field: "telemetry.enabled"
      });
    }
    patch.enabled = input.enabled;
  }

  return patch;
}

function parseUiPatch(value: unknown): SettingsPatch["ui"] {
  const input = readSectionObject(value, "ui");
  rejectUnknownKeys(input, ["locale", "defaultHomeView"], "ui");

  const patch: NonNullable<SettingsPatch["ui"]> = {};

  if (Object.hasOwn(input, "locale")) {
    if (!isSettingsLocale(input.locale)) {
      throw validationError("ui.locale must be zh-CN, en-US, or ja-JP", {
        field: "ui.locale",
        allowed: supportedSettingsLocales
      });
    }
    patch.locale = input.locale;
  }

  if (Object.hasOwn(input, "defaultHomeView")) {
    if (!isDefaultHomeView(input.defaultHomeView)) {
      throw validationError("ui.defaultHomeView must be recommended or latest", {
        field: "ui.defaultHomeView",
        allowed: supportedDefaultHomeViews
      });
    }
    patch.defaultHomeView = input.defaultHomeView;
  }

  return patch;
}

function parseReaderPatch(value: unknown): ReaderSettingsPatch {
  const input = readSectionObject(value, "reader");
  rejectUnknownKeys(
    input,
    ["fontSize", "lineHeight", "paragraphGap", "readerWidth"],
    "reader"
  );

  const patch: ReaderSettingsPatch = {};

  if (Object.hasOwn(input, "fontSize")) {
    patch.fontSize = parseNumberInRange(input.fontSize, "reader.fontSize", "fontSize");
  }
  if (Object.hasOwn(input, "lineHeight")) {
    patch.lineHeight = parseNumberInRange(input.lineHeight, "reader.lineHeight", "lineHeight");
  }
  if (Object.hasOwn(input, "paragraphGap")) {
    patch.paragraphGap = parseNumberInRange(
      input.paragraphGap,
      "reader.paragraphGap",
      "paragraphGap"
    );
  }
  if (Object.hasOwn(input, "readerWidth")) {
    patch.readerWidth = parseNumberInRange(
      input.readerWidth,
      "reader.readerWidth",
      "readerWidth"
    );
  }

  return patch;
}

function parseRetentionPatch(value: unknown): SettingsPatch["retention"] {
  const input = readSectionObject(value, "retention");
  rejectUnknownKeys(input, ["retentionDays", "keepFavorites", "keepReadLater"], "retention");

  const patch: NonNullable<SettingsPatch["retention"]> = {};

  if (Object.hasOwn(input, "retentionDays")) {
    if (typeof input.retentionDays !== "number") {
      throw validationError("retention.retentionDays must be a number", {
        field: "retention.retentionDays"
      });
    }

    const retentionDays = parseRetentionDays(input.retentionDays);
    if (retentionDays === null) {
      throw validationError(
        `retention.retentionDays must be an integer between ${MIN_ARTICLE_RETENTION_DAYS} and ${MAX_ARTICLE_RETENTION_DAYS}`,
        {
          field: "retention.retentionDays",
          min: MIN_ARTICLE_RETENTION_DAYS,
          max: MAX_ARTICLE_RETENTION_DAYS
        }
      );
    }
    patch.retentionDays = retentionDays;
  }

  for (const key of ["keepFavorites", "keepReadLater"] as const) {
    if (Object.hasOwn(input, key)) {
      if (typeof input[key] !== "boolean") {
        throw validationError(`retention.${key} must be a boolean`, {
          field: `retention.${key}`
        });
      }
      patch[key] = input[key];
    }
  }

  return patch;
}

function readBodyObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw validationError("request body must be an object");
  }

  return value;
}

function readSectionObject(value: unknown, section: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw validationError(`${section} must be an object`, { field: section });
  }

  return value;
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
  prefix?: string
): void {
  const allowed = new Set(allowedKeys);

  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw validationError(
        prefix ? `${prefix}.${key} is not a writable setting` : `${key} is not a writable setting`,
        {
          field: prefix ? `${prefix}.${key}` : key
        }
      );
    }
  }
}

function readStoredNumber(
  value: unknown,
  fallback: number,
  field: keyof typeof READER_RANGES
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const range = READER_RANGES[field];
  return value >= range.min && value <= range.max ? value : fallback;
}

function readOptionalStoredNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value >= min && value <= max ? value : fallback;
}

function readStoredBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readIntegerInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return value >= min && value <= max ? value : fallback;
}

function parseIntegerField(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw validationError(`${field} must be an integer`, { field });
  }
  if (value < min || value > max) {
    throw validationError(`${field} must be between ${min} and ${max}`, {
      field,
      min,
      max
    });
  }
  return value;
}

function parseNumberInRange(
  value: unknown,
  field: string,
  rangeField: keyof typeof READER_RANGES
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw validationError(`${field} must be a number`, { field });
  }

  const range = READER_RANGES[rangeField];
  if (value < range.min || value > range.max) {
    throw validationError(`${field} must be between ${range.min} and ${range.max}`, {
      field,
      min: range.min,
      max: range.max
    });
  }

  return value;
}

function isSettingsLocale(value: unknown): value is SettingsLocale {
  return (
    typeof value === "string" &&
    (supportedSettingsLocales as readonly string[]).includes(value)
  );
}

function isDefaultHomeView(value: unknown): value is DefaultHomeView {
  return (
    typeof value === "string" &&
    (supportedDefaultHomeViews as readonly string[]).includes(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecommendationV3ModuleMode(
  value: unknown,
  fallback: RecommendationV3ModuleMode
): RecommendationV3ModuleMode {
  return isRecommendationV3ModuleMode(value) ? value : fallback;
}

function isRecommendationV3ModuleMode(value: unknown): value is RecommendationV3ModuleMode {
  return value === "disabled" || value === "shadow" || value === "active";
}

function validationError(message: string, details?: unknown): SettingsServiceError {
  return new SettingsServiceError(400, "VALIDATION_ERROR", message, details);
}
