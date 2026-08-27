import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import {
  ARTICLE_ACTION_EVENT_WEIGHTS,
  BASE_RANK_CONTEXT,
  getSqliteVecVersion,
  openDatabase,
  SqliteAppSettingsRepository,
  SqliteArticleActionRepository,
  SqliteArticleRepository,
  SqliteAuthCredentialRepository,
  SqliteEmbeddingRepository,
  SqliteFeedFolderRepository,
  SqliteFeedRepository,
  SqliteJobRepository,
  SqlitePluginRepository,
  SqliteProfileRepository,
  SqliteRankingRepository,
  SqliteReaderCommandEventRepository,
  SqliteSessionRepository,
  SqliteVecVectorStore,
  fromVectorBlob,
  runMigrations,
  type ArticleActionType,
  type ArticleDetailRow,
  type ArticleListCursor,
  type ArticleListInput,
  type ArticleListItemRow,
  type ArticleListView,
  type ArticleReadStatus,
  type ArticleScope,
  type ArticleSearchInput,
  type ArticleSearchSort,
  type ArticleSearchState,
  type DibaoDatabase,
  type EmbeddingIndexRow,
  type EmbeddingIndexListRow,
  type EmbeddingProviderRow,
  type FeedFolderRow,
  type FeedListInput,
  type FeedRow,
  type InterestClusterEvidenceRow,
  type InterestClusterRow,
  type JobRow,
  type JobStatus,
  type PluginJobType,
  type JobType,
  type ProfileSignalCountRow,
  type RecommendedArticleInventory,
  type RecommendedArticleSessionInventory
} from "@dibao/db";
import { cosineSimilarity, profileAlgorithmDefaults } from "@dibao/ranking";
import { dibaoVersion, type ApiError } from "@dibao/shared";
import {
  ArticleActionService,
  ArticleActionServiceError
} from "./article-action-service.js";
import { BackgroundWriteCoordinator } from "./background-write-coordinator.js";
import {
  BEHAVIOR_EVENT_PROJECT_JOB_PRIORITY,
  BEHAVIOR_EVENT_PROJECT_JOB_TYPE,
  BehaviorProjectionJobService
} from "./behavior-projection-job-service.js";
import {
  readSessionCookie,
  serializeClearSessionCookie,
  serializeSessionCookie
} from "./auth-cookie.js";
import { AuthService, AuthServiceError } from "./auth-service.js";
import { isSqliteBusyError } from "./sqlite-errors.js";
import { ArticleRetentionService } from "./article-retention-service.js";
import {
  CoreDatabaseMigrationService,
  type CoreDatabaseMigrationStatus
} from "./core-database-migration-service.js";
import {
  DerivedDataUpgradeService,
  type DerivedDataUpgradeStatus
} from "./derived-data-upgrade-service.js";
import {
  EmbeddingJobService,
  EMBEDDING_GENERATE_JOB_TYPE,
  parseEmbeddingGeneratePayload
} from "./embedding-job-service.js";
import {
  EmbeddingProviderService,
  EmbeddingProviderServiceError
} from "./embedding-provider-service.js";
import { GeminiEmbeddingAdapter } from "./embedding/gemini-adapter.js";
import { OllamaEmbeddingAdapter } from "./embedding/ollama-adapter.js";
import { OpenAiCompatibleEmbeddingAdapter } from "./embedding/openai-compatible-adapter.js";
import {
  FeedManagementService,
  FeedManagementServiceError
} from "./feed-management-service.js";
import {
  FeedDiscoveryError,
  FeedDiscoveryService,
  type FeedDiscoveryCandidate,
  type FeedDiscoveryResult
} from "./feed-discovery-service.js";
import {
  FeedHealthService,
  type FeedDiagnosticsResult,
  type FeedHealthDiagnostic
} from "./feed-health-service.js";
import {
  DEFAULT_FEED_REFRESH_INTERVAL_MS,
  FeedRefreshCoordinator,
  FeedRefreshJobService,
  FeedRefreshScheduler
} from "./feed-refresh-job-service.js";
import {
  FeedIngestionError,
  FeedRefreshService,
  type FeedFetcher
} from "./feed-refresh-service.js";
import {
  FeedFullContentService,
  type FullContentBackfillResult,
  type FullContentPreviewResponse
} from "./feed-full-content-service.js";
import {
  DEFAULT_FOREGROUND_ACTIVITY_WRITE_THROTTLE_MS,
  foregroundQuietUntil,
  foregroundActivitySignalPath,
  writeForegroundActivitySignal
} from "./foreground-activity.js";
import { FullContentExtractionService } from "./full-content-extraction-service.js";
import type { HostnameResolver } from "./controlled-fetch.js";
import {
  InterestClusterLabelService,
  InterestClusterLabelServiceError,
  INTEREST_CLUSTER_LABEL_REBUILD_JOB_TYPE
} from "./interest-cluster-label-service.js";
import { InterestClusterCalibrationService } from "./interest-cluster-calibration-service.js";
import {
  InterestClusterMergeService,
  InterestClusterMergeServiceError,
  INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE,
  INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE
} from "./interest-cluster-merge-service.js";
import {
  InterestFamilyService,
  InterestFamilyServiceError,
  INTEREST_FAMILY_REBUILD_JOB_TYPE,
  type RecommendationClusterFamily
} from "./interest-family-service.js";
import {
  jobQueueWakeSignalPath,
  watchJobQueueWakeSignal,
  writeJobQueueWakeSignal
} from "./job-queue-wake-signal.js";
import { JobRunner, type JobRunnerEvent } from "./job-runner.js";
import {
  DEFAULT_JOB_HISTORY_CLEANUP_INTERVAL_MS,
  DEFAULT_JOB_HISTORY_RETENTION_DAYS,
  JobHistoryCleanupScheduler
} from "./job-history-cleanup-scheduler.js";
import { LatestReleaseService } from "./latest-release-service.js";
import {
  OFFLINE_ARTICLE_BATCH_LIMIT,
  OFFLINE_RECOMMENDED_LIMIT_MAX,
  OFFLINE_RECOMMENDED_LIMIT_MIN,
  OfflineReadingService,
  type OfflineManifestArticle
} from "./offline-reading-service.js";
import { OpmlService, OpmlServiceError } from "./opml-service.js";
import { PluginService, PluginServiceError } from "./plugin-service.js";
import { pluginUiCss } from "./plugin-ui.js";
import {
  DEFAULT_PROFILE_DECAY_INTERVAL_MS,
  ProfileDecayJobService,
  ProfileDecayScheduler
} from "./profile-decay-job-service.js";
import {
  PROFILE_EVENT_PROCESS_JOB_TYPE,
  ProfileEventProcessJobService
} from "./profile-event-job-service.js";
import { ProfileService } from "./profile-service.js";
import { ProfileRebuildService } from "./profile-rebuild-service.js";
import {
  RankingRecalculateJobService,
  RANKING_RECALCULATE_JOB_TYPE,
  RANKING_RECALCULATE_REFRESH_DELAY_MS
} from "./ranking-job-service.js";
import {
  ReaderCommandService,
  ReaderCommandServiceError
} from "./reader-command-service.js";
import {
  ReaderDiscoveryService,
  type RelatedSearchResponse,
  type ReaderDiscoveryResponse
} from "./reader-discovery-service.js";
import {
  ARTICLE_FINGERPRINT_BACKFILL_JOB_TYPE,
  DUPLICATE_GROUP_REBUILD_JOB_TYPE,
  FTRL_TRAIN_JOB_TYPE,
  KEYWORD_PROFILE_REBUILD_JOB_TYPE,
  RANKING_EVAL_RUN_JOB_TYPE,
  RECOMMENDATION_BACKFILL_JOB_TYPE,
  RECENT_INTENT_REBUILD_JOB_TYPE,
  RecommendationMaintenanceService,
  RecommendationMaintenanceServiceError
} from "./recommendation-maintenance-service.js";
import {
  DEFAULT_RECOMMENDATION_MAINTENANCE_SCHEDULER_INTERVAL_MS,
  RecommendationMaintenanceScheduler
} from "./recommendation-maintenance-scheduler.js";
import {
  RECOMMENDATION_ALGORITHM_VERSION,
  RECOMMENDATION_FEATURE_SCHEMA_VERSION,
  RecommendationRankingService,
  type RankExplanationClusterMatch,
  type RankExplanationResult
} from "./ranking-service.js";
import { RecommendationMemoryService } from "./recommendation-memory-service.js";
import { PassiveExposureBuffer } from "./passive-exposure-buffer.js";
import {
  DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
  RetentionCleanupJobService,
  RetentionCleanupScheduler
} from "./retention-cleanup-job-service.js";
import { SettingsService, SettingsServiceError } from "./settings-service.js";
import {
  attachServerTelemetryErrorHandler,
  configureServerTelemetry
} from "./telemetry.js";
import {
  VectorIndexRebuildJobService,
  VECTOR_INDEX_REBUILD_JOB_TYPE
} from "./vector-index-rebuild-job-service.js";

type HealthStatus = "ok" | "error";

type HealthResponse = {
  ok: boolean;
  database: HealthStatus;
  fts: HealthStatus;
  vectorStore: HealthStatus;
  version: string;
};

type SetupStatusResponse = {
  setupCompleted: boolean;
  hasFeeds: boolean;
  hasEmbeddingProvider: boolean;
  firstRefreshStatus: "idle" | "running" | "succeeded" | "failed";
  coreDatabaseMigration?: CoreDatabaseMigrationStatus;
  derivedDataUpgrade?: DerivedDataUpgradeStatus;
  optionalPluginSteps?: unknown[];
};

type FeedQuery = {
  folderId?: string;
  enabled?: string;
};

type CreateFeedBody = {
  feedUrl?: unknown;
  folderId?: unknown;
};

type DiscoverFeedBody = {
  url?: unknown;
};

type FeedFolderParams = {
  id: string;
};

type AuthCredentialBody = {
  username?: unknown;
  password?: unknown;
  telemetryEnabled?: unknown;
};

type ChangePasswordBody = {
  currentPassword?: unknown;
  newPassword?: unknown;
};

type FeedParams = {
  id: string;
};

type FullContentPreviewBody = {
  articleUrl?: unknown;
};

type ArticleQuery = {
  view?: string;
  feedId?: string;
  folderId?: string;
  status?: string;
  unreadOnly?: string;
  includeUnreadCount?: string;
  todayOnly?: string;
  timeWindow?: string;
  limit?: string;
  cursor?: string;
  sort?: string;
  recommendationSessionId?: string;
};

type ReaderDiscoveryQuery = {
  limit?: string;
};

type RelatedSearchQuery = {
  limit?: string;
  cursor?: string;
  state?: string;
};

type RecommendationInventoryQuery = ArticleQuery & {
  loadedCount?: string;
  recommendationSessionPosition?: string;
};

type SearchQuery = {
  q?: string;
  scope?: string;
  feedId?: string;
  folderId?: string;
  from?: string;
  to?: string;
  state?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
  includeUnreadCount?: string;
};

type JobQuery = {
  status?: string;
  type?: string;
  limit?: string;
};

type PluginParams = {
  id: string;
};

type PluginTaskParams = {
  id: string;
  taskId: string;
};

type PluginTaskRunParams = {
  id: string;
  runId: string;
};

type PluginSecretParams = {
  id: string;
  key: string;
};

type PluginDeliveryParams = {
  id: string;
  deliveryId: string;
};

type PluginDeliveryQuery = {
  status?: string;
  limit?: string;
};

type PluginApiParams = {
  id: string;
  "*": string;
};

type PluginAssetParams = PluginApiParams;

type PluginInstallBody = {
  url?: unknown;
  package?: unknown;
  sha256?: unknown;
};

type OptionalPluginBody = {
  enabled?: unknown;
  timezone?: unknown;
};

type PluginUninstallQuery = {
  deleteData?: string;
};

type ArticleParams = {
  id: string;
};

type ArticleActionBody = {
  clientActionId?: unknown;
  type?: unknown;
  value?: unknown;
  progress?: unknown;
  metadata?: unknown;
};

type OfflineManifestQuery = {
  recommendedLimit?: string;
};

type OfflineArticleBatchBody = {
  articleIds?: unknown;
};

type BulkArticleActionBody = {
  actions?: unknown;
};

type ReaderCommandBody = {
  scope?: unknown;
};

type EmbeddingProviderParams = {
  id: string;
};

type EmbeddingIndexParams = {
  id: string;
};

type RecommendationMaintenanceParams = {
  task: string;
};

type RecommendationExposureBody = {
  clientSessionId?: unknown;
  articleIds?: unknown;
  exposedAt?: unknown;
};

type RecommendationClusterQuery = {
  limit?: string;
  clusterDetailLevel?: string;
};

type RecommendationStatusQuery = {
  includeClusterItems?: string;
  clusterItemLimit?: string;
  clusterDetailLevel?: string;
};

type RecommendationInventoryState = "available" | "empty" | "ranking";

type RecommendationInventoryResponse = {
  status: RecommendationInventoryState;
  activeRankContext: string;
  latestRerankWindowId: string | null;
  eligibleCount: number;
  sortedCount: number;
  remainingSortedCount: number;
  latestActiveCount: number;
  staleActiveCount: number;
  fallbackCount: number;
  baseFallbackCount: number;
  unrankedFallbackCount: number;
  loadedCount: number;
  recommendationSessionId: string | null;
  recommendationSessionPosition: number | null;
  recommendationSessionExpiresAt: string | null;
  rankingJob: {
    queued: number;
    running: number;
  };
  lastRankedAt: string | null;
  updatedAt: string;
};

type RecommendationMergeCandidateQuery = {
  status?: string;
  limit?: string;
};

type RecommendationClusterParams = {
  id: string;
};

type RecommendationMergeCandidateParams = {
  id: string;
};

type RecommendationFamilyParams = {
  id: string;
};

type RecommendationClusterLabelBody = {
  manualLabel?: unknown;
};

type RecommendationFamilyLabelBody = {
  manualLabel?: unknown;
};

type RecommendationClusterDetailLevel = "summary" | "diagnostic";

type CursorPayload = {
  offset: number;
};

type EncodedCursorPayload = CursorPayload | { keyset: ArticleListCursor };

const ARTICLE_EXPLANATION_CACHE_TTL_MS = 60_000;
const ARTICLE_EXPLANATION_CACHE_MAX_ENTRIES = 500;
const RECOMMENDATION_SESSION_TTL_MS = 24 * 60 * 60_000;
const RECOMMENDATION_SESSION_MAX_ITEMS = 1_000;
const WAL_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const WAL_MAINTENANCE_MIN_BYTES = 16 * 1024 * 1024;

type BuildServerOptions = {
  db?: DibaoDatabase;
  databasePath?: string;
  migrate?: boolean;
  closeDatabaseOnClose?: boolean;
  feedFetcher?: FeedFetcher;
  now?: () => number;
  logger?: boolean;
  cookieSecure?: boolean;
  authRequired?: boolean;
  authMaxFailedLoginAttempts?: number;
  authLoginLockoutMs?: number;
  backgroundJobs?: boolean;
  feedRefreshIntervalMs?: number;
  retentionCleanupIntervalMs?: number;
  jobHistoryCleanupIntervalMs?: number;
  jobHistoryRetentionDays?: number;
  profileDecayIntervalMs?: number;
  recommendationMaintenanceIntervalMs?: number;
  jobRunnerIntervalMs?: number;
  jobRunnerMaxJobsPerDrain?: number;
  jobRetryDelayMs?: number;
  embeddingFetcher?: typeof fetch;
  fullContentFetcher?: typeof fetch;
  latestReleaseFetcher?: typeof fetch;
  pluginFetcher?: typeof fetch;
  fetchResolveHostname?: HostnameResolver;
  enableUserPluginInstall?: boolean;
  pluginTrustedPublicKeys?: Record<string, string>;
  officialPluginsDir?: string;
  pluginDataDir?: string;
  pluginSecretKey?: string;
  webDistDir?: string | false;
  coreMigrationDeferMs?: number;
  upgradeAutoStart?: boolean;
  recordForegroundActivity?: boolean;
  foregroundActivityWriteThrottleMs?: number;
  foregroundQuietWindowMs?: number;
  backgroundStartupDelayMs?: number;
  rankingTargetChunkMs?: number;
};

export type DibaoServerInstance = FastifyInstance & {
  drainBackgroundJobsNow?: () => Promise<number>;
};

export function buildServer(options: BuildServerOptions = {}) {
  const configuredDatabasePath = options.databasePath
    ? resolveDatabasePath(options.databasePath)
    : options.db
      ? undefined
      : resolveDatabasePath(undefined);
  const db = options.db ?? openConfiguredDatabase(options);
  const closeDatabaseOnClose = options.closeDatabaseOnClose ?? !options.db;
  const settings = new SqliteAppSettingsRepository(db);
  const credentials = new SqliteAuthCredentialRepository(db);
  const sessions = new SqliteSessionRepository(db);
  const folders = new SqliteFeedFolderRepository(db);
  const feeds = new SqliteFeedRepository(db);
  const jobs = new SqliteJobRepository(db);
  const plugins = new SqlitePluginRepository(db);
  const articles = new SqliteArticleRepository(db);
  const readerCommandEvents = new SqliteReaderCommandEventRepository(db);
  const embeddings = new SqliteEmbeddingRepository(db);
  const articleActions = new SqliteArticleActionRepository(db);
  const rankings = new SqliteRankingRepository(db);
  const profiles = new SqliteProfileRepository(db);
  const vectorStore = new SqliteVecVectorStore(db);
  const app = Fastify({
    logger: options.logger ?? true
  });
  const backgroundJobs = options.backgroundJobs ?? false;
  const recordForegroundActivityEnabled = options.recordForegroundActivity ?? !backgroundJobs;
  const foregroundActivityWriteThrottleMs =
    options.foregroundActivityWriteThrottleMs ??
    DEFAULT_FOREGROUND_ACTIVITY_WRITE_THROTTLE_MS;
  const foregroundSignalPath = foregroundActivitySignalPath(configuredDatabasePath);
  const jobWakeSignalPath = jobQueueWakeSignalPath(configuredDatabasePath);
  const foregroundQuietWindowMs = Math.max(0, options.foregroundQuietWindowMs ?? 0);
  const backgroundStartupDelayMs = Math.max(0, options.backgroundStartupDelayMs ?? 0);
  const backgroundInitialTickDelayMs = backgroundJobs
    ? Math.max(backgroundStartupDelayMs, foregroundQuietWindowMs)
    : 0;
  let lastForegroundActivityWriteAt = 0;
  const coreDatabaseMigrationService = new CoreDatabaseMigrationService({
    db,
    databasePath: configuredDatabasePath,
    runInChildProcess: !options.db && configuredDatabasePath !== undefined,
    now: options.now,
    deferMs: options.coreMigrationDeferMs,
    onError: (error) => app.log.error(error)
  });
  const hasBlockingCoreMigration = coreDatabaseMigrationService.getStatus().blocking;
  const onFetchWarning = (warning: unknown) => {
    app.log.warn({ event: "outbound_fetch_private_target", warning });
  };
  let pluginServiceForFullContent: PluginService | null = null;
  const fullContentExtractor = new FullContentExtractionService({
    fetcher: options.fullContentFetcher,
    pluginExtractor: async (input) => pluginServiceForFullContent?.extractFullContent(input) ?? null,
    onFetchWarning,
    resolveHostname: options.fetchResolveHostname
  });
  const embeddingAdapters = {
    openai_compatible: new OpenAiCompatibleEmbeddingAdapter({
      fetcher: options.embeddingFetcher
    }),
    gemini: new GeminiEmbeddingAdapter({
      fetcher: options.embeddingFetcher
    }),
    ollama: new OllamaEmbeddingAdapter({
      fetcher: options.embeddingFetcher
    })
  };
  const embeddingProviderService = new EmbeddingProviderService({
    embeddings,
    vectorStore,
    adapters: embeddingAdapters,
    now: options.now
  });
  const settingsService = new SettingsService({
    settings,
    now: options.now
  });
  const existingCredential = credentials.findCredential();
  if (existingCredential) {
    settingsService.ensureInstallationCompletedAt(existingCredential.createdAt);
  }
  const latestReleaseService = new LatestReleaseService({
    settings,
    now: options.now,
    fetcher: options.latestReleaseFetcher,
    getInstallationCompletedAt: () => settingsService.ensureInstallationCompletedAt()
  });
  const profileService = new ProfileService({
    embeddings,
    profiles,
    getClusterLimits: () => settingsService.getSettings().ranking,
    getClusterCalibration: (embeddingIndexId) =>
      clusterCalibrationService.getOrCreateCalibration(embeddingIndexId),
    now: options.now
  });
  configureServerTelemetry({
    enabled: settingsService.getSettings().telemetry.enabled
  });
  const recommendationMemoryService = new RecommendationMemoryService(db, options.now);
  const passiveExposureBuffer = new PassiveExposureBuffer(recommendationMemoryService);
  attachServerTelemetryErrorHandler(app);
  const rankingService = new RecommendationRankingService({
    db,
    embeddings,
    profiles,
    rankings,
    getRankingSettings: () => settingsService.getSettings().ranking,
    shouldPause: () => {
      if (foregroundQuietWindowMs <= 0) {
        return { pause: false };
      }
      const now = options.now?.() ?? Date.now();
      const resumeAfter = foregroundQuietUntil(settings, {
        now,
        quietWindowMs: foregroundQuietWindowMs,
        signalPath: foregroundSignalPath
      });
      return resumeAfter ? { pause: true, resumeAfter } : { pause: false };
    },
    maxChunkDurationMs: options.rankingTargetChunkMs,
    now: options.now
  });
  const readerDiscoveryService = new ReaderDiscoveryService({
    articles,
    embeddings,
    vectorStore,
    getActiveRankContext: () => rankingService.getActiveRankContext()
  });
  const offlineReadingService = new OfflineReadingService({
    articles,
    getActiveRankContext: () => rankingService.getActiveRankContext(),
    now: options.now
  });
  const articleExplanationCache = new Map<
    string,
    { articleId: string; rankContext: string; explanation: RankExplanationResult; expiresAt: number }
  >();
  function cachedArticleExplanation(articleId: string): {
    explanation: RankExplanationResult | null;
    cacheHit: boolean;
  } {
    const rankContext = rankingService.getActiveRankContext();
    const cacheKey = `${rankContext}:${articleId}`;
    const now = options.now?.() ?? Date.now();
    const cached = articleExplanationCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      articleExplanationCache.delete(cacheKey);
      articleExplanationCache.set(cacheKey, cached);
      return { explanation: cached.explanation, cacheHit: true };
    }
    if (cached) {
      articleExplanationCache.delete(cacheKey);
    }

    const explanation = rankingService.explainArticle(articleId);
    if (!explanation) {
      return { explanation: null, cacheHit: false };
    }

    articleExplanationCache.set(cacheKey, {
      articleId,
      rankContext,
      explanation,
      expiresAt: now + ARTICLE_EXPLANATION_CACHE_TTL_MS
    });
    while (articleExplanationCache.size > ARTICLE_EXPLANATION_CACHE_MAX_ENTRIES) {
      const oldestKey = articleExplanationCache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      articleExplanationCache.delete(oldestKey);
    }
    return { explanation, cacheHit: false };
  }
  function invalidateArticleExplanationCache(articleId: string): void {
    for (const [key, value] of articleExplanationCache) {
      if (value.articleId === articleId) {
        articleExplanationCache.delete(key);
      }
    }
  }
  let drainDueJobsForPlugins: (() => Promise<number>) | null = null;
  const pluginService = new PluginService({
    db,
    plugins,
    jobs,
    dibaoVersion,
    getActiveRankContext: () => rankingService.getActiveRankContext(),
    getLocale: () => settingsService.getSettings().ui.locale,
    officialPluginsDir: options.officialPluginsDir,
    pluginDataDir: options.pluginDataDir,
    secretKey: options.pluginSecretKey,
    fetcher: options.pluginFetcher,
    resolveHostname: options.fetchResolveHostname,
    enableUserPluginInstall: options.enableUserPluginInstall,
    trustedPublicKeys: options.pluginTrustedPublicKeys,
    now: options.now,
    drainDueJobs: async () => drainDueJobsForPlugins ? await drainDueJobsForPlugins() : 0,
    logPerformance: (record) => {
      app.log.info(record, "plugin.api.performance");
    }
  });
  pluginServiceForFullContent = pluginService;
  if (!hasBlockingCoreMigration) {
    pluginService.reconcileOfficialPlugins();
  }
  const backgroundWriteCoordinator = new BackgroundWriteCoordinator({
    onRun: (record) => {
      app.log.info(
        {
          route: "jobs.backgroundWrite",
          name: record.name,
          priority: record.priority,
          durationMs: roundDuration(record.durationMs)
        },
        "job.performance"
      );
    }
  });
  const rankingJobService = new RankingRecalculateJobService({
    jobs,
    ranking: rankingService,
    now: options.now
  });
  const behaviorProjectionJobService = new BehaviorProjectionJobService({
    db,
    jobs,
    profile: profileService,
    rankingJobs: rankingJobService,
    now: options.now
  });
  const readerCommandService = new ReaderCommandService({
    articles,
    commandEvents: readerCommandEvents,
    rankingJobs: rankingJobService,
    now: options.now
  });
  const clusterLabelService = new InterestClusterLabelService({
    db,
    settings,
    now: options.now
  });
  const clusterCalibrationService = new InterestClusterCalibrationService({
    db,
    now: options.now
  });
  const clusterMergeService = new InterestClusterMergeService({
    db,
    clusterLabels: clusterLabelService,
    now: options.now
  });
  const interestFamilyService = new InterestFamilyService({
    db,
    getFamilyLimits: () => settingsService.getSettings().ranking,
    getClusterCalibration: (embeddingIndexId) =>
      clusterCalibrationService.getOrCreateCalibration(embeddingIndexId),
    now: options.now
  });
  const profileRebuildService = new ProfileRebuildService({
    db,
    profile: profileService,
    clusterLabels: clusterLabelService,
    calibration: clusterCalibrationService,
    interestFamilies: interestFamilyService,
    ranking: rankingService
  });
  const derivedDataUpgradeService = new DerivedDataUpgradeService({
    db,
    settings,
    profileRebuild: profileRebuildService,
    now: options.now,
    onError: (error) => app.log.error(error)
  });
  const recommendationMaintenanceService = new RecommendationMaintenanceService({
    db,
    jobs,
    rankingJobs: rankingJobService,
    clusterLabels: clusterLabelService,
    clusterMerge: clusterMergeService,
    interestFamilies: interestFamilyService,
    memory: recommendationMemoryService,
    getRankingSettings: () => settingsService.getSettings().ranking,
    getMaintenanceSettings: () => settingsService.getSettings().recommendationMaintenance,
    now: options.now
  });
  const embeddingJobService = new EmbeddingJobService({
    articles,
    embeddings,
    jobs,
    providerService: embeddingProviderService,
    profile: profileService,
    rankingJobs: rankingJobService,
    recordUsage: (input) => {
      db.prepare(
        `
          insert into embedding_usage_events (
            id,
            provider_id,
            embedding_index_id,
            model,
            source,
            request_count,
            item_count,
            estimated_tokens,
            created_at
          )
          values (?, ?, ?, ?, 'job', 1, ?, ?, ?)
        `
      ).run(
        `usage_${randomBytes(10).toString("hex")}`,
        input.providerId,
        input.embeddingIndexId,
        input.model,
        input.itemCount,
        input.estimatedTokens,
        input.now
      );
    },
    requestCountSince: (input) => {
      const row = db
        .prepare(
          `
            select coalesce(sum(request_count), 0) as count
            from embedding_usage_events
            where provider_id = ?
              and created_at >= ?
          `
        )
        .get(input.providerId, input.since) as { count: number } | undefined;

      return row?.count ?? 0;
    },
    vectorStore,
    now: options.now
  });
  const vectorIndexRebuildJobService = new VectorIndexRebuildJobService({
    embeddings,
    jobs,
    vectorStore,
    now: options.now
  });
  const feedRefreshService = new FeedRefreshService({
    db,
    feeds,
    articles,
    fetcher: options.feedFetcher,
    fullContentExtractor,
    onFetchWarning,
    resolveHostname: options.fetchResolveHostname,
    now: options.now
  });
  const feedFullContentService = new FeedFullContentService({
    feeds,
    refreshService: feedRefreshService,
    extractor: fullContentExtractor
  });
  const feedDiscoveryService = new FeedDiscoveryService({
    feeds,
    fetcher: options.feedFetcher,
    onFetchWarning,
    resolveHostname: options.fetchResolveHostname
  });
  const feedHealthService = new FeedHealthService({
    feeds,
    now: options.now
  });
  const feedRefreshCoordinator = new FeedRefreshCoordinator({
    refreshService: feedRefreshService,
    afterRefresh: (result) => {
      handleEffectiveContentChanged(result.effectiveContentChangedArticleIds);
      void pluginService.emitHook("feed.refreshCompleted", {
        feedId: result.feed.id,
        refreshedAt: options.now?.() ?? Date.now(),
        articleIds: result.articleIds,
        createdArticleIds: result.createdArticleIds,
        updatedArticleIds: result.updatedArticleIds,
        articlesSeen: result.articlesSeen,
        articlesCreated: result.articlesCreated,
        articlesUpdated: result.articlesUpdated
      }).catch((error) => app.log.error(error));
      for (const articleId of result.createdArticleIds) {
        void pluginService.emitHook("article.created", {
          articleId,
          feedId: result.feed.id,
          createdAt: options.now?.() ?? Date.now()
        }).catch((error) => app.log.error(error));
      }
      for (const articleId of result.updatedArticleIds) {
        void pluginService.emitHook("article.updated", {
          articleId,
          feedId: result.feed.id,
          updatedAt: options.now?.() ?? Date.now()
        }).catch((error) => app.log.error(error));
      }
      const maintenanceSettings = settingsService.getSettings().recommendationMaintenance;
      if (
        result.articleIds.length > 0 &&
        maintenanceSettings.maintenanceEnabled &&
        maintenanceSettings.duplicateAutoRebuildEnabled
      ) {
        recommendationMaintenanceService.enqueueFingerprintBackfill();
        const duplicateResult = recommendationMaintenanceService.enqueueDuplicateRebuild({
          runAfter: (options.now ?? Date.now)() + 20 * 60_000
        });
        recommendationMaintenanceService.recordScheduleEnqueue("duplicate_hourly", duplicateResult);
      }
    }
  });
  const feedRefreshJobService = new FeedRefreshJobService({
    feeds,
    jobs,
    refresher: feedRefreshCoordinator,
    now: options.now
  });
  const profileEventJobService = new ProfileEventProcessJobService({
    jobs,
    profile: profileService,
    rankingJobs: rankingJobService,
    now: options.now
  });
  const articleActionService = new ArticleActionService({
    actions: articleActions,
    behaviorProjectionJobs: behaviorProjectionJobService,
    recommendationMemory: recommendationMemoryService,
    maintenance: {
      enqueueStrongActionMaintenance: (now) => {
        const maintenanceSettings = settingsService.getSettings().recommendationMaintenance;
        if (
          !maintenanceSettings.maintenanceEnabled ||
          (!maintenanceSettings.recentIntentAutoRebuildEnabled &&
            !maintenanceSettings.ftrlAutoTrainEnabled)
        ) {
          recommendationMaintenanceService.recordScheduleSkip("recent_intent_periodic", "disabled");
          recommendationMaintenanceService.recordScheduleSkip("ftrl_train_periodic", "disabled");
          return null;
        }

        const results = {
          recentIntent: maintenanceSettings.recentIntentAutoRebuildEnabled
            ? recommendationMaintenanceService.enqueueRecentIntentRebuild({
                runAfter: (now ?? (options.now ?? Date.now)()) + 10 * 60_000
              })
            : null,
          ftrlTrain: maintenanceSettings.ftrlAutoTrainEnabled
            ? recommendationMaintenanceService.enqueueFtrlTrain({
                runAfter: (now ?? (options.now ?? Date.now)()) + 15 * 60_000
              })
            : null
        };
        if (results.recentIntent) {
          recommendationMaintenanceService.recordScheduleEnqueue(
            "recent_intent_periodic",
            results.recentIntent
          );
        } else {
          recommendationMaintenanceService.recordScheduleSkip("recent_intent_periodic", "disabled");
        }
        if (results.ftrlTrain) {
          recommendationMaintenanceService.recordScheduleEnqueue("ftrl_train_periodic", results.ftrlTrain);
        } else {
          recommendationMaintenanceService.recordScheduleSkip("ftrl_train_periodic", "disabled");
        }
        return results;
      }
    },
    removeReadLaterOnReadComplete: () =>
      settingsService.getSettings().behavior.removeReadLaterOnReadComplete,
    now: options.now
  });
  const feedManagementService = new FeedManagementService({
    feeds,
    folders,
    rankingJobs: rankingJobService,
    now: options.now
  });
  const opmlService = new OpmlService({
    folders,
    feeds,
    now: options.now
  });
  const authService = new AuthService({
    credentials,
    sessions,
    settings,
    now: options.now,
    maxFailedLoginAttempts: options.authMaxFailedLoginAttempts,
    loginLockoutMs: options.authLoginLockoutMs,
    onSessionTouchError: (error) => {
      app.log.warn({ error, route: "auth.session.touch" }, "database is busy while touching session");
    }
  });
  const articleRetentionService = new ArticleRetentionService({
    settings,
    articles,
    vectorStore,
    now: options.now
  });
  const retentionCleanupJobService = new RetentionCleanupJobService({
    jobs,
    retention: articleRetentionService,
    now: options.now
  });
  const profileDecayJobService = new ProfileDecayJobService({
    jobs,
    profile: profileService,
    rankingJobs: rankingJobService,
    settings,
    now: options.now
  });
  const cookieOptions = {
    secure: resolveCookieSecure(options.cookieSecure)
  };
  const authRequired = options.authRequired ?? true;
  let maintenanceTickTimer: NodeJS.Timeout | null = null;
  let maintenanceInitialTickTimer: NodeJS.Timeout | null = null;
  let walMaintenanceTimer: NodeJS.Timeout | null = null;
  let backgroundStartupTimer: NodeJS.Timeout | null = null;
  let stopJobWakeWatcher: (() => void) | null = null;
  let backgroundServicesStarted = false;
  let recommendationInventorySubscriberId = 0;
  let recommendationInventoryHeartbeatTimer: NodeJS.Timeout | null = null;
  const recommendationInventorySubscribers = new Map<
    number,
    {
      input: ArticleListInput;
      loadedCount: number;
      recommendationSessionPosition: number;
      send: (payload: RecommendationInventoryResponse) => void;
      heartbeat: () => void;
      close: () => void;
    }
  >();

  const jobRunner = new JobRunner({
    jobs,
    handlers: {
      feed_refresh: (job) => feedRefreshJobService.handleFeedRefreshJob(job),
      retention_cleanup: (job) => retentionCleanupJobService.handleRetentionCleanupJob(job),
      profile_decay: (job) => profileDecayJobService.handleProfileDecayJob(job),
      [PROFILE_EVENT_PROCESS_JOB_TYPE]: (job) =>
        profileEventJobService.handleProfileEventProcessJob(job),
      [BEHAVIOR_EVENT_PROJECT_JOB_TYPE]: async (job) => {
        const result = await backgroundWriteCoordinator.run(
          {
            name: BEHAVIOR_EVENT_PROJECT_JOB_TYPE,
            priority: BEHAVIOR_EVENT_PROJECT_JOB_PRIORITY
          },
          () => behaviorProjectionJobService.handleBehaviorEventProjectJob(job)
        );
        app.log.info(
          {
            route: "jobs.behaviorProjection",
            jobId: job.id,
            processed: result.processed,
            hasMore: result.hasMore,
            enqueuedRanking: result.enqueuedRanking
          },
          "job.performance"
        );
      },
      [RANKING_RECALCULATE_JOB_TYPE]: async (job) => {
        const result = await backgroundWriteCoordinator.run(
          {
            name: RANKING_RECALCULATE_JOB_TYPE,
            priority: job.priority
          },
          () => rankingJobService.handleRankingRecalculateJob(job)
        );
        if (result.processed > 0) {
          await pluginService.emitHook("ranking.afterRanked", {
            jobId: job.id,
            rankedAt: options.now?.() ?? Date.now()
          });
        }
      },
      [EMBEDDING_GENERATE_JOB_TYPE]: (job) =>
        embeddingJobService.handleEmbeddingGenerateJob(job),
      [VECTOR_INDEX_REBUILD_JOB_TYPE]: (job) =>
        vectorIndexRebuildJobService.handleVectorIndexRebuildJob(job),
      [ARTICLE_FINGERPRINT_BACKFILL_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [DUPLICATE_GROUP_REBUILD_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [KEYWORD_PROFILE_REBUILD_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [RECENT_INTENT_REBUILD_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [RANKING_EVAL_RUN_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [FTRL_TRAIN_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [RECOMMENDATION_BACKFILL_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [INTEREST_CLUSTER_LABEL_REBUILD_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job),
      [INTEREST_FAMILY_REBUILD_JOB_TYPE]: (job) =>
        recommendationMaintenanceService.handleJob(job)
    },
    pluginHandler: pluginService.handlePluginJob,
    now: options.now,
    pollIntervalMs: options.jobRunnerIntervalMs,
    retryDelayMs: options.jobRetryDelayMs,
    maxJobsPerDrain: options.jobRunnerMaxJobsPerDrain,
    onEvent: (event) => {
      app.log.info(jobRunnerEventLog(event), "job.runner");
      if (
        event.job.type === RANKING_RECALCULATE_JOB_TYPE ||
        event.job.type === BEHAVIOR_EVENT_PROJECT_JOB_TYPE
      ) {
        broadcastRecommendationInventory("ranking job event");
      }
    },
    beforeRun: (job) => {
      if (foregroundQuietWindowMs <= 0 || !isForegroundDeferrableJobType(job.type)) {
        return { run: true };
      }

      const now = options.now?.() ?? Date.now();
      const deferUntil = foregroundQuietUntil(settings, {
        now,
        quietWindowMs: foregroundQuietWindowMs,
        signalPath: foregroundSignalPath
      });
      return deferUntil
        ? {
            run: false,
            deferUntil,
            reason: `Deferred ${job.type} until foreground quiet window ends`
          }
        : { run: true };
    },
    onError: (error) => app.log.error(error)
  });
  drainDueJobsForPlugins = async () => await jobRunner.drainDue();
  (app as DibaoServerInstance).drainBackgroundJobsNow = async () => await jobRunner.drainDue();
  const feedRefreshScheduler = new FeedRefreshScheduler({
    refreshJobs: feedRefreshJobService,
    runner: jobRunner,
    intervalMs: options.feedRefreshIntervalMs ?? DEFAULT_FEED_REFRESH_INTERVAL_MS,
    initialDelayMs: backgroundInitialTickDelayMs,
    onError: (error) => app.log.error(error)
  });
  const retentionCleanupScheduler = new RetentionCleanupScheduler({
    cleanupJobs: retentionCleanupJobService,
    runner: jobRunner,
    intervalMs: options.retentionCleanupIntervalMs ?? DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
    initialDelayMs: backgroundInitialTickDelayMs,
    onError: (error) => app.log.error(error)
  });
  const jobHistoryCleanupScheduler = new JobHistoryCleanupScheduler({
    jobs,
    retentionDays: options.jobHistoryRetentionDays ?? DEFAULT_JOB_HISTORY_RETENTION_DAYS,
    intervalMs:
      options.jobHistoryCleanupIntervalMs ?? DEFAULT_JOB_HISTORY_CLEANUP_INTERVAL_MS,
    initialDelayMs: backgroundInitialTickDelayMs,
    now: options.now,
    onCleanup: (result) => {
      if (result.deleted > 0) {
        app.log.info({
          route: "jobs.historyCleanup",
          cutoff: result.cutoff,
          deleted: result.deleted
        });
      }
    },
    onError: (error) => app.log.error(error)
  });
  const profileDecayScheduler = new ProfileDecayScheduler({
    decayJobs: profileDecayJobService,
    runner: jobRunner,
    intervalMs: options.profileDecayIntervalMs ?? DEFAULT_PROFILE_DECAY_INTERVAL_MS,
    initialDelayMs: backgroundInitialTickDelayMs,
    onError: (error) => app.log.error(error)
  });
  const recommendationMaintenanceScheduler = new RecommendationMaintenanceScheduler({
    db,
    jobs,
    maintenance: recommendationMaintenanceService,
    settings: () => settingsService.getSettings().recommendationMaintenance,
    embeddingJobs: embeddingJobService,
    runner: jobRunner,
    intervalMs:
      options.recommendationMaintenanceIntervalMs ??
      DEFAULT_RECOMMENDATION_MAINTENANCE_SCHEDULER_INTERVAL_MS,
    initialDelayMs: backgroundInitialTickDelayMs,
    now: options.now,
    onError: (error) => app.log.error(error)
  });

  function drainBackgroundJobs(): void {
    if (backgroundJobs) {
      void jobRunner.drainDue().catch((error) => app.log.error(error));
      return;
    }

    if (jobWakeSignalPath) {
      writeJobQueueWakeSignal(
        jobWakeSignalPath,
        { now: options.now?.() ?? Date.now() },
        (error) => app.log.warn({ error }, "job.queue_wake.write_failed")
      );
    }
  }

  function enqueueEmbeddingArticles(articleIds: string[]): void {
    try {
      const queued = embeddingJobService.enqueueArticlesForActiveIndex(articleIds);
      if (queued.length > 0) {
        drainBackgroundJobs();
      }
    } catch (error) {
      app.log.error(error);
    }
  }

  function enqueueEmbeddingBackfill(): void {
    try {
      const queued = embeddingJobService.enqueueBackfillForActiveIndex();
      if (queued.length > 0) {
        drainBackgroundJobs();
      }
    } catch (error) {
      app.log.error(error);
    }
  }

  function enqueueRankingAll(): void {
    try {
      rankingJobService.enqueueAll();
      drainBackgroundJobs();
    } catch (error) {
      app.log.error(error);
    }
  }

  function handleEffectiveContentChanged(articleIds: string[]): void {
    const uniqueArticleIds = [...new Set(articleIds)].filter((articleId) => articleId.trim());
    if (uniqueArticleIds.length === 0) {
      return;
    }

    enqueueEmbeddingArticles(uniqueArticleIds);
    try {
      rankingJobService.enqueueArticles(uniqueArticleIds, {
        delayMs: RANKING_RECALCULATE_REFRESH_DELAY_MS
      });
      if (hasBehaviorEvidence(uniqueArticleIds)) {
        const maintenanceSettings = settingsService.getSettings().recommendationMaintenance;
        if (maintenanceSettings.maintenanceEnabled) {
          recommendationMaintenanceService.enqueueRecalculate();
          if (maintenanceSettings.keywordAutoRebuildEnabled) {
            recommendationMaintenanceService.enqueueKeywordRebuild();
          }
          if (maintenanceSettings.recentIntentAutoRebuildEnabled) {
            recommendationMaintenanceService.enqueueRecentIntentRebuild();
          }
        }
      }
      drainBackgroundJobs();
    } catch (error) {
      app.log.error(error);
    }
  }

  function hasBehaviorEvidence(articleIds: string[]): boolean {
    for (const chunk of chunkStrings(articleIds, 400)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const row = db
        .prepare(
          `
            select 1 as found
            from behavior_events
            where article_id in (${placeholders})
            limit 1
          `
        )
        .get(...chunk) as { found: number } | undefined;
      if (row) {
        return true;
      }
    }
    return false;
  }

  app.addContentTypeParser(
    /^multipart\/form-data(?:;.*)?$/i,
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    }
  );
  app.addContentTypeParser(
    /^application\/xml(?:;.*)?$/i,
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    }
  );
  app.addContentTypeParser(
    /^application\/octet-stream(?:;.*)?$/i,
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    }
  );
  app.addContentTypeParser(
    /^text\/xml(?:;.*)?$/i,
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    }
  );

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (isSqliteBusyError(error)) {
      return sendDatabaseBusyError(reply);
    }
    return sendApiError(reply, 500, "INTERNAL_ERROR", "Internal server error");
  });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = parseRequestPathname(request.url);
    recordForegroundApiActivity(request, pathname);

    if (pathname && isApiPath(pathname)) {
      reply.header("Cache-Control", "no-store");
    }

    if (pathname && !isApiPath(pathname)) {
      return;
    }

    if (!authRequired || isAnonymousRoute(request.method, request.routeOptions.url)) {
      return;
    }

    const token = readSessionCookie(request.headers.cookie);
    if (!authService.authenticate(token)) {
      return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required");
    }

    if (
      (coreDatabaseMigrationService.isBlocking() || derivedDataUpgradeService.isBlocking()) &&
      !isUpgradeAllowedRoute(request.method, request.routeOptions.url)
    ) {
      const isCoreMigrationBlocking = coreDatabaseMigrationService.isBlocking();
      const status = isCoreMigrationBlocking
        ? coreDatabaseMigrationService.getStatus()
        : derivedDataUpgradeService.getStatus();
      return sendApiError(
        reply,
        423,
        isCoreMigrationBlocking
          ? "CORE_DATABASE_MIGRATION_IN_PROGRESS"
          : "DERIVED_DATA_UPGRADE_IN_PROGRESS",
        isCoreMigrationBlocking
          ? "Dibao is applying database migrations for this version upgrade"
          : "Dibao is rebuilding derived recommendation data for this version upgrade",
        status
      );
    }
  });

  function recordForegroundApiActivity(
    request: FastifyRequest,
    pathname: string | null
  ): void {
    if (!recordForegroundActivityEnabled || !pathname || !isForegroundActivityRoute(pathname)) {
      return;
    }

    const now = options.now?.() ?? Date.now();
    if (now - lastForegroundActivityWriteAt < foregroundActivityWriteThrottleMs) {
      return;
    }

    lastForegroundActivityWriteAt = now;
    if (!foregroundSignalPath) {
      return;
    }

    writeForegroundActivitySignal(
      foregroundSignalPath,
      {
        now,
        route: request.routeOptions.url ?? pathname,
        method: request.method
      },
      (error) => app.log.warn({ error }, "foreground.activity.write_failed")
    );
  }

  function getRecommendationInventoryResponse(
    input: ArticleListInput,
    loadedCount: number,
    recommendationSessionPosition: number
  ): RecommendationInventoryResponse {
    const now = options.now?.() ?? Date.now();
    const inventory = articles.getRecommendedInventory({
      ...input,
      view: "recommended",
      includeUnreadCount: false,
      rankContext: rankingService.getActiveRankContext()
    });
    const rankingJob = {
      queued: jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "queued"),
      running: jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "running")
    };
    const sessionInventory = input.recommendationSessionId
      ? articles.getRecommendedSessionInventory({
          sessionId: input.recommendationSessionId,
          afterPosition: recommendationSessionPosition,
          filters: input,
          now
        })
      : null;
    return mapRecommendationInventory(
      inventory,
      loadedCount,
      rankingJob,
      now,
      sessionInventory,
      recommendationSessionPosition
    );
  }

  function resolveRecommendationSession(
    input: ArticleListInput,
    scopeKey: string
  ): { sessionId: string; resetCursor: boolean } {
    const now = options.now?.() ?? Date.now();
    const activeRankContext = rankingService.getActiveRankContext();
    const requestedSessionId =
      input.recommendationSessionId ??
      (input.cursor?.type === "recommended_session" ? input.cursor.sessionId : undefined);
    if (requestedSessionId) {
      const existing = articles.findRecommendedSession(requestedSessionId, now);
      if (existing?.scopeKey === scopeKey) {
        const sessionInventory = articles.getRecommendedSessionInventory({
          sessionId: existing.id,
          afterPosition: -1,
          filters: input,
          now
        });
        if ((sessionInventory?.eligibleCount ?? 0) > 0) {
          return { sessionId: existing.id, resetCursor: false };
        }
        const currentInventory = articles.getRecommendedInventory({
          ...input,
          rankContext: activeRankContext
        });
        const currentSessionCandidateCount =
          currentInventory.latestRerankWindowId
            ? currentInventory.latestActiveCount
            : activeRankContext === BASE_RANK_CONTEXT
              ? currentInventory.latestActiveCount + currentInventory.unrankedFallbackCount
              : 0;
        if (
          existing.rankContext === activeRankContext &&
          existing.rerankWindowId === currentInventory.latestRerankWindowId &&
          currentSessionCandidateCount === 0
        ) {
          return { sessionId: existing.id, resetCursor: false };
        }
      }
    }

    const created = articles.createRecommendedSession({
      ...input,
      id: `rec_session_${randomBytes(10).toString("hex")}`,
      rankContext: activeRankContext,
      scopeKey,
      maxItems: RECOMMENDATION_SESSION_MAX_ITEMS,
      now,
      expiresAt: now + RECOMMENDATION_SESSION_TTL_MS,
      cursor: undefined,
      recommendationSessionId: undefined
    });
    return { sessionId: created.id, resetCursor: true };
  }

  function ensureRecommendationInventoryHeartbeat(): void {
    if (recommendationInventoryHeartbeatTimer) {
      return;
    }
    recommendationInventoryHeartbeatTimer = setInterval(() => {
      for (const subscriber of recommendationInventorySubscribers.values()) {
        subscriber.heartbeat();
      }
    }, 25_000);
    recommendationInventoryHeartbeatTimer.unref?.();
  }

  function broadcastRecommendationInventory(reason: string): void {
    if (recommendationInventorySubscribers.size === 0) {
      return;
    }
    for (const subscriber of recommendationInventorySubscribers.values()) {
      try {
        subscriber.send(
          getRecommendationInventoryResponse(
            subscriber.input,
            subscriber.loadedCount,
            subscriber.recommendationSessionPosition
          )
        );
      } catch (error) {
        app.log.warn({ error, reason }, "recommendation.inventory.broadcast_failed");
      }
    }
  }

  function startBackgroundServices(): void {
    if (!backgroundJobs) {
      return;
    }
    if (backgroundStartupTimer || backgroundServicesStarted) {
      return;
    }
    if (backgroundStartupDelayMs > 0) {
      backgroundStartupTimer = setTimeout(() => {
        backgroundStartupTimer = null;
        startBackgroundServicesNow();
      }, backgroundStartupDelayMs);
      backgroundStartupTimer.unref?.();
      app.log.info(
        { delayMs: backgroundStartupDelayMs },
        "background services waiting for startup quiet window"
      );
      return;
    }
    startBackgroundServicesNow();
  }

  function startBackgroundServicesNow(): void {
    if (backgroundServicesStarted) {
      return;
    }
    backgroundServicesStarted = true;
    const cancelledLegacyRankingJobs = rankingJobService.cancelLegacyCursorJobs();
    if (cancelledLegacyRankingJobs > 0) {
      app.log.info(
        { cancelledLegacyRankingJobs },
        "cancelled legacy full-history ranking jobs"
      );
    }
    const pendingProjectionJob = behaviorProjectionJobService.enqueueProjectionIfPending();
    if (pendingProjectionJob) {
      app.log.info(
        {
          route: "jobs.behaviorProjection.startup",
          jobId: pendingProjectionJob.id,
          runAfter: timestampToIso(pendingProjectionJob.runAfter)
        },
        "job.performance"
      );
    }
    jobRunner.start();
    if (jobWakeSignalPath && !stopJobWakeWatcher) {
      stopJobWakeWatcher = watchJobQueueWakeSignal(
        jobWakeSignalPath,
        () => {
          void jobRunner.drainDue().catch((error) => app.log.error(error));
        },
        (error) => app.log.warn({ error }, "job.queue_wake.watch_failed")
      );
    }
    feedRefreshScheduler.start();
    retentionCleanupScheduler.start();
    jobHistoryCleanupScheduler.start();
    profileDecayScheduler.start();
    recommendationMaintenanceScheduler.start();
    if (!walMaintenanceTimer && configuredDatabasePath && configuredDatabasePath !== ":memory:") {
      const maintainWalWhenIdle = () => {
        const now = options.now?.() ?? Date.now();
        if (
          foregroundQuietUntil(settings, {
            now,
            quietWindowMs: foregroundQuietWindowMs,
            signalPath: foregroundSignalPath
          })
        ) {
          return;
        }
        try {
          const wal = statSync(`${configuredDatabasePath}-wal`, { throwIfNoEntry: false });
          if (!wal || wal.size < WAL_MAINTENANCE_MIN_BYTES) {
            return;
          }
          db.pragma("wal_checkpoint(PASSIVE)");
          app.log.info({ walBytes: wal.size }, "sqlite.wal_maintenance");
        } catch (error) {
          // The next idle interval can retry; this path must never affect requests.
          app.log.debug({ error }, "sqlite.wal_maintenance_skipped");
        }
      };
      walMaintenanceTimer = setInterval(maintainWalWhenIdle, WAL_MAINTENANCE_INTERVAL_MS);
      walMaintenanceTimer.unref?.();
    }
    if (!maintenanceTickTimer) {
      const intervalMs =
        options.recommendationMaintenanceIntervalMs ??
        DEFAULT_RECOMMENDATION_MAINTENANCE_SCHEDULER_INTERVAL_MS;
      const emitMaintenanceTick = () => {
        void pluginService
          .enqueueDueSchedules()
          .then(() =>
            pluginService.emitHook("maintenance.tick", {
              tickedAt: options.now?.() ?? Date.now()
            })
          )
          .then(() => jobRunner.drainDue())
          .catch((error) => app.log.error(error));
      };
      maintenanceInitialTickTimer = setTimeout(() => {
        maintenanceInitialTickTimer = null;
        emitMaintenanceTick();
      }, backgroundInitialTickDelayMs);
      maintenanceInitialTickTimer.unref?.();
      maintenanceTickTimer = setInterval(emitMaintenanceTick, intervalMs);
      maintenanceTickTimer.unref?.();
    }
  }

  async function startUpgradePipeline(): Promise<void> {
    const coreStatus = coreDatabaseMigrationService.getStatus();
    if (coreStatus.blocking) {
      const result = await coreDatabaseMigrationService.startIfRequired();
      if (result.blocking) {
        return;
      }
      pluginService.reconcileOfficialPlugins();
    }

    if (backgroundJobs) {
      const derivedStatus = derivedDataUpgradeService.getStatus();
      if (derivedStatus.blocking) {
        const result = await derivedDataUpgradeService.startIfRequired();
        if (result.blocking) {
          return;
        }
      }
    }

    startBackgroundServices();
  }

  if (options.upgradeAutoStart !== false) {
    app.addHook("onReady", async () => {
      void startUpgradePipeline().catch((error) => app.log.error(error));
    });
  }

  app.addHook("onClose", async () => {
    coreDatabaseMigrationService.stop();
    recommendationMaintenanceScheduler.stop();
    profileDecayScheduler.stop();
    jobHistoryCleanupScheduler.stop();
    retentionCleanupScheduler.stop();
    feedRefreshScheduler.stop();
    jobRunner.stop();
    for (const subscriber of recommendationInventorySubscribers.values()) {
      subscriber.close();
    }
    recommendationInventorySubscribers.clear();
    if (recommendationInventoryHeartbeatTimer) {
      clearInterval(recommendationInventoryHeartbeatTimer);
      recommendationInventoryHeartbeatTimer = null;
    }
    if (stopJobWakeWatcher) {
      stopJobWakeWatcher();
      stopJobWakeWatcher = null;
    }
    passiveExposureBuffer.dispose();
    pluginService.dispose();
    if (maintenanceTickTimer) {
      clearInterval(maintenanceTickTimer);
      maintenanceTickTimer = null;
    }
    if (maintenanceInitialTickTimer) {
      clearTimeout(maintenanceInitialTickTimer);
      maintenanceInitialTickTimer = null;
    }
    if (walMaintenanceTimer) {
      clearInterval(walMaintenanceTimer);
      walMaintenanceTimer = null;
    }
    if (backgroundStartupTimer) {
      clearTimeout(backgroundStartupTimer);
      backgroundStartupTimer = null;
    }
  });

  if (closeDatabaseOnClose) {
    app.addHook("onClose", async () => {
      db.close();
    });
  }

  app.get("/api/auth/session", async (request) => ({
    data: authService.getSessionStatus(readSessionCookie(request.headers.cookie))
  }));

  app.post<{ Body: AuthCredentialBody }>("/api/auth/setup", async (request, reply) => {
    const parsed = parseAuthCredentialBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    try {
      const session = await authService.setup(parsed.username, parsed.password, requestMeta(request));
      settingsService.markInstallationCompleted();
      if (parsed.telemetryEnabled !== undefined) {
        const result = settingsService.updateSettings({
          telemetry: {
            enabled: parsed.telemetryEnabled
          }
        });
        configureServerTelemetry({
          enabled: result.settings.telemetry.enabled
        });
      }
      reply.header(
        "set-cookie",
        serializeSessionCookie(session.token, session.expiresAt, cookieOptions)
      );
      return {
        data: {
          ok: true
        }
      };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post<{ Body: AuthCredentialBody }>("/api/auth/login", async (request, reply) => {
    const parsed = parseAuthCredentialBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    try {
      const session = await authService.login(parsed.username, parsed.password, requestMeta(request));
      reply.header(
        "set-cookie",
        serializeSessionCookie(session.token, session.expiresAt, cookieOptions)
      );
      return {
        data: {
          ok: true
        }
      };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    authService.logout(readSessionCookie(request.headers.cookie));
    reply.header("set-cookie", serializeClearSessionCookie(cookieOptions));
    return {
      data: {
        ok: true
      }
    };
  });

  app.post("/api/auth/logout-all", async (_request, reply) => {
    authService.logoutAll();
    reply.header("set-cookie", serializeClearSessionCookie(cookieOptions));
    return {
      data: {
        ok: true
      }
    };
  });

  app.post<{ Body: ChangePasswordBody }>("/api/auth/password", async (request, reply) => {
    const parsed = parseChangePasswordBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    try {
      const session = await authService.changePassword(
        parsed.currentPassword,
        parsed.newPassword,
        requestMeta(request)
      );
      reply.header(
        "set-cookie",
        serializeSessionCookie(session.token, session.expiresAt, cookieOptions)
      );
      return {
        data: {
          ok: true
        }
      };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get("/api/setup/status", async () => {
    const coreMigrationStatus = coreDatabaseMigrationService.getStatus();
    if (coreMigrationStatus.blocking) {
      return {
        data: getSetupStatus(
          credentials.hasCredential(),
          false,
          false,
          coreMigrationStatus,
          null,
          []
        )
      };
    }

    const hasFeeds = feeds.list().length > 0;
    return {
      data: getSetupStatus(
        credentials.hasCredential(),
        hasFeeds,
        embeddingProviderService.hasActiveProviderAndIndex(),
        coreMigrationStatus,
        derivedDataUpgradeService.getStatus(),
        hasFeeds
          ? pluginService.listSetupSteps().filter(
              (plugin) => settings.getJson(`setup.optionalPlugin.${plugin.id}`) === null
            )
          : []
      )
    };
  });

  app.post<{ Params: PluginParams; Body: OptionalPluginBody }>(
    "/api/setup/optional-plugins/:id",
    async (request, reply) => {
      const parsed = parseOptionalPluginBody(request.body);
      if (!parsed.ok) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
      }
      try {
        const plugin = parsed.enabled ? await pluginService.enable(request.params.id) : pluginService.disable(request.params.id);
        if (parsed.enabled && parsed.timezone) {
          pluginService.updateSettings(request.params.id, { timezone: parsed.timezone });
        }
        settings.setJson(`setup.optionalPlugin.${request.params.id}`, parsed.enabled ? "enabled" : "skipped", options.now?.() ?? Date.now());
        return { data: plugin };
      } catch (error) {
        return sendPluginError(reply, error);
      }
    }
  );

  app.get("/api/system/upgrade/status", async () => {
    const coreMigrationStatus = coreDatabaseMigrationService.getStatus();
    if (coreMigrationStatus.blocking) {
      void coreDatabaseMigrationService.startIfRequired().catch((error) => app.log.error(error));
      return {
        data: coreMigrationStatus
      };
    }

    const status = derivedDataUpgradeService.getStatus();
    if (status.blocking) {
      void derivedDataUpgradeService.startIfRequired().catch((error) => app.log.error(error));
    }
    return {
      data: status
    };
  });

  app.post("/api/system/upgrade/retry", async () => {
    const coreMigrationStatus = coreDatabaseMigrationService.getStatus();
    if (coreMigrationStatus.blocking) {
      return {
        data: await coreDatabaseMigrationService.retry()
      };
    }
    return {
      data: await derivedDataUpgradeService.retry()
    };
  });

  app.get<{ Querystring: JobQuery }>("/api/jobs", async (request, reply) => {
    const parsed = parseJobQuery(request.query);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    return {
      data: jobs.list(parsed.input).map(mapJob)
    };
  });

  app.get("/api/plugins", async () => ({
    data: pluginService.list()
  }));

  app.get("/api/plugins/catalog", async () => ({
    data: pluginService.listCatalog()
  }));

  app.get("/api/plugins/contributions", async () => ({
    data: pluginService.listContributions()
  }));

  app.post<{ Body: PluginInstallBody }>("/api/plugins/install", async (request, reply) => {
    try {
      const parsed = parsePluginInstallBody(request.body);
      if (!parsed.ok) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
      }
      const plugin = typeof parsed.packageContent === "string"
        ? await pluginService.installFromPackageContent(parsed.packageContent, {
            sourceType: "local_file",
            sourceUrl: null,
            expectedSha256: parsed.sha256
          })
        : await pluginService.installFromUrl(parsed.url ?? "", {
            expectedSha256: parsed.sha256
          });
      return { data: plugin };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.post("/api/plugins/install/upload", async (request, reply) => {
    try {
      const parsed = parsePluginUploadBody(request.body, request.headers["content-type"]);
      if (!parsed.ok) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
      }
      return {
        data: await pluginService.installFromPackageContent(parsed.packageContent, {
          sourceType: "local_file",
          sourceUrl: null,
          expectedSha256: null
        })
      };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.post<{ Params: PluginParams }>("/api/plugins/:id/enable", async (request, reply) => {
    try {
      return { data: await pluginService.enable(request.params.id) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.post<{ Params: PluginParams }>("/api/plugins/:id/disable", async (request, reply) => {
    try {
      return { data: pluginService.disable(request.params.id) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.post<{ Params: PluginParams }>("/api/plugins/:id/update", async (request, reply) => {
    try {
      return { data: await pluginService.checkUpdate(request.params.id) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.delete<{ Params: PluginParams; Querystring: PluginUninstallQuery }>(
    "/api/plugins/:id",
    async (request, reply) => {
      try {
        pluginService.remove(request.params.id, request.query.deleteData === "true");
        return { data: { ok: true } };
      } catch (error) {
        return sendPluginError(reply, error);
      }
    }
  );

  app.get<{ Params: PluginParams }>("/api/plugins/:id/settings", async (request, reply) => {
    try {
      return { data: pluginService.getSettings(request.params.id) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.patch<{ Params: PluginParams; Body: unknown }>("/api/plugins/:id/settings", async (request, reply) => {
    try {
      return { data: pluginService.updateSettings(request.params.id, request.body) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.get<{ Params: PluginParams }>("/api/plugins/:id/secrets", async (request, reply) => {
    try {
      return { data: pluginService.listSecretMetadata(request.params.id) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.post<{ Params: PluginSecretParams; Body: unknown }>("/api/plugins/:id/secrets/:key", async (request, reply) => {
    try {
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as { value?: unknown; hint?: unknown }
        : {};
      return {
        data: pluginService.setSecret(
          request.params.id,
          request.params.key,
          body.value,
          typeof body.hint === "string" ? body.hint : null
        )
      };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.delete<{ Params: PluginSecretParams }>("/api/plugins/:id/secrets/:key", async (request, reply) => {
    try {
      pluginService.deleteSecret(request.params.id, request.params.key);
      return { data: { ok: true } };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.get<{ Params: PluginParams; Querystring: PluginDeliveryQuery }>("/api/plugins/:id/deliveries", async (request, reply) => {
    try {
      const status = isPluginDeliveryStatus(request.query.status) ? request.query.status : undefined;
      return {
        data: pluginService.listDeliveries(request.params.id, {
          status,
          limit: parseOptionalPositiveInteger(request.query.limit)
        })
      };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.get<{ Params: PluginDeliveryParams }>("/api/plugins/:id/deliveries/:deliveryId", async (request, reply) => {
    try {
      return { data: pluginService.getDelivery(request.params.id, request.params.deliveryId) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.get<{ Params: PluginParams }>("/api/plugins/:id/health", async (request, reply) => {
    try {
      return { data: pluginService.getHealth(request.params.id) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.post<{ Params: PluginTaskParams }>("/api/plugins/:id/tasks/:taskId", async (request, reply) => {
    try {
      const job = pluginService.startTask(request.params.id, request.params.taskId);
      drainBackgroundJobs();
      return { data: mapJob(job) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.get<{ Params: PluginTaskRunParams }>("/api/plugins/:id/tasks/:runId", async (request, reply) => {
    const job = jobs.findById(request.params.runId);
    if (!job || !job.type.startsWith(`plugin:${request.params.id}:`)) {
      return sendApiError(reply, 404, "NOT_FOUND", "Plugin task run not found");
    }
    return { data: mapJob(job) };
  });

  app.post<{ Params: PluginTaskRunParams }>("/api/plugins/:id/tasks/:runId/cancel", async (request, reply) => {
    const existing = jobs.findById(request.params.runId);
    if (!existing || !existing.type.startsWith(`plugin:${request.params.id}:`)) {
      return sendApiError(reply, 404, "NOT_FOUND", "Plugin task run not found");
    }
    const job = jobs.cancel(request.params.runId, "Cancelled by user", options.now?.() ?? Date.now()) ?? existing;
    return { data: mapJob(job) };
  });

  app.get<{ Params: PluginApiParams }>("/api/plugins/:id/api/*", async (request, reply) => {
    try {
      return { data: await pluginService.dispatchApi(request.params.id, "GET", request.params["*"], null) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.post<{ Params: PluginApiParams; Body: unknown }>("/api/plugins/:id/api/*", async (request, reply) => {
    try {
      return { data: await pluginService.dispatchApi(request.params.id, "POST", request.params["*"], request.body) };
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  app.get<{ Querystring: RecommendationInventoryQuery }>(
    "/api/recommendation/inventory",
    async (request, reply) => {
      const parsed = parseRecommendationInventoryQuery(request.query, options.now);
      if (!parsed.ok) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
      }

      return {
        data: getRecommendationInventoryResponse(
          parsed.input,
          parsed.loadedCount,
          parsed.recommendationSessionPosition
        )
      };
    }
  );

  app.get<{ Querystring: RecommendationInventoryQuery }>(
    "/api/recommendation/inventory/events",
    (request, reply) => {
      const parsed = parseRecommendationInventoryQuery(request.query, options.now);
      if (!parsed.ok) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
      }

      const subscriberId = recommendationInventorySubscriberId + 1;
      recommendationInventorySubscriberId = subscriberId;
      let closed = false;

      function removeSubscriber(): void {
        if (closed) {
          return;
        }
        closed = true;
        recommendationInventorySubscribers.delete(subscriberId);
        if (
          recommendationInventorySubscribers.size === 0 &&
          recommendationInventoryHeartbeatTimer
        ) {
          clearInterval(recommendationInventoryHeartbeatTimer);
          recommendationInventoryHeartbeatTimer = null;
        }
      }

      function send(payload: RecommendationInventoryResponse): void {
        if (closed) {
          return;
        }
        try {
          reply.raw.write(`event: inventory\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch (error) {
          app.log.warn({ error }, "recommendation.inventory.sse_write_failed");
          removeSubscriber();
        }
      }

      function heartbeat(): void {
        if (closed) {
          return;
        }
        try {
          reply.raw.write(`: ${Date.now()}\n\n`);
        } catch (error) {
          app.log.warn({ error }, "recommendation.inventory.sse_heartbeat_failed");
          removeSubscriber();
        }
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      request.raw.on("close", removeSubscriber);
      recommendationInventorySubscribers.set(subscriberId, {
        input: parsed.input,
        loadedCount: parsed.loadedCount,
        recommendationSessionPosition: parsed.recommendationSessionPosition,
        send,
        heartbeat,
        close: () => {
          removeSubscriber();
          reply.raw.end();
        }
      });
      ensureRecommendationInventoryHeartbeat();
      send(
        getRecommendationInventoryResponse(
          parsed.input,
          parsed.loadedCount,
          parsed.recommendationSessionPosition
        )
      );
    }
  );

  app.get<{ Querystring: RecommendationStatusQuery }>(
    "/api/recommendation/status",
    async (request, reply) => {
      const includeClusterItems = parseBooleanParam(request.query.includeClusterItems);
      if (includeClusterItems === null) {
        return sendApiError(
          reply,
          400,
          "VALIDATION_ERROR",
          "includeClusterItems must be true or false",
          { field: "includeClusterItems" }
        );
      }

      return {
        data: getRecommendationStatus({
          db,
          embeddings,
          profiles,
          rankings,
          rankingService,
          clusterLabels: clusterLabelService,
          interestFamilies: interestFamilyService,
          memory: recommendationMemoryService,
          settings: settingsService.getSettings().ranking,
          includeClusterItems: includeClusterItems ?? true
        })
      };
    }
  );

  app.post<{ Body: RecommendationExposureBody }>("/api/recommendation/exposures", async (request, reply) => {
    const body = request.body ?? {};
    const exposedAt =
      typeof body.exposedAt === "number" && Number.isInteger(body.exposedAt) && body.exposedAt > 0
        ? body.exposedAt
        : undefined;
    if (
      typeof body.clientSessionId !== "string" ||
      body.clientSessionId.trim().length === 0 ||
      !Array.isArray(body.articleIds) ||
      !body.articleIds.every((articleId) => typeof articleId === "string") ||
      (body.exposedAt !== undefined && exposedAt === undefined)
    ) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", "Invalid recommendation exposure batch");
    }
    return {
      data: passiveExposureBuffer.record({
        clientSessionId: body.clientSessionId,
        articleIds: body.articleIds,
        exposedAt
      })
    };
  });

  app.get<{ Querystring: RecommendationStatusQuery }>(
    "/api/recommendation/transparency",
    async (request, reply) => {
      const startedAt = performance.now();
      const includeClusterItems = parseBooleanParam(request.query.includeClusterItems);
      const clusterItemLimit = parseOptionalPositiveInteger(request.query.clusterItemLimit);
      const clusterDetailLevel = parseClusterDetailLevel(request.query.clusterDetailLevel);
      if (includeClusterItems === null) {
        return sendApiError(
          reply,
          400,
          "VALIDATION_ERROR",
          "includeClusterItems must be true or false",
          { field: "includeClusterItems" }
        );
      }
      if (request.query.clusterItemLimit !== undefined && clusterItemLimit === undefined) {
        return sendApiError(
          reply,
          400,
          "VALIDATION_ERROR",
          "clusterItemLimit must be a positive integer",
          { field: "clusterItemLimit" }
        );
      }
      if (clusterDetailLevel === null) {
        return sendApiError(
          reply,
          400,
          "VALIDATION_ERROR",
          "clusterDetailLevel must be summary or diagnostic",
          { field: "clusterDetailLevel" }
        );
      }

      const data = getRecommendationTransparency({
        db,
        embeddings,
        profiles,
        rankings,
        rankingService,
        clusterLabels: clusterLabelService,
        interestFamilies: interestFamilyService,
        memory: recommendationMemoryService,
        settings: settingsService.getSettings().ranking,
        maintenanceSettings: settingsService.getSettings().recommendationMaintenance,
        maintenanceScheduleStates: recommendationMaintenanceService.listScheduleStates(),
        includeClusterItems: includeClusterItems ?? true,
        clusterItemLimit: clusterItemLimit ?? 10,
        clusterDetailLevel: clusterDetailLevel ?? "summary"
      });
      app.log.info(
        {
          route: "/api/recommendation/transparency",
          durationMs: roundDuration(performance.now() - startedAt),
          includeClusterItems: includeClusterItems ?? true,
          clusterItemLimit: clusterItemLimit ?? 10,
          clusterDetailLevel: clusterDetailLevel ?? "summary",
          clusterCount: data.clusters.positive + data.clusters.negative,
          itemCount: data.clusters.items.length,
          familyCount: data.clusters.families?.topFamilies.length ?? 0
        },
        "api.performance"
      );
      return { data };
    }
  );

  app.get<{ Querystring: RecommendationClusterQuery }>(
    "/api/recommendation/clusters",
    async (request, reply) => {
      const startedAt = performance.now();
      const clusterDetailLevel = parseClusterDetailLevel(request.query.clusterDetailLevel);
      if (clusterDetailLevel === null) {
        return sendApiError(
          reply,
          400,
          "VALIDATION_ERROR",
          "clusterDetailLevel must be summary or diagnostic",
          { field: "clusterDetailLevel" }
        );
      }
      const limit = request.query.limit === "all" ? null : parsePositiveInteger(request.query.limit, 12);
      const data = getRecommendationClusters({
        db,
        embeddings,
        profiles,
        rankings,
        rankingService,
        clusterLabels: clusterLabelService,
        interestFamilies: interestFamilyService,
        settings: settingsService.getSettings().ranking,
        limit,
        clusterDetailLevel: clusterDetailLevel ?? "summary"
      });
      app.log.info(
        {
          route: "/api/recommendation/clusters",
          durationMs: roundDuration(performance.now() - startedAt),
          limit: limit ?? "all",
          clusterDetailLevel: clusterDetailLevel ?? "summary",
          total: data.total,
          itemCount: data.items.length,
          familyCount: data.families?.topFamilies.length ?? 0
        },
        "api.performance"
      );
      return { data };
    }
  );

  app.post<{ Params: RecommendationMaintenanceParams }>(
    "/api/recommendation/maintenance/:task",
    async (request, reply) => {
      try {
        return {
          data: enqueueRecommendationMaintenanceTask(
            recommendationMaintenanceService,
            request.params.task
          )
        };
      } catch (error) {
        return sendRecommendationMaintenanceError(reply, error);
      }
    }
  );

  app.post("/api/recommendation/recalculate", async () => ({
    data: recommendationMaintenanceService.enqueueRecalculate()
  }));

  app.post("/api/recommendation/backfill/fingerprints", async () => ({
    data: recommendationMaintenanceService.enqueueFingerprintBackfill()
  }));

  app.post("/api/recommendation/rebuild-duplicates", async () => ({
    data: recommendationMaintenanceService.enqueueDuplicateRebuild()
  }));

  app.post("/api/recommendation/rebuild-keywords", async () => ({
    data: recommendationMaintenanceService.enqueueKeywordRebuild()
  }));

  app.post("/api/recommendation/rebuild-recent-intent", async () => ({
    data: recommendationMaintenanceService.enqueueRecentIntentRebuild()
  }));

  app.post("/api/recommendation/rebuild-cluster-labels", async () => ({
    data: recommendationMaintenanceService.enqueueClusterLabelRebuild()
  }));

  app.get("/api/recommendation/cluster-label-lexicon", async () => ({
    data: clusterLabelService.getClusterLabelLexicon()
  }));

  app.patch<{ Body: unknown }>("/api/recommendation/cluster-label-lexicon", async (request, reply) => {
    try {
      const lexicon = clusterLabelService.updateClusterLabelLexicon(request.body);
      const rebuild = recommendationMaintenanceService.enqueueClusterLabelRebuild();
      drainBackgroundJobs();
      return {
        data: {
          ...lexicon,
          rebuildJob: rebuild
        }
      };
    } catch (error) {
      return sendInterestClusterLabelError(reply, error);
    }
  });

  app.post("/api/recommendation/clusters/merge-candidates/rebuild", async () => ({
    data: recommendationMaintenanceService.enqueueClusterMergeDiagnostics()
  }));

  app.get<{ Querystring: RecommendationMergeCandidateQuery }>(
    "/api/recommendation/clusters/merge-candidates",
    async (request, reply) => {
      const parsed = parseMergeCandidateQuery(request.query);
      if (!parsed.ok) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
      }
      return {
        data: clusterMergeService.listCandidates(parsed.input)
      };
    }
  );

  app.post<{ Params: RecommendationMergeCandidateParams }>(
    "/api/recommendation/clusters/merge-candidates/:id/merge",
    async (request, reply) => {
      try {
        const result = clusterMergeService.mergeCandidate(request.params.id);
        const labelRebuild = recommendationMaintenanceService.enqueueClusterLabelRebuild();
        const rankingRecalculate = recommendationMaintenanceService.enqueueRecalculate();
        drainBackgroundJobs();
        return {
          data: {
            ...result,
            labelRebuild,
            rankingRecalculate
          }
        };
      } catch (error) {
        return sendInterestClusterMergeError(reply, error);
      }
    }
  );

  app.post<{ Params: RecommendationMergeCandidateParams }>(
    "/api/recommendation/clusters/merge-candidates/:id/ignore",
    async (request, reply) => {
      try {
        return {
          data: clusterMergeService.ignoreCandidate(request.params.id)
        };
      } catch (error) {
        return sendInterestClusterMergeError(reply, error);
      }
    }
  );

  app.patch<{ Params: RecommendationClusterParams; Body: RecommendationClusterLabelBody }>(
    "/api/recommendation/clusters/:id/label",
    async (request, reply) => {
      const startedAt = performance.now();
      try {
        const result = clusterLabelService.setManualLabel(
          request.params.id,
          request.body?.manualLabel
        );
        app.log.info(
          {
            route: "/api/recommendation/clusters/:id/label",
            durationMs: roundDuration(performance.now() - startedAt)
          },
          "api.performance"
        );
        return {
          data: {
            ok: true,
            clusterId: result.clusterId,
            displayLabel: result.displayLabel,
            labelSource: result.labelSource
          }
        };
      } catch (error) {
        return sendInterestClusterLabelError(reply, error);
      }
    }
  );

  app.patch<{ Params: RecommendationFamilyParams; Body: RecommendationFamilyLabelBody }>(
    "/api/recommendation/families/:id/label",
    async (request, reply) => {
      const startedAt = performance.now();
      try {
        const result = interestFamilyService.setManualLabel(
          request.params.id,
          request.body?.manualLabel
        );
        app.log.info(
          {
            route: "/api/recommendation/families/:id/label",
            durationMs: roundDuration(performance.now() - startedAt)
          },
          "api.performance"
        );
        return {
          data: {
            ok: true,
            familyId: result.familyId,
            displayLabel: result.displayLabel,
            manualLabel: result.manualLabel
          }
        };
      } catch (error) {
        return sendInterestFamilyError(reply, error);
      }
    }
  );

  app.post("/api/recommendation/evaluate", async () => ({
    data: recommendationMaintenanceService.enqueueEvaluation()
  }));

  app.post("/api/recommendation/ftrl/reset", async () => ({
    data: recommendationMaintenanceService.resetFtrl()
  }));

  app.post("/api/recommendation/ftrl/promote", async (_request, reply) => {
    try {
      return {
        data: recommendationMaintenanceService.promoteFtrl()
      };
    } catch (error) {
      return sendRecommendationMaintenanceError(reply, error);
    }
  });

  app.get("/api/settings", async () => ({
    data: settingsService.getSettings()
  }));

  app.get("/api/system/latest-release", async () => ({
    data: await latestReleaseService.getLatestRelease()
  }));

  app.post("/api/system/latest-release/check", async () => ({
    data: await latestReleaseService.refresh()
  }));

  app.patch<{ Body: unknown }>("/api/settings", async (request, reply) => {
    try {
      const beforeSettings = settingsService.getSettings();
      const beforeRanking = beforeSettings.ranking;
      const result = settingsService.updateSettings(request.body);
      configureServerTelemetry({
        enabled: result.settings.telemetry.enabled
      });
      const afterRanking = result.settings.ranking;
      const rankingJob = rankingSettingsChanged(beforeRanking, afterRanking)
        ? rankingJobService.enqueueAll()
        : null;
      const familyJob = profileStructureSettingsChanged(beforeRanking, afterRanking)
        ? recommendationMaintenanceService.enqueueInterestFamilyRebuild()
        : null;
      const retentionCleanupJob = retentionSettingsRequireCleanupQueue(
        beforeSettings.retention,
        result.settings.retention
      )
        ? retentionCleanupJobService.enqueueCleanup()
        : null;
      if (rankingJob || familyJob) {
        drainBackgroundJobs();
      }
      void pluginService.emitHook("settings.afterUpdated", {
        before: beforeSettings,
        after: result.settings
      }).catch((error) => app.log.error(error));
      return {
        data: {
          ...result,
          rankingRecalculateQueued: rankingJob !== null,
          rankingRecalculateJobId: rankingJob?.id ?? null,
          retentionCleanupQueued: retentionCleanupJob !== null,
          retentionCleanupJobId: retentionCleanupJob?.id ?? null
        }
      };
    } catch (error) {
      return sendSettingsError(reply, error);
    }
  });

  app.get("/api/embedding/providers", async () => ({
    data: embeddingProviderService.listProviders()
  }));

  app.post<{ Body: unknown }>("/api/embedding/providers", async (request, reply) => {
    try {
      const provider = embeddingProviderService.createProvider(request.body);
      if (provider.enabled) {
        enqueueEmbeddingBackfill();
        enqueueRankingAll();
      }
      return {
        data: {
          id: provider.id
        }
      };
    } catch (error) {
      return sendEmbeddingProviderError(reply, error);
    }
  });

  app.patch<{ Params: EmbeddingProviderParams; Body: unknown }>(
    "/api/embedding/providers/:id",
    async (request, reply) => {
      try {
        const provider = embeddingProviderService.updateProvider(request.params.id, request.body);
        if (provider.enabled) {
          enqueueEmbeddingBackfill();
          enqueueRankingAll();
        }
        return {
          data: provider
        };
      } catch (error) {
        return sendEmbeddingProviderError(reply, error);
      }
    }
  );

  app.delete<{ Params: EmbeddingProviderParams }>(
    "/api/embedding/providers/:id",
    async (request, reply) => {
      try {
        return {
          data: embeddingProviderService.deleteProvider(request.params.id)
        };
      } catch (error) {
        return sendEmbeddingProviderError(reply, error);
      }
    }
  );

  app.post<{ Params: EmbeddingProviderParams }>(
    "/api/embedding/providers/:id/activate",
    async (request, reply) => {
      try {
        const provider = embeddingProviderService.activateProvider(request.params.id);
        enqueueEmbeddingBackfill();
        enqueueRankingAll();
        return {
          data: provider
        };
      } catch (error) {
        return sendEmbeddingProviderError(reply, error);
      }
    }
  );

  app.post<{ Params: EmbeddingProviderParams }>(
    "/api/embedding/providers/:id/test",
    async (request, reply) => {
      try {
        return {
          data: await embeddingProviderService.testProvider(request.params.id)
        };
      } catch (error) {
        return sendEmbeddingProviderError(reply, error);
      }
    }
  );

  app.get("/api/embedding/indexes", async () => ({
    data: embeddingProviderService.listIndexes()
  }));

  app.post<{ Params: EmbeddingIndexParams }>(
    "/api/embedding/indexes/:id/rebuild",
    async (request, reply) => {
      try {
        embeddingProviderService.rebuildIndex(request.params.id);
        const job = vectorIndexRebuildJobService.enqueueRebuildIndex(request.params.id);
        enqueueRankingAll();
        drainBackgroundJobs();
        return {
          data: {
            jobId: job.id
          }
        };
      } catch (error) {
        return sendEmbeddingProviderError(reply, error);
      }
    }
  );

  app.post<{ Params: EmbeddingIndexParams }>(
    "/api/embedding/indexes/:id/backfill",
    async (request, reply) => {
      try {
        embeddingProviderService.assertBackfillableIndex(request.params.id);
        const result = embeddingJobService.enqueueBackfillForIndex(request.params.id);
        if (result.jobIds.length > 0) {
          drainBackgroundJobs();
        }
        return {
          data: result
        };
      } catch (error) {
        return sendEmbeddingProviderError(reply, error);
      }
    }
  );

  app.get("/api/system/health", async (_request, reply) => {
    const data = getHealth(db);
    const statusCode = data.ok ? 200 : 503;
    return reply.status(statusCode).send({ data });
  });

  app.get("/api/feed-folders", async () => ({
    data: folders.list().map(mapFeedFolder)
  }));

  app.post<{ Body: unknown }>("/api/feed-folders", async (request, reply) => {
    try {
      return {
        data: mapFeedFolder(feedManagementService.createFolder(request.body))
      };
    } catch (error) {
      return sendFeedManagementError(reply, error);
    }
  });

  app.patch<{ Params: FeedFolderParams; Body: unknown }>(
    "/api/feed-folders/:id",
    async (request, reply) => {
      try {
        return {
          data: mapFeedFolder(feedManagementService.updateFolder(request.params.id, request.body))
        };
      } catch (error) {
        return sendFeedManagementError(reply, error);
      }
    }
  );

  app.delete<{ Params: FeedFolderParams }>("/api/feed-folders/:id", async (request, reply) => {
    try {
      return {
        data: feedManagementService.deleteFolder(request.params.id)
      };
    } catch (error) {
      return sendFeedManagementError(reply, error);
    }
  });

  app.get<{ Querystring: FeedQuery }>("/api/feeds", async (request, reply) => {
    const enabled = parseBooleanParam(request.query.enabled);
    if (enabled === null) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", "enabled must be true or false");
    }

    const input: FeedListInput = {};
    if (request.query.folderId !== undefined) {
      input.folderId = request.query.folderId;
    }
    if (enabled !== undefined) {
      input.enabled = enabled;
    }

    return {
      data: feeds.list(input).map(mapFeed)
    };
  });

  app.post<{ Body: DiscoverFeedBody }>("/api/feeds/discover", async (request, reply) => {
    const parsed = parseDiscoverFeedBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    try {
      return {
        data: mapFeedDiscoveryResult(await feedDiscoveryService.discover(parsed.input))
      };
    } catch (error) {
      return sendFeedDiscoveryError(reply, error);
    }
  });

  app.get("/api/feeds/diagnostics", async () => ({
    data: mapFeedDiagnosticsResult(feedHealthService.diagnostics())
  }));

  app.post<{ Body: CreateFeedBody }>("/api/feeds", async (request, reply) => {
    const parsed = parseCreateFeedBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message);
    }

    try {
      feedManagementService.validateFolderReference(parsed.input.folderId);
      const result = await feedRefreshService.addFeed(parsed.input);
      handleEffectiveContentChanged(result.effectiveContentChangedArticleIds);

      return {
        data: {
          feed: mapFeed(result.feed),
          refreshJobId: result.jobId
        }
      };
    } catch (error) {
      if (error instanceof FeedManagementServiceError) {
        return sendFeedManagementError(reply, error);
      }
      return sendFeedIngestionError(reply, error);
    }
  });

  app.patch<{ Params: FeedParams; Body: unknown }>("/api/feeds/:id", async (request, reply) => {
    try {
      return {
        data: mapFeed(feedManagementService.updateFeed(request.params.id, request.body))
      };
    } catch (error) {
      return sendFeedManagementError(reply, error);
    }
  });

  app.post<{ Params: FeedParams; Body: FullContentPreviewBody | undefined }>(
    "/api/feeds/:id/full-content/preview",
    async (request, reply) => {
      const parsed = parseFullContentPreviewBody(request.body);
      if (!parsed.ok) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
      }
      try {
        return {
          data: mapFullContentPreview(
            await feedFullContentService.previewFeedFullContent({
              feedId: request.params.id,
              articleUrl: parsed.articleUrl
            })
          )
        };
      } catch (error) {
        return sendFeedIngestionError(reply, error);
      }
    }
  );

  app.post<{ Params: FeedParams }>(
    "/api/feeds/:id/full-content/backfill-current",
    async (request, reply) => {
      try {
        const result = await feedFullContentService.backfillCurrentFeedFullContent(
          request.params.id
        );
        handleEffectiveContentChanged(result.effectiveContentChangedArticleIds);
        drainBackgroundJobs();
        return {
          data: mapFullContentBackfill(result)
        };
      } catch (error) {
        return sendFeedIngestionError(reply, error);
      }
    }
  );

  app.delete<{ Params: FeedParams }>("/api/feeds/:id", async (request, reply) => {
    try {
      return {
        data: feedManagementService.deleteFeed(request.params.id)
      };
    } catch (error) {
      return sendFeedManagementError(reply, error);
    }
  });

  app.post("/api/feeds/refresh", async () => {
    const jobs = feedRefreshJobService.enqueueDueFeeds();
    if (backgroundJobs) {
      drainBackgroundJobs();
    }

    return {
      data: {
        jobIds: jobs.map((job) => job.id)
      }
    };
  });

  app.post<{ Params: FeedParams }>("/api/feeds/:id/refresh", async (request, reply) => {
    try {
      const result = await feedRefreshCoordinator.refreshFeed(request.params.id);
      drainBackgroundJobs();

      return {
        data: {
          jobId: result.jobId
        }
      };
    } catch (error) {
      return sendFeedIngestionError(reply, error);
    }
  });

  app.post("/api/opml/import", async (request, reply) => {
    const parsed = parseOpmlImportBody(request.body, request.headers["content-type"]);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    try {
      const result = opmlService.importOpml(parsed.xml);
      return {
        data: result
      };
    } catch (error) {
      return sendOpmlServiceError(reply, error);
    }
  });

  app.get("/api/opml/export", async (_request, reply) =>
    reply.type("application/xml; charset=utf-8").send(opmlService.exportOpml())
  );

  app.get<{ Querystring: ArticleQuery }>("/api/articles", async (request, reply) => {
    const parsed = parseArticleQuery(request.query, options.now);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    const startedAt = performance.now();
    const activeRankContext = rankingService.getActiveRankContext();
    const listInput: ArticleListInput = {
      ...parsed.input,
      rankContext: activeRankContext
    };
    if ((parsed.input.view ?? "latest") === "recommended") {
      const resolvedSession = resolveRecommendationSession(
        parsed.input,
        recommendationSessionScopeKey(request.query)
      );
      listInput.recommendationSessionId = resolvedSession.sessionId;
      if (resolvedSession.resetCursor) {
        listInput.cursor = undefined;
        listInput.offset = undefined;
      }
    }
    const result = articles.list(listInput);
    const responseMapStartedAt = performance.now();
    const data = result.items.map(mapArticleListItem);
    const responseMapMs = performance.now() - responseMapStartedAt;
    const durationMs = performance.now() - startedAt;
    app.log.info(
      {
        route: "/api/articles",
        view: parsed.input.view ?? "latest",
        sort: parsed.input.sort ?? null,
        limit: parsed.input.limit ?? null,
        offset: parsed.input.offset ?? 0,
        cursorType: parsed.input.cursor?.type ?? null,
        recommendationSessionId: result.recommendationSession?.id ?? null,
        recommendationSessionPosition: result.recommendationSession?.consumedThrough ?? null,
        rerankWindowId: result.recommendationSession?.rerankWindowId ?? null,
        includeUnreadCount: parsed.input.includeUnreadCount ?? true,
        itemCount: result.items.length,
        hasMore: result.nextOffset !== null,
        unreadCountMs: roundDuration(result.timing?.unreadCountMs ?? 0),
        rankCandidateMs: roundDuration(result.timing?.rankCandidateMs ?? 0),
        unrankedCandidateMs: roundDuration(result.timing?.unrankedCandidateMs ?? 0),
        hydrateMs: roundDuration(result.timing?.hydrateMs ?? 0),
        pageQueryMs: roundDuration(result.timing?.pageQueryMs ?? 0),
        dbMapMs: roundDuration(result.timing?.mapMs ?? 0),
        dbTotalMs: roundDuration(result.timing?.totalMs ?? 0),
        responseMapMs: roundDuration(responseMapMs),
        durationMs: roundDuration(durationMs)
      },
      "performance.route"
    );

    return {
      data,
      page: {
        nextCursor: encodeCursor(result.nextCursor ?? result.nextOffset)
      },
      meta: {
        unreadCount: result.unreadCount,
        ...((parsed.input.view ?? "latest") === "recommended"
          ? {
              recommendationSession: result.recommendationSession
                ? {
                    id: result.recommendationSession.id,
                    rankContext: result.recommendationSession.rankContext,
                    rerankWindowId: result.recommendationSession.rerankWindowId,
                    itemCount: result.recommendationSession.itemCount,
                    consumedThrough: result.recommendationSession.consumedThrough,
                    createdAt: timestampToIsoValue(result.recommendationSession.createdAt),
                    expiresAt: timestampToIsoValue(result.recommendationSession.expiresAt)
                  }
                : null
            }
          : {})
      }
    };
  });

  app.get<{ Querystring: SearchQuery }>("/api/search", async (request, reply) => {
    const parsed = parseSearchQuery(request.query);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    const startedAt = performance.now();
    const result = articles.search({
      ...parsed.input,
      rankContext: rankingService.getActiveRankContext()
    });
    const responseMapStartedAt = performance.now();
    const data = result.items.map(mapArticleListItem);
    const responseMapMs = performance.now() - responseMapStartedAt;
    const durationMs = performance.now() - startedAt;
    app.log.info(
      {
        route: "/api/search",
        scope: parsed.input.scope ?? "default",
        state: parsed.input.state ?? "all",
        sort: parsed.input.sort ?? "relevance",
        limit: parsed.input.limit ?? null,
        offset: parsed.input.offset ?? 0,
        includeUnreadCount: parsed.input.includeUnreadCount ?? true,
        itemCount: result.items.length,
        hasMore: result.nextOffset !== null,
        unreadCountMs: roundDuration(result.timing?.unreadCountMs ?? 0),
        pageQueryMs: roundDuration(result.timing?.pageQueryMs ?? 0),
        dbMapMs: roundDuration(result.timing?.mapMs ?? 0),
        dbTotalMs: roundDuration(result.timing?.totalMs ?? 0),
        responseMapMs: roundDuration(responseMapMs),
        durationMs: roundDuration(durationMs)
      },
      "performance.route"
    );

    return {
      data,
      page: {
        nextCursor: encodeCursor(result.nextOffset)
      },
      meta: {
        unreadCount: result.unreadCount
      }
    };
  });

  async function handleMarkScopeRead(
    request: FastifyRequest<{ Body: ReaderCommandBody }>,
    reply: FastifyReply
  ) {
    const parsed = parseReaderCommandMarkScopeReadBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    try {
      const result = readerCommandService.markScopeRead({
        scope: parsed.scope,
        now: options.now?.() ?? Date.now()
      });
      drainBackgroundJobs();

      return {
        data: {
          ok: true,
          commandId: result.commandId,
          markedReadCount: result.markedReadCount
        }
      };
    } catch (error) {
      return sendReaderCommandError(reply, error);
    }
  }

  async function handleMarkScopeReadPreview(
    request: FastifyRequest<{ Body: ReaderCommandBody }>,
    reply: FastifyReply
  ) {
    const parsed = parseReaderCommandMarkScopeReadBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    try {
      const result = readerCommandService.previewMarkScopeRead({
        scope: parsed.scope,
        now: options.now?.() ?? Date.now()
      });

      return {
        data: {
          ok: true,
          markedReadCount: result.markedReadCount
        }
      };
    } catch (error) {
      return sendReaderCommandError(reply, error);
    }
  }

  app.post<{ Body: ReaderCommandBody }>(
    "/api/reader/commands/mark-scope-read",
    handleMarkScopeRead
  );

  app.post<{ Body: ReaderCommandBody }>(
    "/api/reader/commands/mark-scope-read/preview",
    handleMarkScopeReadPreview
  );

  app.post<{ Body: ReaderCommandBody }>(
    "/api/articles/bulk/mark-read",
    handleMarkScopeRead
  );

  app.get<{ Params: ArticleParams }>("/api/articles/:id", async (request, reply) => {
    const startedAt = performance.now();
    const findStartedAt = performance.now();
    const article = articles.findDetailById(request.params.id, {
      rankContext: rankingService.getActiveRankContext()
    });
    const findMs = performance.now() - findStartedAt;
    const responseMapStartedAt = performance.now();
    const data = article ? mapArticleDetail(article) : null;
    const responseMapMs = performance.now() - responseMapStartedAt;
    app.log.info(
      {
        route: "/api/articles/:id",
        found: Boolean(article),
        findMs: roundDuration(findMs),
        responseMapMs: roundDuration(responseMapMs),
        durationMs: roundDuration(performance.now() - startedAt)
      },
      "performance.route"
    );

    if (!article) {
      return sendApiError(reply, 404, "NOT_FOUND", "Article not found");
    }

    return {
      data
    };
  });

  app.get<{ Querystring: OfflineManifestQuery }>(
    "/api/offline/manifest",
    async (request, reply) => {
      const recommendedLimit = parseIntegerInRange(
        request.query.recommendedLimit,
        200,
        OFFLINE_RECOMMENDED_LIMIT_MIN,
        OFFLINE_RECOMMENDED_LIMIT_MAX
      );
      if (recommendedLimit === null) {
        return sendApiError(
          reply,
          400,
          "VALIDATION_ERROR",
          `recommendedLimit must be an integer between ${OFFLINE_RECOMMENDED_LIMIT_MIN} and ${OFFLINE_RECOMMENDED_LIMIT_MAX}`,
          {
            field: "recommendedLimit",
            min: OFFLINE_RECOMMENDED_LIMIT_MIN,
            max: OFFLINE_RECOMMENDED_LIMIT_MAX
          }
        );
      }

      const startedAt = performance.now();
      const manifest = offlineReadingService.createManifest(recommendedLimit);
      app.log.info(
        {
          route: "/api/offline/manifest",
          recommendedTarget: manifest.recommendedTarget,
          recommendedCount: manifest.recommended.length,
          readLaterCount: manifest.readLater.length,
          recentCount: manifest.recent.length,
          durationMs: roundDuration(performance.now() - startedAt)
        },
        "performance.route"
      );
      return {
        data: {
          snapshotId: manifest.snapshotId,
          generatedAt: timestampToIsoValue(manifest.generatedAt),
          rankContext: manifest.rankContext,
          recommendedTarget: manifest.recommendedTarget,
          recommended: manifest.recommended.map(mapOfflineManifestArticle),
          readLater: manifest.readLater.map(mapOfflineManifestArticle),
          recent: manifest.recent.map(mapOfflineManifestArticle)
        }
      };
    }
  );

  app.post<{ Body: OfflineArticleBatchBody }>(
    "/api/offline/articles/batch",
    async (request, reply) => {
      const articleIds = parseOfflineArticleIds(request.body?.articleIds);
      if (articleIds === null) {
        return sendApiError(
          reply,
          400,
          "VALIDATION_ERROR",
          `articleIds must contain between 1 and ${OFFLINE_ARTICLE_BATCH_LIMIT} unique ids`,
          { field: "articleIds", min: 1, max: OFFLINE_ARTICLE_BATCH_LIMIT }
        );
      }
      return {
        data: offlineReadingService.getArticles(articleIds).map(mapArticleDetail)
      };
    }
  );

  app.get<{ Params: ArticleParams; Querystring: ReaderDiscoveryQuery }>(
    "/api/articles/:id/related",
    async (request, reply) => {
      const limit = parseReaderDiscoveryLimit(request.query.limit);
      if (limit === null) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", "limit must be an integer between 1 and 10", {
          field: "limit",
          min: 1,
          max: 10
        });
      }

      const startedAt = performance.now();
      const result = readerDiscoveryService.findRelatedArticles({
        articleId: request.params.id,
        limit
      });
      app.log.info(
        {
          route: "/api/articles/:id/related",
          status: result?.status ?? "not_found",
          itemCount: result?.items.length ?? 0,
          durationMs: roundDuration(performance.now() - startedAt)
        },
        "performance.route"
      );
      if (!result) {
        return sendApiError(reply, 404, "NOT_FOUND", "Article not found");
      }

      return {
        data: mapReaderDiscoveryResponse(result)
      };
    }
  );

  app.get<{ Params: ArticleParams; Querystring: RelatedSearchQuery }>(
    "/api/articles/:id/related-search",
    async (request, reply) => {
      const limit = parseRelatedSearchLimit(request.query.limit);
      if (limit === null) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", "limit must be an integer between 1 and 100", {
          field: "limit",
          min: 1,
          max: 100
        });
      }

      const offset = decodeOffsetCursor(request.query.cursor);
      if (offset === null) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", "cursor is invalid", {
          field: "cursor"
        });
      }

      const state = parseSearchState(request.query.state);
      if (state === null) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", "state must be all, unread, read, favorites, or read_later", {
          field: "state"
        });
      }

      const startedAt = performance.now();
      const result = readerDiscoveryService.findRelatedSearchArticles({
        articleId: request.params.id,
        limit,
        offset,
        state
      });
      const responseMapStartedAt = performance.now();
      const data = result ? mapRelatedSearchResponse(result) : null;
      const responseMapMs = performance.now() - responseMapStartedAt;
      app.log.info(
        {
          route: "/api/articles/:id/related-search",
          status: result?.status ?? "not_found",
          itemCount: result?.items.length ?? 0,
          hasMore: result?.nextOffset !== null,
          state: state ?? "all",
          limit: limit ?? null,
          offset: offset ?? 0,
          responseMapMs: roundDuration(responseMapMs),
          durationMs: roundDuration(performance.now() - startedAt)
        },
        "performance.route"
      );
      if (!result || !data) {
        return sendApiError(reply, 404, "NOT_FOUND", "Article not found");
      }

      return {
        data,
        page: {
          nextCursor: encodeCursor(result.nextOffset)
        },
        meta: {
          unreadCount: null
        }
      };
    }
  );

  app.get<{ Params: ArticleParams; Querystring: ReaderDiscoveryQuery }>(
    "/api/articles/:id/personalized-related",
    async (request, reply) => {
      const limit = parseReaderDiscoveryLimit(request.query.limit);
      if (limit === null) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", "limit must be an integer between 1 and 10", {
          field: "limit",
          min: 1,
          max: 10
        });
      }

      const startedAt = performance.now();
      const result = readerDiscoveryService.findPersonalizedRelatedArticles({
        articleId: request.params.id,
        limit
      });
      app.log.info(
        {
          route: "/api/articles/:id/personalized-related",
          status: result?.status ?? "not_found",
          itemCount: result?.items.length ?? 0,
          durationMs: roundDuration(performance.now() - startedAt)
        },
        "performance.route"
      );
      if (!result) {
        return sendApiError(reply, 404, "NOT_FOUND", "Article not found");
      }

      return {
        data: mapReaderDiscoveryResponse(result)
      };
    }
  );

  app.get<{ Params: ArticleParams }>("/api/articles/:id/explanation", async (request, reply) => {
    const startedAt = performance.now();
    const explainStartedAt = performance.now();
    const { explanation, cacheHit } = cachedArticleExplanation(request.params.id);
    const explainMs = performance.now() - explainStartedAt;

    if (!explanation) {
      app.log.info(
        {
          route: "/api/articles/:id/explanation",
          found: false,
          cacheHit,
          explainMs: roundDuration(explainMs),
          responseMapMs: 0,
          durationMs: roundDuration(performance.now() - startedAt)
        },
        "performance.route"
      );
      return sendApiError(reply, 404, "NOT_FOUND", "Article not found");
    }
    const responseMapStartedAt = performance.now();
    const data = {
      articleId: explanation.articleId,
      reasons: explanation.reasons.map((reason) => {
        const clusters = reason.clusters?.map((cluster) =>
          labeledExplanationCluster(cluster, clusterLabelService)
        );
        const cluster = reason.cluster
          ? labeledExplanationCluster(reason.cluster, clusterLabelService)
          : clusters?.[0];

        return {
          ...reason,
          ...(cluster ? { cluster } : {}),
          ...(clusters && clusters.length > 0 ? { clusters } : {})
        };
      }),
      generatedAt: timestampToIsoValue(explanation.generatedAt)
    };
    const responseMapMs = performance.now() - responseMapStartedAt;
    app.log.info(
      {
        route: "/api/articles/:id/explanation",
        found: true,
        cacheHit,
        reasonCount: explanation.reasons.length,
        explainMs: roundDuration(explainMs),
        responseMapMs: roundDuration(responseMapMs),
        durationMs: roundDuration(performance.now() - startedAt)
      },
      "performance.route"
    );

    return {
      data
    };
  });

  app.post<{ Params: ArticleParams; Body: ArticleActionBody }>(
    "/api/articles/:id/actions",
    async (request, reply) => {
      const parsed = parseArticleActionBody(request.body);
      if (!parsed.ok) {
        return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
      }

      try {
        const startedAt = performance.now();
        const result = articleActionService.record({
          articleId: request.params.id,
          ...parsed.input
        });
        invalidateArticleExplanationCache(request.params.id);
        app.log.info(
          {
            route: "/api/articles/:id/actions",
            action: parsed.input.type,
            recordMs: roundDuration(performance.now() - startedAt),
            durationMs: roundDuration(performance.now() - startedAt)
          },
          "performance.route"
        );
        if (!result.deduplicated) {
          void pluginService.emitHook("article.actionRecorded", {
            articleId: request.params.id,
            eventId: result.eventId,
            action: parsed.input.type,
            state: result.state
          }).catch((error) => app.log.error(error));
        }

        return {
          data: {
            eventId: result.eventId,
            state: result.state,
            deduplicated: result.deduplicated ?? false
          }
        };
      } catch (error) {
        return sendArticleActionError(reply, error);
      }
    }
  );

  app.post<{ Body: BulkArticleActionBody }>("/api/articles/actions/bulk", async (request, reply) => {
    const parsed = parseBulkArticleActionBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    const startedAt = performance.now();
    const data: Array<{ articleId: string; eventId: string; state: unknown }> = [];
    const skipped: Array<{ articleId: string; code: string; message: string }> = [];
    try {
      const results = articleActionService.recordMany(
        parsed.actions.map((action) => ({ articleId: action.articleId, ...action.input }))
      );
      for (const [index, result] of results.entries()) {
        const action = parsed.actions[index];
        if (!action) continue;
        if (result) {
        invalidateArticleExplanationCache(action.articleId);
        data.push({
          articleId: action.articleId,
          eventId: result.eventId,
          state: result.state
        });
        void pluginService.emitHook("article.actionRecorded", {
          articleId: action.articleId,
          eventId: result.eventId,
          action: action.input.type,
          state: result.state
        }).catch((error) => app.log.error(error));
          continue;
        }
        skipped.push({
          articleId: action.articleId,
          code: "NOT_FOUND",
          message: "Article not found"
        });
      }
    } catch (error) {
      return sendArticleActionError(reply, error);
    }
    app.log.info(
      {
        route: "/api/articles/actions/bulk",
        action: "impression",
        requested: parsed.actions.length,
        recorded: data.length,
        skipped: skipped.length,
        durationMs: roundDuration(performance.now() - startedAt)
      },
      "performance.route"
    );

    return {
      data,
      meta: {
        skipped
      }
    };
  });

  app.get("/api/plugins/ui.css", async (_request, reply) => {
    return reply
      .header("cache-control", "public, max-age=3600")
      .type("text/css; charset=utf-8")
      .send(pluginUiCss);
  });

  app.get<{ Params: PluginAssetParams }>("/api/plugins/:id/assets/*", async (request, reply) => {
    try {
      const assetPath = pluginService.resolveAssetPath(
        request.params.id,
        request.params["*"] || "web/index.html"
      );
      if (!assetPath) {
        return sendApiError(reply, 404, "NOT_FOUND", "Plugin asset not found");
      }
      applyPluginAssetSecurityHeaders(reply, assetPath);
      return sendStaticFile(reply, request.method, assetPath);
    } catch (error) {
      return sendPluginError(reply, error);
    }
  });

  registerWebStaticRoutes(app, options.webDistDir);

  return app;
}

function openConfiguredDatabase(options: BuildServerOptions): DibaoDatabase {
  const databasePath = resolveDatabasePath(options.databasePath);
  ensureDatabaseDirectory(databasePath);
  const shouldMigrate = options.migrate ?? true;
  const shouldRunInitialMigrations =
    shouldMigrate && (!existsSync(databasePath) || statSync(databasePath).size === 0);
  const db = openDatabase(databasePath, {
    migrate: false
  });

  if (shouldRunInitialMigrations) {
    runMigrations(db);
  }

  return db;
}

function resolveDatabasePath(databasePath: string | undefined): string {
  const requested =
    databasePath ??
    process.env.DIBAO_DATABASE_PATH ??
    process.env.DIBAO_DB_PATH ??
    ".dibao/dibao.sqlite";

  if (requested === ":memory:") {
    return requested;
  }

  return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  mkdirSync(dirname(databasePath), { recursive: true });
}

function registerWebStaticRoutes(
  app: FastifyInstance,
  webDistDirOption: BuildServerOptions["webDistDir"]
): void {
  if (webDistDirOption === false) {
    return;
  }

  const webDistDir = resolveWebDistDir(webDistDirOption);

  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (request, reply) => {
      const pathname = parseRequestPathname(request.url);

      if (!pathname || isApiPath(pathname)) {
        return sendApiError(reply, 404, "NOT_FOUND", "Route not found");
      }

      const assetPath = resolveStaticAssetPath(webDistDir, pathname);
      if (assetPath) {
        return sendStaticFile(reply, request.method, assetPath);
      }

      if (pathname === "/service-worker.js") {
        const serviceWorkerPath = resolveStaticAssetPath(webDistDir, "/sw.js");
        if (serviceWorkerPath) {
          return sendStaticFile(reply, request.method, serviceWorkerPath);
        }
        return reply.status(404).type("text/plain; charset=utf-8").send("Not found");
      }

      const indexPath = resolveStaticAssetPath(webDistDir, "/index.html");
      if (!indexPath) {
        return reply.status(404).type("text/plain; charset=utf-8").send("Not found");
      }

      return sendStaticFile(reply, request.method, indexPath);
    }
  });
}

function resolveWebDistDir(webDistDirOption: string | undefined): string {
  if (webDistDirOption) {
    return isAbsolute(webDistDirOption)
      ? webDistDirOption
      : resolve(process.cwd(), webDistDirOption);
  }

  if (process.env.DIBAO_WEB_DIST_DIR) {
    return isAbsolute(process.env.DIBAO_WEB_DIST_DIR)
      ? process.env.DIBAO_WEB_DIST_DIR
      : resolve(process.cwd(), process.env.DIBAO_WEB_DIST_DIR);
  }

  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

function parseRequestPathname(requestUrl: string): string | null {
  try {
    return new URL(requestUrl, "http://localhost").pathname;
  } catch {
    return null;
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function resolveStaticAssetPath(webDistDir: string, pathname: string): string | null {
  const decodedPathname = decodeStaticPathname(pathname);
  if (decodedPathname === null) {
    return null;
  }

  const requestedPath = decodedPathname === "/" ? "/index.html" : decodedPathname;
  const relativePath = requestedPath.replace(/^\/+/, "");
  const candidate = resolve(webDistDir, relativePath);
  const rootPrefix = webDistDir.endsWith(sep) ? webDistDir : `${webDistDir}${sep}`;

  if (candidate !== webDistDir && !candidate.startsWith(rootPrefix)) {
    return null;
  }

  try {
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      const directoryIndex = resolve(candidate, "index.html");
      return existsSync(directoryIndex) ? directoryIndex : null;
    }

    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function decodeStaticPathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function sendStaticFile(reply: FastifyReply, method: string, filePath: string) {
  reply.type(contentTypeForStaticFile(filePath));
  applyStaticCacheHeaders(reply, filePath);
  if (method.toUpperCase() === "HEAD") {
    return reply.send();
  }

  return reply.send(readFileSync(filePath));
}

function applyPluginAssetSecurityHeaders(reply: FastifyReply, filePath: string): void {
  reply.header("X-Content-Type-Options", "nosniff");
  if (extname(filePath).toLowerCase() !== ".html") {
    return;
  }
  reply.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
      "script-src 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'none'"
    ].join("; ")
  );
}

function applyStaticCacheHeaders(reply: FastifyReply, filePath: string): void {
  const fileName = basename(filePath);
  const extension = extname(filePath).toLowerCase();

  if (fileName === "index.html") {
    reply.header("Cache-Control", "no-store");
    return;
  }

  if (fileName === "sw.js" || extension === ".webmanifest") {
    reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
    return;
  }

  if (filePath.includes(`${sep}assets${sep}`)) {
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  reply.header("Cache-Control", "public, max-age=3600");
}

function contentTypeForStaticFile(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".webp":
      return "image/webp";
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function resolveCookieSecure(value: boolean | undefined): boolean {
  if (value !== undefined) {
    return value;
  }

  if (process.env.DIBAO_COOKIE_SECURE === "true") {
    return true;
  }
  if (process.env.DIBAO_COOKIE_SECURE === "false") {
    return false;
  }

  return process.env.NODE_ENV === "production";
}

function isAnonymousRoute(method: string, routePath: string | undefined): boolean {
  if (!routePath) {
    return false;
  }

  return anonymousRoutes.has(`${method.toUpperCase()} ${routePath}`);
}

function isUpgradeAllowedRoute(method: string, routePath: string | undefined): boolean {
  if (!routePath) {
    return false;
  }

  return upgradeAllowedRoutes.has(`${method.toUpperCase()} ${routePath}`);
}

const anonymousRoutes = new Set([
  "GET /api/auth/session",
  "POST /api/auth/setup",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/plugins/ui.css",
  "GET /api/system/health"
]);

function isForegroundActivityRoute(pathname: string): boolean {
  if (!isApiPath(pathname)) {
    return (
      pathname === "/" ||
      pathname === "/index.html" ||
      pathname.startsWith("/assets/") ||
      pathname.endsWith(".js") ||
      pathname.endsWith(".css") ||
      pathname.endsWith(".webmanifest")
    );
  }

  if (pathname === "/api/recommendation/inventory/events") {
    return false;
  }

  return (
    pathname.startsWith("/api/articles") ||
    pathname === "/api/auth/session" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/setup" ||
    pathname === "/api/auth/password" ||
    pathname === "/api/setup/status" ||
    pathname.startsWith("/api/reader") ||
    pathname.startsWith("/api/recommendation") ||
    pathname.startsWith("/api/feeds") ||
    pathname.startsWith("/api/plugins") ||
    pathname === "/api/settings"
  );
}

function isForegroundDeferrableJobType(type: JobType): boolean {
  return (
    type === "feed_refresh" ||
    type === BEHAVIOR_EVENT_PROJECT_JOB_TYPE ||
    type === "embedding_generate" ||
    type === "profile_event_process" ||
    type === "ranking_recalculate" ||
    type === "profile_decay" ||
    type === "retention_cleanup" ||
    type === "vector_index_rebuild" ||
    type === ARTICLE_FINGERPRINT_BACKFILL_JOB_TYPE ||
    type === DUPLICATE_GROUP_REBUILD_JOB_TYPE ||
    type === KEYWORD_PROFILE_REBUILD_JOB_TYPE ||
    type === RECENT_INTENT_REBUILD_JOB_TYPE ||
    type === RANKING_EVAL_RUN_JOB_TYPE ||
    type === FTRL_TRAIN_JOB_TYPE ||
    type === RECOMMENDATION_BACKFILL_JOB_TYPE ||
    type === INTEREST_CLUSTER_LABEL_REBUILD_JOB_TYPE ||
    type === INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE ||
    type === INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE ||
    type === INTEREST_FAMILY_REBUILD_JOB_TYPE
  );
}

const upgradeAllowedRoutes = new Set([
  "GET /api/auth/session",
  "POST /api/auth/logout",
  "POST /api/auth/logout-all",
  "GET /api/setup/status",
  "GET /api/system/health",
  "GET /api/system/upgrade/status",
  "POST /api/system/upgrade/retry"
]);

function requestMeta(request: FastifyRequest) {
  const userAgent = request.headers["user-agent"];

  return {
    userAgent: Array.isArray(userAgent) ? userAgent.join(" ") : userAgent,
    ip: request.ip
  };
}

export function getHealth(db: DibaoDatabase): HealthResponse {
  const database = checkHealth(() => {
    checkDatabaseConnection(db);
  });
  const fts = checkHealth(() => {
    db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'article_fts'")
      .get();
  });
  const vectorStore = checkHealth(() => {
    getSqliteVecVersion(db);
  });

  return {
    ok: database === "ok" && fts === "ok" && vectorStore === "ok",
    database,
    fts,
    vectorStore,
    version: dibaoVersion
  };
}

function checkDatabaseConnection(db: DibaoDatabase): void {
  db.prepare("select 1 as ok").get();
}

function checkHealth(fn: () => void): HealthStatus {
  try {
    fn();
    return "ok";
  } catch {
    return "error";
  }
}

function getSetupStatus(
  setupCompleted: boolean,
  hasFeeds: boolean,
  hasEmbeddingProvider: boolean,
  coreDatabaseMigration: CoreDatabaseMigrationStatus,
  derivedDataUpgrade: DerivedDataUpgradeStatus | null,
  optionalPluginSteps: unknown[] = []
): SetupStatusResponse {
  const status: SetupStatusResponse = {
    setupCompleted,
    hasFeeds,
    hasEmbeddingProvider,
    firstRefreshStatus: "idle"
  };
  if (optionalPluginSteps.length > 0) {
    status.optionalPluginSteps = optionalPluginSteps;
  }
  if (coreDatabaseMigration.blocking || coreDatabaseMigration.state === "pending") {
    status.coreDatabaseMigration = coreDatabaseMigration;
  }
  if (derivedDataUpgrade && (derivedDataUpgrade.blocking || derivedDataUpgrade.state === "pending")) {
    status.derivedDataUpgrade = derivedDataUpgrade;
  }
  return status;
}

function getRecommendationStatus(options: {
  db: DibaoDatabase;
  embeddings: SqliteEmbeddingRepository;
  profiles: SqliteProfileRepository;
  rankings: SqliteRankingRepository;
  rankingService: RecommendationRankingService;
  clusterLabels: InterestClusterLabelService;
  interestFamilies: InterestFamilyService;
  memory?: RecommendationMemoryService;
  settings: ReturnType<SettingsService["getSettings"]>["ranking"];
  includeClusterItems?: boolean;
  clusterItemLimit?: number;
  clusterDetailLevel?: RecommendationClusterDetailLevel;
}) {
  const includeClusterItems = options.includeClusterItems ?? true;
  const clusterItemLimit = Math.max(1, Math.min(5000, options.clusterItemLimit ?? 12));
  const clusterDetailLevel = options.clusterDetailLevel ?? "diagnostic";
  const activeProvider = options.embeddings.findActiveProvider();
  const needsDiagnosticIndex = includeClusterItems && clusterDetailLevel === "diagnostic";
  const summaryOnly = !includeClusterItems;
  const activeIndex = activeProvider
    ? needsDiagnosticIndex
      ? activeDiagnosticIndexFor(activeProvider.id, options.embeddings.listIndexes())
      : options.embeddings.findActiveIndexForProvider(activeProvider.id)
    : null;
  const activeRankContext = options.rankingService.getActiveRankContext();
  const coverage = needsDiagnosticIndex
    ? coverageFor(activeIndex as EmbeddingIndexListRow | null)
    : lightweightCoverageFor(options.db, activeIndex);
  const behaviorCounts = Object.fromEntries(
    options.profiles.countBehaviorEvents().map((row) => [row.eventType, row.count])
  );
  const clusters = options.profiles.countClusters({
    ...(activeIndex ? { embeddingIndexId: activeIndex.id } : {})
  });
  const clusterEvidence = activeIndex && includeClusterItems
    ? clusterDetailLevel === "diagnostic"
      ? options.profiles.listClusterEvidence({ embeddingIndexId: activeIndex.id, limit: 2000 })
      : []
    : [];
  const clusterMergeDiagnostics = activeIndex && includeClusterItems
    ? clusterDetailLevel === "diagnostic"
      ? mergeDiagnosticsByCluster(options.db, activeIndex.id, options.clusterLabels)
      : new Map<string, ClusterMergeDiagnostics>()
    : new Map<string, ClusterMergeDiagnostics>();
  const clustersForStatus = includeClusterItems
    ? options.profiles
        .listClusters({
          ...(activeIndex ? { embeddingIndexId: activeIndex.id } : {})
        })
        .slice(0, clusterItemLimit)
    : [];
  const clusterFamilyMap = includeClusterItems
    ? options.interestFamilies.familyMapForClusters(clustersForStatus.map((cluster) => cluster.id))
    : new Map<string, RecommendationClusterFamily>();
  const clusterItems = clustersForStatus.map((cluster, index) => {
    const displayIndex = index + 1;
    return clusterDetailLevel === "diagnostic"
      ? mapRecommendationCluster(
          cluster,
          displayIndex,
          clusterEvidence,
          options.clusterLabels,
          clusterMergeDiagnostics.get(cluster.id) ?? emptyClusterMergeDiagnostics(),
          clusterFamilyMap.get(cluster.id) ?? null
        )
      : mapRecommendationClusterSummary(
          cluster,
          displayIndex,
          options.clusterLabels,
          clusterFamilyMap.get(cluster.id) ?? null
        );
  });
  const familySummary = summaryOnly
    ? emptyRecommendationFamilySummary()
    : options.interestFamilies.listFamilySummary(activeIndex?.id ?? null, 8);
  const rankedArticles = options.rankings.countRankedArticles({ activeRankContext });
  const lastProfileUpdate = options.profiles.getLastProfileUpdate({
    ...(activeIndex ? { embeddingIndexId: activeIndex.id } : {})
  });
  const lastRankingUpdate = options.rankings.getLastRankingUpdate({ activeRankContext });
  const snapshot = options.memory?.snapshotSummary() ?? null;
  const profileSignals = options.profiles.countProfileSignals();
  const profileLearning = isProfileLearning(profileSignals, clusters);
  const warnings = recommendationWarnings({
    activeProvider,
    activeIndex,
    coverage,
    profileLearning
  });
  const mode = recommendationMode({
    activeProvider,
    activeIndex,
    coverage,
    rankedArticles
  });

  return {
    mode,
    activeProvider: activeProvider ? mapRecommendationProvider(activeProvider) : null,
    activeIndex: activeIndex ? mapRecommendationIndex(activeIndex) : null,
    activeRankContext,
    algorithm: {
      version: RECOMMENDATION_ALGORITHM_VERSION,
      featureSchemaVersion: RECOMMENDATION_FEATURE_SCHEMA_VERSION,
      cocoonLevel: options.settings.cocoonLevel,
      localLearning: {
        enabled: options.settings.localLearningEnabled,
        shadowMode: options.settings.localLearningShadowMode
      },
      exploration: {
        enabled: options.settings.explorationEnabled
      },
      evaluation: {
        enabled: options.settings.evaluationEnabled
      },
      cocoonParameters: cocoonParametersForStatus(options.settings.cocoonLevel)
    },
    coverage: mapCoverage(coverage),
    behaviorCounts,
    clusters: {
      ...clusters,
      families: familySummary,
      items: clusterItems
    },
    rankedArticles,
    lastProfileUpdate: timestampToIso(lastProfileUpdate),
    lastRankingUpdate: timestampToIso(lastRankingUpdate),
    memory: {
      snapshot: snapshot
        ? {
            schemaVersion: snapshot.schemaVersion,
            embeddingIndexId: snapshot.embeddingIndexId,
            generatedAt: timestampToIso(snapshot.generatedAt),
            sourceWatermark: snapshot.sourceWatermark
          }
        : null,
      crossSessionFatigueMode: options.settings.crossSessionFatigueMode,
      recentHistoryMode: options.settings.recentHistoryMode,
      learnedExplorationMode: options.settings.learnedExplorationMode
    },
    warnings
  };
}

function labeledExplanationCluster(
  cluster: RankExplanationClusterMatch,
  clusterLabelService: InterestClusterLabelService
) {
  const label = clusterLabelService.displayLabelForCluster(
    {
      id: cluster.id,
      label: cluster.label,
      polarity: cluster.polarity,
      displayIndex: cluster.displayIndex
    },
    cluster.displayIndex
  );

  return {
    ...cluster,
    ...label,
    label: label.displayLabel
  };
}

function getRecommendationClusters(
  options: Parameters<typeof getRecommendationStatus>[0] & {
    limit: number | null;
    clusterDetailLevel?: RecommendationClusterDetailLevel;
  }
) {
  const clusterDetailLevel = options.clusterDetailLevel ?? "summary";
  const activeProvider = options.embeddings.findActiveProvider();
  const activeIndex = activeProvider
    ? options.embeddings.findActiveIndexForProvider(activeProvider.id)
    : null;
  const clusterEvidence = activeIndex && clusterDetailLevel === "diagnostic"
    ? options.profiles.listClusterEvidence({ embeddingIndexId: activeIndex.id, limit: 5000 })
    : [];
  const clusters = options.profiles.listClusters({
    ...(activeIndex ? { embeddingIndexId: activeIndex.id } : {})
  });
  const limitedClusters = options.limit === null ? clusters : clusters.slice(0, options.limit);
  const clusterMergeDiagnostics = activeIndex && clusterDetailLevel === "diagnostic"
    ? mergeDiagnosticsByCluster(options.db, activeIndex.id, options.clusterLabels)
    : new Map<string, ClusterMergeDiagnostics>();
  const clusterFamilyMap = options.interestFamilies.familyMapForClusters(
    limitedClusters.map((cluster) => cluster.id)
  );

  return {
    activeIndex: activeIndex ? mapRecommendationIndex(activeIndex) : null,
    total: clusters.length,
    families: options.interestFamilies.listFamilySummary(activeIndex?.id ?? null, 24),
    items: limitedClusters.map((cluster, index) => {
      const displayIndex = index + 1;
      return clusterDetailLevel === "diagnostic"
        ? mapRecommendationCluster(
            cluster,
            displayIndex,
            clusterEvidence,
            options.clusterLabels,
            clusterMergeDiagnostics.get(cluster.id) ?? emptyClusterMergeDiagnostics(),
            clusterFamilyMap.get(cluster.id) ?? null
          )
        : mapRecommendationClusterSummary(
            cluster,
            displayIndex,
            options.clusterLabels,
            clusterFamilyMap.get(cluster.id) ?? null
          );
    })
  };
}

function enqueueRecommendationMaintenanceTask(
  service: RecommendationMaintenanceService,
  task: string
) {
  switch (task) {
    case "ranking_recalculate":
      return service.enqueueRecalculate();
    case "fingerprint_backfill":
      return service.enqueueFingerprintBackfill();
    case "duplicate_rebuild":
      return service.enqueueDuplicateRebuild();
    case "keyword_rebuild":
      return service.enqueueKeywordRebuild();
    case "recent_intent_rebuild":
      return service.enqueueRecentIntentRebuild();
    case "cluster_label_rebuild":
      return service.enqueueClusterLabelRebuild();
    case "cluster_merge_diagnostics":
      return service.enqueueClusterMergeDiagnostics();
    case "cluster_auto_merge":
      return service.enqueueClusterAutoMerge();
    case "interest_family_rebuild":
      return service.enqueueInterestFamilyRebuild();
    case "evaluation":
      return service.enqueueEvaluation();
    case "ftrl_train":
      return service.enqueueFtrlTrain();
    case "ftrl_reset":
      return service.resetFtrl();
    case "ftrl_promote":
      return service.promoteFtrl();
    default:
      throw new RecommendationMaintenanceServiceError(
        400,
        "INVALID_MAINTENANCE_TASK",
        "Unknown recommendation maintenance task"
      );
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
    return fallback;
  }

  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isPluginDeliveryStatus(value: unknown): value is "queued" | "running" | "succeeded" | "failed" | "cancelled" {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function parseMergeCandidateQuery(query: RecommendationMergeCandidateQuery):
  | {
      ok: true;
      input: {
        status?: "open" | "merged" | "ignored" | "dismissed" | "all";
        limit?: number;
      };
    }
  | { ok: false; message: string; details?: unknown } {
  let status: "open" | "merged" | "ignored" | "dismissed" | "all" | undefined;
  if (query.status !== undefined) {
    if (
      query.status !== "open" &&
      query.status !== "merged" &&
      query.status !== "ignored" &&
      query.status !== "dismissed" &&
      query.status !== "all"
    ) {
      return {
        ok: false,
        message: "status must be open, merged, ignored, dismissed, or all",
        details: { field: "status" }
      };
    }
    status = query.status;
  }

  const limit = parseLimit(query.limit);
  if (limit === null) {
    return {
      ok: false,
      message: "limit must be a positive integer",
      details: { field: "limit" }
    };
  }

  return {
    ok: true,
    input: {
      ...(status !== undefined ? { status } : {}),
      ...(limit !== undefined ? { limit } : {})
    }
  };
}

function getRecommendationTransparency(options: {
  db: DibaoDatabase;
  embeddings: SqliteEmbeddingRepository;
  profiles: SqliteProfileRepository;
  rankings: SqliteRankingRepository;
  rankingService: RecommendationRankingService;
  clusterLabels: InterestClusterLabelService;
  interestFamilies: InterestFamilyService;
  memory?: RecommendationMemoryService;
  settings: ReturnType<SettingsService["getSettings"]>["ranking"];
  includeClusterItems?: boolean;
  clusterItemLimit?: number;
  clusterDetailLevel?: RecommendationClusterDetailLevel;
  maintenanceSettings?: ReturnType<SettingsService["getSettings"]>["recommendationMaintenance"];
  maintenanceScheduleStates?: Array<{
    taskKey: string;
    lastEnqueuedAt: number | null;
    lastCompletedAt: number | null;
    lastSkippedReason: string | null;
    lastJobId: string | null;
    updatedAt: number;
  }>;
}) {
  const status = getRecommendationStatus(options);
  const fallbackReason =
    status.mode === "baseline"
      ? "no_active_embedding_provider_or_index"
      : status.mode === "embedding"
        ? "embedding_backfill_or_indexing_in_progress"
        : status.mode === "degraded"
          ? "provider_or_embedding_job_failure"
          : null;

  const moduleStatus = recommendationModuleStatus(options.db, status.algorithm, {
    activeIndexId: status.activeIndex?.id ?? null
  });

  return {
    ...status,
    transparency: {
      currentFormula:
        status.mode === "baseline"
          ? "freshness + source + state fallback"
          : "family-aware semantic + freshness + source + state - negative/dedupe/exposure + canonical MMR rerank",
      fallbackReason,
      rankingCore: {
        usesRemoteLlm: false,
        usesRemoteReranker: false,
        usesExternalSearchService: false,
        allowedRemoteDependency: "one embedding provider"
      },
      moduleStatus,
      algorithmModules: recommendationAlgorithmModules(status, moduleStatus),
      maintenance: {
        schemaMigration: "017_interest_families",
        backfillState: "tracked in recommendation_backfill_state",
        explanationAuthority: "article_rank_explanations",
        scoreAuthority: "article_rank_scores",
        automaticMaintenanceEnabled: options.maintenanceSettings?.maintenanceEnabled ?? true,
        settings: options.maintenanceSettings ?? null,
        schedule: (options.maintenanceScheduleStates ?? []).map((state) => ({
          taskKey: state.taskKey,
          lastEnqueuedAt: timestampToIso(state.lastEnqueuedAt),
          lastCompletedAt: timestampToIso(state.lastCompletedAt),
          lastSkippedReason: state.lastSkippedReason,
          lastJobId: state.lastJobId,
          updatedAt: timestampToIsoValue(state.updatedAt)
        }))
      },
      failureStates: {
        migrationNotCompleted: false,
        backfillRunning: status.coverage.pendingJobs > 0,
        rankContextMissing:
          status.activeRankContext !== BASE_RANK_CONTEXT && status.rankedArticles.active === 0,
        embeddingCoverageLow: status.coverage.coverageRatio < STOPPED_COVERAGE_THRESHOLD,
        stalePendingEmbeddingJobs: moduleStatus.stalePendingEmbeddingJobs > 0,
        rankingJobFailedWithoutFallback:
          moduleStatus.failedRankingJobs > 0 &&
          status.rankedArticles.base + status.rankedArticles.active === 0,
        bm25ProfileTermsActive: moduleStatus.bm25ProfileTerms === "active",
        recentIntentMissing: moduleStatus.recentIntent !== "active",
        ftrlTrained:
          moduleStatus.ftrl === "shadow_training" ||
          moduleStatus.ftrl === "ready_to_promote" ||
          moduleStatus.ftrl === "active_low_weight" ||
          moduleStatus.ftrl === "active",
        duplicateNearMatchActive: moduleStatus.duplicate === "near_duplicate_active",
        evidenceUsingDynamicFallback: moduleStatus.evidence === "dynamic_fallback",
        ftrlShadowMode: status.algorithm.localLearning.shadowMode,
        evaluationUnavailable: !status.algorithm.evaluation.enabled,
        recommendationUsingFallback: status.mode === "baseline" || status.mode === "degraded"
      }
    }
  };
}

type RecommendationAlgorithmModuleTone = "normal" | "warning" | "stopped" | "disabled";

const STOPPED_COVERAGE_THRESHOLD = 0.95;
const STALE_PENDING_JOB_AGE_MS = 30 * 60 * 1000;

function recommendationAlgorithmModules(
  status: ReturnType<typeof getRecommendationStatus>,
  moduleStatus: ReturnType<typeof recommendationModuleStatus>
): Array<{
  id: string;
  name: string;
  status: RecommendationAlgorithmModuleTone;
  summary: string;
}> {
  const activeRankContextMissing =
    status.activeRankContext !== BASE_RANK_CONTEXT && status.rankedArticles.active === 0;
  const hasUsableRankingFallback = status.rankedArticles.base + status.rankedArticles.active > 0;
  const recommendationUsingFallback =
    status.mode === "baseline" || status.mode === "degraded";

  return [
    {
      id: "provider",
      name: "Embedding provider",
      status:
        status.activeProvider?.lastTestStatus === "failed"
          ? "stopped"
          : status.activeProvider
            ? "normal"
            : "warning",
      summary: status.activeProvider
        ? `${status.activeProvider.name} · ${status.activeProvider.model}`
        : "No active provider; baseline ranking remains available."
    },
    {
      id: "embedding_index",
      name: "Embedding index",
      status:
        status.activeIndex?.status === "active"
          ? "normal"
          : status.activeIndex
            ? "warning"
            : "stopped",
      summary: status.activeIndex
        ? `${status.activeIndex.model} · ${status.activeIndex.status}`
        : "No active index; semantic matching is unavailable."
    },
    {
      id: "coverage_backfill",
      name: "Coverage and backfill",
      status:
        status.coverage.coverageRatio < STOPPED_COVERAGE_THRESHOLD ||
        moduleStatus.stalePendingEmbeddingJobs > 0
          ? "stopped"
          : status.coverage.pendingJobs > 0 ||
              status.coverage.coverageRatio < 1 ||
              status.coverage.failedJobs > 0
            ? "warning"
            : "normal",
      summary: `${Math.round(status.coverage.coverageRatio * 100)}% coverage · ${status.coverage.pendingJobs} pending · ${status.coverage.failedJobs} failed`
    },
    {
      id: "ranking_pipeline",
      name: "Ranking pipeline",
      status:
        activeRankContextMissing ||
        (moduleStatus.failedRankingJobs > 0 && !hasUsableRankingFallback)
          ? "stopped"
          : moduleStatus.failedRankingJobs > 0
            ? "warning"
            : "normal",
      summary: `rank context ${status.activeRankContext}; active ${status.rankedArticles.active}; base fallback ${status.rankedArticles.base}; failed jobs ${moduleStatus.failedRankingJobs}.`
    },
    {
      id: "profile_clusters",
      name: "Profile clusters",
      status:
        status.clusters.positive + status.clusters.negative > 0
          ? "normal"
          : Object.values(status.behaviorCounts).some((count) => count > 0)
            ? "warning"
            : "stopped",
      summary: `${status.clusters.positive} positive · ${status.clusters.negative} negative`
    },
    {
      id: "interest_families",
      name: "Topic family diversity",
      status:
        status.clusters.families.concentrationRisk === "high"
          ? "warning"
          : moduleStatus.interestFamilies === "not_built" &&
              status.clusters.positive + status.clusters.negative > 0
            ? "warning"
            : "normal",
      summary: `${status.clusters.families.positive} positive · ${status.clusters.families.negative} negative topic families; concentration risk ${status.clusters.families.concentrationRisk}.`
    },
    {
      id: "semantic_ranking",
      name: "Semantic ranking",
      status: recommendationUsingFallback
        ? "stopped"
        : status.mode === "embedding"
          ? "warning"
          : "normal",
      summary:
        status.mode === "baseline"
          ? "Using freshness, source, and state fallback."
          : status.mode === "degraded"
            ? "Provider or embedding failure is forcing a degraded recommendation path."
            : status.mode === "embedding"
              ? "Semantic ranking is available but still backfilling or partially covered."
          : "Combining semantic score with freshness, source, state, and penalties."
    },
    {
      id: "bm25_profile_terms",
      name: "BM25 and profile terms",
      status: moduleStatus.bm25ProfileTerms === "active" ? "normal" : "warning",
      summary: `BM25/profile terms: ${moduleStatus.bm25ProfileTerms}.`
    },
    {
      id: "recent_intent",
      name: "Recent intent",
      status: moduleStatus.recentIntent === "active" ? "normal" : "warning",
      summary: `Recent intent profile: ${moduleStatus.recentIntent}.`
    },
    {
      id: "negative_feedback",
      name: "Negative feedback",
      status: "normal",
      summary: "Hidden and not-interested articles are removed from normal lists and penalize similar candidates."
    },
    {
      id: "dedupe_exposure",
      name: "Dedupe and exposure",
      status:
        moduleStatus.duplicate === "near_duplicate_active"
          ? "normal"
          : "warning",
      summary: `Duplicate module: ${moduleStatus.duplicate}; evidence: ${moduleStatus.evidence}.`
    },
    {
      id: "explanation_evidence",
      name: "Explanation evidence",
      status: moduleStatus.evidence === "dynamic_fallback" ? "warning" : "normal",
      summary: `Evidence source: ${moduleStatus.evidence}.`
    },
    {
      id: "mmr_diversity",
      name: "MMR diversity",
      status: "normal",
      summary: `Cocoon level ${status.algorithm.cocoonLevel}; MMR lambda ${status.algorithm.cocoonParameters.mmrLambda}.`
    },
    {
      id: "local_learning",
      name: "Local learning",
      status:
        moduleStatus.ftrl === "failed"
          ? "stopped"
          : (moduleStatus.ftrl === "active" || moduleStatus.ftrl === "active_low_weight") &&
              !status.algorithm.localLearning.shadowMode
          ? "normal"
          : "disabled",
      summary: `FTRL: ${moduleStatus.ftrl}; shadow mode: ${status.algorithm.localLearning.shadowMode}.`
    },
    {
      id: "evaluation",
      name: "Evaluation replay",
      status:
        moduleStatus.evaluation === "unavailable"
          ? "disabled"
          : moduleStatus.evaluation === "lightweight_replay_diagnostic" ||
              moduleStatus.evaluation === "strict_replay"
          ? "normal"
          : "warning",
      summary: `Evaluation: ${moduleStatus.evaluation}.`
    }
  ];
}

function mapRecommendationCluster(
  cluster: InterestClusterRow,
  displayIndex: number,
  evidence: InterestClusterEvidenceRow[],
  clusterLabels: InterestClusterLabelService,
  mergeDiagnostics: ClusterMergeDiagnostics,
  family: RecommendationClusterFamily | null = null
) {
  const diagnostics = clusterDiagnostics(cluster, evidence);
  const label = clusterLabels.displayLabelForCluster(
    {
      id: cluster.id,
      label: cluster.label,
      polarity: cluster.polarity,
      displayIndex
    },
    displayIndex
  );
  return {
    id: cluster.id,
    polarity: cluster.polarity,
    label: label.displayLabel,
    displayLabel: label.displayLabel,
    labelSource: label.labelSource,
    autoLabel: label.autoLabel,
    manualLabel: label.manualLabel,
    confidence: label.confidence,
    evidenceCount: Math.max(
      diagnostics.supportArticleCount,
      label.representativeArticles.length
    ),
    topTerms: label.topTerms,
    representativeArticles: label.representativeArticles,
    feedTitles: label.feedTitles,
    labelDiagnostics: label.labelDiagnostics,
    mergeDiagnostics,
    family,
    lastGeneratedAt: timestampToIso(label.generatedAt),
    displayIndex,
    weight: cluster.weight,
    sampleCount: cluster.sampleCount,
    diagnostics,
    lastMatchedAt: timestampToIso(cluster.lastMatchedAt),
    updatedAt: timestampToIso(cluster.updatedAt)
  };
}

function mapRecommendationClusterSummary(
  cluster: InterestClusterRow,
  displayIndex: number,
  clusterLabels: InterestClusterLabelService,
  family: RecommendationClusterFamily | null = null
) {
  const label = clusterLabels.displayLabelForCluster(
    {
      id: cluster.id,
      label: cluster.label,
      polarity: cluster.polarity,
      displayIndex
    },
    displayIndex
  );
  return {
    id: cluster.id,
    polarity: cluster.polarity,
    label: label.displayLabel,
    displayLabel: label.displayLabel,
    labelSource: label.labelSource,
    autoLabel: label.autoLabel,
    manualLabel: label.manualLabel,
    confidence: label.confidence,
    evidenceCount: label.representativeArticles.length,
    topTerms: label.topTerms,
    representativeArticles: label.representativeArticles,
    feedTitles: label.feedTitles,
    labelDiagnostics: label.labelDiagnostics,
    family,
    lastGeneratedAt: timestampToIso(label.generatedAt),
    displayIndex,
    weight: cluster.weight,
    sampleCount: cluster.sampleCount,
    lastMatchedAt: timestampToIso(cluster.lastMatchedAt),
    updatedAt: timestampToIso(cluster.updatedAt)
  };
}

type ClusterMergeDiagnostics = {
  candidateCount: number;
  topCandidate: {
    candidateId: string;
    otherClusterId: string;
    otherLabel: string;
    centroidSimilarity: number;
    labelJaccard: number;
    evidenceOverlap: number;
    mergeScore: number;
    recommendation: "auto_merge" | "review" | "ignore";
    status: "open" | "merged" | "ignored" | "dismissed";
  } | null;
};

function emptyClusterMergeDiagnostics(): ClusterMergeDiagnostics {
  return {
    candidateCount: 0,
    topCandidate: null
  };
}

function mergeDiagnosticsByCluster(
  db: DibaoDatabase,
  embeddingIndexId: string,
  clusterLabels: InterestClusterLabelService
): Map<string, ClusterMergeDiagnostics> {
  const candidates = db
    .prepare(
      `
        select
          id,
          left_cluster_id as leftClusterId,
          right_cluster_id as rightClusterId,
          centroid_similarity as centroidSimilarity,
          label_jaccard as labelJaccard,
          evidence_overlap as evidenceOverlap,
          merge_score as mergeScore,
          recommendation,
          status
        from interest_cluster_merge_candidates
        where embedding_index_id = ?
          and status = 'open'
        order by merge_score desc, updated_at desc
      `
    )
    .all(embeddingIndexId) as Array<{
    id: string;
    leftClusterId: string;
    rightClusterId: string;
    centroidSimilarity: number;
    labelJaccard: number;
    evidenceOverlap: number;
    mergeScore: number;
    recommendation: "auto_merge" | "review" | "ignore";
    status: "open" | "merged" | "ignored" | "dismissed";
  }>;
  const clusters = new Map(
    (
      db
        .prepare(
          `
            select
              id,
              polarity,
              label,
              weight,
              sample_count as sampleCount,
              last_matched_at as lastMatchedAt,
              created_at as createdAt,
              updated_at as updatedAt,
              embedding_index_id as embeddingIndexId,
              centroid_vector_blob as centroidVectorBlob
            from interest_clusters
            where embedding_index_id = ?
          `
        )
        .all(embeddingIndexId) as InterestClusterRow[]
    ).map((cluster) => [cluster.id, cluster])
  );
  const result = new Map<string, ClusterMergeDiagnostics>();
  for (const candidate of candidates) {
    for (const side of ["left", "right"] as const) {
      const clusterId = side === "left" ? candidate.leftClusterId : candidate.rightClusterId;
      const otherClusterId = side === "left" ? candidate.rightClusterId : candidate.leftClusterId;
      const current = result.get(clusterId) ?? emptyClusterMergeDiagnostics();
      const otherCluster = clusters.get(otherClusterId);
      const otherLabel = otherCluster
        ? clusterLabels.displayLabelForCluster(
            {
              id: otherCluster.id,
              label: otherCluster.label,
              polarity: otherCluster.polarity
            },
            1
          ).displayLabel
        : otherClusterId;
      current.candidateCount += 1;
      if (!current.topCandidate || candidate.mergeScore > current.topCandidate.mergeScore) {
        current.topCandidate = {
          candidateId: candidate.id,
          otherClusterId,
          otherLabel,
          centroidSimilarity: candidate.centroidSimilarity,
          labelJaccard: candidate.labelJaccard,
          evidenceOverlap: candidate.evidenceOverlap,
          mergeScore: candidate.mergeScore,
          recommendation: candidate.recommendation,
          status: candidate.status
        };
      }
      result.set(clusterId, current);
    }
  }
  return result;
}

function clusterDiagnostics(cluster: InterestClusterRow, evidence: InterestClusterEvidenceRow[]) {
  const hasPersistedClusterEvidence = evidence.some((item) => typeof item.clusterId === "string");
  const evidenceForCluster = hasPersistedClusterEvidence
    ? evidence.filter((item) => item.clusterId === cluster.id)
    : evidence;
  const similarityThreshold =
    cluster.polarity === "positive"
      ? profileAlgorithmDefaults.positiveCreateThreshold
      : profileAlgorithmDefaults.negativeCreateThreshold;

  let centroid: number[] | null = null;
  const matches: Array<{ item: InterestClusterEvidenceRow; similarity: number }> = [];
  for (const item of evidenceForCluster) {
    const storedSimilarity =
      typeof item.similarity === "number" && Number.isFinite(item.similarity)
        ? item.similarity
        : null;
    if (storedSimilarity === null && centroid === null) {
      centroid = fromVectorBlob(cluster.centroidVectorBlob);
    }
    const similarity =
      storedSimilarity ?? cosineSimilarity(centroid ?? [], fromVectorBlob(item.vectorBlob));
    if (!Number.isFinite(similarity)) {
      continue;
    }
    if (!hasPersistedClusterEvidence) {
      if (similarity < similarityThreshold) {
        continue;
      }
    }
    const polarity = profilePolarityForEvent(item);
    if (polarity !== cluster.polarity) {
      continue;
    }
    matches.push({ item, similarity });
  }

  const articleIds = new Set(matches.map(({ item }) => item.articleId));
  const sourceCounts = new Map<string, number>();
  let strongSignalCount = 0;
  let similarityTotal = 0;
  let maxSimilarity = 0;

  for (const match of matches) {
    sourceCounts.set(match.item.feedId, (sourceCounts.get(match.item.feedId) ?? 0) + 1);
    if (isStrongProfileSignal(match.item)) {
      strongSignalCount += 1;
    }
    similarityTotal += match.similarity;
    maxSimilarity = Math.max(maxSimilarity, match.similarity);
  }

  const supportEventCount = matches.length;
  const sourceCount = sourceCounts.size;
  const topSourceEventCount = Math.max(0, ...sourceCounts.values());
  const topSourceShare = supportEventCount > 0 ? topSourceEventCount / supportEventCount : 0;
  const strongSignalRatio =
    supportEventCount > 0 ? strongSignalCount / supportEventCount : 0;
  const averageSimilarity =
    supportEventCount > 0 ? similarityTotal / supportEventCount : 0;
  const risk = overfitRisk({
    supportArticleCount: articleIds.size,
    sourceCount,
    strongSignalRatio,
    topSourceShare,
    averageSimilarity,
    weight: cluster.weight
  });

  return {
    supportArticleCount: articleIds.size,
    supportEventCount,
    sourceCount,
    strongSignalCount,
    strongSignalRatio: roundMetric(strongSignalRatio),
    topSourceShare: roundMetric(topSourceShare),
    averageSimilarity: roundMetric(averageSimilarity),
    maxSimilarity: roundMetric(maxSimilarity),
    overfitRisk: risk,
    warnings: overfitWarnings({
      supportArticleCount: articleIds.size,
      sourceCount,
      strongSignalRatio,
      topSourceShare,
      averageSimilarity,
      weight: cluster.weight,
      risk
    })
  };
}

type RecommendationCoverage = {
  candidateCount: number;
  eligibleArticleCount: number;
  missingEmbeddingCount: number;
  staleEmbeddingCount: number;
  coveredArticleCount: number;
  embeddingCount: number;
  coverageRatio: number;
  pendingJobs: number;
  failedJobs: number;
  lastFailedAt: number | null;
  lastError: string | null;
};

type RecommendationMode = "baseline" | "personalized" | "embedding" | "degraded";

const PROFILE_WARMUP_MIN_SIGNAL_COUNT = 8;
const PROFILE_WARMUP_MIN_SIGNAL_ARTICLE_COUNT = 5;
const PROFILE_WARMUP_MIN_POSITIVE_CLUSTERS = 2;

function activeDiagnosticIndexFor(
  providerId: string,
  indexes: EmbeddingIndexListRow[]
): EmbeddingIndexListRow | null {
  return (
    indexes.find((index) => index.providerId === providerId && index.status === "active") ??
    indexes.find((index) => index.providerId === providerId && index.status === "failed") ??
    null
  );
}

function coverageFor(index: EmbeddingIndexListRow | null): RecommendationCoverage {
  if (!index) {
    return {
      candidateCount: 0,
      eligibleArticleCount: 0,
      missingEmbeddingCount: 0,
      staleEmbeddingCount: 0,
      coveredArticleCount: 0,
      embeddingCount: 0,
      coverageRatio: 0,
      pendingJobs: 0,
      failedJobs: 0,
      lastFailedAt: null,
      lastError: null
    };
  }

  return {
    candidateCount: index.candidateCount,
    eligibleArticleCount: index.eligibleArticleCount,
    missingEmbeddingCount: index.missingEmbeddingCount,
    staleEmbeddingCount: index.staleEmbeddingCount,
    coveredArticleCount: index.coveredArticleCount,
    embeddingCount: index.embeddingCount,
    coverageRatio: index.coverageRatio,
    pendingJobs: index.pendingJobs,
    failedJobs: index.failedJobs,
    lastFailedAt: index.lastFailedAt,
    lastError: index.lastError
  };
}

function emptyRecommendationFamilySummary() {
  return {
    positive: 0,
    negative: 0,
    topFamilies: [],
    dominantFamily: null,
    concentrationRisk: "low" as const
  };
}

function recommendationMode(input: {
  activeProvider: EmbeddingProviderRow | null;
  activeIndex: EmbeddingIndexRow | null;
  coverage: RecommendationCoverage;
  rankedArticles: { base: number; active: number };
}): RecommendationMode {
  if (!input.activeProvider || !input.activeIndex) {
    return "baseline";
  }

  if (
    input.activeIndex.status === "failed" ||
    input.activeProvider.lastTestStatus === "failed" ||
    hasBlockingEmbeddingFailures(input.coverage)
  ) {
    return "degraded";
  }

  const hasUsableRanking = input.rankedArticles.base + input.rankedArticles.active > 0;
  if (!hasUsableRanking || input.coverage.coverageRatio < STOPPED_COVERAGE_THRESHOLD) {
    return "embedding";
  }

  return "personalized";
}

function hasBlockingEmbeddingFailures(coverage: RecommendationCoverage): boolean {
  if (coverage.failedJobs === 0) {
    return false;
  }

  return (
    coverage.missingEmbeddingCount > 0 ||
    coverage.staleEmbeddingCount > 0 ||
    coverage.coverageRatio < 1
  );
}

function recommendationWarnings(input: {
  activeProvider: EmbeddingProviderRow | null;
  activeIndex: EmbeddingIndexRow | null;
  coverage: RecommendationCoverage;
  profileLearning: boolean;
}): Array<{ code: string; message: string }> {
  const warnings: Array<{ code: string; message: string }> = [];

  if (!input.activeProvider || !input.activeIndex) {
    warnings.push({
      code: "NO_PROVIDER",
      message: "No active embedding provider and index are configured; recommendations are using baseline ranking."
    });
  } else if (input.coverage.pendingJobs > 0 || input.coverage.coverageRatio < 1) {
    warnings.push({
      code: "EMBEDDING_PENDING",
      message: "Embedding generation is still running or incomplete for the active index."
    });
  }

  if (
    input.activeIndex &&
    (hasBlockingEmbeddingFailures(input.coverage) || input.activeIndex.status === "failed")
  ) {
    warnings.push({
      code: "EMBEDDING_JOB_FAILED",
      message: "Embedding generation has failed jobs for the active index."
    });
  }

  if (input.activeProvider?.lastTestStatus === "failed") {
    warnings.push({
      code: "PROVIDER_TEST_FAILED",
      message: "The active embedding provider's latest connection test failed."
    });
  }

  if (input.profileLearning) {
    warnings.push({
      code: "PROFILE_WARMUP",
      message: "The recommendation profile still has limited behavior and interest signals."
    });
  }

  return warnings;
}

function isProfileLearning(
  profileSignals: ProfileSignalCountRow,
  clusters: { positive: number; negative: number }
): boolean {
  return (
    profileSignals.signalCount < PROFILE_WARMUP_MIN_SIGNAL_COUNT ||
    profileSignals.articleCount < PROFILE_WARMUP_MIN_SIGNAL_ARTICLE_COUNT ||
    clusters.positive < PROFILE_WARMUP_MIN_POSITIVE_CLUSTERS
  );
}

function rankingSettingsChanged(
  before: ReturnType<SettingsService["getSettings"]>["ranking"],
  after: ReturnType<SettingsService["getSettings"]>["ranking"]
): boolean {
  return (
    before.cocoonLevel !== after.cocoonLevel ||
    before.localLearningEnabled !== after.localLearningEnabled ||
    before.localLearningShadowMode !== after.localLearningShadowMode ||
    before.explorationEnabled !== after.explorationEnabled ||
    before.evaluationEnabled !== after.evaluationEnabled
  );
}

function profileStructureSettingsChanged(
  before: ReturnType<SettingsService["getSettings"]>["ranking"],
  after: ReturnType<SettingsService["getSettings"]>["ranking"]
): boolean {
  return (
    before.maxPositiveInterestClusters !== after.maxPositiveInterestClusters ||
    before.maxNegativeInterestClusters !== after.maxNegativeInterestClusters ||
    before.maxPositiveInterestFamilies !== after.maxPositiveInterestFamilies ||
    before.maxNegativeInterestFamilies !== after.maxNegativeInterestFamilies
  );
}

function retentionSettingsRequireCleanupQueue(
  before: ReturnType<SettingsService["getSettings"]>["retention"],
  after: ReturnType<SettingsService["getSettings"]>["retention"]
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

function recommendationModuleStatus(
  db: DibaoDatabase,
  algorithm: {
    localLearning: { enabled: boolean; shadowMode: boolean };
    exploration: { enabled: boolean };
    evaluation: { enabled: boolean };
  },
  diagnostics: {
    activeIndexId: string | null;
  }
) {
  const profileTermCount = countIfTable(db, "profile_terms");
  const recentIntentActive =
    scalarCount(
      db,
      "select count(*) as count from recent_intent_profiles where event_count > 0 and centroid_vector_blob is not null"
    ) > 0;
  const model = db
    .prepare(
      `
        select
          status,
          sample_count as sampleCount,
          blend_alpha as blendAlpha,
          metrics_json as metricsJson
        from rank_model_versions
        where status in ('shadow', 'active', 'failed', 'retired')
        order by updated_at desc
        limit 1
      `
    )
    .get() as
    | {
        status: "shadow" | "active" | "failed" | "retired";
        sampleCount: number;
        blendAlpha: number;
        metricsJson: string | null;
      }
    | undefined;
  const nearDuplicateActive =
    scalarCount(
      db,
      "select count(*) as count from duplicate_group_members where reason like 'near_%'"
    ) > 0;
  const duplicateBuilt = countIfTable(db, "duplicate_groups") > 0;
  const evidenceRows = countIfTable(db, "interest_cluster_evidence");
  const interestFamilyRows = countIfTable(db, "interest_families");
  const latestEval = db
    .prepare(
      `
        select metrics_json as metricsJson
        from ranking_eval_runs
        where status = 'succeeded'
        order by created_at desc
        limit 1
      `
    )
    .get() as { metricsJson: string | null } | undefined;
  const evalMode = evaluationModeFromMetrics(latestEval?.metricsJson ?? null);
  const stalePendingEmbeddingJobs = diagnostics.activeIndexId
    ? scalarCount(
        db,
        `
          select count(*) as count
          from jobs
          where type = 'embedding_generate'
            and status in ('queued', 'running')
            and created_at < ?
            and payload_json like ?
        `,
        [Date.now() - STALE_PENDING_JOB_AGE_MS, `%${diagnostics.activeIndexId}%`]
      )
    : 0;
  const failedRankingJobs = scalarCount(
    db,
    `
      select count(*) as count
      from jobs
      where type = 'ranking_recalculate'
        and status = 'failed'
    `
  );

  return {
    bm25ProfileTerms: profileTermCount > 0 ? "active" : "not_active",
    recentIntent: recentIntentActive ? "active" : "missing",
    ftrl: ftrlStatusForTransparency(model, algorithm.localLearning.enabled),
    exploration: algorithm.exploration.enabled
      ? "enabled_bonus_only"
      : "disabled",
    evaluation: !algorithm.evaluation.enabled ? "unavailable" : evalMode,
    duplicate: nearDuplicateActive ? "near_duplicate_active" : duplicateBuilt ? "exact_scaffold" : "not_built",
    interestFamilies: interestFamilyRows > 0 ? "active" : "not_built",
    evidence: evidenceRows > 0 ? "live_evidence" : "dynamic_fallback",
    stalePendingEmbeddingJobs,
    failedRankingJobs
  };
}

function evaluationModeFromMetrics(
  metricsJson: string | null
): "unavailable" | "diagnostic_only" | "lightweight_replay_diagnostic" | "strict_replay" {
  if (!metricsJson) {
    return "unavailable";
  }
  try {
    const metrics = JSON.parse(metricsJson) as {
      evaluationMode?: unknown;
      diagnosticOnly?: unknown;
    };
    if (metrics.evaluationMode === "strict_replay") {
      return "strict_replay";
    }
    return metrics.evaluationMode === "lightweight_replay_diagnostic" || metrics.diagnosticOnly === true
      ? "lightweight_replay_diagnostic"
      : "diagnostic_only";
  } catch {
    return "diagnostic_only";
  }
}

function ftrlStatusForTransparency(
  model:
    | {
        status: "shadow" | "active" | "failed" | "retired";
        sampleCount: number;
        blendAlpha: number;
        metricsJson: string | null;
      }
    | undefined,
  localLearningEnabled: boolean
):
  | "disabled"
  | "shadow_no_samples"
  | "insufficient_samples"
  | "shadow_training"
  | "ready_to_promote"
  | "active_low_weight"
  | "active"
  | "auto_paused"
  | "retired"
  | "failed" {
  if (!localLearningEnabled) {
    return "disabled";
  }
  if (!model) {
    return "shadow_no_samples";
  }
  if (model.status === "failed") {
    return "failed";
  }
  if (model.status === "retired") {
    return "retired";
  }

  const metrics = parseJsonObject(model.metricsJson);
  const lifecycleStatus = metrics.lifecycleStatus;
  if (
    lifecycleStatus === "shadow_no_samples" ||
    lifecycleStatus === "insufficient_samples" ||
    lifecycleStatus === "shadow_training" ||
    lifecycleStatus === "ready_to_promote" ||
    lifecycleStatus === "active_low_weight" ||
    lifecycleStatus === "active" ||
    lifecycleStatus === "auto_paused" ||
    lifecycleStatus === "retired"
  ) {
    return lifecycleStatus;
  }

  const highQualitySamples =
    typeof metrics.highQualitySamples === "number" ? metrics.highQualitySamples : model.sampleCount;
  if (model.status === "active") {
    return model.blendAlpha <= 0.05 ? "active_low_weight" : "active";
  }
  if (highQualitySamples >= 100) {
    return "ready_to_promote";
  }
  if (highQualitySamples >= 50) {
    return "shadow_training";
  }
  if (highQualitySamples > 0) {
    return "insufficient_samples";
  }
  return "shadow_no_samples";
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function countIfTable(db: DibaoDatabase, tableName: string): number {
  const exists = db
    .prepare("select 1 as ok from sqlite_master where type in ('table', 'view') and name = ?")
    .get(tableName) as { ok: number } | undefined;
  if (!exists) {
    return 0;
  }
  return scalarCount(db, `select count(*) as count from ${tableName}`);
}

function scalarCount(db: DibaoDatabase, sql: string, params: unknown[] = []): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function mapRecommendationProvider(provider: EmbeddingProviderRow) {
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    model: provider.model,
    dimension: provider.dimension,
    lastTestStatus: provider.lastTestStatus,
    lastTestAt: timestampToIso(provider.lastTestAt)
  };
}

function mapRecommendationIndex(index: EmbeddingIndexRow) {
  return {
    id: index.id,
    status: index.status,
    model: index.model,
    dimension: index.dimension
  };
}

function lightweightCoverageFor(
  db: DibaoDatabase,
  index: EmbeddingIndexRow | null
): RecommendationCoverage {
  if (!index) {
    return coverageFor(null);
  }

  const row = db
    .prepare(
      `
        with eligible_article_rows as (
          select
            a.id as articleId,
            coalesce(a.content_hash, a.id || ':' || a.updated_at) as contentHash
          from articles a
          join feeds f on f.id = a.feed_id
          left join article_contents ac on ac.article_id = a.id
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and (
              trim(coalesce(a.title, '')) != ''
              or trim(coalesce(a.summary, '')) != ''
              or trim(substr(coalesce(ac.content_text, ''), 1, 256)) != ''
            )
        )
        select
          count(*) as candidateCount,
          sum(case when ae.article_id is null then 1 else 0 end) as missingEmbeddingCount,
          sum(case when ae.article_id is not null and ae.content_hash != ear.contentHash then 1 else 0 end) as staleEmbeddingCount,
          sum(case when ae.article_id is not null and ae.content_hash = ear.contentHash then 1 else 0 end) as coveredArticleCount,
          (
            select count(*)
            from article_embeddings ae_count
            where ae_count.embedding_index_id = ?
          ) as embeddingCount,
          (
            select count(*)
            from jobs j
            where j.type = 'embedding_generate'
              and j.status in ('queued', 'running')
              and j.payload_json is not null
              and json_valid(j.payload_json)
              and json_extract(j.payload_json, '$.embeddingIndexId') = ?
          ) as pendingJobs,
          (
            select count(*)
            from jobs j
            where j.type = 'embedding_generate'
              and j.status = 'failed'
              and j.payload_json is not null
              and json_valid(j.payload_json)
              and json_extract(j.payload_json, '$.embeddingIndexId') = ?
          ) as failedJobs,
          (
            select coalesce(j.finished_at, j.updated_at)
            from jobs j
            where j.type = 'embedding_generate'
              and j.status = 'failed'
              and j.payload_json is not null
              and json_valid(j.payload_json)
              and json_extract(j.payload_json, '$.embeddingIndexId') = ?
            order by coalesce(j.finished_at, j.updated_at) desc, j.id desc
            limit 1
          ) as lastFailedAt,
          (
            select j.error
            from jobs j
            where j.type = 'embedding_generate'
              and j.status = 'failed'
              and j.payload_json is not null
              and json_valid(j.payload_json)
              and json_extract(j.payload_json, '$.embeddingIndexId') = ?
            order by coalesce(j.finished_at, j.updated_at) desc, j.id desc
            limit 1
          ) as lastError
        from eligible_article_rows ear
        left join article_embeddings ae
          on ae.article_id = ear.articleId
         and ae.embedding_index_id = ?
      `
    )
    .get(index.id, index.id, index.id, index.id, index.id, index.id) as
    | {
        candidateCount: number;
        missingEmbeddingCount: number | null;
        staleEmbeddingCount: number | null;
        coveredArticleCount: number | null;
        embeddingCount: number;
        pendingJobs: number;
        failedJobs: number;
        lastFailedAt: number | null;
        lastError: string | null;
      }
    | undefined;

  const candidateCount = row?.candidateCount ?? 0;
  const coveredArticleCount = row?.coveredArticleCount ?? 0;
  return {
    candidateCount,
    eligibleArticleCount: candidateCount,
    missingEmbeddingCount: row?.missingEmbeddingCount ?? 0,
    staleEmbeddingCount: row?.staleEmbeddingCount ?? 0,
    coveredArticleCount,
    embeddingCount: row?.embeddingCount ?? 0,
    coverageRatio: coverageRatioForCounts(coveredArticleCount, candidateCount),
    pendingJobs: row?.pendingJobs ?? 0,
    failedJobs: row?.failedJobs ?? 0,
    lastFailedAt: row?.lastFailedAt ?? null,
    lastError: row?.lastError ?? null
  };
}

function coverageRatioForCounts(coveredArticleCount: number, candidateCount: number): number {
  return candidateCount === 0 ? 0 : Math.min(1, coveredArticleCount / candidateCount);
}

function mapCoverage(coverage: RecommendationCoverage) {
  return {
    candidateCount: coverage.candidateCount,
    eligibleArticleCount: coverage.eligibleArticleCount,
    missingEmbeddingCount: coverage.missingEmbeddingCount,
    staleEmbeddingCount: coverage.staleEmbeddingCount,
    coveredArticleCount: coverage.coveredArticleCount,
    embeddingCount: coverage.embeddingCount,
    coverageRatio: coverage.coverageRatio,
    pendingJobs: coverage.pendingJobs,
    failedJobs: coverage.failedJobs,
    lastFailedAt: timestampToIso(coverage.lastFailedAt),
    lastError: coverage.lastError
  };
}

function cocoonParametersForStatus(level: number) {
  const c = Math.min(Math.max((level - 1) / 9, 0), 1);
  const lerp = (left: number, right: number) => left + (right - left) * c;
  return {
    personalizationStrength: roundMetric(lerp(0.65, 1.25)),
    diversityStrength: roundMetric(lerp(1.25, 0.55)),
    mmrLambda: roundMetric(lerp(0.55, 0.88)),
    explorationRatio: roundMetric(lerp(0.08, 0.005)),
    sourceCapTop20: Math.round(lerp(3, 12)),
    familyCapTop20: Math.round(lerp(4, 7)),
    familyCapTop50: Math.round(lerp(8, 14)),
    pendingEmbeddingFloor: roundMetric(lerp(0.12, 0.03)),
    freshnessWeight: roundMetric(lerp(1.15, 0.75)),
    negativeSemanticStrength: roundMetric(lerp(0.75, 1.15)),
    recentIntentStrength: roundMetric(lerp(0.75, 1.2)),
    keywordProfileStrength: roundMetric(lerp(0.75, 1.15))
  };
}

function profilePolarityForEvent(
  event: Pick<InterestClusterEvidenceRow, "eventType" | "metadataJson" | "readingProgress">
): "positive" | "negative" | null {
  switch (event.eventType) {
    case "favorite":
    case "like":
    case "read_later":
    case "read_complete":
      return "positive";
    case "read_progress":
      return readProgressForEvidence(event) >= profileAlgorithmDefaults.readCompleteProgressThreshold
        ? "positive"
        : null;
    case "hide":
    case "not_interested":
      return "negative";
    default:
      return null;
  }
}

function isStrongProfileSignal(
  event: Pick<InterestClusterEvidenceRow, "eventType" | "metadataJson" | "readingProgress">
): boolean {
  return (
    event.eventType === "favorite" ||
    event.eventType === "like" ||
    event.eventType === "read_later" ||
    event.eventType === "read_complete" ||
    event.eventType === "hide" ||
    event.eventType === "not_interested" ||
    (event.eventType === "read_progress" &&
      readProgressForEvidence(event) >= profileAlgorithmDefaults.readCompleteProgressThreshold)
  );
}

function readProgressForEvidence(
  event: Pick<InterestClusterEvidenceRow, "metadataJson" | "readingProgress">
): number {
  if (event.metadataJson) {
    try {
      const metadata = JSON.parse(event.metadataJson) as unknown;
      const progress =
        typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
          ? (metadata as { progress?: unknown }).progress
          : undefined;
      if (typeof progress === "number" && Number.isFinite(progress)) {
        return progress;
      }
    } catch {
      // Fall back to persisted state.
    }
  }

  return event.readingProgress;
}

function overfitRisk(input: {
  supportArticleCount: number;
  sourceCount: number;
  strongSignalRatio: number;
  topSourceShare: number;
  averageSimilarity: number;
  weight: number;
}): "low" | "medium" | "high" {
  let riskScore = 0;
  if (input.weight >= 20 && input.supportArticleCount < 5) {
    riskScore += 2;
  } else if (input.supportArticleCount < 3) {
    riskScore += 2;
  } else if (input.supportArticleCount < 6) {
    riskScore += 1;
  }
  if (input.sourceCount <= 1 && input.supportArticleCount >= 3) {
    riskScore += 1;
  }
  if (input.topSourceShare >= 0.75 && input.supportArticleCount >= 4) {
    riskScore += 1;
  }
  if (input.strongSignalRatio < 0.35) {
    riskScore += 1;
  }
  if (input.averageSimilarity < profileAlgorithmDefaults.positiveMergeThreshold) {
    riskScore += 1;
  }

  if (riskScore >= 3) {
    return "high";
  }
  if (riskScore >= 1) {
    return "medium";
  }
  return "low";
}

function overfitWarnings(input: {
  supportArticleCount: number;
  sourceCount: number;
  strongSignalRatio: number;
  topSourceShare: number;
  averageSimilarity: number;
  weight: number;
  risk: "low" | "medium" | "high";
}): string[] {
  const warnings: string[] = [];
  if (input.risk === "high") {
    warnings.push("OVERFIT_RISK_HIGH");
  }
  if (input.weight >= 20 && input.supportArticleCount < 5) {
    warnings.push("HIGH_WEIGHT_LOW_SUPPORT");
  }
  if (input.sourceCount <= 1 && input.supportArticleCount >= 3) {
    warnings.push("SINGLE_SOURCE_DOMINANT");
  }
  if (input.topSourceShare >= 0.75 && input.supportArticleCount >= 4) {
    warnings.push("TOP_SOURCE_DOMINANT");
  }
  if (input.strongSignalRatio < 0.35) {
    warnings.push("WEAK_SIGNAL_HEAVY");
  }
  if (input.averageSimilarity < profileAlgorithmDefaults.positiveMergeThreshold) {
    warnings.push("LOW_INTERNAL_SIMILARITY");
  }
  return warnings;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function parseJobQuery(query: JobQuery):
  | {
      ok: true;
      input: {
        status?: JobStatus;
        type?: JobType;
        limit?: number;
      };
    }
  | { ok: false; message: string; details?: unknown } {
  const status = parseJobStatus(query.status);
  if (status === null) {
    return {
      ok: false,
      message: "status must be queued, running, succeeded, failed, or cancelled",
      details: { field: "status" }
    };
  }

  const type = parseJobType(query.type);
  if (type === null) {
    return {
      ok: false,
      message:
        "type must be a supported job type",
      details: { field: "type" }
    };
  }

  const limit = parseLimit(query.limit);
  if (limit === null) {
    return {
      ok: false,
      message: "limit must be a positive integer",
      details: { field: "limit" }
    };
  }

  return {
    ok: true,
    input: {
      ...(status !== undefined ? { status } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(limit !== undefined ? { limit } : {})
    }
  };
}

function parseOptionalPluginBody(
  body: OptionalPluginBody | undefined
): { ok: true; enabled: boolean; timezone?: string } | { ok: false; message: string; details?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be an object" };
  }
  if (typeof body.enabled !== "boolean") {
    return {
      ok: false,
      message: "enabled must be a boolean",
      details: { field: "enabled" }
    };
  }
  const timezone = typeof body.timezone === "string" && body.timezone.trim()
    ? body.timezone.trim()
    : undefined;
  return { ok: true, enabled: body.enabled, ...(timezone ? { timezone } : {}) };
}

function parseArticleQuery(
  query: ArticleQuery,
  now: (() => number) | undefined
):
  | { ok: true; input: ArticleListInput }
  | { ok: false; message: string; details?: unknown } {
  const view = parseArticleView(query.view);
  if (view === null) {
    return {
      ok: false,
      message: "view must be recommended, latest, favorites, or read_later"
    };
  }

  const status = parseArticleStatus(query.status);
  if (status === null) {
    return {
      ok: false,
      message: "status must be unread, read, or all"
    };
  }

  const unreadOnly = parseBooleanParam(query.unreadOnly);
  if (unreadOnly === null) {
    return {
      ok: false,
      message: "unreadOnly must be true or false"
    };
  }
  const includeUnreadCount = parseBooleanParam(query.includeUnreadCount);
  if (includeUnreadCount === null) {
    return {
      ok: false,
      message: "includeUnreadCount must be true or false"
    };
  }

  const todayOnly = parseBooleanParam(query.todayOnly);
  if (todayOnly === null) {
    return {
      ok: false,
      message: "todayOnly must be true or false"
    };
  }
  const timeWindow = parseArticleTimeWindow(query.timeWindow, todayOnly);
  if (timeWindow === null) {
    return {
      ok: false,
      message: "timeWindow must be 24h, 7d, or 30d",
      details: { field: "timeWindow" }
    };
  }

  const limit = parseLimit(query.limit);
  if (limit === null) {
    return {
      ok: false,
      message: "limit must be a positive integer"
    };
  }

  const cursor = decodeArticleListCursor(query.cursor);
  if (cursor === null) {
    return {
      ok: false,
      message: "cursor is invalid"
    };
  }

  const recommendationSessionId = parseRecommendationSessionId(query.recommendationSessionId);
  if (recommendationSessionId === null) {
    return {
      ok: false,
      message: "recommendationSessionId is invalid",
      details: { field: "recommendationSessionId" }
    };
  }
  if (recommendationSessionId !== undefined && view !== "recommended") {
    return {
      ok: false,
      message: "recommendationSessionId requires the recommended view",
      details: { field: "recommendationSessionId" }
    };
  }
  if (cursor?.type === "recommended_session" && view !== "recommended") {
    return {
      ok: false,
      message: "recommended session cursor requires the recommended view",
      details: { field: "cursor" }
    };
  }
  if (
    cursor?.type === "recommended_session" &&
    recommendationSessionId !== undefined &&
    cursor.sessionId !== recommendationSessionId
  ) {
    return {
      ok: false,
      message: "recommendation session cursor does not match recommendationSessionId",
      details: { fields: ["cursor", "recommendationSessionId"] }
    };
  }

  const sort = parseArticleSort(query.sort);
  if (sort === null) {
    return {
      ok: false,
      message:
        "sort must be favorited_desc, favorited_asc, ranked, read_later_desc, read_later_asc, published_desc, or published_asc",
      details: {
        field: "sort",
        allowed: [
          "favorited_desc",
          "favorited_asc",
          "ranked",
          "read_later_desc",
          "read_later_asc",
          "published_desc",
          "published_asc"
        ]
      }
    };
  }
  if (sort !== undefined && view === "favorites" && !isFavoriteArticleSort(sort)) {
    return {
      ok: false,
      message: "sort must be favorited_desc, favorited_asc, published_desc, or published_asc",
      details: {
        field: "sort",
        allowed: ["favorited_desc", "favorited_asc", "published_desc", "published_asc"]
      }
    };
  }
  if (sort !== undefined && view === "read_later" && !isReadLaterArticleSort(sort)) {
    return {
      ok: false,
      message:
        "sort must be ranked, read_later_desc, read_later_asc, published_desc, or published_asc",
      details: {
        field: "sort",
        allowed: ["ranked", "read_later_desc", "read_later_asc", "published_desc", "published_asc"]
      }
    };
  }

  const input: ArticleListInput = {
    view: view ?? "latest",
    limit,
    offset: cursor?.type === "offset" ? cursor.offset : undefined
  };
  if (cursor && cursor.type !== "offset") {
    input.cursor = cursor;
  }
  if (recommendationSessionId !== undefined) {
    input.recommendationSessionId = recommendationSessionId;
  }

  if (query.feedId !== undefined) {
    input.feedId = query.feedId;
  }
  if (query.folderId !== undefined) {
    input.folderId = query.folderId;
  }
  if (status !== undefined) {
    input.status = status;
  }
  if (unreadOnly !== undefined) {
    input.unreadOnly = unreadOnly;
  }
  if (includeUnreadCount !== undefined) {
    input.includeUnreadCount = includeUnreadCount;
  }
  if (timeWindow !== undefined) {
    const range = rollingTimeRange(now?.() ?? Date.now(), timeWindow);
    input.todayStartAt = range.startAt;
    input.todayEndAt = range.endAt;
  }
  if (sort !== undefined) {
    input.sort = sort;
  }

  return { ok: true, input };
}

function parseRecommendationInventoryQuery(
  query: RecommendationInventoryQuery,
  now: (() => number) | undefined
):
  | {
      ok: true;
      input: ArticleListInput;
      loadedCount: number;
      recommendationSessionPosition: number;
    }
  | { ok: false; message: string; details?: unknown } {
  if (query.view !== undefined && query.view !== "recommended") {
    return {
      ok: false,
      message: "view must be recommended",
      details: { field: "view" }
    };
  }

  const loadedCount = parseLoadedCount(query.loadedCount);
  if (loadedCount === null) {
    return {
      ok: false,
      message: "loadedCount must be a non-negative integer",
      details: { field: "loadedCount" }
    };
  }
  const recommendationSessionPosition = parseRecommendationSessionPosition(
    query.recommendationSessionPosition
  );
  if (recommendationSessionPosition === null) {
    return {
      ok: false,
      message: "recommendationSessionPosition must be a non-negative integer",
      details: { field: "recommendationSessionPosition" }
    };
  }

  const parsed = parseArticleQuery(
    {
      ...query,
      view: "recommended",
      cursor: undefined,
      includeUnreadCount: "false",
      limit: undefined
    },
    now
  );
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    input: {
      ...parsed.input,
      view: "recommended",
      includeUnreadCount: false,
      cursor: undefined,
      offset: undefined,
      limit: undefined
    },
    loadedCount,
    recommendationSessionPosition
  };
}

function recommendationSessionScopeKey(query: ArticleQuery): string {
  return JSON.stringify({
    feedId: query.feedId?.trim() || null,
    folderId: query.folderId?.trim() || null,
    status: query.status ?? null,
    unreadOnly: query.unreadOnly === "true",
    timeWindow:
      query.timeWindow ?? (query.todayOnly === "true" ? "24h" : "all")
  });
}

function parseLoadedCount(value: string | undefined): number | null {
  if (value === undefined) {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
    return null;
  }

  return parsed;
}

function parseRecommendationSessionPosition(value: string | undefined): number | null {
  if (value === undefined) {
    return -1;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : null;
}

function parseRecommendationSessionId(value: string | undefined): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return /^rec_session_[a-f0-9]{20}$/.test(normalized) ? normalized : null;
}

function mapRecommendationInventory(
  inventory: RecommendedArticleInventory,
  loadedCount: number,
  rankingJob: { queued: number; running: number },
  now: number,
  sessionInventory: RecommendedArticleSessionInventory | null,
  recommendationSessionPosition: number
): RecommendationInventoryResponse {
  const normalizedLoadedCount = Math.max(0, Math.trunc(loadedCount));
  const fallbackCount = inventory.baseFallbackCount + inventory.unrankedFallbackCount;
  const sortedCount = sessionInventory?.eligibleCount ?? inventory.latestActiveCount;
  const remainingSortedCount = sessionInventory?.remainingCount ??
    Math.max(0, inventory.latestActiveCount - normalizedLoadedCount);
  const hasRankingJob = rankingJob.queued + rankingJob.running > 0;
  const status: RecommendationInventoryState = hasRankingJob
    ? "ranking"
    : remainingSortedCount > 0
      ? "available"
      : "empty";

  return {
    status,
    activeRankContext: inventory.rankContext,
    latestRerankWindowId: inventory.latestRerankWindowId,
    eligibleCount: inventory.eligibleCount,
    sortedCount,
    remainingSortedCount,
    latestActiveCount: inventory.latestActiveCount,
    staleActiveCount: inventory.staleActiveCount,
    fallbackCount,
    baseFallbackCount: inventory.baseFallbackCount,
    unrankedFallbackCount: inventory.unrankedFallbackCount,
    loadedCount: normalizedLoadedCount,
    recommendationSessionId: sessionInventory?.session.id ?? null,
    recommendationSessionPosition:
      sessionInventory ? recommendationSessionPosition : null,
    recommendationSessionExpiresAt: sessionInventory
      ? timestampToIsoValue(sessionInventory.session.expiresAt)
      : null,
    rankingJob,
    lastRankedAt: timestampToIso(inventory.lastRankedAt),
    updatedAt: timestampToIsoValue(now)
  };
}

function parseSearchQuery(query: SearchQuery):
  | { ok: true; input: ArticleSearchInput }
  | { ok: false; message: string; details?: unknown } {
  const rawQuery = query.q?.trim() ?? "";
  if (!rawQuery) {
    return {
      ok: false,
      message: "q is required",
      details: { field: "q" }
    };
  }
  if (rawQuery.length > 256) {
    return {
      ok: false,
      message: "q must be 256 characters or fewer",
      details: { field: "q", maxLength: 256 }
    };
  }

  const scope = parseSearchScope(query.scope);
  if (scope === null) {
    return {
      ok: false,
      message: "scope must be default or full_text",
      details: { field: "scope" }
    };
  }

  const state = parseSearchState(query.state);
  if (state === null) {
    return {
      ok: false,
      message: "state must be all, unread, read, favorites, or read_later",
      details: { field: "state" }
    };
  }

  const sort = parseSearchSort(query.sort);
  if (sort === null) {
    return {
      ok: false,
      message: "sort must be relevance, recommended, or latest",
      details: { field: "sort" }
    };
  }

  const from = parseSearchTimestamp(query.from);
  if (from === null) {
    return {
      ok: false,
      message: "from must be an ISO 8601 date or YYYY-MM-DD",
      details: { field: "from" }
    };
  }

  const to = parseSearchTimestamp(query.to);
  if (to === null) {
    return {
      ok: false,
      message: "to must be an ISO 8601 date or YYYY-MM-DD",
      details: { field: "to" }
    };
  }

  if (typeof from === "number" && typeof to === "number" && from > to) {
    return {
      ok: false,
      message: "from must be before to",
      details: { field: "from" }
    };
  }

  const limit = parseLimit(query.limit);
  if (limit === null) {
    return {
      ok: false,
      message: "limit must be a positive integer",
      details: { field: "limit" }
    };
  }

  const offset = decodeOffsetCursor(query.cursor);
  if (offset === null) {
    return {
      ok: false,
      message: "cursor is invalid",
      details: { field: "cursor" }
    };
  }

  const includeUnreadCount = parseBooleanParam(query.includeUnreadCount);
  if (includeUnreadCount === null) {
    return {
      ok: false,
      message: "includeUnreadCount must be true or false",
      details: { field: "includeUnreadCount" }
    };
  }

  return {
    ok: true,
    input: {
      query: rawQuery,
      scope: scope ?? "default",
      state: state ?? "all",
      sort: sort ?? "relevance",
      limit,
      offset,
      ...(includeUnreadCount !== undefined ? { includeUnreadCount } : {}),
      ...(query.feedId !== undefined ? { feedId: query.feedId } : {}),
      ...(query.folderId !== undefined ? { folderId: query.folderId } : {}),
      ...(typeof from === "number" ? { from } : {}),
      ...(typeof to === "number" ? { to } : {})
    }
  };
}

function parseReaderCommandMarkScopeReadBody(body: ReaderCommandBody | undefined):
  | { ok: true; scope: ArticleScope }
  | { ok: false; message: string; details?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be an object" };
  }

  const rawScope = body.scope;
  if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    return {
      ok: false,
      message: "scope is required",
      details: { field: "scope" }
    };
  }

  const scope = rawScope as Record<string, unknown>;
  if (scope.type === "article_list") {
    return parseReaderCommandArticleListScope(scope);
  }
  if (scope.type === "search") {
    return parseReaderCommandSearchScope(scope);
  }

  return {
    ok: false,
    message: "scope.type must be article_list or search",
    details: { field: "scope.type" }
  };
}

function parseReaderCommandArticleListScope(
  scope: Record<string, unknown>
): { ok: true; scope: ArticleScope } | { ok: false; message: string; details?: unknown } {
  const view = scope.view;
  if (view !== "latest" && view !== "recommended") {
    return {
      ok: false,
      message: "view must be latest or recommended",
      details: { field: "scope.view" }
    };
  }

  const source = parseReaderCommandSource(scope);
  if (!source.ok) {
    return source;
  }

  const clearWindow = parseArticleTimeWindowValue(scope.clearWindow);
  if (clearWindow === null) {
    return {
      ok: false,
      message: "clearWindow must be all, 24h, 7d, or 30d",
      details: { field: "scope.clearWindow" }
    };
  }
  const legacyTimeWindow = parseArticleTimeWindowValue(scope.timeWindow);
  if (legacyTimeWindow === null) {
    return {
      ok: false,
      message: "timeWindow must be all, 24h, 7d, or 30d",
      details: { field: "scope.timeWindow" }
    };
  }
  if (clearWindow !== undefined && legacyTimeWindow !== undefined && clearWindow !== legacyTimeWindow) {
    return {
      ok: false,
      message: "clearWindow and timeWindow cannot conflict",
      details: { fields: ["scope.clearWindow", "scope.timeWindow"] }
    };
  }

  return {
    ok: true,
    scope: {
      type: "article_list",
      view,
      clearWindow: clearWindow ?? legacyTimeWindow ?? "all",
      ...source.source
    }
  };
}

function parseReaderCommandSearchScope(
  scope: Record<string, unknown>
): { ok: true; scope: ArticleScope } | { ok: false; message: string; details?: unknown } {
  const queryValue = scope.q ?? scope.query;
  if (typeof queryValue !== "string" || queryValue.trim() === "") {
    return {
      ok: false,
      message: "q is required",
      details: { field: "scope.q" }
    };
  }

  const query = queryValue.trim();
  if (query.length > 256) {
    return {
      ok: false,
      message: "q must be 256 characters or fewer",
      details: { field: "scope.q", maxLength: 256 }
    };
  }

  const source = parseReaderCommandSource(scope);
  if (!source.ok) {
    return source;
  }

  const state = parseSearchStateValue(scope.state);
  if (state === null) {
    return {
      ok: false,
      message: "state must be all, unread, read, favorites, or read_later",
      details: { field: "scope.state" }
    };
  }

  const from = parseSearchTimestampValue(scope.from);
  if (from === null) {
    return {
      ok: false,
      message: "from must be an ISO 8601 date or YYYY-MM-DD",
      details: { field: "scope.from" }
    };
  }

  const to = parseSearchTimestampValue(scope.to);
  if (to === null) {
    return {
      ok: false,
      message: "to must be an ISO 8601 date or YYYY-MM-DD",
      details: { field: "scope.to" }
    };
  }

  if (typeof from === "number" && typeof to === "number" && from > to) {
    return {
      ok: false,
      message: "from must be before to",
      details: { field: "scope.from" }
    };
  }

  return {
    ok: true,
    scope: {
      type: "search",
      query,
      state: state ?? "all",
      ...(typeof from === "number" ? { from } : {}),
      ...(typeof to === "number" ? { to } : {}),
      ...source.source
    }
  };
}

function parseReaderCommandSource(
  scope: Record<string, unknown>
):
  | { ok: true; source: { feedId?: string; folderId?: string } }
  | { ok: false; message: string; details?: unknown } {
  const feedId = parseOptionalScopeString(scope.feedId);
  if (feedId === null) {
    return {
      ok: false,
      message: "feedId must be a string",
      details: { field: "scope.feedId" }
    };
  }

  const folderId = parseOptionalScopeString(scope.folderId);
  if (folderId === null) {
    return {
      ok: false,
      message: "folderId must be a string",
      details: { field: "scope.folderId" }
    };
  }

  if (feedId && folderId) {
    return {
      ok: false,
      message: "feedId and folderId cannot be used together",
      details: { fields: ["scope.feedId", "scope.folderId"] }
    };
  }

  return {
    ok: true,
    source: {
      ...(feedId ? { feedId } : {}),
      ...(folderId ? { folderId } : {})
    }
  };
}

function parseOptionalScopeString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseArticleTimeWindowValue(
  value: unknown
): "all" | "24h" | "7d" | "30d" | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "all" || value === "24h" || value === "7d" || value === "30d") {
    return value;
  }

  return null;
}

function parseSearchStateValue(value: unknown): ArticleSearchState | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (
    value === "all" ||
    value === "unread" ||
    value === "read" ||
    value === "favorites" ||
    value === "read_later"
  ) {
    return value;
  }

  return null;
}

function parseSearchTimestampValue(value: unknown): number | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return value === "" ? undefined : null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseArticleTimeWindow(
  value: string | undefined,
  todayOnly: boolean | undefined
): "24h" | "7d" | "30d" | undefined | null {
  if (value === undefined) {
    return todayOnly ? "24h" : undefined;
  }
  if (value === "" || value === "all") {
    return undefined;
  }
  if (value === "24h" || value === "7d" || value === "30d") {
    return value;
  }
  return null;
}

function rollingTimeRange(
  timestamp: number,
  window: "24h" | "7d" | "30d"
): { startAt: number; endAt: number } {
  const durationMs =
    window === "24h"
      ? 24 * 60 * 60 * 1000
      : window === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return {
    startAt: timestamp - durationMs,
    endAt: timestamp
  };
}

function parseCreateFeedBody(body: CreateFeedBody | undefined):
  | { ok: true; input: { feedUrl: string; folderId?: string | null } }
  | { ok: false; message: string } {
  if (!body || typeof body.feedUrl !== "string" || body.feedUrl.trim() === "") {
    return { ok: false, message: "feedUrl is required" };
  }

  let folderId: string | null | undefined;
  if (body.folderId !== undefined) {
    if (body.folderId === null) {
      folderId = null;
    } else if (typeof body.folderId === "string" && body.folderId.trim() !== "") {
      folderId = body.folderId.trim();
    } else {
      return { ok: false, message: "folderId must be a string or null" };
    }
  }

  return {
    ok: true,
    input: {
      feedUrl: body.feedUrl,
      ...(folderId !== undefined ? { folderId } : {})
    }
  };
}

function parseDiscoverFeedBody(body: DiscoverFeedBody | undefined):
  | { ok: true; input: { url: string } }
  | { ok: false; message: string; details?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be an object" };
  }

  if (typeof body.url !== "string" || body.url.trim() === "") {
    return {
      ok: false,
      message: "url is required",
      details: {
        field: "url"
      }
    };
  }

  return {
    ok: true,
    input: {
      url: body.url.trim()
    }
  };
}

function parseAuthCredentialBody(body: AuthCredentialBody | undefined):
  | { ok: true; username: string; password: string; telemetryEnabled?: boolean }
  | { ok: false; message: string; details?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be an object" };
  }

  if (typeof body.username !== "string" || body.username.trim().length === 0) {
    return {
      ok: false,
      message: "username is required",
      details: { field: "username" }
    };
  }

  if (typeof body.password !== "string" || body.password.length === 0) {
    return {
      ok: false,
      message: "password is required",
      details: { field: "password" }
    };
  }

  if (
    Object.hasOwn(body, "telemetryEnabled") &&
    typeof body.telemetryEnabled !== "boolean"
  ) {
    return {
      ok: false,
      message: "telemetryEnabled must be a boolean",
      details: { field: "telemetryEnabled" }
    };
  }

  const telemetryEnabled =
    typeof body.telemetryEnabled === "boolean" ? body.telemetryEnabled : undefined;

  return {
    ok: true,
    username: body.username,
    password: body.password,
    telemetryEnabled
  };
}

function parseChangePasswordBody(body: ChangePasswordBody | undefined):
  | { ok: true; currentPassword: string; newPassword: string }
  | { ok: false; message: string; details?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be an object" };
  }

  if (typeof body.currentPassword !== "string" || body.currentPassword.length === 0) {
    return {
      ok: false,
      message: "currentPassword is required",
      details: { field: "currentPassword" }
    };
  }

  if (typeof body.newPassword !== "string" || body.newPassword.length === 0) {
    return {
      ok: false,
      message: "newPassword is required",
      details: { field: "newPassword" }
    };
  }

  return {
    ok: true,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword
  };
}

function parseOpmlImportBody(
  body: unknown,
  contentTypeHeader: string | string[] | undefined
): { ok: true; xml: string } | { ok: false; message: string; details?: unknown } {
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0]
    : contentTypeHeader;

  if (typeof body === "string") {
    return body.trim()
      ? { ok: true, xml: body }
      : { ok: false, message: "OPML body is required" };
  }

  if (Buffer.isBuffer(body)) {
    const xml = contentType?.toLowerCase().startsWith("multipart/form-data")
      ? extractMultipartFile(body, contentType)
      : body.toString("utf8");

    if (!xml) {
      return {
        ok: false,
        message: "OPML file is required",
        details: { field: "file" }
      };
    }

    return { ok: true, xml };
  }

  return {
    ok: false,
    message: "OPML import requires multipart/form-data or application/xml"
  };
}

function parsePluginInstallBody(
  body: PluginInstallBody | undefined
):
  | { ok: true; url: string; sha256: string | null; packageContent?: undefined }
  | { ok: true; packageContent: string; sha256: string | null; url?: undefined }
  | { ok: false; message: string; details?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Plugin install body must be an object" };
  }
  const sha256 = typeof body.sha256 === "string" && body.sha256.trim() ? body.sha256.trim() : null;
  if (typeof body.package === "string" && body.package.trim()) {
    return { ok: true, packageContent: body.package, sha256 };
  }
  if (typeof body.url === "string" && body.url.trim()) {
    return { ok: true, url: body.url.trim(), sha256 };
  }
  return {
    ok: false,
    message: "Plugin install requires url or package",
    details: { fields: ["url", "package"] }
  };
}

function parsePluginUploadBody(
  body: unknown,
  contentTypeHeader: string | string[] | undefined
): { ok: true; packageContent: string } | { ok: false; message: string; details?: unknown } {
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0]
    : contentTypeHeader;

  if (typeof body === "string") {
    return body.trim()
      ? { ok: true, packageContent: body }
      : { ok: false, message: "Plugin package body is required" };
  }

  if (Buffer.isBuffer(body)) {
    const packageContent = contentType?.toLowerCase().startsWith("multipart/form-data")
      ? extractMultipartFile(body, contentType)
      : body.toString("utf8");

    if (!packageContent) {
      return {
        ok: false,
        message: "Plugin package file is required",
        details: { field: "file" }
      };
    }

    return { ok: true, packageContent };
  }

  return {
    ok: false,
    message: "Plugin upload requires multipart/form-data or application/octet-stream"
  };
}

function extractMultipartFile(body: Buffer, contentType: string | undefined): string | null {
  const boundaryMatch = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    return null;
  }

  const raw = body.toString("utf8");
  for (const part of raw.split(`--${boundary}`)) {
    if (!/content-disposition:/i.test(part)) {
      continue;
    }

    const separator = part.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
    const separatorIndex = part.indexOf(separator);
    if (separatorIndex < 0) {
      continue;
    }

    const headers = part.slice(0, separatorIndex);
    if (!/name="file"/i.test(headers) && !/filename=/i.test(headers)) {
      continue;
    }

    const content = part.slice(separatorIndex + separator.length).replace(/^\r?\n/, "");
    const trimmed = content.replace(/\r?\n$/, "").trim();
    return trimmed || null;
  }

  return null;
}

function parseArticleActionBody(body: ArticleActionBody | undefined):
  | {
      ok: true;
      input: {
        type: ArticleActionType;
        progress?: number;
        metadata?: Record<string, unknown>;
        eventId?: string;
      };
    }
  | { ok: false; message: string; details?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be an object" };
  }

  const type = normalizeArticleActionType(body.type, body.value);
  if (!type) {
    return {
      ok: false,
      message:
        "type must be impression, open, mark_read, mark_unread, favorite, unfavorite, like, unlike, read_later, remove_read_later, hide, not_interested, or read_progress"
    };
  }

  const metadata = parseMetadata(body.metadata);
  if (metadata === null) {
    return { ok: false, message: "metadata must be an object" };
  }

  const eventId = parseOptionalClientActionId(body.clientActionId);
  if (eventId === null) {
    return {
      ok: false,
      message: "clientActionId must be a UUID-like string between 8 and 128 characters",
      details: { fields: ["clientActionId"], minLength: 8, maxLength: 128 }
    };
  }

  if (type === "read_progress") {
    const progress = parseProgress(body.progress ?? body.value);
    if (progress === null) {
      return {
        ok: false,
        message: "progress or value must be a number between 0 and 1",
        details: { fields: ["progress", "value"], min: 0, max: 1 }
      };
    }

    return {
      ok: true,
      input: {
        type,
        progress,
        ...(eventId !== undefined ? { eventId } : {}),
        ...(metadata !== undefined ? { metadata } : {})
      }
    };
  }

  return {
    ok: true,
    input: {
      type,
      ...(eventId !== undefined ? { eventId } : {}),
      ...(metadata !== undefined ? { metadata } : {})
    }
  };
}

function parseOptionalClientActionId(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length >= 8 &&
    normalized.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : null;
}

function parseIntegerInRange(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number | null {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseOfflineArticleIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const articleIds = value.flatMap((item) =>
    typeof item === "string" && item.trim().length > 0 ? [item.trim()] : []
  );
  const uniqueIds = Array.from(new Set(articleIds));
  if (
    uniqueIds.length !== value.length ||
    uniqueIds.length < 1 ||
    uniqueIds.length > OFFLINE_ARTICLE_BATCH_LIMIT
  ) {
    return null;
  }
  return uniqueIds;
}

function parseBulkArticleActionBody(body: BulkArticleActionBody | undefined):
  | {
      ok: true;
      actions: Array<{
        articleId: string;
        input: {
          type: "impression";
          metadata?: Record<string, unknown>;
        };
      }>;
    }
  | { ok: false; message: string; details?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be an object" };
  }
  if (!Array.isArray(body.actions)) {
    return { ok: false, message: "actions must be an array" };
  }
  if (body.actions.length === 0 || body.actions.length > 50) {
    return {
      ok: false,
      message: "actions must contain between 1 and 50 items",
      details: { fields: ["actions"], min: 1, max: 50 }
    };
  }

  const actions: Array<{
    articleId: string;
    input: {
      type: "impression";
      metadata?: Record<string, unknown>;
    };
  }> = [];
  for (const [index, rawAction] of body.actions.entries()) {
    if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
      return {
        ok: false,
        message: "action must be an object",
        details: { index }
      };
    }
    const articleId = typeof (rawAction as { articleId?: unknown }).articleId === "string"
      ? (rawAction as { articleId: string }).articleId.trim()
      : "";
    if (!articleId) {
      return {
        ok: false,
        message: "articleId is required",
        details: { index, fields: ["articleId"] }
      };
    }
    const parsed = parseArticleActionBody(rawAction as ArticleActionBody);
    if (!parsed.ok) {
      return {
        ...parsed,
        details: { index, ...(typeof parsed.details === "object" && parsed.details !== null ? parsed.details : {}) }
      };
    }
    if (parsed.input.type !== "impression") {
      return {
        ok: false,
        message: "bulk article actions only support impression",
        details: { index, fields: ["type"] }
      };
    }
    actions.push({
      articleId,
      input: {
        type: "impression",
        ...(parsed.input.metadata !== undefined ? { metadata: parsed.input.metadata } : {})
      }
    });
  }

  return { ok: true, actions };
}

function parseArticleView(value: string | undefined): ArticleListView | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "recommended" ||
    value === "latest" ||
    value === "favorites" ||
    value === "read_later"
  ) {
    return value;
  }

  return null;
}

function parseArticleSort(value: string | undefined): ArticleListInput["sort"] | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "favorited_desc" ||
    value === "favorited_asc" ||
    value === "ranked" ||
    value === "read_later_desc" ||
    value === "read_later_asc" ||
    value === "published_desc" ||
    value === "published_asc"
  ) {
    return value;
  }

  return null;
}

function isFavoriteArticleSort(value: ArticleListInput["sort"]): boolean {
  return (
    value === "favorited_desc" ||
    value === "favorited_asc" ||
    value === "published_desc" ||
    value === "published_asc"
  );
}

function isReadLaterArticleSort(value: ArticleListInput["sort"]): boolean {
  return (
    value === "ranked" ||
    value === "read_later_desc" ||
    value === "read_later_asc" ||
    value === "published_desc" ||
    value === "published_asc"
  );
}

function parseSearchState(value: string | undefined): ArticleSearchState | undefined | null {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (
    value === "all" ||
    value === "unread" ||
    value === "read" ||
    value === "favorites" ||
    value === "read_later"
  ) {
    return value;
  }

  return null;
}

function parseSearchSort(value: string | undefined): ArticleSearchSort | undefined | null {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (value === "relevance" || value === "recommended" || value === "latest") {
    return value;
  }

  return null;
}

function parseSearchScope(value: string | undefined): ArticleSearchInput["scope"] | undefined | null {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (value === "default" || value === "full_text") {
    return value;
  }

  return null;
}

function parseSearchTimestamp(value: string | undefined): number | undefined | null {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseJobStatus(value: string | undefined): JobStatus | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }

  return null;
}

function parseJobType(value: string | undefined): JobType | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "feed_refresh" ||
    value === "content_extract" ||
    value === "embedding_generate" ||
    value === "profile_event_process" ||
    value === "ranking_recalculate" ||
    value === "profile_decay" ||
    value === "retention_cleanup" ||
    value === "vector_index_rebuild" ||
    value === ARTICLE_FINGERPRINT_BACKFILL_JOB_TYPE ||
    value === DUPLICATE_GROUP_REBUILD_JOB_TYPE ||
    value === KEYWORD_PROFILE_REBUILD_JOB_TYPE ||
    value === RECENT_INTENT_REBUILD_JOB_TYPE ||
    value === RANKING_EVAL_RUN_JOB_TYPE ||
    value === FTRL_TRAIN_JOB_TYPE ||
    value === RECOMMENDATION_BACKFILL_JOB_TYPE ||
    value === INTEREST_CLUSTER_LABEL_REBUILD_JOB_TYPE ||
    value === INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE ||
    value === INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE ||
    value === INTEREST_FAMILY_REBUILD_JOB_TYPE
  ) {
    return value as JobType;
  }

  if (value.startsWith("plugin:")) {
    return value as PluginJobType;
  }

  return null;
}

function isArticleActionType(value: unknown): value is ArticleActionType {
  return (
    typeof value === "string" &&
    Object.hasOwn(ARTICLE_ACTION_EVENT_WEIGHTS, value)
  );
}

function normalizeArticleActionType(type: unknown, value: unknown): ArticleActionType | null {
  if (!isArticleActionType(type)) {
    return null;
  }

  if (value === false) {
    if (type === "favorite") {
      return "unfavorite";
    }
    if (type === "like") {
      return "unlike";
    }
    if (type === "read_later") {
      return "remove_read_later";
    }
    if (type === "mark_read") {
      return "mark_unread";
    }
  }

  return type;
}

function parseProgress(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }

  return value;
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseArticleStatus(value: string | undefined): ArticleReadStatus | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (value === "unread" || value === "read" || value === "all") {
    return value;
  }

  return null;
}

function parseBooleanParam(value: string | undefined): boolean | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

function parseClusterDetailLevel(value: string | undefined): RecommendationClusterDetailLevel | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (value === "summary" || value === "diagnostic") {
    return value;
  }
  return null;
}

function roundDuration(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function parseLimit(value: string | undefined): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return Math.min(parsed, 100);
}

function parseReaderDiscoveryLimit(value: string | undefined): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    return null;
  }

  return parsed;
}

function parseRelatedSearchLimit(value: string | undefined): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    return null;
  }

  return parsed;
}

function encodeCursor(cursor: number | ArticleListCursor | null): string | null {
  if (cursor === null) {
    return null;
  }

  const payload: EncodedCursorPayload =
    typeof cursor === "number" ? { offset: cursor } : { keyset: cursor };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeOffsetCursor(cursor: string | undefined): number | undefined | null {
  if (cursor === undefined) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<
      CursorPayload
    >;

    const offset = payload.offset;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      return null;
    }

    return offset;
  } catch {
    return null;
  }
}

function decodeArticleListCursor(cursor: string | undefined): ArticleListCursor | undefined | null {
  if (cursor === undefined) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<
      EncodedCursorPayload
    >;
    if ("offset" in payload) {
      const offset = payload.offset;
      return typeof offset === "number" && Number.isInteger(offset) && offset >= 0
        ? { type: "offset", offset }
        : null;
    }
    if ("keyset" in payload && isArticleListCursor(payload.keyset)) {
      return payload.keyset;
    }
    return null;
  } catch {
    return null;
  }
}

function isArticleListCursor(value: unknown): value is ArticleListCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Partial<ArticleListCursor>;
  if (cursor.type === "recommended_session") {
    return (
      typeof cursor.sessionId === "string" &&
      /^rec_session_[a-f0-9]{20}$/.test(cursor.sessionId) &&
      typeof cursor.position === "number" &&
      Number.isInteger(cursor.position) &&
      cursor.position >= 0
    );
  }
  if (cursor.type === "recommended") {
    return (
      typeof cursor.publishedAt === "number" &&
      typeof cursor.id === "string" &&
      (cursor.rankMissing === undefined || typeof cursor.rankMissing === "number") &&
      (cursor.rerankMissing === undefined || typeof cursor.rerankMissing === "number") &&
      (cursor.rerankPosition === undefined ||
        cursor.rerankPosition === null ||
        typeof cursor.rerankPosition === "number") &&
      (cursor.score === undefined || cursor.score === null || typeof cursor.score === "number")
    );
  }
  if (cursor.type === "latest") {
    return typeof cursor.publishedAt === "number" && typeof cursor.id === "string";
  }
  if (cursor.type === "favorites") {
    return (
      isFavoriteArticleSort(cursor.sort) &&
      typeof cursor.favoritedAt === "number" &&
      typeof cursor.publishedAt === "number" &&
      typeof cursor.id === "string"
    );
  }
  if (cursor.type === "read_later") {
    return (
      isReadLaterArticleSort(cursor.sort) &&
      typeof cursor.readLaterAt === "number" &&
      typeof cursor.publishedAt === "number" &&
      typeof cursor.id === "string" &&
      (cursor.rerankMissing === undefined || typeof cursor.rerankMissing === "number") &&
      (cursor.rerankPosition === undefined ||
        cursor.rerankPosition === null ||
        typeof cursor.rerankPosition === "number") &&
      (cursor.score === undefined || cursor.score === null || typeof cursor.score === "number")
    );
  }
  return false;
}

function mapFeedFolder(folder: FeedFolderRow) {
  return {
    id: folder.id,
    title: folder.title,
    sortOrder: folder.sortOrder
  };
}

function mapFeed(feed: FeedRow) {
  return {
    ...feed,
    lastFetchedAt: timestampToIso(feed.lastFetchedAt),
    lastSuccessAt: timestampToIso(feed.lastSuccessAt),
    nextRefreshAt: timestampToIso(feed.nextRefreshAt),
    createdAt: timestampToIsoValue(feed.createdAt),
    updatedAt: timestampToIsoValue(feed.updatedAt)
  };
}

function mapFullContentPreview(result: FullContentPreviewResponse) {
  return result;
}

function mapFullContentBackfill(result: FullContentBackfillResult) {
  return result;
}

function mapFeedDiscoveryResult(result: FeedDiscoveryResult) {
  return {
    ...result,
    candidates: result.candidates.map(mapFeedDiscoveryCandidate)
  };
}

function mapFeedDiscoveryCandidate(candidate: FeedDiscoveryCandidate) {
  return {
    ...candidate,
    recentItems: candidate.recentItems.map((item) => ({
      ...item,
      publishedAt: timestampToIso(item.publishedAt)
    }))
  };
}

function mapFeedDiagnosticsResult(result: FeedDiagnosticsResult) {
  return {
    summary: result.summary,
    items: result.items.map((item) => ({
      feed: item.feed,
      diagnostic: mapFeedHealthDiagnostic(item.diagnostic)
    }))
  };
}

function mapFeedHealthDiagnostic(diagnostic: FeedHealthDiagnostic) {
  return {
    ...diagnostic,
    lastFetchedAt: timestampToIso(diagnostic.lastFetchedAt),
    lastSuccessAt: timestampToIso(diagnostic.lastSuccessAt),
    nextRefreshAt: timestampToIso(diagnostic.nextRefreshAt)
  };
}

function mapJob(job: JobRow) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    error: job.error,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAfter: timestampToIsoValue(job.runAfter),
    startedAt: timestampToIso(job.startedAt),
    finishedAt: timestampToIso(job.finishedAt),
    createdAt: timestampToIsoValue(job.createdAt),
    updatedAt: timestampToIsoValue(job.updatedAt),
    payloadSummary: summarizeJobPayload(job)
  };
}

function summarizeJobPayload(job: JobRow): { embeddingIndexId: string; articleCount: number } | null {
  if (job.type !== EMBEDDING_GENERATE_JOB_TYPE) {
    return null;
  }

  const payload = parseEmbeddingGeneratePayload(job.payloadJson);
  if (!payload) {
    return null;
  }

  return {
    embeddingIndexId: payload.embeddingIndexId,
    articleCount: payload.articleIds.length
  };
}

function mapArticleListItem(article: ArticleListItemRow) {
  return {
    id: article.id,
    feedId: article.feedId,
    feedTitle: article.feedTitle,
    title: article.title,
    url: article.url,
    author: article.author,
    summary: articleListSummaryPreview(article.summary),
    publishedAt: timestampToIso(article.publishedAt),
    discoveredAt: timestampToIsoValue(article.discoveredAt),
    state: article.state,
    ...(article.rank
      ? {
          rank: {
            score: article.rank.score,
            calculatedAt: timestampToIsoValue(article.rank.calculatedAt)
          }
        }
      : {})
  };
}

function mapArticleDetail(article: ArticleDetailRow) {
  const hasBody = Boolean(article.contentHtml || article.contentText);

  return {
    ...mapArticleListItem(article),
    contentHtml: article.contentHtml,
    contentText: article.contentText,
    summary: hasBody ? articleListSummaryPreview(article.summary) : article.summary,
    extractionStatus: article.extractionStatus,
    extractionError: article.extractionError
  };
}

function mapOfflineManifestArticle(article: OfflineManifestArticle) {
  return {
    article: mapArticleListItem(article.article),
    contentRevision: article.contentRevision,
    position: article.position,
    favoritedAt: timestampToIso(article.favoritedAt),
    readLaterAt: timestampToIso(article.readLaterAt),
    openedAt: timestampToIso(article.openedAt)
  };
}

function mapReaderDiscoveryResponse(response: ReaderDiscoveryResponse) {
  return {
    status: response.status,
    items: response.items.map(mapArticleListItem),
    ...(response.status === "unavailable" ? { reason: response.reason } : {})
  };
}

function mapRelatedSearchResponse(response: RelatedSearchResponse) {
  return {
    status: response.status,
    sourceArticle: mapArticleListItem(response.sourceArticle),
    items: response.items.map(mapArticleListItem),
    threshold: response.threshold,
    totalCount: response.totalCount,
    ...(response.status === "unavailable" ? { reason: response.reason } : {})
  };
}

function articleListSummaryPreview(summary: string | null): string | null {
  if (!summary) {
    return null;
  }

  const text = summary
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return null;
  }

  return text.length > 360 ? `${text.slice(0, 360)}...` : text;
}

function jobRunnerEventLog(event: JobRunnerEvent) {
  return {
    event: event.event,
    jobId: event.job.id,
    type: event.job.type,
    status: event.job.status,
    attempts: event.job.attempts,
    maxAttempts: event.job.maxAttempts,
    ...("error" in event ? { error: event.error } : {}),
    ...("reason" in event ? { reason: event.reason } : {}),
    ...("runAfter" in event ? { runAfter: timestampToIsoValue(event.runAfter) } : {})
  };
}

function timestampToIso(value: number | null): string | null {
  return value === null ? null : timestampToIsoValue(value);
}

function timestampToIsoValue(value: number): string {
  return new Date(value).toISOString();
}

function parseFullContentPreviewBody(body: FullContentPreviewBody | undefined):
  | { ok: true; articleUrl?: string }
  | { ok: false; message: string; details?: unknown } {
  if (body === undefined || body === null) {
    return { ok: true };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be an object" };
  }
  if (body.articleUrl === undefined) {
    return { ok: true };
  }
  if (typeof body.articleUrl !== "string") {
    return {
      ok: false,
      message: "articleUrl must be a string",
      details: { field: "articleUrl" }
    };
  }
  const articleUrl = body.articleUrl.trim();
  return articleUrl ? { ok: true, articleUrl } : { ok: true };
}

function chunkStrings(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function sendApiError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
) {
  const error: ApiError["error"] = { code, message };

  if (details !== undefined) {
    error.details = details;
  }

  return reply.status(statusCode).send({ error });
}

function sendDatabaseBusyError(reply: FastifyReply) {
  reply.header("Retry-After", "5");
  return sendApiError(
    reply,
    503,
    "DATABASE_BUSY",
    "Dibao is busy with background maintenance. Please try again shortly.",
    { retryAfterMs: 5_000 }
  );
}

function sendFeedIngestionError(reply: FastifyReply, error: unknown) {
  if (error instanceof FeedIngestionError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendFeedDiscoveryError(reply: FastifyReply, error: unknown) {
  if (error instanceof FeedDiscoveryError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthServiceError) {
    if (error.code === "DATABASE_BUSY") {
      reply.header("Retry-After", "5");
    }
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendArticleActionError(reply: FastifyReply, error: unknown) {
  if (error instanceof ArticleActionServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendReaderCommandError(reply: FastifyReply, error: unknown) {
  if (error instanceof ReaderCommandServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendFeedManagementError(reply: FastifyReply, error: unknown) {
  if (error instanceof FeedManagementServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendOpmlServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof OpmlServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendSettingsError(reply: FastifyReply, error: unknown) {
  if (error instanceof SettingsServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendRecommendationMaintenanceError(reply: FastifyReply, error: unknown) {
  if (error instanceof RecommendationMaintenanceServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendInterestClusterLabelError(reply: FastifyReply, error: unknown) {
  if (error instanceof InterestClusterLabelServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendInterestFamilyError(reply: FastifyReply, error: unknown) {
  if (error instanceof InterestFamilyServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendInterestClusterMergeError(reply: FastifyReply, error: unknown) {
  if (error instanceof InterestClusterMergeServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendEmbeddingProviderError(reply: FastifyReply, error: unknown) {
  if (error instanceof EmbeddingProviderServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}

function sendPluginError(reply: FastifyReply, error: unknown) {
  if (error instanceof PluginServiceError) {
    return sendApiError(reply, error.statusCode, error.code, error.message, error.details);
  }

  throw error;
}
