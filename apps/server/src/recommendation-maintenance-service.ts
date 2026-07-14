import { createHash, randomBytes } from "node:crypto";
import { fromVectorBlob, toVectorBlob, type DibaoDatabase, type JobRepository, type JobRow, type JobType } from "@dibao/db";
import { clamp, cosineSimilarity, normalizeVector } from "@dibao/ranking";
import {
  INTEREST_CLUSTER_LABEL_REBUILD_JOB_TYPE,
  type InterestClusterLabelService
} from "./interest-cluster-label-service.js";
import {
  INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE,
  INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE,
  type InterestClusterMergeService
} from "./interest-cluster-merge-service.js";
import {
  INTEREST_FAMILY_REBUILD_JOB_TYPE,
  type InterestFamilyService
} from "./interest-family-service.js";
import { PermanentJobFailure } from "./job-runner.js";
import type { RankingRecalculateJobService } from "./ranking-job-service.js";
import type { RecommendationMemoryService } from "./recommendation-memory-service.js";

export {
  INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE,
  INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE
} from "./interest-cluster-merge-service.js";
export { INTEREST_FAMILY_REBUILD_JOB_TYPE } from "./interest-family-service.js";

export const ARTICLE_FINGERPRINT_BACKFILL_JOB_TYPE = "article_fingerprint_backfill" as const;
export const DUPLICATE_GROUP_REBUILD_JOB_TYPE = "duplicate_group_rebuild" as const;
export const KEYWORD_PROFILE_REBUILD_JOB_TYPE = "keyword_profile_rebuild" as const;
export const RECENT_INTENT_REBUILD_JOB_TYPE = "recent_intent_rebuild" as const;
export const RANKING_EVAL_RUN_JOB_TYPE = "ranking_eval_run" as const;
export const FTRL_TRAIN_JOB_TYPE = "ftrl_train" as const;
export const RECOMMENDATION_BACKFILL_JOB_TYPE = "recommendation_backfill" as const;
export const FTRL_ACTIVE_ALPHA_CAP = 0.2;
export const FTRL_ABSOLUTE_ALPHA_CAP = 0.25;
export const FTRL_INITIAL_ACTIVE_ALPHA = 0.05;
const FTRL_ALPHA_STEP = 0.05;
const FTRL_ALPHA_ADJUST_INTERVAL_MS = 7 * 86_400_000;

type MaintenanceJobType =
  | typeof ARTICLE_FINGERPRINT_BACKFILL_JOB_TYPE
  | typeof DUPLICATE_GROUP_REBUILD_JOB_TYPE
  | typeof KEYWORD_PROFILE_REBUILD_JOB_TYPE
  | typeof RECENT_INTENT_REBUILD_JOB_TYPE
  | typeof RANKING_EVAL_RUN_JOB_TYPE
  | typeof FTRL_TRAIN_JOB_TYPE
  | typeof RECOMMENDATION_BACKFILL_JOB_TYPE
  | typeof INTEREST_CLUSTER_LABEL_REBUILD_JOB_TYPE
  | typeof INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE
  | typeof INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE
  | typeof INTEREST_FAMILY_REBUILD_JOB_TYPE;

export type RecommendationMaintenanceResult = {
  jobId: string;
  existing: boolean;
};

export type RecommendationMaintenanceEnqueueOptions = {
  runAfter?: number;
  payloadJson?: string | null;
};

export type RecommendationMaintenanceScheduleState = {
  taskKey: string;
  lastEnqueuedAt: number | null;
  lastCompletedAt: number | null;
  lastSkippedReason: string | null;
  lastJobId: string | null;
  updatedAt: number;
};

export type RecommendationMaintenanceServiceOptions = {
  db: DibaoDatabase;
  jobs: Pick<JobRepository, "enqueue" | "listOpenByType">;
  rankingJobs: Pick<RankingRecalculateJobService, "enqueueAll">;
  clusterLabels?: Pick<InterestClusterLabelService, "rebuildActiveIndexLabels">;
  clusterMerge?: Pick<
    InterestClusterMergeService,
    "rebuildActiveIndexCandidates" | "autoMergeOpenCandidates"
  >;
  interestFamilies?: Pick<InterestFamilyService, "rebuildActiveIndexFamilies">;
  memory?: Pick<RecommendationMemoryService, "rebuildSnapshot">;
  getRankingSettings?: () => { localLearningEnabled: boolean; localLearningShadowMode: boolean };
  getMaintenanceSettings?: () => { ftrlAutoPromoteEnabled: boolean; clusterAutoMergeEnabled?: boolean };
  now?: () => number;
  jobIdFactory?: () => string;
};

export class RecommendationMaintenanceServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "RecommendationMaintenanceServiceError";
  }
}

export class RecommendationMaintenanceService {
  private readonly now: () => number;
  private readonly jobIdFactory: () => string;

  constructor(private readonly options: RecommendationMaintenanceServiceOptions) {
    this.now = options.now ?? Date.now;
    this.jobIdFactory = options.jobIdFactory ?? randomJobId;
  }

  enqueueRecalculate(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    const existing = this.options.jobs.listOpenByType("ranking_recalculate").find((job) => {
      try {
        return job.payloadJson === null || JSON.stringify(JSON.parse(job.payloadJson)) === "{}";
      } catch {
        return false;
      }
    });
    const job = this.options.rankingJobs.enqueueAll();
    return { jobId: job.id, existing: existing !== undefined };
  }

  enqueueFingerprintBackfill(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(ARTICLE_FINGERPRINT_BACKFILL_JOB_TYPE, options);
  }

  enqueueDuplicateRebuild(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(DUPLICATE_GROUP_REBUILD_JOB_TYPE, options);
  }

  enqueueKeywordRebuild(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(KEYWORD_PROFILE_REBUILD_JOB_TYPE, options);
  }

  enqueueRecentIntentRebuild(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(RECENT_INTENT_REBUILD_JOB_TYPE, options);
  }

  enqueueEvaluation(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(RANKING_EVAL_RUN_JOB_TYPE, options);
  }

  enqueueFtrlTrain(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(FTRL_TRAIN_JOB_TYPE, options);
  }

  enqueueClusterLabelRebuild(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(INTEREST_CLUSTER_LABEL_REBUILD_JOB_TYPE, options);
  }

  enqueueClusterMergeDiagnostics(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE, options);
  }

  enqueueClusterAutoMerge(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE, options);
  }

  enqueueInterestFamilyRebuild(options: RecommendationMaintenanceEnqueueOptions = {}): RecommendationMaintenanceResult {
    return this.enqueueUnique(INTEREST_FAMILY_REBUILD_JOB_TYPE, options);
  }

  enqueueStrongActionMaintenance(now: number = this.now()): {
    recentIntent: RecommendationMaintenanceResult;
    ftrlTrain: RecommendationMaintenanceResult;
  } {
    return {
      recentIntent: this.enqueueRecentIntentRebuild({ runAfter: now + 10 * 60_000 }),
      ftrlTrain: this.enqueueFtrlTrain({ runAfter: now + 15 * 60_000 })
    };
  }

  recordScheduleEnqueue(taskKey: string, result: RecommendationMaintenanceResult): void {
    const now = this.now();
    this.options.db
      .prepare(
        `
          insert into recommendation_maintenance_schedule_state (
            task_key,
            last_enqueued_at,
            last_completed_at,
            last_skipped_reason,
            last_job_id,
            updated_at
          )
          values (?, ?, null, ?, ?, ?)
          on conflict(task_key) do update set
            last_enqueued_at = case
              when ? = 1 then recommendation_maintenance_schedule_state.last_enqueued_at
              else excluded.last_enqueued_at
            end,
            last_skipped_reason = excluded.last_skipped_reason,
            last_job_id = excluded.last_job_id,
            updated_at = excluded.updated_at
        `
      )
      .run(
        taskKey,
        result.existing ? null : now,
        result.existing ? "existing_job" : null,
        result.jobId,
        now,
        result.existing ? 1 : 0
      );
  }

  recordScheduleSkip(taskKey: string, reason: string): void {
    const now = this.now();
    this.options.db
      .prepare(
        `
          insert into recommendation_maintenance_schedule_state (
            task_key,
            last_enqueued_at,
            last_completed_at,
            last_skipped_reason,
            last_job_id,
            updated_at
          )
          values (?, null, null, ?, null, ?)
          on conflict(task_key) do update set
            last_skipped_reason = excluded.last_skipped_reason,
            updated_at = excluded.updated_at
        `
      )
      .run(taskKey, reason, now);
  }

  listScheduleStates(): RecommendationMaintenanceScheduleState[] {
    return (
      this.options.db
        .prepare(
          `
            select
              task_key as taskKey,
              last_enqueued_at as lastEnqueuedAt,
              last_completed_at as lastCompletedAt,
              last_skipped_reason as lastSkippedReason,
              last_job_id as lastJobId,
              updated_at as updatedAt
            from recommendation_maintenance_schedule_state
            order by task_key
          `
        )
        .all() as RecommendationMaintenanceScheduleState[]
    );
  }

  scheduleStateFor(taskKey: string): RecommendationMaintenanceScheduleState | null {
    const row = this.options.db
      .prepare(
        `
          select
            task_key as taskKey,
            last_enqueued_at as lastEnqueuedAt,
            last_completed_at as lastCompletedAt,
            last_skipped_reason as lastSkippedReason,
            last_job_id as lastJobId,
            updated_at as updatedAt
          from recommendation_maintenance_schedule_state
          where task_key = ?
        `
      )
      .get(taskKey) as RecommendationMaintenanceScheduleState | undefined;
    return row ?? null;
  }

  resetFtrl(): { ok: true } {
    this.options.db.transaction(() => {
      this.options.db.prepare("delete from rank_model_weights").run();
      this.options.db.prepare("delete from rank_training_examples").run();
      this.options.db
        .prepare("update rank_model_versions set status = 'retired', updated_at = ? where status != 'retired'")
        .run(this.now());
    })();
    return { ok: true };
  }

  promoteFtrl(): {
    ok: true;
    modelVersionId: string;
    sampleCount: number;
    highQualitySampleCount: number;
    blendAlpha: number;
  } {
    const model = this.options.db
      .prepare(
        `
          select
            id,
            status,
            sample_count as sampleCount,
            blend_alpha as blendAlpha,
            metrics_json as metricsJson
          from rank_model_versions
          where status in ('shadow', 'active')
          order by case when status = 'active' then 0 else 1 end, updated_at desc
          limit 1
        `
      )
      .get() as
      | {
          id: string;
          status: "shadow" | "active";
          sampleCount: number;
          blendAlpha: number;
          metricsJson: string | null;
        }
      | undefined;

    const highQualitySampleCount = highQualitySampleCountFor(model?.metricsJson ?? null);
    if (!model || model.sampleCount < 100 || highQualitySampleCount < 100) {
      throw new RecommendationMaintenanceServiceError(
        409,
        "INSUFFICIENT_FTRL_SAMPLES",
        "FTRL model cannot be promoted until it has at least 100 high-quality local samples.",
        {
          sampleCount: model?.sampleCount ?? 0,
          highQualitySampleCount,
          blendAlpha: model?.blendAlpha ?? 0
        }
      );
    }

    const now = this.now();
    this.options.db.transaction(() => {
      this.options.db
        .prepare("update rank_model_versions set status = 'retired', updated_at = ? where status = 'active' and id != ?")
        .run(now, model.id);
      this.options.db
        .prepare(
          `
            update rank_model_versions
            set
              status = 'active',
              blend_alpha = ?,
              metrics_json = ?,
              updated_at = ?
            where id = ?
          `
        )
        .run(
          clamp(Math.max(model.blendAlpha, FTRL_INITIAL_ACTIVE_ALPHA), 0, FTRL_ACTIVE_ALPHA_CAP),
          JSON.stringify({
            ...parseMetricsJson(model.metricsJson),
            highQualitySamples: highQualitySampleCount,
            lifecycleStatus: "active_low_weight",
            lastAlphaAdjustedAt: now,
            autoPausedReason: null
          }),
          now,
          model.id
        );
    })();
    const blendAlpha = clamp(Math.max(model.blendAlpha, FTRL_INITIAL_ACTIVE_ALPHA), 0, FTRL_ACTIVE_ALPHA_CAP);

    return {
      ok: true,
      modelVersionId: model.id,
      sampleCount: model.sampleCount,
      highQualitySampleCount,
      blendAlpha
    };
  }

  handleJob(job: JobRow): void {
    if (job.payloadJson !== null && job.payloadJson !== "{}") {
      throw new PermanentJobFailure(`Invalid ${job.type} job payload`);
    }

    switch (job.type) {
      case ARTICLE_FINGERPRINT_BACKFILL_JOB_TYPE:
        this.backfillFingerprints();
        this.markScheduleCompleted(job.id);
        return;
      case DUPLICATE_GROUP_REBUILD_JOB_TYPE:
        this.rebuildDuplicateGroups();
        this.options.memory?.rebuildSnapshot();
        this.options.rankingJobs.enqueueAll();
        this.markScheduleCompleted(job.id);
        return;
      case KEYWORD_PROFILE_REBUILD_JOB_TYPE:
        this.rebuildKeywordProfile();
        this.options.memory?.rebuildSnapshot();
        this.options.rankingJobs.enqueueAll();
        this.markScheduleCompleted(job.id);
        return;
      case RECENT_INTENT_REBUILD_JOB_TYPE:
        this.rebuildRecentIntent();
        this.options.memory?.rebuildSnapshot();
        this.options.rankingJobs.enqueueAll();
        this.markScheduleCompleted(job.id);
        return;
      case RANKING_EVAL_RUN_JOB_TYPE:
        this.runReplayEvaluation();
        this.markScheduleCompleted(job.id);
        return;
      case FTRL_TRAIN_JOB_TYPE:
        this.trainFtrl();
        this.options.rankingJobs.enqueueAll();
        this.markScheduleCompleted(job.id);
        return;
      case RECOMMENDATION_BACKFILL_JOB_TYPE:
        this.touchBackfillState(job.type, "succeeded", null);
        this.markScheduleCompleted(job.id);
        return;
      case INTEREST_CLUSTER_LABEL_REBUILD_JOB_TYPE:
        if (!this.options.clusterLabels) {
          throw new PermanentJobFailure("Interest cluster label service is not configured");
        }
        this.options.clusterLabels.rebuildActiveIndexLabels();
        this.markScheduleCompleted(job.id);
        return;
      case INTEREST_CLUSTER_MERGE_DIAGNOSTICS_JOB_TYPE:
        if (!this.options.clusterMerge) {
          throw new PermanentJobFailure("Interest cluster merge service is not configured");
        }
        this.options.clusterMerge.rebuildActiveIndexCandidates();
        this.markScheduleCompleted(job.id);
        return;
      case INTEREST_CLUSTER_AUTO_MERGE_JOB_TYPE:
        if (!this.options.clusterMerge) {
          throw new PermanentJobFailure("Interest cluster merge service is not configured");
        }
        if (this.options.getMaintenanceSettings?.().clusterAutoMergeEnabled !== true) {
          this.markScheduleCompleted(job.id);
          return;
        }
        if (this.options.clusterMerge.autoMergeOpenCandidates().mergedCount > 0) {
          this.enqueueClusterLabelRebuild();
          this.options.rankingJobs.enqueueAll();
        }
        this.markScheduleCompleted(job.id);
        return;
      case INTEREST_FAMILY_REBUILD_JOB_TYPE:
        if (!this.options.interestFamilies) {
          throw new PermanentJobFailure("Interest family service is not configured");
        }
        this.options.interestFamilies.rebuildActiveIndexFamilies();
        this.options.memory?.rebuildSnapshot();
        this.options.rankingJobs.enqueueAll();
        this.markScheduleCompleted(job.id);
        return;
      default:
        throw new PermanentJobFailure(`Unsupported recommendation maintenance job: ${job.type}`);
    }
  }

  private markScheduleCompleted(jobId: string): void {
    const now = this.now();
    this.options.db
      .prepare(
        `
          update recommendation_maintenance_schedule_state
          set
            last_completed_at = ?,
            updated_at = ?
          where last_job_id = ?
        `
      )
      .run(now, now, jobId);
  }

  private enqueueUnique(
    type: MaintenanceJobType,
    options: RecommendationMaintenanceEnqueueOptions = {}
  ): RecommendationMaintenanceResult {
    const existing = this.options.jobs.listOpenByType(type)[0];
    if (existing) {
      return { jobId: existing.id, existing: true };
    }

    const now = this.now();
    const job = this.options.jobs.enqueue({
      id: this.jobIdFactory(),
      type,
      payloadJson: options.payloadJson ?? null,
      maxAttempts: 1,
      now,
      runAfter: options.runAfter ?? now
    });
    return { jobId: job.id, existing: false };
  }

  private backfillFingerprints(): void {
    const now = this.now();
    const rows = this.options.db
      .prepare(
        `
          select
            id,
            dedupe_key as dedupeKey,
            content_hash as contentHash,
            canonical_url as canonicalUrl,
            url,
            title,
            summary
          from articles
          where deleted_at is null
            and status != 'deleted'
        `
      )
      .all() as Array<{
        id: string;
        dedupeKey: string | null;
        contentHash: string | null;
        canonicalUrl: string | null;
        url: string;
        title: string;
        summary: string | null;
      }>;

    const insert = this.options.db.prepare(
      `
        insert into article_fingerprints (
          article_id,
          dedupe_key,
          content_hash,
          canonical_url,
          normalized_url,
          normalized_title,
          title_hash,
          title_simhash,
          summary_simhash,
          calculated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(article_id) do update set
          dedupe_key = excluded.dedupe_key,
          content_hash = excluded.content_hash,
          canonical_url = excluded.canonical_url,
          normalized_url = excluded.normalized_url,
          normalized_title = excluded.normalized_title,
          title_hash = excluded.title_hash,
          title_simhash = excluded.title_simhash,
          summary_simhash = excluded.summary_simhash,
          calculated_at = excluded.calculated_at
      `
    );

    this.options.db.transaction(() => {
      for (const row of rows) {
        const normalizedTitle = normalizeTitle(row.title);
        insert.run(
          row.id,
          row.dedupeKey,
          row.contentHash,
          row.canonicalUrl,
          normalizeUrl(row.canonicalUrl ?? row.url),
          normalizedTitle,
          sha256(normalizedTitle),
          simhash(normalizedTitle),
          simhash(normalizeTitle(row.summary ?? "")),
          now
        );
      }
      this.touchBackfillState("article_fingerprint_backfill", "succeeded", rows.length);
    })();
  }

  private rebuildDuplicateGroups(): void {
    this.backfillFingerprints();
    const now = this.now();
    const buckets = this.options.db
      .prepare(
        `
          select
            coalesce(dedupe_key, content_hash, normalized_url, title_hash) as bucketKey,
            case
              when dedupe_key is not null then 'exact_dedupe_key'
              when content_hash is not null then 'exact_content_hash'
              when normalized_url is not null then 'exact_url'
              else 'exact_title_hash'
            end as reason,
            group_concat(article_id, char(31)) as articleIds,
            count(*) as count
          from article_fingerprints
          where coalesce(dedupe_key, content_hash, normalized_url, title_hash) is not null
          group by bucketKey
          having count(*) > 1
        `
      )
      .all() as Array<{ bucketKey: string; reason: string; articleIds: string; count: number }>;
    const nearRows = this.options.db
      .prepare(
        `
          select
            af.article_id as articleId,
            af.normalized_title as normalizedTitle,
            af.title_simhash as titleSimhash,
            af.summary_simhash as summarySimhash,
            coalesce(a.published_at, a.discovered_at) as articleTime
          from article_fingerprints af
          join articles a on a.id = af.article_id
          join feeds f on f.id = a.feed_id
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and coalesce(a.published_at, a.discovered_at) >= ?
          order by coalesce(a.published_at, a.discovered_at) desc, af.article_id
        `
      )
      .all(now - 14 * 86_400_000) as Array<{
      articleId: string;
      normalizedTitle: string | null;
      titleSimhash: string | null;
      summarySimhash: string | null;
      articleTime: number;
    }>;

    this.options.db.transaction(() => {
      this.options.db.prepare("delete from duplicate_group_members").run();
      this.options.db.prepare("delete from duplicate_groups").run();

      const insertGroup = this.options.db.prepare(
        `
          insert into duplicate_groups (
            id,
            representative_article_id,
            duplicate_reason,
            confidence,
            article_count,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?)
        `
      );
      const insertMember = this.options.db.prepare(
        `
          insert into duplicate_group_members (
            duplicate_group_id,
            article_id,
            confidence,
            reason,
            is_representative,
            created_at
          )
          values (?, ?, ?, ?, ?, ?)
        `
      );
      const grouped = new Set<string>();

      for (const bucket of buckets) {
        const articleIds = bucket.articleIds.split(String.fromCharCode(31)).filter(Boolean);
        const representative = articleIds[0]!;
        const groupId = `dup_${sha256(bucket.reason + ":" + bucket.bucketKey).slice(0, 24)}`;
        const confidence =
          bucket.reason === "exact_dedupe_key" || bucket.reason === "exact_content_hash" ? 0.98 : 0.86;
        insertGroup.run(groupId, representative, bucket.reason, confidence, articleIds.length, now, now);
        for (const articleId of articleIds) {
          insertMember.run(groupId, articleId, confidence, bucket.reason, articleId === representative ? 1 : 0, now);
          grouped.add(articleId);
        }
      }

      for (const bucketRows of boundedNearDuplicateBuckets(nearRows)) {
        const articleIds = new Set<string>();
        let reason: "near_title_simhash" | "near_summary_simhash" | null = null;
        for (let leftIndex = 0; leftIndex < bucketRows.length; leftIndex += 1) {
          const left = bucketRows[leftIndex]!;
          if (grouped.has(left.articleId)) {
            continue;
          }
          for (let rightIndex = leftIndex + 1; rightIndex < bucketRows.length; rightIndex += 1) {
            const right = bucketRows[rightIndex]!;
            if (grouped.has(right.articleId)) {
              continue;
            }
            if (
              left.titleSimhash &&
              right.titleSimhash &&
              hammingDistanceHex(left.titleSimhash, right.titleSimhash) <= 5
            ) {
              articleIds.add(left.articleId);
              articleIds.add(right.articleId);
              reason = "near_title_simhash";
            } else if (
              left.summarySimhash &&
              right.summarySimhash &&
              hammingDistanceHex(left.summarySimhash, right.summarySimhash) <= 8
            ) {
              articleIds.add(left.articleId);
              articleIds.add(right.articleId);
              reason = "near_summary_simhash";
            }
          }
        }
        if (articleIds.size < 2 || !reason) {
          continue;
        }
        const ids = Array.from(articleIds).sort();
        const representative = ids[0]!;
        const groupId = `dup_${sha256(reason + ":" + ids.join(":")).slice(0, 24)}`;
        insertGroup.run(groupId, representative, reason, 0.72, ids.length, now, now);
        for (const articleId of ids) {
          insertMember.run(groupId, articleId, 0.72, reason, articleId === representative ? 1 : 0, now);
          grouped.add(articleId);
        }
      }

      this.touchBackfillState("duplicate_group_rebuild", "succeeded", buckets.length + grouped.size);
    })();
  }

  private rebuildKeywordProfile(): void {
    const now = this.now();
    const rows = this.options.db
      .prepare(
        `
          select
            be.event_type as eventType,
            be.metadata_json as metadataJson,
            be.created_at as createdAt,
            coalesce(s.reading_progress, 0) as readingProgress,
            a.title,
            a.summary,
            ac.content_text as contentText,
            f.title as feedTitle
          from behavior_events be
          join articles a on a.id = be.article_id
          join feeds f on f.id = a.feed_id
          left join article_states s on s.article_id = a.id
          left join article_contents ac on ac.article_id = a.id
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
        `
      )
      .all() as Array<{
      eventType: string;
      metadataJson: string | null;
      createdAt: number;
      readingProgress: number;
      title: string;
      summary: string | null;
      contentText: string | null;
      feedTitle: string;
    }>;

    const weights = new Map<string, { weight: number; evidenceCount: number; lastEventAt: number }>();
    for (const row of rows) {
      const polarity = keywordPolarity(row.eventType, row.metadataJson, row.readingProgress);
      if (!polarity) {
        continue;
      }
      const eventWeight = keywordEventWeight(row.eventType, row.metadataJson, row.readingProgress);
      const ageHours = Math.max(0, (now - row.createdAt) / 3_600_000);
      const scopes: Array<{ scope: "long" | "recent"; decay: number }> = [
        { scope: "long", decay: Math.pow(0.5, ageHours / (24 * 45)) },
        { scope: "recent", decay: Math.pow(0.5, ageHours / 48) }
      ];
      const termWeights = new Map<string, number>();
      for (const term of profileTokens(row.title).slice(0, 12)) {
        termWeights.set(term, (termWeights.get(term) ?? 0) + 3 * profileTermMultiplier(term));
      }
      for (const term of profileTokens(row.summary ?? "").slice(0, 24)) {
        termWeights.set(term, (termWeights.get(term) ?? 0) + 1.5 * profileTermMultiplier(term));
      }
      for (const term of profileTokens((row.contentText ?? "").slice(0, 4000)).slice(0, 64)) {
        termWeights.set(term, (termWeights.get(term) ?? 0) + 0.35 * profileTermMultiplier(term));
      }
      for (const term of profileTokens(row.feedTitle).slice(0, 4)) {
        termWeights.set(term, (termWeights.get(term) ?? 0) + 0.4 * profileTermMultiplier(term));
      }
      for (const scope of scopes) {
        for (const [term, fieldWeight] of termWeights) {
          const key = `${polarity}:${scope.scope}:${term}`;
          const existing = weights.get(key) ?? { weight: 0, evidenceCount: 0, lastEventAt: 0 };
          weights.set(key, {
            weight: existing.weight + eventWeight * fieldWeight * scope.decay,
            evidenceCount: existing.evidenceCount + 1,
            lastEventAt: Math.max(existing.lastEventAt, row.createdAt)
          });
        }
      }
    }

    this.options.db.transaction(() => {
      this.options.db.prepare("delete from profile_terms").run();
      const insert = this.options.db.prepare(
        `
          insert into profile_terms (
            term,
            polarity,
            scope,
            weight,
            evidence_count,
            last_event_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?)
        `
      );
      for (const polarity of ["positive", "negative"] as const) {
        for (const scope of ["long", "recent"] as const) {
          const top = Array.from(weights.entries())
            .filter(([key]) => key.startsWith(`${polarity}:${scope}:`))
            .map(([key, value]) => ({
              term: key.slice(`${polarity}:${scope}:`.length),
              ...value
            }))
            .filter((item) => item.weight > 0)
            .sort((left, right) => right.weight - left.weight)
            .slice(0, 256);
          for (const item of top) {
            insert.run(
              item.term,
              polarity,
              scope,
              Number(item.weight.toFixed(6)),
              item.evidenceCount,
              item.lastEventAt || null,
              now
            );
          }
        }
      }
      this.touchBackfillState("keyword_profile_rebuild", "succeeded", weights.size);
    })();
  }

  private rebuildRecentIntent(): void {
    const now = this.now();
    const activeIndex = this.options.db
      .prepare(
        `
          select id
          from embedding_indexes
          where status = 'active'
          order by updated_at desc
          limit 1
        `
      )
      .get() as { id: string } | undefined;
    if (!activeIndex) {
      this.touchBackfillState("recent_intent_rebuild", "succeeded", 0);
      return;
    }
    const rows = this.options.db
      .prepare(
        `
          select
            be.event_type as eventType,
            be.metadata_json as metadataJson,
            be.created_at as createdAt,
            coalesce(s.reading_progress, 0) as readingProgress,
            ae.vector_blob as vectorBlob
          from behavior_events be
          join articles a on a.id = be.article_id
          join feeds f on f.id = a.feed_id
          join article_embeddings ae
            on ae.article_id = a.id
           and ae.embedding_index_id = ?
          left join article_states s on s.article_id = a.id
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and ae.vector_blob is not null
            and be.created_at >= ?
          order by be.created_at desc, be.id desc
          limit 100
        `
      )
      .all(activeIndex.id, now - 72 * 3_600_000) as Array<{
      eventType: string;
      metadataJson: string | null;
      createdAt: number;
      readingProgress: number;
      vectorBlob: Buffer;
    }>;

    const centroids = new Map<"positive" | "negative", { vector: number[]; weight: number; count: number }>();
    for (const row of rows) {
      const polarity = keywordPolarity(row.eventType, row.metadataJson, row.readingProgress);
      if (!polarity) {
        continue;
      }
      const ageHours = Math.max(0, (now - row.createdAt) / 3_600_000);
      const weight = keywordEventWeight(row.eventType, row.metadataJson, row.readingProgress) * Math.pow(0.5, ageHours / 18);
      const vector = fromVectorBlob(row.vectorBlob);
      const existing = centroids.get(polarity);
      if (!existing) {
        centroids.set(polarity, { vector: vector.map((value) => value * weight), weight, count: 1 });
      } else {
        existing.vector = existing.vector.map((value, index) => value + (vector[index] ?? 0) * weight);
        existing.weight += weight;
        existing.count += 1;
      }
    }

    this.options.db.transaction(() => {
      const upsert = this.options.db.prepare(
        `
          insert into recent_intent_profiles (
            id,
            embedding_index_id,
            polarity,
            centroid_vector_blob,
            weight,
            event_count,
            half_life_hours,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, 18, ?)
          on conflict(id) do update set
            centroid_vector_blob = excluded.centroid_vector_blob,
            weight = excluded.weight,
            event_count = excluded.event_count,
            half_life_hours = excluded.half_life_hours,
            updated_at = excluded.updated_at
        `
      );
      for (const polarity of ["positive", "negative"] as const) {
        const centroid = centroids.get(polarity);
        const id = `recent_intent_${activeIndex.id}_${polarity}`;
        if (!centroid || centroid.weight <= 0) {
          upsert.run(id, activeIndex.id, polarity, null, 0, 0, now);
          continue;
        }
        upsert.run(
          id,
          activeIndex.id,
          polarity,
          toVectorBlob(normalizeVector(centroid.vector.map((value) => value / centroid.weight))),
          Number(centroid.weight.toFixed(6)),
          centroid.count,
          now
        );
      }
      this.touchBackfillState("recent_intent_rebuild", "succeeded", rows.length);
    })();
  }

  private trainFtrl(): void {
    const now = this.now();
    const modelId = "ftrl_schema_3";
    const rows = this.options.db
      .prepare(
        `
          select
            be.id as eventId,
            be.article_id as articleId,
            be.event_type as eventType,
            be.metadata_json as metadataJson,
            be.created_at as createdAt,
            coalesce(s.reading_progress, 0) as readingProgress,
            ars.semantic_score as semanticScore,
            ars.bm25_score as bm25Score,
            ars.source_score as sourceScore,
            ars.freshness_score as freshnessScore,
            ars.state_score as stateScore,
            ars.duplicate_penalty as duplicatePenalty,
            ars.exposure_penalty as exposurePenalty,
            ars.exploration_bonus as explorationBonus,
            ars.rerank_position as rerankPosition
          from behavior_events be
          join articles a on a.id = be.article_id
          left join article_states s on s.article_id = be.article_id
          left join article_rank_scores ars
            on ars.article_id = be.article_id
           and ars.rank_context != 'base'
          where be.event_type in (
            'favorite',
            'like',
            'read_later',
            'mark_read',
            'read_complete',
            'read_progress',
            'open',
            'hide',
            'not_interested',
            'quick_bounce'
          )
          order by be.created_at, be.id
          limit 5000
        `
      )
      .all() as Array<{
      eventId: string;
      articleId: string;
      eventType: string;
      metadataJson: string | null;
      createdAt: number;
      readingProgress: number;
      semanticScore: number | null;
      bm25Score: number | null;
      sourceScore: number | null;
      freshnessScore: number | null;
      stateScore: number | null;
      duplicatePenalty: number | null;
      exposurePenalty: number | null;
      explorationBonus: number | null;
      rerankPosition: number | null;
    }>;

    const examples = rows
      .map((row) => trainingExampleFor(row))
      .filter((example): example is NonNullable<typeof example> => example !== null);
    const highQualitySamples = examples.filter((example) => example.sampleWeight >= 0.75).length;
    const existingModel = existingModelFor(this.options.db, modelId);
    const status = existingModel?.status === "active" ? "active" : "shadow";
    const existingMetrics = parseMetricsJson(existingModel?.metricsJson ?? null);
    const lifecycle = ftrlLifecycleFor({
      db: this.options.db,
      now,
      status,
      existingBlendAlpha: existingModel?.blendAlpha ?? 0,
      existingMetrics,
      highQualitySamples
    });

    this.options.db.transaction(() => {
      this.options.db
        .prepare(
          `
            insert into rank_model_versions (
              id,
              algorithm_version,
              feature_schema_version,
              status,
              sample_count,
              blend_alpha,
              metrics_json,
              created_at,
              updated_at
            )
            values (?, 'rec_v3', 3, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
              sample_count = excluded.sample_count,
              blend_alpha = excluded.blend_alpha,
              metrics_json = excluded.metrics_json,
              updated_at = excluded.updated_at
          `
        )
        .run(
          modelId,
          lifecycle.status,
          examples.length,
          lifecycle.blendAlpha,
          JSON.stringify({
            ...existingMetrics,
            highQualitySamples,
            lifecycleStatus: lifecycle.lifecycleStatus,
            mode: lifecycle.status,
            lastAlphaAdjustedAt: lifecycle.lastAlphaAdjustedAt,
            autoPausedReason: lifecycle.autoPausedReason
          }),
          now,
          now
        );

      const insertExample = this.options.db.prepare(
        `
          insert into rank_training_examples (
            id,
            model_version_id,
            article_id,
            behavior_event_id,
            label,
            sample_weight,
            event_type,
            exposure_context,
            rank_position_when_exposed,
            was_exploration,
            created_from,
            feature_values_json,
            created_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'behavior_event', ?, ?)
          on conflict(id) do nothing
        `
      );
      for (const example of examples) {
        insertExample.run(
          `train_${example.eventId}`,
          modelId,
          example.articleId,
          example.eventId,
          example.label,
          example.sampleWeight,
          example.eventType,
          example.exposureContext,
          example.rankPosition,
          example.wasExploration ? 1 : 0,
          JSON.stringify(Object.fromEntries(example.features)),
          example.createdAt
        );
      }

      this.options.db.prepare("delete from rank_model_weights where model_version_id = ?").run(modelId);
      const weights = trainFtrlWeights(examples);
      const insertWeight = this.options.db.prepare(
        `
          insert into rank_model_weights (
            model_version_id,
            feature_name,
            weight,
            accumulator,
            z,
            n,
            updated_at
          )
          values (?, ?, ?, 0, ?, ?, ?)
        `
      );
      for (const [featureName, state] of weights) {
        insertWeight.run(modelId, featureName, state.weight, state.z, state.n, now);
      }
      this.touchBackfillState("ftrl_train", "succeeded", examples.length);
    })();
    this.maybeAutoPromoteFtrl(modelId, highQualitySamples);
  }

  private maybeAutoPromoteFtrl(modelId: string, highQualitySamples: number): void {
    const maintenanceSettings = this.options.getMaintenanceSettings?.();
    const rankingSettings = this.options.getRankingSettings?.();
    if (
      !maintenanceSettings?.ftrlAutoPromoteEnabled ||
      !rankingSettings?.localLearningEnabled ||
      rankingSettings.localLearningShadowMode ||
      highQualitySamples < 150
    ) {
      return;
    }

    const latestEvaluation = this.options.db
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
    const metrics = parseMetricsJson(latestEvaluation?.metricsJson ?? null);
    if (metrics.evaluationMode !== "lightweight_replay_diagnostic" || metrics.diagnosticOnly !== true) {
      return;
    }

    if (hasElevatedNegativeFeedback(this.options.db, this.now())) {
      return;
    }

    const model = existingModelFor(this.options.db, modelId);
    if (!model || model.status !== "shadow" || model.blendAlpha <= 0) {
      return;
    }

    this.promoteFtrl();
  }

  private runReplayEvaluation(): void {
    const now = this.now();
    const runId = `eval_${now}_${randomBytes(4).toString("hex")}`;
    const cutoffRows = this.options.db
      .prepare(
        `
          select created_at as cutoffAt
          from behavior_events
          where created_at >= ?
          group by date(created_at / 1000, 'unixepoch')
          order by created_at desc
          limit 50
        `
      )
      .all(now - 60 * 86_400_000) as Array<{ cutoffAt: number }>;
    const metrics = replayMetricsFor(this.options.db, cutoffRows.map((row) => row.cutoffAt));

    this.options.db
      .prepare(
        `
          insert into ranking_eval_runs (
            id,
            algorithm_version,
            rank_context,
            status,
            metrics_json,
            error,
            created_at,
            started_at,
            finished_at
          )
          values (?, 'rec_v3', 'diagnostic', 'succeeded', ?, null, ?, ?, ?)
        `
      )
      .run(
        runId,
        JSON.stringify({
          evaluationMode: "lightweight_replay_diagnostic",
          strictReplay: false,
          diagnosticOnly: true,
          note:
            "Lightweight local replay diagnostic; not a full strict replay and not a causal A/B test.",
          ...metrics
        }),
        now,
        now,
        now
      );
    this.touchBackfillState("ranking_eval_run", "succeeded", 1);
  }

  private touchBackfillState(
    taskKey: string,
    status: "running" | "succeeded" | "failed",
    processedCount: number | null
  ): void {
    const now = this.now();
    this.options.db
      .prepare(
        `
          insert into recommendation_backfill_state (
            task_key,
            status,
            cursor,
            processed_count,
            error,
            started_at,
            updated_at,
            finished_at
          )
          values (?, ?, null, ?, null, ?, ?, ?)
          on conflict(task_key) do update set
            status = excluded.status,
            processed_count = case
              when excluded.processed_count is null then recommendation_backfill_state.processed_count
              else excluded.processed_count
            end,
            error = null,
            updated_at = excluded.updated_at,
            finished_at = excluded.finished_at
        `
      )
      .run(taskKey, status, processedCount ?? null, now, now, status === "succeeded" ? now : null);
  }
}

function randomJobId(): string {
  return `job_${Date.now()}_${randomBytes(6).toString("hex")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function simhash(text: string): string {
  const tokens = tokenize(text);
  const bits = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const hash = BigInt(`0x${sha256(token).slice(0, 16)}`);
    for (let bit = 0; bit < 64; bit += 1) {
      bits[bit] += (hash & (1n << BigInt(bit))) === 0n ? -1 : 1;
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if ((bits[bit] ?? 0) > 0) {
      result |= 1n << BigInt(bit);
    }
  }
  return result.toString(16).padStart(16, "0");
}

function hammingDistanceHex(left: string, right: string): number {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value > 0n) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}

function boundedNearDuplicateBuckets<T extends { normalizedTitle: string | null }>(
  rows: T[]
): T[][] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const tokens = tokenize(row.normalizedTitle ?? "").slice(0, 4);
    if (tokens.length === 0) {
      continue;
    }
    const key = tokens.join(" ");
    const bucket = buckets.get(key) ?? [];
    if (bucket.length < 80) {
      bucket.push(row);
    }
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).filter((bucket) => bucket.length > 1);
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .slice(0, 64)
    )
  );
}

function profileTokens(text: string): string[] {
  const cleaned = stripProfileNoise(text);
  return Array.from(
    new Set(
      cleaned
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter(isProfileTerm)
        .slice(0, 96)
    )
  );
}

function stripProfileNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\b(?:class|href|src|alt|title|width|height|style|data-[\w-]+)=["'][^"']*["']/gi, " ")
    .replace(/\b[a-z]+:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ");
}

function isProfileTerm(term: string): boolean {
  if (term.length < 2 || term.length > 32) {
    return false;
  }
  if (PROFILE_TERM_STOPWORDS.has(term)) {
    return false;
  }
  if (/^\d+$/.test(term)) {
    return false;
  }
  if (/^\d{4}[/-]?\d{0,2}[/-]?\d{0,2}$/.test(term)) {
    return false;
  }
  if (/^[a-f0-9]{16,}$/i.test(term)) {
    return false;
  }
  return true;
}

function profileTermMultiplier(term: string): number {
  return BROAD_PROFILE_TERMS.has(term) ? 0.42 : 1;
}

const PROFILE_TERM_STOPWORDS = new Set([
  "http",
  "https",
  "www",
  "com",
  "org",
  "net",
  "img",
  "src",
  "href",
  "class",
  "style",
  "alt",
  "title",
  "width",
  "height",
  "url",
  "css",
  "html",
  "decoding",
  "async",
  "aligncenter",
  "blockquote",
  "figure",
  "figcaption",
  "button",
  "newsletter",
  "subscribe",
  "login",
  "cookie",
  "cookies",
  "advertisement",
  "sponsored",
  "read",
  "more",
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "over",
  "your",
  "you",
  "are",
  "was",
  "were",
  "to",
  "in",
  "on",
  "of",
  "a",
  "an",
  "is"
]);

const BROAD_PROFILE_TERMS = new Set(["ai"]);

function keywordPolarity(
  eventType: string,
  metadataJson?: string | null,
  readingProgress?: number
): "positive" | "negative" | null {
  switch (eventType) {
    case "favorite":
    case "like":
    case "read_later":
    case "mark_read":
    case "read_complete":
      return "positive";
    case "read_progress": {
      const progress = progressFromMetadata(metadataJson) ?? readingProgress ?? 0;
      return progress >= 0.75
        ? "positive"
        : isQuickBounce(metadataJson, readingProgress)
          ? "negative"
          : null;
    }
    case "hide":
    case "not_interested":
    case "quick_bounce":
      return "negative";
    default:
      return null;
  }
}

function keywordEventWeight(
  eventType: string,
  metadataJson?: string | null,
  readingProgress?: number
): number {
  switch (eventType) {
    case "like":
      return 3;
    case "favorite":
      return 2.6;
    case "read_later":
      return 2;
    case "mark_read":
    case "read_complete":
      return 2.4;
    case "read_progress": {
      const progress = progressFromMetadata(metadataJson) ?? readingProgress ?? 0;
      if (progress >= 0.9) {
        return 2.2;
      }
      if (progress >= 0.75) {
        return 1.5;
      }
      return isQuickBounce(metadataJson, readingProgress) ? 0.8 : 0;
    }
    case "hide":
      return 2;
    case "not_interested":
      return 3;
    case "quick_bounce":
      return 1;
    default:
      return 0;
  }
}

function progressFromMetadata(metadataJson?: string | null): number | null {
  if (!metadataJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadataJson) as { progress?: unknown };
    return typeof parsed.progress === "number" ? parsed.progress : null;
  } catch {
    return null;
  }
}

function activeDurationFromMetadata(metadataJson?: string | null): number | null {
  if (!metadataJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadataJson) as { activeDurationMs?: unknown };
    return typeof parsed.activeDurationMs === "number" ? parsed.activeDurationMs : null;
  } catch {
    return null;
  }
}

function isQuickBounce(metadataJson?: string | null, readingProgress?: number): boolean {
  const duration = activeDurationFromMetadata(metadataJson);
  const progress = progressFromMetadata(metadataJson) ?? readingProgress ?? 0;
  return duration !== null && duration <= 5_000 && progress <= 0.1;
}

type FtrlTrainingExample = {
  eventId: string;
  articleId: string;
  eventType: string;
  label: number;
  sampleWeight: number;
  exposureContext: string;
  rankPosition: number | null;
  wasExploration: boolean;
  features: Map<string, number>;
  createdAt: number;
};

function trainingExampleFor(row: {
  eventId: string;
  articleId: string;
  eventType: string;
  metadataJson: string | null;
  readingProgress: number;
  semanticScore: number | null;
  bm25Score: number | null;
  sourceScore: number | null;
  freshnessScore: number | null;
  stateScore: number | null;
  duplicatePenalty: number | null;
  exposurePenalty: number | null;
  explorationBonus: number | null;
  rerankPosition: number | null;
  createdAt: number;
}): FtrlTrainingExample | null {
  const progress = progressFromMetadata(row.metadataJson) ?? row.readingProgress;
  const labelAndWeight = labelAndWeightForEvent(row.eventType, progress);
  if (!labelAndWeight) {
    return null;
  }
  return {
    eventId: row.eventId,
    articleId: row.articleId,
    eventType: row.eventType,
    label: labelAndWeight.label,
    sampleWeight: labelAndWeight.sampleWeight,
    exposureContext: row.rerankPosition === null ? "unknown" : "recommended",
    rankPosition: row.rerankPosition,
    wasExploration: (row.explorationBonus ?? 0) > 0,
    features: new Map(
      Object.entries({
        semantic: clamp((row.semanticScore ?? 0) / 0.68, 0, 1),
        bm25: clamp((row.bm25Score ?? 0) / 0.14, 0, 1),
        source: clamp(((row.sourceScore ?? 0) + 0.14) / 0.28, 0, 1),
        freshness: clamp((row.freshnessScore ?? 0) / 0.2, 0, 1),
        state: clamp(((row.stateScore ?? 0) + 0.12) / 0.36, 0, 1),
        duplicate_penalty: clamp(Math.abs(row.duplicatePenalty ?? 0) / 0.2, 0, 1),
        exposure_penalty: (row.exposurePenalty ?? 0) < 0 ? 1 : 0,
        exploration_bonus: (row.explorationBonus ?? 0) > 0 ? 1 : 0
      })
    ),
    createdAt: row.createdAt
  };
}

function labelAndWeightForEvent(
  eventType: string,
  progress: number
): { label: number; sampleWeight: number } | null {
  switch (eventType) {
    case "favorite":
    case "like":
      return { label: 1, sampleWeight: 1.5 };
    case "read_later":
      return { label: 0.9, sampleWeight: 1.3 };
    case "mark_read":
    case "read_complete":
      return { label: 0.85, sampleWeight: 1.2 };
    case "read_progress":
      if (progress >= 0.75) {
        return { label: 0.7, sampleWeight: 1 };
      }
      if (progress >= 0.5) {
        return { label: 0.5, sampleWeight: 0.4 };
      }
      return null;
    case "open":
      return { label: 0.2, sampleWeight: 0.05 };
    case "quick_bounce":
      return { label: 0.1, sampleWeight: 0.6 };
    case "hide":
    case "not_interested":
      return { label: 0, sampleWeight: 1.4 };
    default:
      return null;
  }
}

function trainFtrlWeights(
  examples: FtrlTrainingExample[]
): Map<string, { z: number; n: number; weight: number }> {
  const alpha = 0.05;
  const beta = 1;
  const lambda1 = 0.05;
  const lambda2 = 0.1;
  const maxAbsWeight = 5;
  const states = new Map<string, { z: number; n: number; weight: number }>();
  const stateFor = (feature: string) => {
    const state = states.get(feature) ?? { z: 0, n: 0, weight: 0 };
    states.set(feature, state);
    return state;
  };
  const computeWeight = (state: { z: number; n: number }): number => {
    if (Math.abs(state.z) <= lambda1) {
      return 0;
    }
    const sign = state.z < 0 ? -1 : 1;
    return clamp(
      -(state.z - sign * lambda1) / ((beta + Math.sqrt(state.n)) / alpha + lambda2),
      -maxAbsWeight,
      maxAbsWeight
    );
  };

  for (const example of examples) {
    let logit = 0;
    for (const [feature, value] of example.features) {
      const state = stateFor(feature);
      state.weight = computeWeight(state);
      logit += state.weight * value;
    }
    const prediction = 1 / (1 + Math.exp(-logit));
    for (const [feature, value] of example.features) {
      const state = stateFor(feature);
      const gradient = (prediction - example.label) * value * example.sampleWeight;
      const sigma = (Math.sqrt(state.n + gradient * gradient) - Math.sqrt(state.n)) / alpha;
      state.z += gradient - sigma * state.weight;
      state.n += gradient * gradient;
      state.weight = computeWeight(state);
    }
  }
  return states;
}

type FtrlLifecycleStatus =
  | "shadow_no_samples"
  | "insufficient_samples"
  | "shadow_training"
  | "ready_to_promote"
  | "active_low_weight"
  | "active"
  | "auto_paused"
  | "retired";

type FtrlMetricsJson = {
  highQualitySamples?: number;
  lastAlphaAdjustedAt?: number | null;
  autoPausedReason?: string | null;
  lifecycleStatus?: FtrlLifecycleStatus;
  [key: string]: unknown;
};

function ftrlLifecycleFor(input: {
  db: DibaoDatabase;
  now: number;
  status: "shadow" | "active";
  existingBlendAlpha: number;
  existingMetrics: FtrlMetricsJson;
  highQualitySamples: number;
}): {
  status: "shadow" | "active";
  blendAlpha: number;
  lifecycleStatus: FtrlLifecycleStatus;
  lastAlphaAdjustedAt: number | null;
  autoPausedReason: string | null;
} {
  if (input.highQualitySamples <= 0) {
    return {
      status: "shadow",
      blendAlpha: 0,
      lifecycleStatus: "shadow_no_samples",
      lastAlphaAdjustedAt: null,
      autoPausedReason: null
    };
  }

  if (input.status !== "active") {
    return {
      status: "shadow",
      blendAlpha: input.highQualitySamples >= 100 ? FTRL_INITIAL_ACTIVE_ALPHA : 0,
      lifecycleStatus:
        input.highQualitySamples >= 100
          ? "ready_to_promote"
          : input.highQualitySamples >= 50
            ? "shadow_training"
            : "insufficient_samples",
      lastAlphaAdjustedAt: null,
      autoPausedReason: null
    };
  }

  const lastAlphaAdjustedAt =
    typeof input.existingMetrics.lastAlphaAdjustedAt === "number"
      ? input.existingMetrics.lastAlphaAdjustedAt
      : null;
  const negativeFeedbackIsHigh = hasElevatedNegativeFeedback(input.db, input.now);
  let blendAlpha = clamp(
    Math.max(input.existingBlendAlpha, FTRL_INITIAL_ACTIVE_ALPHA),
    0,
    FTRL_ACTIVE_ALPHA_CAP
  );
  let nextLastAlphaAdjustedAt = lastAlphaAdjustedAt;
  let autoPausedReason: string | null =
    typeof input.existingMetrics.autoPausedReason === "string"
      ? input.existingMetrics.autoPausedReason
      : null;

  if (
    lastAlphaAdjustedAt === null ||
    input.now - lastAlphaAdjustedAt >= FTRL_ALPHA_ADJUST_INTERVAL_MS
  ) {
    if (negativeFeedbackIsHigh) {
      blendAlpha = Math.max(0, Number((blendAlpha - FTRL_ALPHA_STEP).toFixed(4)));
      autoPausedReason = "negative_feedback_elevated";
      nextLastAlphaAdjustedAt = input.now;
    } else if (autoPausedReason === null) {
      blendAlpha = Math.min(
        FTRL_ACTIVE_ALPHA_CAP,
        Number((blendAlpha + FTRL_ALPHA_STEP).toFixed(4))
      );
      nextLastAlphaAdjustedAt = input.now;
    }
  }

  if (blendAlpha <= 0 && negativeFeedbackIsHigh) {
    return {
      status: "shadow",
      blendAlpha: 0,
      lifecycleStatus: "auto_paused",
      lastAlphaAdjustedAt: nextLastAlphaAdjustedAt,
      autoPausedReason: "negative_feedback_elevated"
    };
  }

  return {
    status: "active",
    blendAlpha: clamp(blendAlpha, 0, FTRL_ACTIVE_ALPHA_CAP),
    lifecycleStatus: blendAlpha <= 0.05 ? "active_low_weight" : "active",
    lastAlphaAdjustedAt: nextLastAlphaAdjustedAt,
    autoPausedReason
  };
}

function hasElevatedNegativeFeedback(db: DibaoDatabase, now: number): boolean {
  const row = db
    .prepare(
      `
        select
          count(*) as total,
          sum(case when event_type in ('hide', 'not_interested') then 1 else 0 end) as negative
        from behavior_events
        where created_at >= ?
      `
    )
    .get(now - 7 * 86_400_000) as { total: number; negative: number | null } | undefined;
  const total = row?.total ?? 0;
  if (total < 20) {
    return false;
  }
  return ((row?.negative ?? 0) / total) >= 0.35;
}

function existingModelFor(
  db: DibaoDatabase,
  modelId: string
): { status: "shadow" | "active" | "retired" | "failed"; blendAlpha: number; metricsJson: string | null } | null {
  const row = db
    .prepare("select status, blend_alpha as blendAlpha, metrics_json as metricsJson from rank_model_versions where id = ?")
    .get(modelId) as
    | { status: "shadow" | "active" | "retired" | "failed"; blendAlpha: number; metricsJson: string | null }
    | undefined;
  return row ?? null;
}

function existingModelStatus(
  db: DibaoDatabase,
  modelId: string
): "shadow" | "active" | "retired" | "failed" | null {
  const row = db
    .prepare("select status from rank_model_versions where id = ?")
    .get(modelId) as { status: "shadow" | "active" | "retired" | "failed" } | undefined;
  return row?.status ?? null;
}

function highQualitySampleCountFor(metricsJson: string | null): number {
  if (!metricsJson) {
    return 0;
  }
  try {
    const metrics = JSON.parse(metricsJson) as { highQualitySamples?: unknown };
    return typeof metrics.highQualitySamples === "number" ? metrics.highQualitySamples : 0;
  } catch {
    return 0;
  }
}

function parseMetricsJson(metricsJson: string | null): FtrlMetricsJson {
  if (!metricsJson) {
    return {};
  }
  try {
    const metrics = JSON.parse(metricsJson) as unknown;
    return typeof metrics === "object" && metrics !== null && !Array.isArray(metrics)
      ? (metrics as FtrlMetricsJson)
      : {};
  } catch {
    return {};
  }
}

function replayMetricsFor(
  db: DibaoDatabase,
  cutoffs: number[]
): Record<string, number> {
  let labelCount = 0;
  let hit10 = 0;
  let mrrTotal = 0;
  let ndcg10Total = 0;
  const positiveRanks: number[] = [];
  for (const cutoff of cutoffs) {
    const positives = db
      .prepare(
        `
          select distinct article_id as articleId
          from behavior_events
          where created_at > ?
            and created_at <= ?
            and event_type in ('favorite', 'like', 'read_later', 'mark_read', 'read_complete')
          limit 50
        `
      )
      .all(cutoff, cutoff + 7 * 86_400_000) as Array<{ articleId: string }>;
    if (positives.length === 0) {
      continue;
    }
    const positiveSet = new Set(positives.map((row) => row.articleId));
    const candidates = db
      .prepare(
        `
          select
            a.id as articleId,
            a.title,
            a.summary,
            coalesce(a.published_at, a.discovered_at) as articleTime
          from articles a
          join feeds f on f.id = a.feed_id
          left join article_states s on s.article_id = a.id
          where a.discovered_at <= ?
            and a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and s.hidden_at is null
            and s.not_interested_at is null
          order by coalesce(a.published_at, a.discovered_at) desc, a.id desc
          limit 300
        `
      )
      .all(cutoff) as Array<{
      articleId: string;
      title: string;
      summary: string | null;
      articleTime: number;
    }>;
    const profileTerms = lightweightReplayTerms(db, cutoff);
    const ranked = candidates
      .map((candidate) => ({
        articleId: candidate.articleId,
        score:
          replayTermOverlap(`${candidate.title} ${candidate.summary ?? ""}`, profileTerms) * 10 +
          candidate.articleTime / 86_400_000
      }))
      .sort((left, right) => right.score - left.score || right.articleId.localeCompare(left.articleId));
    labelCount += positiveSet.size;
    let firstRank: number | null = null;
    let dcg10 = 0;
    for (let index = 0; index < ranked.length; index += 1) {
      if (!positiveSet.has(ranked[index]!.articleId)) {
        continue;
      }
      const rank = index + 1;
      positiveRanks.push(rank);
      firstRank = firstRank === null ? rank : Math.min(firstRank, rank);
      if (rank <= 10) {
        hit10 += 1;
        dcg10 += 1 / Math.log2(rank + 1);
      }
    }
    if (firstRank !== null) {
      mrrTotal += 1 / firstRank;
    }
    const ideal = Array.from({ length: Math.min(10, positiveSet.size) }).reduce<number>(
      (sum, _value, index) => sum + 1 / Math.log2(index + 2),
      0
    );
    ndcg10Total += ideal > 0 ? dcg10 / ideal : 0;
  }
  positiveRanks.sort((left, right) => left - right);
  const evaluatedCutoffs = cutoffs.length;
  return {
    cutoffCount: evaluatedCutoffs,
    labelCount,
    sampleCount: positiveRanks.length,
    hitAt10: labelCount > 0 ? hit10 / labelCount : 0,
    ndcgAt10: evaluatedCutoffs > 0 ? ndcg10Total / evaluatedCutoffs : 0,
    mrr: evaluatedCutoffs > 0 ? mrrTotal / evaluatedCutoffs : 0,
    positiveRankMedian:
      positiveRanks.length > 0 ? positiveRanks[Math.floor(positiveRanks.length / 2)]! : 0
  };
}

function lightweightReplayTerms(db: DibaoDatabase, cutoff: number): Set<string> {
  const rows = db
    .prepare(
      `
        select a.title, a.summary
        from behavior_events be
        join articles a on a.id = be.article_id
        where be.created_at < ?
          and be.event_type in ('favorite', 'like', 'read_later', 'mark_read', 'read_complete', 'read_progress')
        order by be.created_at desc
        limit 100
      `
    )
    .all(cutoff) as Array<{ title: string; summary: string | null }>;
  const terms = new Set<string>();
  for (const row of rows) {
    for (const term of tokenize(`${row.title} ${row.summary ?? ""}`).slice(0, 12)) {
      terms.add(term);
      if (terms.size >= 64) {
        return terms;
      }
    }
  }
  return terms;
}

function replayTermOverlap(text: string, terms: Set<string>): number {
  if (terms.size === 0) {
    return 0;
  }
  const candidateTerms = new Set(tokenize(text));
  let matches = 0;
  for (const term of terms) {
    if (candidateTerms.has(term)) {
      matches += 1;
    }
  }
  return matches / Math.max(terms.size, 1);
}
