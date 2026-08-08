import type { DibaoDatabase, JobRepository } from "@dibao/db";
import type { EmbeddingJobService } from "./embedding-job-service.js";
import type { JobRunner } from "./job-runner.js";
import {
  DUPLICATE_GROUP_REBUILD_JOB_TYPE,
  FTRL_TRAIN_JOB_TYPE,
  INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE,
  INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE,
  INTEREST_FAMILY_REBUILD_JOB_TYPE,
  KEYWORD_PROFILE_REBUILD_JOB_TYPE,
  RECENT_INTENT_REBUILD_JOB_TYPE,
  type RecommendationMaintenanceResult,
  type RecommendationMaintenanceService
} from "./recommendation-maintenance-service.js";
import type { RecommendationMaintenanceSettings } from "./settings-service.js";

export const DEFAULT_RECOMMENDATION_MAINTENANCE_SCHEDULER_INTERVAL_MS = 15 * 60_000;

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;

export type RecommendationMaintenanceSchedulerService = Pick<
  RecommendationMaintenanceService,
  | "enqueueRecentIntentRebuild"
  | "enqueueDuplicateRebuild"
  | "enqueueKeywordRebuild"
  | "enqueueFtrlTrain"
  | "enqueueClusterLabelRebuild"
  | "enqueueClusterMergeDiagnostics"
  | "enqueueClusterAutoMerge"
  | "enqueueInterestFamilyRebuild"
  | "enqueueRecalculate"
  | "enqueueEvaluation"
  | "recordScheduleEnqueue"
  | "recordScheduleSkip"
  | "scheduleStateFor"
>;

export type RecommendationMaintenanceSchedulerOptions = {
  db: DibaoDatabase;
  jobs: Pick<JobRepository, "listOpenByType">;
  maintenance: RecommendationMaintenanceSchedulerService;
  settings: () => RecommendationMaintenanceSettings;
  embeddingJobs?: Pick<EmbeddingJobService, "enqueueBackfillForActiveIndex">;
  runner?: Pick<JobRunner, "drainDue">;
  intervalMs?: number;
  initialDelayMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

export class RecommendationMaintenanceScheduler {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly now: () => number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialTick: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RecommendationMaintenanceSchedulerOptions) {
    this.intervalMs =
      options.intervalMs ?? DEFAULT_RECOMMENDATION_MAINTENANCE_SCHEDULER_INTERVAL_MS;
    this.initialDelayMs = Math.max(0, Math.floor(options.initialDelayMs ?? 0));
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.interval || this.initialTick || this.intervalMs <= 0) {
      return;
    }

    this.initialTick = setTimeout(() => {
      this.initialTick = null;
      void this.tick().catch((error) => this.options.onError?.(error));
    }, this.initialDelayMs);
    this.initialTick.unref?.();
    this.interval = setInterval(() => {
      void this.tick().catch((error) => this.options.onError?.(error));
    }, this.intervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.initialTick) {
      clearTimeout(this.initialTick);
      this.initialTick = null;
    }
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
  }

  async tick(): Promise<Array<{ taskKey: string; jobId: string; existing: boolean }>> {
    const settings = this.options.settings();
    const enqueued: Array<{ taskKey: string; jobId: string; existing: boolean }> = [];

    if (!settings.maintenanceEnabled) {
      for (const taskKey of ALL_TASK_KEYS) {
        this.options.maintenance.recordScheduleSkip(taskKey, "disabled");
      }
      return enqueued;
    }

    this.enqueuePeriodicStrongSignalWork(settings, enqueued);
    this.enqueueHourlyWork(settings, enqueued);
    this.enqueueDailyWork(settings, enqueued);
    this.enqueueWeeklyEvaluation(settings, enqueued);

    if (enqueued.length > 0 && this.options.runner) {
      await this.options.runner.drainDue();
    }

    return enqueued;
  }

  private enqueuePeriodicStrongSignalWork(
    settings: RecommendationMaintenanceSettings,
    enqueued: Array<{ taskKey: string; jobId: string; existing: boolean }>
  ): void {
    if (
      settings.recentIntentAutoRebuildEnabled &&
      this.isDue("recent_intent_periodic", FIFTEEN_MINUTES_MS) &&
      this.hasStrongBehaviorSince(this.lastEnqueuedAt("recent_intent_periodic") ?? this.now() - FIFTEEN_MINUTES_MS)
    ) {
      this.enqueue(
        "recent_intent_periodic",
        () => this.options.maintenance.enqueueRecentIntentRebuild(),
        enqueued
      );
    }

    if (
      settings.ftrlAutoTrainEnabled &&
      this.isDue("ftrl_train_periodic", FIFTEEN_MINUTES_MS) &&
      this.hasUntrainedFtrlExamples()
    ) {
      this.enqueue("ftrl_train_periodic", () => this.options.maintenance.enqueueFtrlTrain(), enqueued);
    }
  }

  private enqueueHourlyWork(
    settings: RecommendationMaintenanceSettings,
    enqueued: Array<{ taskKey: string; jobId: string; existing: boolean }>
  ): void {
    if (settings.recentIntentAutoRebuildEnabled && this.isDue("recent_intent_hourly", ONE_HOUR_MS)) {
      this.enqueue("recent_intent_hourly", () => this.options.maintenance.enqueueRecentIntentRebuild(), enqueued);
    }

    if (settings.duplicateAutoRebuildEnabled && this.isDue("duplicate_hourly", ONE_HOUR_MS)) {
      this.enqueue("duplicate_hourly", () => this.options.maintenance.enqueueDuplicateRebuild(), enqueued);
    }

    if (settings.embeddingHealthAutoBackfillEnabled && this.isDue("embedding_health_hourly", ONE_HOUR_MS)) {
      this.enqueueEmbeddingHealth(enqueued);
    }

  }

  private enqueueDailyWork(
    settings: RecommendationMaintenanceSettings,
    enqueued: Array<{ taskKey: string; jobId: string; existing: boolean }>
  ): void {
    if (settings.keywordAutoRebuildEnabled && this.isDue("keyword_profile_daily", ONE_DAY_MS)) {
      this.enqueue("keyword_profile_daily", () => this.options.maintenance.enqueueKeywordRebuild(), enqueued);
    }
    if (settings.duplicateAutoRebuildEnabled && this.isDue("duplicate_daily", ONE_DAY_MS)) {
      this.enqueue("duplicate_daily", () => this.options.maintenance.enqueueDuplicateRebuild(), enqueued);
    }
    if (settings.recentIntentAutoRebuildEnabled && this.isDue("recent_intent_daily", ONE_DAY_MS)) {
      this.enqueue("recent_intent_daily", () => this.options.maintenance.enqueueRecentIntentRebuild(), enqueued);
    }
    if (settings.ftrlAutoTrainEnabled && this.isDue("ftrl_train_daily", ONE_DAY_MS)) {
      this.enqueue("ftrl_train_daily", () => this.options.maintenance.enqueueFtrlTrain(), enqueued);
    }
    if (settings.clusterLabelAutoRebuildEnabled && this.isDue("cluster_label_daily", ONE_DAY_MS)) {
      this.enqueue(
        "cluster_label_daily",
        () => this.options.maintenance.enqueueClusterLabelRebuild(),
        enqueued
      );
    }
    if (
      settings.clusterMergeDiagnosticsEnabled &&
      this.isDue("cluster_merge_diagnostics_daily", ONE_DAY_MS)
    ) {
      this.enqueue(
        "cluster_merge_diagnostics_daily",
        () => this.options.maintenance.enqueueClusterMergeDiagnostics(),
        enqueued
      );
    }
    if (this.isDue("interest_family_daily", ONE_DAY_MS)) {
      this.enqueue(
        "interest_family_daily",
        () => this.options.maintenance.enqueueInterestFamilyRebuild(),
        enqueued
      );
    }
    if (settings.clusterAutoMergeEnabled && this.isDue("cluster_auto_merge_daily", ONE_DAY_MS)) {
      this.enqueue(
        "cluster_auto_merge_daily",
        () => this.options.maintenance.enqueueClusterAutoMerge(),
        enqueued
      );
    }
  }

  private enqueueWeeklyEvaluation(
    settings: RecommendationMaintenanceSettings,
    enqueued: Array<{ taskKey: string; jobId: string; existing: boolean }>
  ): void {
    const intervalMs = settings.evaluationAutoRunIntervalDays * ONE_DAY_MS;
    if (!settings.evaluationAutoRunEnabled) {
      this.options.maintenance.recordScheduleSkip("evaluation_weekly", "disabled");
      return;
    }

    if (this.isDue("evaluation_weekly", intervalMs)) {
      this.enqueue("evaluation_weekly", () => this.options.maintenance.enqueueEvaluation(), enqueued);
    }
  }

  private enqueueEmbeddingHealth(
    enqueued: Array<{ taskKey: string; jobId: string; existing: boolean }>
  ): void {
    if (!this.hasActiveEmbeddingIndex()) {
      this.options.maintenance.recordScheduleSkip("embedding_health_hourly", "no_active_index");
      return;
    }

    if (this.options.jobs.listOpenByType("embedding_generate").length > 0) {
      this.options.maintenance.recordScheduleSkip("embedding_health_hourly", "existing_job");
      return;
    }

    const beforeOpenCount = this.options.jobs.listOpenByType("embedding_generate").length;
    const jobs = this.options.embeddingJobs?.enqueueBackfillForActiveIndex() ?? [];
    const afterOpenCount = this.options.jobs.listOpenByType("embedding_generate").length;
    const result: RecommendationMaintenanceResult = {
      jobId: jobs[0]?.id ?? "embedding_health_noop",
      existing: beforeOpenCount > 0 || (jobs.length === 0 && afterOpenCount > 0)
    };

    if (jobs.length === 0 && afterOpenCount === beforeOpenCount) {
      this.options.maintenance.recordScheduleSkip("embedding_health_hourly", "no_missing_or_stale_embeddings");
      return;
    }

    this.options.maintenance.recordScheduleEnqueue("embedding_health_hourly", result);
    enqueued.push({ taskKey: "embedding_health_hourly", ...result });
  }

  private enqueue(
    taskKey: string,
    producer: () => RecommendationMaintenanceResult,
    enqueued: Array<{ taskKey: string; jobId: string; existing: boolean }>
  ): void {
    const result = producer();
    this.options.maintenance.recordScheduleEnqueue(taskKey, result);
    enqueued.push({ taskKey, ...result });
  }

  private isDue(taskKey: string, intervalMs: number): boolean {
    const lastEnqueuedAt = this.lastEnqueuedAt(taskKey);
    return lastEnqueuedAt === null || this.now() - lastEnqueuedAt >= intervalMs;
  }

  private lastEnqueuedAt(taskKey: string): number | null {
    return this.options.maintenance.scheduleStateFor(taskKey)?.lastEnqueuedAt ?? null;
  }

  private hasStrongBehaviorSince(since: number): boolean {
    const row = this.options.db
      .prepare(
        `
          select count(*) as count
          from behavior_events
          where created_at >= ?
            and (
              event_type in ('favorite', 'like', 'read_later', 'mark_read', 'read_complete', 'hide', 'not_interested')
              or (
                event_type = 'read_progress'
                and coalesce(json_extract(metadata_json, '$.progress'), 0) >= 0.75
              )
            )
        `
      )
      .get(since) as { count: number } | undefined;
    return (row?.count ?? 0) > 0;
  }

  private hasUntrainedFtrlExamples(): boolean {
    const row = this.options.db
      .prepare(
        `
          select count(*) as count
          from behavior_events be
          where be.event_type in (
            'favorite',
            'like',
            'read_later',
            'mark_read',
            'read_complete',
            'read_progress',
            'hide',
            'not_interested',
            'quick_bounce'
          )
            and not exists (
              select 1
              from rank_training_examples rte
              where rte.behavior_event_id = be.id
            )
        `
      )
      .get() as { count: number } | undefined;
    return (row?.count ?? 0) > 0;
  }

  private hasMaintenanceOutputCompletedAfter(timestamp: number): boolean {
    return MAINTENANCE_OUTPUT_TASK_KEYS.some((taskKey) => {
      const state = this.options.maintenance.scheduleStateFor(taskKey);
      return (state?.lastCompletedAt ?? 0) > timestamp;
    });
  }

  private hasActiveEmbeddingIndex(): boolean {
    const row = this.options.db
      .prepare("select id from embedding_indexes where status = 'active' order by updated_at desc limit 1")
      .get() as { id: string } | undefined;
    return row !== undefined;
  }
}

const ALL_TASK_KEYS = [
  "recent_intent_periodic",
  "recent_intent_hourly",
  "recent_intent_daily",
  "keyword_profile_daily",
  "duplicate_hourly",
  "duplicate_daily",
  "ftrl_train_periodic",
  "ftrl_train_daily",
  "cluster_label_daily",
  "cluster_merge_diagnostics_daily",
  "interest_family_daily",
  "cluster_auto_merge_daily",
  "evaluation_weekly",
  "embedding_health_hourly"
] as const;

const MAINTENANCE_OUTPUT_TASK_KEYS = [
  "recent_intent_periodic",
  "recent_intent_hourly",
  "recent_intent_daily",
  "keyword_profile_daily",
  "duplicate_hourly",
  "duplicate_daily",
  "ftrl_train_periodic",
  "ftrl_train_daily",
  "cluster_label_daily",
  "cluster_merge_diagnostics_daily",
  "interest_family_daily"
] as const;

export function maintenanceJobTypeForTaskKey(taskKey: string): string | null {
  switch (taskKey) {
    case "recent_intent_periodic":
    case "recent_intent_hourly":
    case "recent_intent_daily":
      return RECENT_INTENT_REBUILD_JOB_TYPE;
    case "keyword_profile_daily":
      return KEYWORD_PROFILE_REBUILD_JOB_TYPE;
    case "duplicate_hourly":
    case "duplicate_daily":
      return DUPLICATE_GROUP_REBUILD_JOB_TYPE;
    case "ftrl_train_periodic":
    case "ftrl_train_daily":
      return FTRL_TRAIN_JOB_TYPE;
    case "cluster_label_daily":
      return "interest_cluster_label_rebuild";
    case "cluster_merge_diagnostics_daily":
      return INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE;
    case "interest_family_daily":
      return INTEREST_FAMILY_REBUILD_JOB_TYPE;
    case "cluster_auto_merge_daily":
      return INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE;
    default:
      return null;
  }
}
