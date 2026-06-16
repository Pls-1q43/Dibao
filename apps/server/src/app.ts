import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
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
  SqliteProfileRepository,
  SqliteRankingRepository,
  SqliteReaderCommandEventRepository,
  SqliteSessionRepository,
  SqliteVecVectorStore,
  fromVectorBlob,
  type ArticleActionType,
  type ArticleDetailRow,
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
  type JobType,
  type ProfileSignalCountRow
} from "@dibao/db";
import { cosineSimilarity, profileAlgorithmDefaults } from "@dibao/ranking";
import { dibaoVersion, type ApiError } from "@dibao/shared";
import {
  ArticleActionService,
  ArticleActionServiceError
} from "./article-action-service.js";
import {
  readSessionCookie,
  serializeClearSessionCookie,
  serializeSessionCookie
} from "./auth-cookie.js";
import { AuthService, AuthServiceError } from "./auth-service.js";
import { ArticleRetentionService } from "./article-retention-service.js";
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
import { FullContentExtractionService } from "./full-content-extraction-service.js";
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
  INTEREST_FAMILY_REBUILD_JOB_TYPE,
  type RecommendationClusterFamily
} from "./interest-family-service.js";
import { JobRunner } from "./job-runner.js";
import { LatestReleaseService } from "./latest-release-service.js";
import { OpmlService, OpmlServiceError } from "./opml-service.js";
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
  RANKING_RECALCULATE_JOB_TYPE
} from "./ranking-job-service.js";
import {
  ReaderCommandService,
  ReaderCommandServiceError
} from "./reader-command-service.js";
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
  RecommendationRankingService,
  type RankExplanationClusterMatch
} from "./ranking-service.js";
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
  derivedDataUpgrade?: DerivedDataUpgradeStatus;
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
  todayOnly?: string;
  timeWindow?: string;
  limit?: string;
  cursor?: string;
  sort?: string;
};

type SearchQuery = {
  q?: string;
  feedId?: string;
  folderId?: string;
  from?: string;
  to?: string;
  state?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
};

type JobQuery = {
  status?: string;
  type?: string;
  limit?: string;
};

type ArticleParams = {
  id: string;
};

type ArticleActionBody = {
  type?: unknown;
  value?: unknown;
  progress?: unknown;
  metadata?: unknown;
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

type RecommendationClusterQuery = {
  limit?: string;
};

type RecommendationStatusQuery = {
  includeClusterItems?: string;
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

type RecommendationClusterLabelBody = {
  manualLabel?: unknown;
};

type CursorPayload = {
  offset: number;
};

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
  profileDecayIntervalMs?: number;
  recommendationMaintenanceIntervalMs?: number;
  jobRunnerIntervalMs?: number;
  jobRetryDelayMs?: number;
  embeddingFetcher?: typeof fetch;
  fullContentFetcher?: typeof fetch;
  latestReleaseFetcher?: typeof fetch;
  webDistDir?: string | false;
};

export function buildServer(options: BuildServerOptions = {}) {
  const db = options.db ?? openConfiguredDatabase(options);
  const closeDatabaseOnClose = options.closeDatabaseOnClose ?? !options.db;
  const settings = new SqliteAppSettingsRepository(db);
  const credentials = new SqliteAuthCredentialRepository(db);
  const sessions = new SqliteSessionRepository(db);
  const folders = new SqliteFeedFolderRepository(db);
  const feeds = new SqliteFeedRepository(db);
  const jobs = new SqliteJobRepository(db);
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
  const onFetchWarning = (warning: unknown) => {
    app.log.warn({ event: "outbound_fetch_private_target", warning });
  };
  const fullContentExtractor = new FullContentExtractionService({
    fetcher: options.fullContentFetcher,
    onFetchWarning
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
  attachServerTelemetryErrorHandler(app);
  const rankingService = new RecommendationRankingService({
    db,
    embeddings,
    profiles,
    rankings,
    getRankingSettings: () => settingsService.getSettings().ranking,
    now: options.now
  });
  const rankingJobService = new RankingRecalculateJobService({
    jobs,
    ranking: rankingService,
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
    onFetchWarning
  });
  const feedHealthService = new FeedHealthService({
    feeds,
    now: options.now
  });
  const feedRefreshCoordinator = new FeedRefreshCoordinator({
    refreshService: feedRefreshService,
    afterRefresh: (result) => {
      handleEffectiveContentChanged(result.effectiveContentChangedArticleIds);
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
    profileJobs: profileEventJobService,
    rankingJobs: rankingJobService,
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
    loginLockoutMs: options.authLoginLockoutMs
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
  const backgroundJobs = options.backgroundJobs ?? false;

  const jobRunner = new JobRunner({
    jobs,
    handlers: {
      feed_refresh: (job) => feedRefreshJobService.handleFeedRefreshJob(job),
      retention_cleanup: (job) => retentionCleanupJobService.handleRetentionCleanupJob(job),
      profile_decay: (job) => profileDecayJobService.handleProfileDecayJob(job),
      [PROFILE_EVENT_PROCESS_JOB_TYPE]: (job) =>
        profileEventJobService.handleProfileEventProcessJob(job),
      [RANKING_RECALCULATE_JOB_TYPE]: (job) =>
        rankingJobService.handleRankingRecalculateJob(job),
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
    now: options.now,
    pollIntervalMs: options.jobRunnerIntervalMs,
    retryDelayMs: options.jobRetryDelayMs,
    onError: (error) => app.log.error(error)
  });
  const feedRefreshScheduler = new FeedRefreshScheduler({
    refreshJobs: feedRefreshJobService,
    runner: jobRunner,
    intervalMs: options.feedRefreshIntervalMs ?? DEFAULT_FEED_REFRESH_INTERVAL_MS,
    onError: (error) => app.log.error(error)
  });
  const retentionCleanupScheduler = new RetentionCleanupScheduler({
    cleanupJobs: retentionCleanupJobService,
    runner: jobRunner,
    intervalMs: options.retentionCleanupIntervalMs ?? DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
    onError: (error) => app.log.error(error)
  });
  const profileDecayScheduler = new ProfileDecayScheduler({
    decayJobs: profileDecayJobService,
    runner: jobRunner,
    intervalMs: options.profileDecayIntervalMs ?? DEFAULT_PROFILE_DECAY_INTERVAL_MS,
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
    now: options.now,
    onError: (error) => app.log.error(error)
  });

  function drainBackgroundJobs(): void {
    if (backgroundJobs) {
      void jobRunner.drainDue().catch((error) => app.log.error(error));
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
      rankingJobService.enqueueArticles(uniqueArticleIds);
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
    /^text\/xml(?:;.*)?$/i,
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    }
  );

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    return sendApiError(reply, 500, "INTERNAL_ERROR", "Internal server error");
  });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = parseRequestPathname(request.url);
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
      derivedDataUpgradeService.isBlocking() &&
      !isUpgradeAllowedRoute(request.method, request.routeOptions.url)
    ) {
      return sendApiError(
        reply,
        423,
        "DERIVED_DATA_UPGRADE_IN_PROGRESS",
        "Dibao is rebuilding derived recommendation data for this version upgrade",
        derivedDataUpgradeService.getStatus()
      );
    }
  });

  function startBackgroundServices(): void {
    if (!backgroundJobs) {
      return;
    }
    jobRunner.start();
    feedRefreshScheduler.start();
    retentionCleanupScheduler.start();
    profileDecayScheduler.start();
    recommendationMaintenanceScheduler.start();
  }

  if (backgroundJobs) {
    app.addHook("onReady", async () => {
      const status = derivedDataUpgradeService.getStatus();
      if (!status.blocking) {
        startBackgroundServices();
        return;
      }

      void derivedDataUpgradeService
        .startIfRequired()
        .then((result) => {
          if (!result.blocking) {
            startBackgroundServices();
          }
        })
        .catch((error) => app.log.error(error));
    });
  }

  app.addHook("onClose", async () => {
    recommendationMaintenanceScheduler.stop();
    profileDecayScheduler.stop();
    retentionCleanupScheduler.stop();
    feedRefreshScheduler.stop();
    jobRunner.stop();
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

  app.post<{ Body: ChangePasswordBody }>("/api/auth/password", async (request, reply) => {
    const parsed = parseChangePasswordBody(request.body);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    try {
      await authService.changePassword(parsed.currentPassword, parsed.newPassword);
      return {
        data: {
          ok: true
        }
      };
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get("/api/setup/status", async () => ({
    data: getSetupStatus(
      credentials.hasCredential(),
      feeds.list().length > 0,
      embeddingProviderService.hasActiveProviderAndIndex(),
      derivedDataUpgradeService.getStatus()
    )
  }));

  app.get("/api/system/upgrade/status", async () => {
    const status = derivedDataUpgradeService.getStatus();
    if (status.blocking) {
      void derivedDataUpgradeService.startIfRequired().catch((error) => app.log.error(error));
    }
    return {
      data: status
    };
  });

  app.post("/api/system/upgrade/retry", async () => ({
    data: await derivedDataUpgradeService.retry()
  }));

  app.get<{ Querystring: JobQuery }>("/api/jobs", async (request, reply) => {
    const parsed = parseJobQuery(request.query);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    return {
      data: jobs.list(parsed.input).map(mapJob)
    };
  });

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
          settings: settingsService.getSettings().ranking,
          includeClusterItems: includeClusterItems ?? true
        })
      };
    }
  );

  app.get("/api/recommendation/transparency", async () => ({
    data: getRecommendationTransparency({
      db,
      embeddings,
      profiles,
      rankings,
      rankingService,
      clusterLabels: clusterLabelService,
      interestFamilies: interestFamilyService,
      settings: settingsService.getSettings().ranking,
      maintenanceSettings: settingsService.getSettings().recommendationMaintenance,
      maintenanceScheduleStates: recommendationMaintenanceService.listScheduleStates()
    })
  }));

  app.get<{ Querystring: RecommendationClusterQuery }>(
    "/api/recommendation/clusters",
    async (request) => ({
      data: getRecommendationClusters({
        db,
        embeddings,
        profiles,
        rankings,
        rankingService,
        clusterLabels: clusterLabelService,
        interestFamilies: interestFamilyService,
        settings: settingsService.getSettings().ranking,
        limit: request.query.limit === "all" ? null : parsePositiveInteger(request.query.limit, 12)
      })
    })
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
      try {
        const result = clusterLabelService.setManualLabel(
          request.params.id,
          request.body?.manualLabel
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

    const result = articles.list({
      ...parsed.input,
      rankContext: rankingService.getActiveRankContext()
    });

    return {
      data: result.items.map(mapArticleListItem),
      page: {
        nextCursor: encodeCursor(result.nextOffset)
      },
      meta: {
        unreadCount: result.unreadCount
      }
    };
  });

  app.get<{ Querystring: SearchQuery }>("/api/search", async (request, reply) => {
    const parsed = parseSearchQuery(request.query);
    if (!parsed.ok) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", parsed.message, parsed.details);
    }

    const result = articles.search({
      ...parsed.input,
      rankContext: rankingService.getActiveRankContext()
    });

    return {
      data: result.items.map(mapArticleListItem),
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
    const article = articles.findDetailById(request.params.id, {
      rankContext: rankingService.getActiveRankContext()
    });

    if (!article) {
      return sendApiError(reply, 404, "NOT_FOUND", "Article not found");
    }

    return {
      data: mapArticleDetail(article)
    };
  });

  app.get<{ Params: ArticleParams }>("/api/articles/:id/explanation", async (request, reply) => {
    const explanation = rankingService.explainArticle(request.params.id);

    if (!explanation) {
      return sendApiError(reply, 404, "NOT_FOUND", "Article not found");
    }

    return {
      data: {
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
      }
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
        const result = articleActionService.record({
          articleId: request.params.id,
          ...parsed.input
        });

        return {
          data: {
            state: result.state
          }
        };
      } catch (error) {
        return sendArticleActionError(reply, error);
      }
    }
  );

  registerWebStaticRoutes(app, options.webDistDir);

  return app;
}

function openConfiguredDatabase(options: BuildServerOptions): DibaoDatabase {
  const databasePath = resolveDatabasePath(options.databasePath);
  ensureDatabaseDirectory(databasePath);

  return openDatabase(databasePath, {
    migrate: options.migrate ?? true
  });
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
  if (method.toUpperCase() === "HEAD") {
    return reply.send();
  }

  return reply.send(readFileSync(filePath));
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
  "GET /api/system/health"
]);

const upgradeAllowedRoutes = new Set([
  "GET /api/auth/session",
  "POST /api/auth/logout",
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

function getHealth(db: DibaoDatabase): HealthResponse {
  const database = checkHealth(() => {
    db.prepare("select 1 as ok").get();
  });
  const fts = checkHealth(() => {
    db.prepare("select count(*) as count from article_fts").get();
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
  derivedDataUpgrade: DerivedDataUpgradeStatus
): SetupStatusResponse {
  const status: SetupStatusResponse = {
    setupCompleted,
    hasFeeds,
    hasEmbeddingProvider,
    firstRefreshStatus: "idle"
  };
  if (derivedDataUpgrade.blocking || derivedDataUpgrade.state === "pending") {
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
  settings: ReturnType<SettingsService["getSettings"]>["ranking"];
  includeClusterItems?: boolean;
}) {
  const includeClusterItems = options.includeClusterItems ?? true;
  const activeProvider = options.embeddings.findActiveProvider();
  const activeIndex = activeProvider
    ? includeClusterItems
      ? activeDiagnosticIndexFor(activeProvider.id, options.embeddings.listIndexes())
      : options.embeddings.findActiveIndexForProvider(activeProvider.id)
    : null;
  const activeRankContext = options.rankingService.getActiveRankContext();
  const coverage = includeClusterItems
    ? coverageFor(activeIndex as EmbeddingIndexListRow | null)
    : lightweightCoverageFor(options.db, activeIndex);
  const behaviorCounts = Object.fromEntries(
    options.profiles.countBehaviorEvents().map((row) => [row.eventType, row.count])
  );
  const clusters = options.profiles.countClusters({
    ...(activeIndex ? { embeddingIndexId: activeIndex.id } : {})
  });
  const clusterEvidence = activeIndex && includeClusterItems
    ? options.profiles.listClusterEvidence({ embeddingIndexId: activeIndex.id, limit: 2000 })
    : [];
  const clusterMergeDiagnostics = activeIndex && includeClusterItems
    ? mergeDiagnosticsByCluster(options.db, activeIndex.id, options.clusterLabels)
    : new Map<string, ClusterMergeDiagnostics>();
  const clustersForStatus = includeClusterItems
    ? options.profiles
        .listClusters({
          ...(activeIndex ? { embeddingIndexId: activeIndex.id } : {})
        })
        .slice(0, 12)
    : [];
  const clusterFamilyMap = includeClusterItems
    ? options.interestFamilies.familyMapForClusters(clustersForStatus.map((cluster) => cluster.id))
    : new Map<string, RecommendationClusterFamily>();
  const clusterItems = clustersForStatus.map((cluster, index) =>
    mapRecommendationCluster(
      cluster,
      index + 1,
      clusterEvidence,
      options.clusterLabels,
      clusterMergeDiagnostics.get(cluster.id) ?? emptyClusterMergeDiagnostics(),
      clusterFamilyMap.get(cluster.id) ?? null
    )
  );
  const familySummary = options.interestFamilies.listFamilySummary(activeIndex?.id ?? null, 8);
  const rankedArticles = options.rankings.countRankedArticles({ activeRankContext });
  const lastProfileUpdate = options.profiles.getLastProfileUpdate({
    ...(activeIndex ? { embeddingIndexId: activeIndex.id } : {})
  });
  const lastRankingUpdate = options.rankings.getLastRankingUpdate({ activeRankContext });
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
    coverage
  });

  return {
    mode,
    activeProvider: activeProvider ? mapRecommendationProvider(activeProvider) : null,
    activeIndex: activeIndex ? mapRecommendationIndex(activeIndex) : null,
    activeRankContext,
    algorithm: {
      version: "rec_v3",
      featureSchemaVersion: 3,
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
  options: Parameters<typeof getRecommendationStatus>[0] & { limit: number | null }
) {
  const activeProvider = options.embeddings.findActiveProvider();
  const indexes = options.embeddings.listIndexes();
  const activeIndex = activeProvider ? activeDiagnosticIndexFor(activeProvider.id, indexes) : null;
  const clusterEvidence = activeIndex
    ? options.profiles.listClusterEvidence({ embeddingIndexId: activeIndex.id, limit: 5000 })
    : [];
  const clusters = options.profiles.listClusters({
    ...(activeIndex ? { embeddingIndexId: activeIndex.id } : {})
  });
  const limitedClusters = options.limit === null ? clusters : clusters.slice(0, options.limit);
  const clusterMergeDiagnostics = activeIndex
    ? mergeDiagnosticsByCluster(options.db, activeIndex.id, options.clusterLabels)
    : new Map<string, ClusterMergeDiagnostics>();
  const clusterFamilyMap = options.interestFamilies.familyMapForClusters(
    limitedClusters.map((cluster) => cluster.id)
  );

  return {
    activeIndex: activeIndex ? mapRecommendationIndex(activeIndex) : null,
    total: clusters.length,
    families: options.interestFamilies.listFamilySummary(activeIndex?.id ?? null, 24),
    items: limitedClusters.map((cluster, index) =>
      mapRecommendationCluster(
        cluster,
        index + 1,
        clusterEvidence,
        options.clusterLabels,
        clusterMergeDiagnostics.get(cluster.id) ?? emptyClusterMergeDiagnostics(),
        clusterFamilyMap.get(cluster.id) ?? null
      )
    )
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
  settings: ReturnType<SettingsService["getSettings"]>["ranking"];
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

function recommendationMode(input: {
  activeProvider: EmbeddingProviderRow | null;
  activeIndex: EmbeddingIndexRow | null;
  coverage: RecommendationCoverage;
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

  if (input.coverage.pendingJobs > 0 || input.coverage.coverageRatio < 1) {
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

  const offset = decodeCursor(query.cursor);
  if (offset === null) {
    return {
      ok: false,
      message: "cursor is invalid"
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
    offset
  };

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

  const offset = decodeCursor(query.cursor);
  if (offset === null) {
    return {
      ok: false,
      message: "cursor is invalid",
      details: { field: "cursor" }
    };
  }

  return {
    ok: true,
    input: {
      query: rawQuery,
      state: state ?? "all",
      sort: sort ?? "relevance",
      limit,
      offset,
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
        ...(metadata !== undefined ? { metadata } : {})
      }
    };
  }

  return {
    ok: true,
    input: {
      type,
      ...(metadata !== undefined ? { metadata } : {})
    }
  };
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
    value === INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE
  ) {
    return value;
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

function encodeCursor(offset: number | null): string | null {
  if (offset === null) {
    return null;
  }

  return Buffer.from(JSON.stringify({ offset } satisfies CursorPayload)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number | undefined | null {
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
