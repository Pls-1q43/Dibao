import { randomBytes } from "node:crypto";
import type { DibaoDatabase } from "@dibao/db";

export const USER_REPRESENTATION_SCHEMA_VERSION = 1;
const EXPOSURE_BATCH_LIMIT = 100;

export type RecommendationExposureInput = {
  clientSessionId: string;
  articleIds: string[];
  exposedAt?: number;
};

export type UserRepresentationSnapshotSummary = {
  schemaVersion: number;
  embeddingIndexId: string | null;
  generatedAt: number;
  sourceWatermark: number;
};

export class RecommendationMemoryService {
  constructor(
    private readonly db: DibaoDatabase,
    private readonly now: () => number = Date.now
  ) {}

  snapshotSummary(): UserRepresentationSnapshotSummary | null {
    const row = this.db
      .prepare(
        `
          select
            schema_version as schemaVersion,
            embedding_index_id as embeddingIndexId,
            generated_at as generatedAt,
            source_watermark as sourceWatermark
          from user_representation_snapshots
          where id = 'current'
        `
      )
      .get() as UserRepresentationSnapshotSummary | undefined;
    return row ?? null;
  }

  rebuildSnapshot(): UserRepresentationSnapshotSummary {
    const now = this.now();
    this.db.prepare(`delete from recommendation_exposures where exposed_at < ?`).run(now - 30 * 86_400_000);
    const activeIndex = this.db
      .prepare(
        `select id from embedding_indexes where status = 'active' order by updated_at desc limit 1`
      )
      .get() as { id: string } | undefined;
    const sourceWatermark = (
      this.db.prepare(`select coalesce(max(created_at), 0) as value from behavior_events`).get() as {
        value: number;
      }
    ).value;
    const payload = {
      schemaVersion: USER_REPRESENTATION_SCHEMA_VERSION,
      generatedAt: now,
      embeddingIndexId: activeIndex?.id ?? null,
      longTermInterestFamilies: this.db
        .prepare(
          `
            select id, polarity, weight, maturity, dominance_ratio as dominanceRatio, updated_at as updatedAt
            from interest_families
            where embedding_index_id = ?
            order by weight desc
            limit 32
          `
        )
        .all(activeIndex?.id ?? "") ,
      recentIntents: this.db
        .prepare(
          `
            select polarity, weight, event_count as eventCount, half_life_hours as halfLifeHours, updated_at as updatedAt
            from recent_intent_profiles
            where embedding_index_id = ?
            order by polarity
          `
        )
        .all(activeIndex?.id ?? ""),
      recentStrongBehaviorRefs: this.db
        .prepare(
          `
            select be.article_id as articleId, be.event_type as eventType, be.created_at as createdAt
            from behavior_events be
            where be.event_type in ('favorite', 'like', 'read_later', 'read_complete', 'hide', 'not_interested')
               or (be.event_type = 'read_progress' and coalesce(json_extract(be.metadata_json, '$.progress'), 0) >= 0.75)
            order by be.created_at desc, be.id desc
            limit 50
          `
        )
        .all(),
      sourcePreferences: this.db
        .prepare(
          `
            select feed_id as feedId, smoothed_positive_rate as positiveRate, source_confidence as confidence
            from feed_stats
            order by source_confidence desc, smoothed_positive_rate desc
            limit 32
          `
        )
        .all(),
      recentExposureFatigue: this.db
        .prepare(
          `
            select
              count(*) as exposureCount,
              count(distinct feed_id) as feedCount,
              count(distinct interest_family_id) as familyCount,
              count(distinct duplicate_group_id) as duplicateGroupCount
            from recommendation_exposures
            where exposed_at >= ?
          `
        )
        .get(now - 7 * 86_400_000),
      explorationOutcomes: this.db
        .prepare(
          `
            select bucket_key as bucketKey, bucket_type as bucketType, impressions,
              positive_events as positiveEvents, negative_events as negativeEvents, alpha, beta, updated_at as updatedAt
            from exploration_buckets
            order by updated_at desc
            limit 32
          `
        )
        .all()
    };

    this.db
      .prepare(
        `
          insert into user_representation_snapshots (
            id, schema_version, embedding_index_id, source_watermark, payload_json, generated_at, updated_at
          ) values ('current', ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            schema_version = excluded.schema_version,
            embedding_index_id = excluded.embedding_index_id,
            source_watermark = excluded.source_watermark,
            payload_json = excluded.payload_json,
            generated_at = excluded.generated_at,
            updated_at = excluded.updated_at
        `
      )
      .run(
        USER_REPRESENTATION_SCHEMA_VERSION,
        activeIndex?.id ?? null,
        sourceWatermark,
        JSON.stringify(payload),
        now,
        now
      );

    return {
      schemaVersion: USER_REPRESENTATION_SCHEMA_VERSION,
      embeddingIndexId: activeIndex?.id ?? null,
      generatedAt: now,
      sourceWatermark
    };
  }

  recordExposures(input: RecommendationExposureInput): { recorded: number; existing: number } {
    const clientSessionId = input.clientSessionId.trim();
    const articleIds = Array.from(new Set(input.articleIds.filter((id) => typeof id === "string" && id.length > 0)))
      .slice(0, EXPOSURE_BATCH_LIMIT);
    if (!clientSessionId || articleIds.length === 0) {
      return { recorded: 0, existing: 0 };
    }
    const exposedAt = input.exposedAt ?? this.now();
    const placeholders = articleIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
          select
            a.id as articleId,
            a.feed_id as feedId,
            rs.rank_context as rankContext,
            rs.rerank_position as rankPosition,
            json_extract(re.payload_json, '$.components.primaryFamilyId') as familyId,
            dgm.duplicate_group_id as duplicateGroupId,
            rs.was_exploration as wasExploration,
            rs.exploration_bucket_key as explorationBucketKey
          from articles a
          join article_rank_scores rs on rs.article_id = a.id
          left join article_rank_explanations re
            on re.article_id = a.id and re.rank_context = rs.rank_context
          left join duplicate_group_members dgm on dgm.article_id = a.id
          where a.id in (${placeholders})
            and rs.rank_context != 'base'
        `
      )
      .all(...articleIds) as Array<{
      articleId: string;
      feedId: string | null;
      rankContext: string;
      rankPosition: number | null;
      familyId: string | null;
      duplicateGroupId: string | null;
      wasExploration: 0 | 1;
      explorationBucketKey: string | null;
    }>;
    let recorded = 0;
    let existing = 0;
    const insert = this.db.prepare(
      `
        insert into recommendation_exposures (
          id, client_session_id, article_id, rank_context, rank_position, feed_id,
          interest_family_id, duplicate_group_id, was_exploration, exploration_bucket_key, exposed_at, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(client_session_id, article_id) do nothing
      `
    );
    const ensureBucket = this.db.prepare(
      `
        insert into exploration_buckets (bucket_key, bucket_type, impressions, positive_events, negative_events, alpha, beta, updated_at)
        values (?, ?, 0, 0, 0, 1, 1, ?)
        on conflict(bucket_key) do nothing
      `
    );
    const insertAttempt = this.db.prepare(
      `
        insert into exploration_attempts (exposure_id, bucket_key, article_id, created_at, updated_at)
        values (?, ?, ?, ?, ?)
        on conflict(exposure_id) do nothing
      `
    );
    const incrementBucket = this.db.prepare(
      `update exploration_buckets set impressions = impressions + 1, updated_at = ? where bucket_key = ?`
    );

    this.db.transaction(() => {
      for (const row of rows) {
        const exposureId = `exposure_${randomBytes(10).toString("hex")}`;
        const result = insert.run(
          exposureId,
          clientSessionId,
          row.articleId,
          row.rankContext,
          row.rankPosition,
          row.feedId,
          row.familyId,
          row.duplicateGroupId,
          row.wasExploration,
          row.explorationBucketKey,
          exposedAt,
          this.now()
        );
        if (result.changes === 0) {
          existing += 1;
          continue;
        }
        recorded += 1;
        if (row.wasExploration === 1 && row.explorationBucketKey) {
          ensureBucket.run(row.explorationBucketKey, "ranking", this.now());
          insertAttempt.run(exposureId, row.explorationBucketKey, row.articleId, this.now(), this.now());
          incrementBucket.run(this.now(), row.explorationBucketKey);
        }
      }
    })();
    return { recorded, existing };
  }

  recordBehaviorOutcome(input: {
    articleId: string;
    type: string;
    progress?: number;
    now?: number;
  }): void {
    const outcome = explorationOutcomeForBehavior(input.type, input.progress);
    if (!outcome) return;
    const now = input.now ?? this.now();
    const attempt = this.db
      .prepare(
        `
          select ea.exposure_id as exposureId, ea.bucket_key as bucketKey
          from exploration_attempts ea
          join recommendation_exposures re on re.id = ea.exposure_id
          where ea.article_id = ? and ea.outcome = 'pending' and re.exposed_at >= ?
          order by re.exposed_at desc
          limit 1
        `
      )
      .get(input.articleId, now - 7 * 86_400_000) as { exposureId: string; bucketKey: string } | undefined;
    if (!attempt) return;
    const delta = outcome === "strong_success" ? 2 : outcome === "success" ? 1 : 2;
    this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `update exploration_attempts set outcome = ?, outcome_at = ?, updated_at = ? where exposure_id = ? and outcome = 'pending'`
        )
        .run(outcome, now, now, attempt.exposureId);
      if (updated.changes === 0) return;
      if (outcome === "strong_failure") {
        this.db
          .prepare(`update exploration_buckets set beta = beta + ?, negative_events = negative_events + 1, updated_at = ? where bucket_key = ?`)
          .run(delta, now, attempt.bucketKey);
      } else {
        this.db
          .prepare(`update exploration_buckets set alpha = alpha + ?, positive_events = positive_events + 1, updated_at = ? where bucket_key = ?`)
          .run(delta, now, attempt.bucketKey);
      }
    })();
  }
}

function explorationOutcomeForBehavior(
  type: string,
  progress?: number
): "success" | "strong_success" | "strong_failure" | null {
  if (type === "favorite" || type === "like" || type === "read_later") return "strong_success";
  if (type === "hide" || type === "not_interested") return "strong_failure";
  if (type === "mark_read" || (type === "read_progress" && (progress ?? 0) >= 0.75)) return "success";
  return null;
}
