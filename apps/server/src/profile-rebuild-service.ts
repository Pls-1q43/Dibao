import { setImmediate as delayImmediate } from "node:timers/promises";
import { SqliteRankingRepository, type DibaoDatabase } from "@dibao/db";
import type {
  ClusterLabelRebuildProgress,
  InterestClusterLabelService
} from "./interest-cluster-label-service.js";
import type { InterestClusterCalibrationService } from "./interest-cluster-calibration-service.js";
import type { InterestFamilyService } from "./interest-family-service.js";
import type { ProfileService } from "./profile-service.js";
import {
  RECOMMENDATION_ALGORITHM_VERSION,
  RECOMMENDATION_FEATURE_SCHEMA_VERSION,
  type RecommendationRankingService
} from "./ranking-service.js";

export type ProfileRebuildInput = {
  chunkSize?: number;
  rebuildLabels?: boolean;
  rebuildFamilies?: boolean;
  recalculateRanking?: boolean;
};

export type ProfileRebuildStep = "reset" | "replay" | "labels" | "families" | "ranking";

export type ProfileRebuildProgress = {
  step: ProfileRebuildStep;
  articleCount: number;
  articleIdsProcessed: number;
  chunksProcessed: number;
  workUnitCount?: number;
  workUnitsProcessed?: number;
};

export type AsyncProfileRebuildInput = ProfileRebuildInput & {
  onProgress?: (progress: ProfileRebuildProgress) => void;
};

export type ProfileRebuildResult = {
  embeddingIndexId: string | null;
  reset: {
    clustersDeleted: number;
    evidenceDeleted: number;
    labelsDeleted: number;
    familiesDeleted: number;
    familyMembersDeleted: number;
    mergeCandidatesDeleted: number;
    snapshotsTouched: number;
    invalidSnapshots: number;
  };
  replay: {
    articleCount: number;
    articleIdsProcessed: number;
    chunksProcessed: number;
    profileChanged: boolean;
  };
  rebuilt: {
    labels: number | null;
    families: number | null;
    familyMembers: number | null;
    rankingRows: number | null;
  };
  after: {
    clusters: number;
    evidence: number;
  };
};

export type ProfileRebuildServiceOptions = {
  db: DibaoDatabase;
  profile: Pick<ProfileService, "processArticleEvents"> &
    Partial<Pick<ProfileService, "beginDeferredClusterTrim" | "finalizeClusterMaintenance">>;
  clusterLabels?: Pick<InterestClusterLabelService, "rebuildIndexLabels"> &
    Partial<Pick<InterestClusterLabelService, "rebuildIndexLabelsAsync">>;
  calibration?: Pick<InterestClusterCalibrationService, "getOrCreateCalibration" | "refreshCalibration">;
  interestFamilies?: Pick<InterestFamilyService, "rebuildFamiliesForIndex">;
  ranking?: Pick<RecommendationRankingService, "recalculateAll"> &
    Partial<Pick<RecommendationRankingService, "getActiveRankContext" | "recalculateArticles" | "createBlockingUpgradeSession">>;
};

type TopicSnapshot = {
  profileV0?: Record<string, unknown>;
};

type SnapshotRow = {
  articleId: string;
  topicSnapshotJson: string | null;
};

export class ProfileRebuildService {
  constructor(private readonly options: ProfileRebuildServiceOptions) {}

  getRankContract() {
    return {
      rankContext: this.options.ranking?.getActiveRankContext?.() ?? "base",
      algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
      featureSchemaVersion: RECOMMENDATION_FEATURE_SCHEMA_VERSION
    };
  }

  async rebuildAllRankingsAsync(onProgress: (progress: ProfileRebuildProgress) => void): Promise<number> {
    const ranking = this.options.ranking;
    if (!ranking?.recalculateArticles) {
      throw new Error("Full ranking upgrade requires a ranking service");
    }
    const repository = new SqliteRankingRepository(this.options.db);
    const contract = this.getRankContract();
    let cursor: string | null = null;
    let processed = 0;
    let chunks = 0;
    const total = (this.options.db.prepare(`
      select count(*) as count from articles a join feeds f on f.id = a.feed_id
      where a.deleted_at is null and a.status != 'deleted' and f.deleted_at is null and f.enabled = 1
    `).get() as { count: number }).count;
    const score = this.options.db.prepare(`
      select algorithm_version as algorithmVersion, feature_schema_version as featureSchemaVersion
      from article_rank_scores where article_id = ? and rank_context = ?
    `);

    const session = ranking.createBlockingUpgradeSession?.();
    try {
      // recalculateAll uses a bounded discovery window. Upgrade must visit every
      // eligible article, including those outside that ordinary ranking window.
      while (true) {
        onProgress({ step: "ranking", articleCount: total, articleIdsProcessed: processed, chunksProcessed: chunks });
        const candidates = repository.listCandidates({ afterArticleId: cursor, limit: 50 });
        if (candidates.length === 0) {
          break;
        }
        const ids = candidates.map((candidate) => candidate.articleId);
        const written = session ? session.recalculateArticles(ids) : ranking.recalculateArticles(ids);
        if (written !== ids.length) {
          throw new Error(`Incomplete ranking upgrade: expected ${ids.length}, wrote ${written}`);
        }
        for (const candidate of candidates) {
          const id = candidate.articleId;
          // The ranking contract intentionally gives interacted articles only
          // baseline scores; embedding-context scores are for unseen articles.
          const expectedContext = candidate.stateRowExists ? "base" : contract.rankContext;
          const row = score.get(id, expectedContext) as typeof contract | undefined;
          if (!row || (expectedContext !== "base" &&
            (row.algorithmVersion !== contract.algorithmVersion || row.featureSchemaVersion !== contract.featureSchemaVersion))) {
            throw new Error(`Missing current-contract ranking for ${id} (${expectedContext})`);
          }
        }
        processed += ids.length;
        chunks += 1;
        cursor = ids.at(-1)!;
        await delayImmediate();
      }
      onProgress({ step: "ranking", articleCount: processed, articleIdsProcessed: processed, chunksProcessed: chunks });
      return processed;
    } finally {
      session?.dispose();
    }
  }

  rebuildActiveIndexProfile(input: ProfileRebuildInput = {}): ProfileRebuildResult {
    const embeddingIndexId = this.activeEmbeddingIndexId();
    if (!embeddingIndexId) {
      return emptyRebuildResult();
    }

    this.options.calibration?.refreshCalibration(embeddingIndexId);
    const reset = this.resetActiveIndexProfile(embeddingIndexId);
    const articleIds = this.listReplayArticleIds(embeddingIndexId);
    const chunkSize = clampChunkSize(input.chunkSize);
    let articleIdsProcessed = 0;
    let chunksProcessed = 0;
    let profileChanged = false;

    const endDeferredTrim = this.options.profile.beginDeferredClusterTrim?.();
    try {
      for (let offset = 0; offset < articleIds.length; offset += chunkSize) {
        const chunk = articleIds.slice(offset, offset + chunkSize);
        const result = this.options.profile.processArticleEvents(chunk);
        articleIdsProcessed += result.articleIds.length;
        chunksProcessed += 1;
        profileChanged = result.profileChanged || profileChanged;
      }
    } finally {
      endDeferredTrim?.();
    }
    this.options.profile.finalizeClusterMaintenance?.(embeddingIndexId);

    const labels =
      input.rebuildLabels === false
        ? null
        : this.options.clusterLabels?.rebuildIndexLabels(embeddingIndexId) ?? null;
    const familyResult =
      input.rebuildFamilies === false
        ? null
        : this.options.interestFamilies?.rebuildFamiliesForIndex(embeddingIndexId) ?? null;
    const rankingRows =
      input.recalculateRanking === false
        ? null
        : this.options.ranking?.recalculateAll() ?? null;

    return {
      embeddingIndexId,
      reset,
      replay: {
        articleCount: articleIds.length,
        articleIdsProcessed,
        chunksProcessed,
        profileChanged
      },
      rebuilt: {
        labels,
        families: familyResult?.familyCount ?? null,
        familyMembers: familyResult?.memberCount ?? null,
        rankingRows
      },
      after: {
        clusters: this.countActiveIndexRows("interest_clusters", embeddingIndexId),
        evidence: this.countActiveIndexEvidence(embeddingIndexId)
      }
    };
  }

  async rebuildActiveIndexProfileAsync(
    input: AsyncProfileRebuildInput = {}
  ): Promise<ProfileRebuildResult> {
    const embeddingIndexId = this.activeEmbeddingIndexId();
    if (!embeddingIndexId) {
      return emptyRebuildResult();
    }

    input.onProgress?.({
      step: "reset",
      articleCount: 0,
      articleIdsProcessed: 0,
      chunksProcessed: 0
    });
    await delayImmediate();
    this.options.calibration?.refreshCalibration(embeddingIndexId);
    const reset = this.resetActiveIndexProfile(embeddingIndexId);
    const articleIds = this.listReplayArticleIds(embeddingIndexId);
    const chunkSize = clampChunkSize(input.chunkSize);
    let articleIdsProcessed = 0;
    let chunksProcessed = 0;
    let profileChanged = false;

    input.onProgress?.({
      step: "replay",
      articleCount: articleIds.length,
      articleIdsProcessed,
      chunksProcessed
    });
    const endDeferredTrim = this.options.profile.beginDeferredClusterTrim?.();
    try {
      for (let offset = 0; offset < articleIds.length; offset += chunkSize) {
        const chunk = articleIds.slice(offset, offset + chunkSize);
        const result = this.options.profile.processArticleEvents(chunk);
        articleIdsProcessed += result.articleIds.length;
        chunksProcessed += 1;
        profileChanged = result.profileChanged || profileChanged;
        input.onProgress?.({
          step: "replay",
          articleCount: articleIds.length,
          articleIdsProcessed,
          chunksProcessed
        });
        await delayImmediate();
      }
    } finally {
      endDeferredTrim?.();
    }
    this.options.profile.finalizeClusterMaintenance?.(embeddingIndexId);

    input.onProgress?.({
      step: "labels",
      articleCount: articleIds.length,
      articleIdsProcessed,
      chunksProcessed
    });
    await delayImmediate();
    const labels =
      input.rebuildLabels === false
        ? null
        : await this.rebuildLabelsAsync(embeddingIndexId, {
            chunkSize,
            articleCount: articleIds.length,
            articleIdsProcessed,
            chunksProcessed,
            onProgress: input.onProgress
          });

    input.onProgress?.({
      step: "families",
      articleCount: articleIds.length,
      articleIdsProcessed,
      chunksProcessed
    });
    await delayImmediate();
    const familyResult =
      input.rebuildFamilies === false
        ? null
        : this.options.interestFamilies?.rebuildFamiliesForIndex(embeddingIndexId) ?? null;

    input.onProgress?.({
      step: "ranking",
      articleCount: articleIds.length,
      articleIdsProcessed,
      chunksProcessed
    });
    await delayImmediate();
    const rankingRows =
      input.recalculateRanking === false
        ? null
        : this.options.ranking?.recalculateAll() ?? null;

    return {
      embeddingIndexId,
      reset,
      replay: {
        articleCount: articleIds.length,
        articleIdsProcessed,
        chunksProcessed,
        profileChanged
      },
      rebuilt: {
        labels,
        families: familyResult?.familyCount ?? null,
        familyMembers: familyResult?.memberCount ?? null,
        rankingRows
      },
      after: {
        clusters: this.countActiveIndexRows("interest_clusters", embeddingIndexId),
        evidence: this.countActiveIndexEvidence(embeddingIndexId)
      }
    };
  }

  private resetActiveIndexProfile(embeddingIndexId: string): ProfileRebuildResult["reset"] {
    const before = {
      clustersDeleted: this.countActiveIndexRows("interest_clusters", embeddingIndexId),
      evidenceDeleted: this.countActiveIndexEvidence(embeddingIndexId),
      labelsDeleted: this.countActiveIndexLabels(embeddingIndexId),
      familiesDeleted: this.countActiveIndexRows("interest_families", embeddingIndexId),
      familyMembersDeleted: this.countActiveIndexRows(
        "interest_cluster_family_members",
        embeddingIndexId
      ),
      mergeCandidatesDeleted: this.countActiveIndexRows(
        "interest_cluster_merge_candidates",
        embeddingIndexId
      ),
      snapshotsTouched: 0,
      invalidSnapshots: 0
    };

    const reset = this.options.db.transaction(() => {
      this.options.db
        .prepare("delete from interest_cluster_merge_candidates where embedding_index_id = ?")
        .run(embeddingIndexId);
      this.options.db
        .prepare("delete from interest_cluster_family_members where embedding_index_id = ?")
        .run(embeddingIndexId);
      this.options.db
        .prepare("delete from interest_families where embedding_index_id = ?")
        .run(embeddingIndexId);
      this.options.db
        .prepare(
          `
            delete from interest_cluster_labels
            where cluster_id in (
              select id from interest_clusters where embedding_index_id = ?
            )
          `
        )
        .run(embeddingIndexId);
      this.options.db
        .prepare(
          `
            delete from interest_cluster_evidence
            where cluster_id in (
              select id from interest_clusters where embedding_index_id = ?
            )
          `
        )
        .run(embeddingIndexId);
      this.options.db
        .prepare("delete from interest_clusters where embedding_index_id = ?")
        .run(embeddingIndexId);

      const snapshotResult = this.removeActiveIndexSnapshots(embeddingIndexId);
      return {
        ...before,
        snapshotsTouched: snapshotResult.snapshotsTouched,
        invalidSnapshots: snapshotResult.invalidSnapshots
      };
    });

    return reset();
  }

  private async rebuildLabelsAsync(
    embeddingIndexId: string,
    input: {
      chunkSize: number;
      articleCount: number;
      articleIdsProcessed: number;
      chunksProcessed: number;
      onProgress?: (progress: ProfileRebuildProgress) => void;
    }
  ): Promise<number | null> {
    const clusterLabels = this.options.clusterLabels;
    if (!clusterLabels) {
      return null;
    }
    if (typeof clusterLabels.rebuildIndexLabelsAsync === "function") {
      return clusterLabels.rebuildIndexLabelsAsync(embeddingIndexId, {
        chunkSize: Math.max(1, Math.floor(input.chunkSize / 4)),
        onProgress: (progress: ClusterLabelRebuildProgress) => {
          input.onProgress?.({
            step: "labels",
            articleCount: input.articleCount,
            articleIdsProcessed: input.articleIdsProcessed,
            chunksProcessed: input.chunksProcessed + progress.chunksProcessed,
            workUnitCount: progress.clusterCount,
            workUnitsProcessed: progress.clustersProcessed
          });
        }
      });
    }

    return clusterLabels.rebuildIndexLabels(embeddingIndexId);
  }

  private removeActiveIndexSnapshots(embeddingIndexId: string): {
    snapshotsTouched: number;
    invalidSnapshots: number;
  } {
    const rows = this.options.db
      .prepare(
        `
          select article_id as articleId, topic_snapshot_json as topicSnapshotJson
          from article_behavior_summaries
          where topic_snapshot_json is not null
            and instr(topic_snapshot_json, ?) > 0
        `
      )
      .all(embeddingIndexId) as SnapshotRow[];
    const update = this.options.db.prepare(
      "update article_behavior_summaries set topic_snapshot_json = ? where article_id = ?"
    );
    let snapshotsTouched = 0;
    let invalidSnapshots = 0;

    for (const row of rows) {
      const snapshot = parseTopicSnapshot(row.topicSnapshotJson);
      if (!snapshot) {
        invalidSnapshots += 1;
        continue;
      }
      if (!snapshot.profileV0 || !(embeddingIndexId in snapshot.profileV0)) {
        continue;
      }

      delete snapshot.profileV0[embeddingIndexId];
      if (Object.keys(snapshot.profileV0).length === 0) {
        delete snapshot.profileV0;
      }

      const nextSnapshot = Object.keys(snapshot).length > 0 ? JSON.stringify(snapshot) : null;
      update.run(nextSnapshot, row.articleId);
      snapshotsTouched += 1;
    }

    return { snapshotsTouched, invalidSnapshots };
  }

  private listReplayArticleIds(embeddingIndexId: string): string[] {
    const rows = this.options.db
      .prepare(
        `
          select be.article_id as articleId, min(be.created_at) as firstEventAt
          from behavior_events be
          join articles a on a.id = be.article_id
          join feeds f on f.id = a.feed_id
          join article_embeddings ae
            on ae.article_id = a.id
           and ae.embedding_index_id = ?
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and ae.vector_blob is not null
            and ae.content_hash = coalesce(a.content_hash, a.id || ':' || a.updated_at)
          group by be.article_id
          order by firstEventAt, be.article_id
        `
      )
      .all(embeddingIndexId) as Array<{ articleId: string }>;
    return rows.map((row) => row.articleId);
  }

  private activeEmbeddingIndexId(): string | null {
    const row = this.options.db
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
    return row?.id ?? null;
  }

  private countActiveIndexRows(table: string, embeddingIndexId: string): number {
    return countRow(
      this.options.db.prepare(`select count(*) as count from ${table} where embedding_index_id = ?`).get(
        embeddingIndexId
      )
    );
  }

  private countActiveIndexEvidence(embeddingIndexId: string): number {
    return countRow(
      this.options.db
        .prepare(
          `
            select count(*) as count
            from interest_cluster_evidence ice
            join interest_clusters ic on ic.id = ice.cluster_id
            where ic.embedding_index_id = ?
          `
        )
        .get(embeddingIndexId)
    );
  }

  private countActiveIndexLabels(embeddingIndexId: string): number {
    return countRow(
      this.options.db
        .prepare(
          `
            select count(*) as count
            from interest_cluster_labels labels
            join interest_clusters clusters on clusters.id = labels.cluster_id
            where clusters.embedding_index_id = ?
          `
        )
        .get(embeddingIndexId)
    );
  }
}

function parseTopicSnapshot(value: string | null): TopicSnapshot | null {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as TopicSnapshot)
      : null;
  } catch {
    return null;
  }
}

function clampChunkSize(value: number | undefined): number {
  if (!Number.isFinite(value ?? 0)) {
    return 100;
  }
  return Math.max(1, Math.min(500, Math.floor(value ?? 100)));
}

function countRow(row: unknown): number {
  return (row as { count?: number } | undefined)?.count ?? 0;
}

function emptyRebuildResult(): ProfileRebuildResult {
  return {
    embeddingIndexId: null,
    reset: {
      clustersDeleted: 0,
      evidenceDeleted: 0,
      labelsDeleted: 0,
      familiesDeleted: 0,
      familyMembersDeleted: 0,
      mergeCandidatesDeleted: 0,
      snapshotsTouched: 0,
      invalidSnapshots: 0
    },
    replay: {
      articleCount: 0,
      articleIdsProcessed: 0,
      chunksProcessed: 0,
      profileChanged: false
    },
    rebuilt: {
      labels: null,
      families: null,
      familyMembers: null,
      rankingRows: null
    },
    after: {
      clusters: 0,
      evidence: 0
    }
  };
}
