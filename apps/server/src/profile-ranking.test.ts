import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  SqliteArticleActionRepository,
  SqliteArticleRepository,
  SqliteAppSettingsRepository,
  SqliteEmbeddingRepository,
  SqliteFeedRepository,
  SqliteJobRepository,
  SqliteProfileRepository,
  SqliteRankingRepository,
  SqliteVecVectorStore,
  toVectorBlob,
  type DibaoDatabase
} from "@dibao/db";
import { JobRunner } from "./job-runner.js";
import { DerivedDataUpgradeService } from "./derived-data-upgrade-service.js";
import { ProfileDecayJobService } from "./profile-decay-job-service.js";
import {
  BEHAVIOR_EVENT_PROJECT_JOB_TYPE,
  BehaviorProjectionJobService
} from "./behavior-projection-job-service.js";
import {
  PROFILE_EVENT_PROCESS_JOB_TYPE,
  ProfileEventProcessJobService
} from "./profile-event-job-service.js";
import { ProfileRebuildService } from "./profile-rebuild-service.js";
import { ProfileService } from "./profile-service.js";
import {
  RankingRecalculateJobService,
  RANKING_RECALCULATE_JOB_TYPE
} from "./ranking-job-service.js";
import {
  FTRL_TRAIN_JOB_TYPE,
  KEYWORD_PROFILE_REBUILD_JOB_TYPE,
  RANKING_EVAL_RUN_JOB_TYPE,
  RECENT_INTENT_REBUILD_JOB_TYPE,
  RecommendationMaintenanceService
} from "./recommendation-maintenance-service.js";
import {
  RECOMMENDATION_FEATURE_SCHEMA_VERSION,
  RecommendationRankingService
} from "./ranking-service.js";
import { buildServer as buildRealServer } from "./app.js";

const tempDirs: string[] = [];
const TEST_ACTIVE_RANK_CONTEXT = `rec_v3:embedding:cocoon_5:schema_${RECOMMENDATION_FEATURE_SCHEMA_VERSION}`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildServer(options: Parameters<typeof buildRealServer>[0] = {}) {
  return buildRealServer({
    authRequired: false,
    ...options
  });
}

describe("profile algorithm and recommendation ranking", () => {
  it("processes a single event idempotently and does not replay it after a content hash change", () => {
    const fixture = createProfileFixture();
    const { actions, articles, db, profile, profiles, vectorStore } = fixture;

    try {
      const result = actions.record({
        articleId: "article_liked",
        type: "favorite",
        now: 2000
      });
      expect(result?.eventId).toEqual(expect.any(String));

      profile.processEvent(result!.eventId);
      profile.processEvent(result!.eventId);

      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })).toHaveLength(1);
      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })[0]).toMatchObject({
        label: null
      });
      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })[0]?.weight).toBeCloseTo(4.2);

      articles.upsert({
        id: "article_liked",
        feedId: "feed_profile",
        url: "https://example.com/article_liked",
        canonicalUrl: "https://example.com/article_liked",
        title: "Liked article rewritten",
        summary: "A changed article body.",
        publishedAt: 1000,
        discoveredAt: 1000,
        contentHash: "hash_liked_v2",
        dedupeKey: "article_liked",
        now: 3000
      });
      vectorStore.upsertArticleVector({
        articleId: "article_liked",
        embeddingIndexId: "index_profile",
        vector: [0, 1, 0],
        contentHash: "hash_liked_v2",
        now: 3000
      });

      profile.processArticleEvents(["article_liked"]);

      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })).toHaveLength(1);
      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })[0]?.weight).toBeCloseTo(4.2);

      const snapshot = JSON.parse(profiles.getTopicSnapshot("article_liked") ?? "{}") as {
        profileV0?: Record<string, Record<string, { processedEventIds?: string[] }>>;
      };
      expect(snapshot.profileV0?.index_profile?.hash_liked?.processedEventIds).toContain(
        result!.eventId
      );
      expect(snapshot.profileV0?.index_profile?.hash_liked_v2?.processedEventIds).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("keeps a valid profile signal when article updated_at is newer but content hash still matches", () => {
    const fixture = createProfileFixture();
    const { actions, articles, db, profile, profiles } = fixture;

    try {
      const result = actions.record({
        articleId: "article_liked",
        type: "favorite",
        now: 2000
      });
      articles.upsert({
        id: "article_liked",
        feedId: "feed_profile",
        url: "https://example.com/article_liked",
        canonicalUrl: "https://example.com/article_liked",
        title: "Liked profile topic",
        summary: "The same content refreshed by the feed.",
        publishedAt: 1000,
        discoveredAt: 1000,
        contentHash: "hash_liked",
        dedupeKey: "article_liked",
        now: 3000
      });

      profile.processEvent(result!.eventId);

      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })).toHaveLength(1);
      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })[0]?.weight).toBeCloseTo(4.2);
      expect(clusterEvidenceCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("does not mark a stale embedding hash as processed before the current vector arrives", () => {
    const fixture = createProfileFixture();
    const { actions, articles, db, profile, profiles, vectorStore } = fixture;

    try {
      const result = actions.record({
        articleId: "article_liked",
        type: "favorite",
        now: 2000
      });
      articles.upsert({
        id: "article_liked",
        feedId: "feed_profile",
        url: "https://example.com/article_liked",
        canonicalUrl: "https://example.com/article_liked",
        title: "Liked profile topic rewritten",
        summary: "A changed article body.",
        publishedAt: 1000,
        discoveredAt: 1000,
        contentHash: "hash_liked_v2",
        dedupeKey: "article_liked",
        now: 3000
      });

      profile.processEvent(result!.eventId);

      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })).toHaveLength(0);
      expect(profiles.getTopicSnapshot("article_liked")).toBeNull();

      vectorStore.upsertArticleVector({
        articleId: "article_liked",
        embeddingIndexId: "index_profile",
        vector: [1, 0, 0],
        contentHash: "hash_liked_v2",
        now: 4000
      });
      profile.processArticleEvents(["article_liked"]);

      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })).toHaveLength(1);
      expect(clusterEvidenceCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rebuilds active-index profile clusters from behavior history without recomputing embeddings", () => {
    const fixture = createProfileFixture();
    const { actions, db, profile, profiles } = fixture;

    try {
      const result = actions.record({
        articleId: "article_liked",
        type: "favorite",
        now: 2000
      });
      profiles.upsertTopicSnapshot({
        articleId: "article_liked",
        feedId: "feed_profile",
        topicSnapshotJson: JSON.stringify({
          profileV0: {
            index_profile: {
              hash_liked: {
                processedEventIds: [result!.eventId]
              }
            }
          }
        }),
        now: 3000
      });

      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })).toHaveLength(0);

      const rebuild = new ProfileRebuildService({
        db,
        profile
      });
      const rebuildResult = rebuild.rebuildActiveIndexProfile({
        rebuildLabels: false,
        rebuildFamilies: false,
        recalculateRanking: false
      });

      expect(rebuildResult).toMatchObject({
        embeddingIndexId: "index_profile",
        reset: {
          snapshotsTouched: 1
        },
        replay: {
          articleCount: 1,
          profileChanged: true
        },
        after: {
          clusters: 1,
          evidence: 1
        }
      });
      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })[0]?.weight).toBeCloseTo(4.2);
      expect(clusterEvidenceCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("runs the v0.1.1 blocking derived-data upgrade from stored behavior without recomputing embeddings", async () => {
    const fixture = createProfileFixture();
    const { actions, db, profile, profiles } = fixture;
    const settings = new SqliteAppSettingsRepository(db);

    try {
      const result = actions.record({
        articleId: "article_liked",
        type: "favorite",
        now: 2000
      });
      profiles.upsertCluster({
        id: "cluster_polluted",
        embeddingIndexId: "index_profile",
        polarity: "positive",
        centroidVectorBlob: toVectorBlob([0.5, 0.5, 0]),
        weight: 100,
        sampleCount: 220,
        lastMatchedAt: 3000,
        now: 3000
      });
      profiles.upsertTopicSnapshot({
        articleId: "article_liked",
        feedId: "feed_profile",
        topicSnapshotJson: JSON.stringify({
          profileV0: {
            index_profile: {
              hash_liked: {
                processedEventIds: [result!.eventId]
              }
            }
          }
        }),
        now: 3000
      });
      const embeddingRowsBefore = countRows(db, "article_embeddings");

      const upgrade = new DerivedDataUpgradeService({
        db,
        settings,
        profileRebuild: new ProfileRebuildService({
          db,
          profile
        }),
        now: () => 5000
      });

      expect(upgrade.getStatus()).toMatchObject({
        state: "pending",
        blocking: true,
        activeIndexId: "index_profile"
      });

      const upgradeResult = await upgrade.startIfRequired();

      expect(upgradeResult).toMatchObject({
        state: "completed",
        blocking: false,
        result: {
          reset: {
            clustersDeleted: 1,
            snapshotsTouched: 1
          },
          replay: {
            articleCount: 1,
            articleIdsProcessed: 1,
            profileChanged: true
          },
          after: {
            clusters: 1,
            evidence: 1
          }
        }
      });
      expect(profiles.listClusters({ embeddingIndexId: "index_profile" })[0]).toMatchObject({
        sampleCount: 1
      });
      expect(countRows(db, "article_embeddings")).toBe(embeddingRowsBefore);
      expect(upgrade.getStatus()).toMatchObject({
        state: "completed",
        blocking: false
      });
    } finally {
      db.close();
    }
  });

  it("uses positive profile clusters to raise similar articles in ranking v1", () => {
    const fixture = createProfileFixture();
    const { actions, db, profile, ranking } = fixture;

    try {
      const result = actions.record({
        articleId: "article_liked",
        type: "favorite",
        now: 2000
      });
      profile.processEvent(result!.eventId);
      ranking.recalculateAll();

      const similarScore = activeScore(db, "article_similar");
      const otherScore = activeScore(db, "article_other");

      expect(similarScore).not.toBeNull();
      expect(otherScore).not.toBeNull();
      expect(similarScore!).toBeGreaterThan(otherScore!);
      expect(activeBm25Score(db, "article_similar")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("weights like above favorite in profile clusters and source stats", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const actions = new SqliteArticleActionRepository(db);
    const embeddings = new SqliteEmbeddingRepository(db);
    const profiles = new SqliteProfileRepository(db);
    const vectorStore = new SqliteVecVectorStore(db);

    try {
      feeds.upsert({ id: "feed_like", title: "Like Feed", feedUrl: "https://example.com/like.xml", now: 1000 });
      feeds.upsert({ id: "feed_favorite", title: "Favorite Feed", feedUrl: "https://example.com/favorite.xml", now: 1000 });
      embeddings.upsertProvider({
        id: "provider_like",
        type: "openai_compatible",
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 1000
      });
      embeddings.createIndex({
        id: "index_like",
        providerId: "provider_like",
        model: "fixture",
        dimension: 3,
        now: 1000
      });

      insertArticleForFeed(articles, "seed_like", "feed_like", "Seed like", "hash_like", 1000);
      insertArticleForFeed(articles, "seed_favorite", "feed_favorite", "Seed favorite", "hash_favorite", 1000);
      vectorStore.upsertArticleVector({
        articleId: "seed_like",
        embeddingIndexId: "index_like",
        vector: [1, 0, 0],
        contentHash: "hash_like",
        now: 1000
      });
      vectorStore.upsertArticleVector({
        articleId: "seed_favorite",
        embeddingIndexId: "index_like",
        vector: [0, 1, 0],
        contentHash: "hash_favorite",
        now: 1000
      });

      let clusterCount = 0;
      const profile = new ProfileService({
        embeddings,
        profiles,
        clusterIdFactory: () => {
          clusterCount += 1;
          return `cluster_like_${clusterCount}`;
        },
        now: () => 5000
      });

      const like = actions.record({ articleId: "seed_like", type: "like", now: 2000 });
      const favorite = actions.record({ articleId: "seed_favorite", type: "favorite", now: 2100 });
      profile.processEvent(like!.eventId);
      profile.processEvent(favorite!.eventId);

      const clusters = profiles.listClusters({ embeddingIndexId: "index_like", polarity: "positive" });
      expect(clusters[0]?.weight).toBeCloseTo(5.6);
      expect(clusters[1]?.weight).toBeCloseTo(4.2);
      expect(clusters.map((cluster) => cluster.label)).toEqual([null, null]);
      expect(feedStats(db, "feed_like").positiveScore).toBeGreaterThan(
        feedStats(db, "feed_favorite").positiveScore
      );
    } finally {
      db.close();
    }
  });

  it("keeps medium-similarity clear signals from widening an existing interest cluster", () => {
    const fixture = createProfileFixture();
    const { actions, articles, db, embeddings, profiles, vectorStore } = fixture;

    try {
      insertArticle(
        articles,
        "article_medium_clear",
        "Medium similarity clear signal",
        "hash_medium_clear",
        1300
      );
      insertArticle(
        articles,
        "article_medium_progress",
        "Medium similarity progress signal",
        "hash_medium_progress",
        1400
      );
      vectorStore.upsertArticleVector({
        articleId: "article_medium_clear",
        embeddingIndexId: "index_profile",
        vector: [0.7, 0.714, 0],
        contentHash: "hash_medium_clear",
        now: 1000
      });
      vectorStore.upsertArticleVector({
        articleId: "article_medium_progress",
        embeddingIndexId: "index_profile",
        vector: [0.7, -0.714, 0],
        contentHash: "hash_medium_progress",
        now: 1000
      });

      let clusterCount = 0;
      const profile = new ProfileService({
        embeddings,
        profiles,
        clusterIdFactory: () => {
          clusterCount += 1;
          return `cluster_medium_${clusterCount}`;
        },
        now: () => 5000
      });

      const favorite = actions.record({ articleId: "article_liked", type: "favorite", now: 2000 });
      profile.processEvent(favorite!.eventId);
      const firstCluster = profiles.listClusters({ embeddingIndexId: "index_profile" })[0]!;
      expect(firstCluster.sampleCount).toBe(1);

      const readLater = actions.record({
        articleId: "article_medium_clear",
        type: "read_later",
        now: 2100
      });
      profile.processEvent(readLater!.eventId);

      const clustersAfterClearSignal = profiles.listClusters({ embeddingIndexId: "index_profile" });
      expect(clustersAfterClearSignal).toHaveLength(2);
      expect(
        clustersAfterClearSignal.find((cluster) => cluster.id === firstCluster.id)?.sampleCount
      ).toBe(1);
      expect(clusterEvidenceCount(db)).toBe(2);

      const progress = actions.record({
        articleId: "article_medium_progress",
        type: "read_progress",
        progress: 0.75,
        now: 2200
      });
      profile.processEvent(progress!.eventId);

      const clustersAfterProgress = profiles.listClusters({ embeddingIndexId: "index_profile" });
      expect(clustersAfterProgress).toHaveLength(3);
      expect(
        clustersAfterProgress.find((cluster) => cluster.id === firstCluster.id)?.sampleCount
      ).toBe(1);
      expect(clustersAfterProgress.find((cluster) => cluster.id === "cluster_medium_3")?.sampleCount).toBe(
        1
      );
      expect(clusterEvidenceCount(db)).toBe(3);
    } finally {
      db.close();
    }
  });

  it("treats unlike as a weak correction without creating a negative interest cluster", () => {
    const fixture = createProfileFixture();
    const { actions, db, profile, profiles } = fixture;

    try {
      const unlike = actions.record({
        articleId: "article_liked",
        type: "unlike",
        now: 2000
      });
      profile.processEvent(unlike!.eventId);

      expect(profiles.listClusters({ embeddingIndexId: "index_profile", polarity: "negative" })).toHaveLength(0);
      expect(feedStats(db, "feed_profile").negativeScore).toBeGreaterThan(0);
      expect(feedStats(db, "feed_profile").negativeScore).toBeLessThan(0.1);
    } finally {
      db.close();
    }
  });

  it("queues ranking recalculation after article actions and applies it after draining jobs", async () => {
    const fixture = createProfileFixture();
    const { db, jobs } = fixture;
    const app = buildServer({ db, logger: false, now: () => 5000 });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/articles/article_liked/actions",
        payload: {
          type: "favorite"
        }
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.eventId).toEqual(expect.any(String));
      await waitForDeferredPostActionWork();
      expect(jobs.countByTypeAndStatus(BEHAVIOR_EVENT_PROJECT_JOB_TYPE, "queued")).toBe(1);
      expect(jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "queued")).toBe(0);
      expect(activeScore(db, "article_similar")).toBeNull();

      await drainProfileAndRankingJobs(db, 5000);

      expect(activeScore(db, "article_similar")).not.toBeNull();
      const recommended = await app.inject({
        method: "GET",
        url: "/api/articles?view=recommended"
      });

      expect(recommended.statusCode, recommended.body).toBe(200);
      const ids = recommended.json().data.map((article: { id: string }) => article.id);
      expect(ids.indexOf("article_similar")).toBeLessThan(ids.indexOf("article_other"));
    } finally {
      await app.close();
      db.close();
    }
  });

  it("REC-031 keeps cold start and pending embedding recommendations populated", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const rankings = new SqliteRankingRepository(db);

    try {
      feeds.upsert({
        id: "feed_cold",
        title: "Cold Feed",
        feedUrl: "https://example.com/cold.xml",
        now: 1000
      });
      insertArticleForFeed(articles, "article_cold_recent", "feed_cold", "Cold recent", "hash_cold_recent", 9000);
      insertArticleForFeed(articles, "article_cold_old", "feed_cold", "Cold old", "hash_cold_old", 1000);

      const coldRanking = new RecommendationRankingService({
        rankings,
        now: () => 10_000
      });
      coldRanking.recalculateAll();

      const coldStart = articles.list({
        view: "recommended",
        rankContext: coldRanking.getActiveRankContext()
      }).items.map((article) => article.id);
      expect(coldStart.slice(0, 2)).toEqual(["article_cold_recent", "article_cold_old"]);

      const embeddings = new SqliteEmbeddingRepository(db);
      embeddings.upsertProvider({
        id: "provider_pending",
        type: "openai_compatible",
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 10_000
      });
      embeddings.createIndex({
        id: "index_pending",
        providerId: "provider_pending",
        model: "fixture",
        dimension: 3,
        now: 10_000
      });

      const pendingRanking = new RecommendationRankingService({
        embeddings,
        profiles: new SqliteProfileRepository(db),
        rankings,
        now: () => 10_000
      });
      pendingRanking.recalculateAll();

      const pending = articles.list({
        view: "recommended",
        rankContext: pendingRanking.getActiveRankContext()
      }).items.map((article) => article.id);
      expect(pending).toContain("article_cold_recent");
      expect(pendingRanking.explainArticle("article_cold_recent")).toMatchObject({
        status: "embedding_pending"
      });
    } finally {
      db.close();
    }
  });

  it("keeps touched articles out of the active rerank window while still updating base scores", () => {
    const fixture = createProfileFixture();
    const { actions, db, ranking } = fixture;

    try {
      actions.record({
        articleId: "article_liked",
        type: "open",
        now: 2_000
      });

      ranking.recalculateAll();

      expect(activeScore(db, "article_liked")).toBeNull();
      expect(activeScoreForContext(db, "article_liked", "base")).not.toBeNull();
      expect(activeScore(db, "article_similar")).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("pauses full ranking chunks at a safe cursor when foreground activity resumes", () => {
    const fixture = createProfileFixture();
    try {
      const ranking = new RecommendationRankingService({
        embeddings: fixture.embeddings,
        profiles: fixture.profiles,
        rankings: fixture.rankings,
        shouldPause: ({ processed }) =>
          processed >= 1
            ? { pause: true, resumeAfter: 8_000 }
            : { pause: false },
        now: () => 5_000
      });

      const result = ranking.recalculateChunk({
        cursor: null,
        limit: 3
      });

      expect(result).toMatchObject({
        processed: 1,
        nextCursor: "article_liked",
        paused: true,
        resumeAfter: 8_000
      });
      expect(activeScore(fixture.db, "article_liked")).not.toBeNull();
      expect(activeScore(fixture.db, "article_other")).toBeNull();
      expect(activeScore(fixture.db, "article_similar")).toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  it("does not commit or advance a ranking chunk when foreground activity resumes before writeback", () => {
    const fixture = createProfileFixture();
    try {
      const ranking = new RecommendationRankingService({
        embeddings: fixture.embeddings,
        profiles: fixture.profiles,
        rankings: fixture.rankings,
        shouldPause: ({ processed }) =>
          processed >= 1
            ? { pause: true, resumeAfter: 8_000 }
            : { pause: false },
        now: () => 5_000
      });

      const result = ranking.recalculateChunk({
        cursor: null,
        limit: 1
      });

      expect(result).toMatchObject({
        processed: 0,
        nextCursor: null,
        paused: true,
        resumeAfter: 8_000
      });
      expect(activeScore(fixture.db, "article_liked")).toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  it("orders recommended articles by score before chunk-local rerank_position and keeps latest date-based", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const rankings = new SqliteRankingRepository(db);

    try {
      feeds.upsert({
        id: "feed_rerank",
        title: "Rerank Feed",
        feedUrl: "https://example.com/rerank.xml",
        now: 1000
      });
      insertArticleForFeed(articles, "article_position_2", "feed_rerank", "High score later position", "hash_pos_2", 2000);
      insertArticleForFeed(articles, "article_position_1", "feed_rerank", "Low score first position", "hash_pos_1", 1000);

      rankings.upsertScore({
        articleId: "article_position_2",
        rankContext: "ctx_rerank",
        score: 0.99,
        baseScore: 0.99,
        interestScore: 0,
        sourceScore: 0,
        freshnessScore: 0,
        stateScore: 0,
        diversityScore: 0,
        penaltyScore: 0,
        rerankPosition: 2,
        calculatedAt: 3000
      });
      rankings.upsertScore({
        articleId: "article_position_1",
        rankContext: "ctx_rerank",
        score: 0.2,
        baseScore: 0.2,
        interestScore: 0,
        sourceScore: 0,
        freshnessScore: 0,
        stateScore: 0,
        diversityScore: 0,
        penaltyScore: 0,
        rerankPosition: 1,
        calculatedAt: 3000
      });

      expect(
        articles.list({ view: "recommended", rankContext: "ctx_rerank" }).items.map((article) => article.id)
      ).toEqual(["article_position_2", "article_position_1"]);
      expect(articles.list().items.map((article) => article.id)).toEqual([
        "article_position_2",
        "article_position_1"
      ]);
    } finally {
      db.close();
    }
  });

  it("falls back to score when rerank_position is missing", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const rankings = new SqliteRankingRepository(db);

    try {
      feeds.upsert({
        id: "feed_score_fallback",
        title: "Score Fallback Feed",
        feedUrl: "https://example.com/score.xml",
        now: 1000
      });
      insertArticleForFeed(articles, "article_score_low", "feed_score_fallback", "Low score", "hash_score_low", 2000);
      insertArticleForFeed(articles, "article_score_high", "feed_score_fallback", "High score", "hash_score_high", 1000);

      for (const [articleId, score] of [
        ["article_score_low", 0.1],
        ["article_score_high", 0.9]
      ] as const) {
        rankings.upsertScore({
          articleId,
          rankContext: "ctx_score_fallback",
          score,
          baseScore: score,
          interestScore: 0,
          sourceScore: 0,
          freshnessScore: 0,
          stateScore: 0,
          diversityScore: 0,
          penaltyScore: 0,
          calculatedAt: 3000
        });
      }

      expect(
        articles.list({ view: "recommended", rankContext: "ctx_score_fallback" }).items.map((article) => article.id)
      ).toEqual(["article_score_high", "article_score_low"]);
    } finally {
      db.close();
    }
  });

  it("keeps mature non-AI families in the top window when AI has more matching clusters", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const embeddings = new SqliteEmbeddingRepository(db);
    const profiles = new SqliteProfileRepository(db);
    const rankings = new SqliteRankingRepository(db);
    const vectorStore = new SqliteVecVectorStore(db);

    try {
      embeddings.upsertProvider({
        id: "provider_family_rank",
        type: "openai_compatible",
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 1000
      });
      embeddings.createIndex({
        id: "index_family_rank",
        providerId: "provider_family_rank",
        model: "fixture",
        dimension: 3,
        status: "active",
        now: 1000
      });
      for (const feedId of ["feed_ai_rank", "feed_finance_rank", "feed_science_rank"]) {
        feeds.upsert({
          id: feedId,
          title: feedId,
          feedUrl: `https://example.com/${feedId}.xml`,
          now: 1000
        });
      }

      insertRankingFamily(db, profiles, {
        familyId: "family_ai_rank",
        displayLabel: "AI",
        clusters: [
          ["cluster_ai_rank_1", [1, 0, 0]],
          ["cluster_ai_rank_2", [0.99, 0.01, 0]],
          ["cluster_ai_rank_3", [0.98, 0.02, 0]]
        ],
        dominanceRatio: 0.6
      });
      insertRankingFamily(db, profiles, {
        familyId: "family_finance_rank",
        displayLabel: "Finance",
        clusters: [["cluster_finance_rank", [0, 1, 0]]],
        dominanceRatio: 0.25
      });
      insertRankingFamily(db, profiles, {
        familyId: "family_science_rank",
        displayLabel: "Science",
        clusters: [["cluster_science_rank", [0, 0, 1]]],
        dominanceRatio: 0.15
      });

      for (let index = 0; index < 24; index += 1) {
        insertRankCandidate(articles, vectorStore, {
          articleId: `article_ai_family_${index}`,
          feedId: "feed_ai_rank",
          title: `AI family ${index}`,
          vector: [1, 0, 0],
          publishedAt: 10_000 - index
        });
      }
      for (let index = 0; index < 8; index += 1) {
        insertRankCandidate(articles, vectorStore, {
          articleId: `article_finance_family_${index}`,
          feedId: "feed_finance_rank",
          title: `Finance family ${index}`,
          vector: [0, 1, 0],
          publishedAt: 9_000 - index
        });
        insertRankCandidate(articles, vectorStore, {
          articleId: `article_science_family_${index}`,
          feedId: "feed_science_rank",
          title: `Science family ${index}`,
          vector: [0, 0, 1],
          publishedAt: 8_000 - index
        });
      }

      const ranking = new RecommendationRankingService({
        db,
        embeddings,
        profiles,
        rankings,
        now: () => 20_000
      });
      ranking.recalculateAll();

      const top20 = recommendedIds(db).slice(0, 20);
      expect(top20.filter((id) => id.startsWith("article_ai_family_")).length).toBeLessThan(20);
      expect(top20.some((id) => id.startsWith("article_finance_family_"))).toBe(true);
      expect(top20.some((id) => id.startsWith("article_science_family_"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("REC-031 boosts favorite, read later, and derived read complete topics above open-only topics", () => {
    const fixture = createEvaluationFixture();
    const { actions, db, profile, ranking } = fixture;

    try {
      ranking.recalculateAll();
      const before = recommendedIds(db);
      expect(before).toContain("candidate_favorite");
      expect(before).toContain("candidate_open");

      for (const articleId of ["seed_open_1", "seed_open_2", "seed_open_3", "seed_open_4"]) {
        const result = actions.record({ articleId, type: "open", now: 2_000 });
        profile.processEvent(result!.eventId);
      }
      const favorite = actions.record({ articleId: "seed_favorite", type: "favorite", now: 2_100 });
      const readLater = actions.record({ articleId: "seed_later", type: "read_later", now: 2_200 });
      const readComplete = actions.record({
        articleId: "seed_complete",
        type: "read_progress",
        progress: 0.75,
        metadata: { activeDurationMs: 20_000 },
        now: 2_300
      });
      profile.processEvent(favorite!.eventId);
      profile.processEvent(readLater!.eventId);
      profile.processEvent(readComplete!.eventId);
      ranking.recalculateAll();

      const after = recommendedIds(db);
      expect(after.indexOf("candidate_favorite")).toBeLessThan(after.indexOf("candidate_open"));
      expect(after.indexOf("candidate_later")).toBeLessThan(after.indexOf("candidate_open"));
      expect(after.indexOf("candidate_complete")).toBeLessThan(after.indexOf("candidate_open"));
    } finally {
      db.close();
    }
  });

  it("REC-031 applies not interested as a strong similar-content negative signal", () => {
    const fixture = createEvaluationFixture();
    const { actions, db, profile, ranking } = fixture;

    try {
      ranking.recalculateAll();
      const before = recommendedIds(db);
      const beforeScore = activeScoreForContext(db, "candidate_negative", "index_eval");
      expect(before).toContain("candidate_negative");

      const result = actions.record({
        articleId: "seed_negative",
        type: "not_interested",
        now: 2_000
      });
      profile.processEvent(result!.eventId);
      ranking.recalculateAll();

      const after = recommendedIds(db);
      expect(after).not.toContain("seed_negative");
      expect(activeScoreForContext(db, "candidate_negative", "index_eval")).toBeLessThan(
        beforeScore ?? Number.POSITIVE_INFINITY
      );
      expect(after.indexOf("candidate_negative")).toBeGreaterThan(after.indexOf("candidate_other"));
    } finally {
      db.close();
    }
  });

  it("REC-031 guards source stats against open overfit but learns after clear signals", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const actions = new SqliteArticleActionRepository(db);
    const profiles = new SqliteProfileRepository(db);
    const rankings = new SqliteRankingRepository(db);
    const profile = new ProfileService({
      embeddings: new SqliteEmbeddingRepository(db),
      profiles,
      now: () => 20_000
    });
    const ranking = new RecommendationRankingService({
      rankings,
      now: () => 20_000
    });

    try {
      feeds.upsert({ id: "feed_open", title: "Open Feed", feedUrl: "https://example.com/open.xml", now: 1000 });
      feeds.upsert({ id: "feed_clear", title: "Clear Feed", feedUrl: "https://example.com/clear.xml", now: 1000 });
      feeds.upsert({ id: "feed_plain", title: "Plain Feed", feedUrl: "https://example.com/plain.xml", now: 1000 });
      insertArticleForFeed(articles, "candidate_open_source", "feed_open", "Open source candidate", "hash_open_source", 5_000);
      insertArticleForFeed(articles, "candidate_clear_source", "feed_clear", "Clear source candidate", "hash_clear_source", 5_000);
      insertArticleForFeed(articles, "candidate_plain_source", "feed_plain", "Plain source candidate", "hash_plain_source", 5_000);

      for (let index = 0; index < 20; index += 1) {
        const articleId = `seed_open_source_${index}`;
        insertArticleForFeed(articles, articleId, "feed_open", `Open seed ${index}`, `hash_open_${index}`, 1_000 + index);
        const result = actions.record({ articleId, type: "open", now: 6_000 + index });
        profile.processEvent(result!.eventId);
      }
      ranking.recalculateAll();
      const openOnly = recommendedIds(db, "base");
      expect(openOnly.indexOf("candidate_open_source")).toBeGreaterThan(
        openOnly.indexOf("candidate_plain_source") - 2
      );

      for (let index = 0; index < 10; index += 1) {
        const articleId = `seed_clear_source_${index}`;
        insertArticleForFeed(articles, articleId, "feed_clear", `Clear seed ${index}`, `hash_clear_${index}`, 2_000 + index);
        const result = actions.record({ articleId, type: "read_later", now: 7_000 + index });
        profile.processEvent(result!.eventId);
      }
      ranking.recalculateAll();
      const clearSignals = recommendedIds(db, "base");
      expect(clearSignals.indexOf("candidate_clear_source")).toBeLessThan(
        clearSignals.indexOf("candidate_plain_source")
      );
    } finally {
      db.close();
    }
  });

  it("rebuilds profile_terms and uses true FTS/BM25 profile matches in ranking", () => {
    const fixture = createProfileFixture();
    const { actions, articles, db, ranking } = fixture;

    try {
      articles.upsert({
        id: "article_keyword",
        feedId: "feed_profile",
        url: "https://example.com/article_keyword",
        canonicalUrl: "https://example.com/article_keyword",
        title: "Liked profile topic digest",
        summary: "A focused profile topic.",
        publishedAt: 1300,
        discoveredAt: 1300,
        contentHash: "hash_keyword",
        dedupeKey: "article_keyword",
        now: 1300
      });
      articles.upsert({
        id: "article_unmatched_keyword",
        feedId: "feed_profile",
        url: "https://example.com/article_unmatched_keyword",
        canonicalUrl: "https://example.com/article_unmatched_keyword",
        title: "Weather market digest",
        summary: "A distant unrelated note.",
        publishedAt: 1350,
        discoveredAt: 1350,
        contentHash: "hash_unmatched_keyword",
        dedupeKey: "article_unmatched_keyword",
        now: 1350
      });
      articles.upsert({
        id: "article_negative_keyword",
        feedId: "feed_profile",
        url: "https://example.com/article_negative_keyword",
        canonicalUrl: "https://example.com/article_negative_keyword",
        title: "Blocked politics digest",
        summary: "A profile topic with a negative term.",
        publishedAt: 1400,
        discoveredAt: 1400,
        contentHash: "hash_negative_keyword",
        dedupeKey: "article_negative_keyword",
        now: 1400
      });
      articles.upsert({
        id: "article_malicious_keyword",
        feedId: "feed_profile",
        url: "https://example.com/article_malicious_keyword",
        canonicalUrl: "https://example.com/article_malicious_keyword",
        title: "Foo bar profile digest",
        summary: "A term that should survive sanitized FTS syntax.",
        publishedAt: 1450,
        discoveredAt: 1450,
        contentHash: "hash_malicious_keyword",
        dedupeKey: "article_malicious_keyword",
        now: 1450
      });
      const rankingBeforeTerms = new RecommendationRankingService({
        db,
        embeddings: new SqliteEmbeddingRepository(db),
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        now: () => 5000
      });
      rankingBeforeTerms.recalculateAll();
      expect(bm25ScoreForContext(db, "article_keyword", rankingBeforeTerms.getActiveRankContext())).toBe(0);

      actions.record({ articleId: "article_liked", type: "favorite", now: 2000 });
      const maintenance = createMaintenanceService(db, 5000);
      maintenance.handleJob(maintenanceJob(KEYWORD_PROFILE_REBUILD_JOB_TYPE));
      db.prepare(
        `
          insert into profile_terms (term, polarity, scope, weight, evidence_count, last_event_at, updated_at)
          values
            ('blocked', 'negative', 'long', 8, 1, 2000, 5000),
            ('foo" OR bar', 'positive', 'recent', 8, 1, 2000, 5000)
          on conflict(term, polarity, scope) do update set
            weight = excluded.weight,
            evidence_count = excluded.evidence_count,
            last_event_at = excluded.last_event_at,
            updated_at = excluded.updated_at
        `
      ).run();
      const rankingWithDb = new RecommendationRankingService({
        db,
        embeddings: new SqliteEmbeddingRepository(db),
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        now: () => 5000
      });
      rankingWithDb.recalculateAll();

      const keywordScore = bm25ScoreForContext(db, "article_keyword", rankingWithDb.getActiveRankContext());
      const otherScore = bm25ScoreForContext(db, "article_unmatched_keyword", rankingWithDb.getActiveRankContext());
      const maliciousScore = bm25ScoreForContext(db, "article_malicious_keyword", rankingWithDb.getActiveRankContext());
      const negative = db
        .prepare(
          `
            select negative_penalty as negativePenalty
            from article_rank_scores
            where article_id = 'article_negative_keyword'
              and rank_context = ?
          `
        )
        .get(rankingWithDb.getActiveRankContext()) as { negativePenalty: number | null } | undefined;

      expect(keywordScore).toBeGreaterThanOrEqual(0);
      expect(keywordScore).toBeGreaterThan(otherScore ?? -1);
      expect(maliciousScore).toBeGreaterThan(0);
      expect(negative?.negativePenalty ?? 0).toBeLessThan(0);
      expect(countRows(db, "profile_terms")).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("generalizes negative finance-market profile terms without boosting generic positive words", () => {
    const fixture = createProfileFixture();
    const { articles, db } = fixture;

    try {
      articles.upsert({
        id: "article_finance_us",
        feedId: "feed_profile",
        url: "https://example.com/article_finance_us",
        canonicalUrl: "https://example.com/article_finance_us",
        title: "SPCX is now Wall Street's most shorted new stock",
        summary: "An article with comments, points, and news boilerplate.",
        publishedAt: 1500,
        discoveredAt: 1500,
        contentHash: "hash_finance_us",
        dedupeKey: "article_finance_us",
        now: 1500
      });
      articles.upsert({
        id: "article_finance_cn",
        feedId: "feed_profile",
        url: "https://example.com/article_finance_cn",
        canonicalUrl: "https://example.com/article_finance_cn",
        title: "这才是A股接下来的真剧本",
        summary: "上一交易日后的市场推演。",
        publishedAt: 1600,
        discoveredAt: 1600,
        contentHash: "hash_finance_cn",
        dedupeKey: "article_finance_cn",
        now: 1600
      });
      articles.upsert({
        id: "article_meaningful_positive",
        feedId: "feed_profile",
        url: "https://example.com/article_meaningful_positive",
        canonicalUrl: "https://example.com/article_meaningful_positive",
        title: "Compiler agents improve code review",
        summary: "Compiler agents coordinate patches and tests.",
        publishedAt: 1700,
        discoveredAt: 1700,
        contentHash: "hash_meaningful_positive",
        dedupeKey: "article_meaningful_positive",
        now: 1700
      });
      articles.upsert({
        id: "article_finance_share_price",
        feedId: "feed_profile",
        url: "https://example.com/article_finance_share_price",
        canonicalUrl: "https://example.com/article_finance_share_price",
        title: "中际旭创将香港发售价定在每股980港元",
        summary: "新股发行价更新。",
        publishedAt: 1800,
        discoveredAt: 1800,
        contentHash: "hash_finance_share_price",
        dedupeKey: "article_finance_share_price",
        now: 1800
      });
      articles.upsert({
        id: "article_false_positive_sp",
        feedId: "feed_profile",
        url: "https://example.com/article_false_positive_sp",
        canonicalUrl: "https://example.com/article_false_positive_sp",
        title: "Business process agents improve planning",
        summary: "A workflow article that should not match finance markers.",
        publishedAt: 1900,
        discoveredAt: 1900,
        contentHash: "hash_false_positive_sp",
        dedupeKey: "article_false_positive_sp",
        now: 1900
      });
      db.prepare(
        `
          insert into profile_terms (term, polarity, scope, weight, evidence_count, last_event_at, updated_at)
          values
            ('article', 'positive', 'long', 10, 5, 2000, 5000),
            ('comments', 'positive', 'long', 9, 4, 2000, 5000),
            ('news', 'positive', 'recent', 9, 4, 2000, 5000),
            ('points', 'positive', 'recent', 8, 3, 2000, 5000),
            ('compiler agents', 'positive', 'long', 12, 3, 2000, 5000),
            ('code review', 'positive', 'recent', 8, 2, 2000, 5000),
            ('上一交易日', 'negative', 'long', 10, 2, 2000, 5000),
            ('A股三大指数', 'negative', 'long', 10, 2, 2000, 5000),
            ('美股盘前', 'negative', 'recent', 8, 1, 2000, 5000)
          on conflict(term, polarity, scope) do update set
            weight = excluded.weight,
            evidence_count = excluded.evidence_count,
            last_event_at = excluded.last_event_at,
            updated_at = excluded.updated_at
        `
      ).run();

      const rankingWithDb = new RecommendationRankingService({
        db,
        embeddings: new SqliteEmbeddingRepository(db),
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        now: () => 5000
      });
      rankingWithDb.recalculateArticles([
        "article_finance_us",
        "article_finance_cn",
        "article_meaningful_positive",
        "article_finance_share_price",
        "article_false_positive_sp"
      ]);

      const rows = db
        .prepare(
          `
            select
              article_id as articleId,
              bm25_score as bm25Score,
              negative_penalty as negativePenalty
            from article_rank_scores
            where rank_context = ?
              and article_id in (?, ?, ?, ?, ?)
          `
        )
        .all(
          rankingWithDb.getActiveRankContext(),
          "article_finance_us",
          "article_finance_cn",
          "article_meaningful_positive",
          "article_finance_share_price",
          "article_false_positive_sp"
        ) as Array<{
        articleId: string;
        bm25Score: number | null;
        negativePenalty: number | null;
      }>;
      const byId = new Map(rows.map((row) => [row.articleId, row]));

      expect(byId.get("article_finance_us")?.negativePenalty ?? 0).toBeLessThan(-0.08);
      expect(byId.get("article_finance_cn")?.negativePenalty ?? 0).toBeLessThan(-0.08);
      expect(byId.get("article_finance_share_price")?.negativePenalty ?? 0).toBeLessThan(-0.08);
      expect(byId.get("article_false_positive_sp")?.negativePenalty ?? 0).toBe(0);
      expect(byId.get("article_finance_us")?.bm25Score ?? 0).toBe(0);
      expect(byId.get("article_meaningful_positive")?.bm25Score ?? 0).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("builds recent intent from existing embeddings and uses it without embedding calls", () => {
    const fixture = createProfileFixture();
    const { actions, db } = fixture;

    try {
      actions.record({ articleId: "article_liked", type: "favorite", now: 4900 });
      const maintenance = createMaintenanceService(db, 5000);
      maintenance.handleJob(maintenanceJob(RECENT_INTENT_REBUILD_JOB_TYPE));

      const recent = db
        .prepare("select event_count as eventCount, weight from recent_intent_profiles where polarity = 'positive'")
        .get() as { eventCount: number; weight: number } | undefined;
      expect(recent?.eventCount).toBeGreaterThan(0);

      const ranking = new RecommendationRankingService({
        db,
        embeddings: new SqliteEmbeddingRepository(db),
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        now: () => 5000
      });
      ranking.recalculateAll();

      expect(activeScore(db, "article_similar")).toBeGreaterThan(activeScore(db, "article_other") ?? 0);
    } finally {
      db.close();
    }
  });

  it("persists live cluster evidence and exposes table-backed evidence first", () => {
    const fixture = createProfileFixture();
    const { actions, db, profile, profiles } = fixture;

    try {
      const event = actions.record({ articleId: "article_liked", type: "favorite", now: 2000 });
      profile.processEvent(event!.eventId);

      const evidence = profiles.listClusterEvidence({ embeddingIndexId: "index_profile" });
      expect(evidence[0]).toMatchObject({
        articleId: "article_liked",
        behaviorEventId: event!.eventId,
        evidenceSource: "live_event",
        confidence: 1
      });
    } finally {
      db.close();
    }
  });

  it("rebuilds simhash near-duplicate groups and ranking reads persisted duplicate penalties", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const embeddings = new SqliteEmbeddingRepository(db);

    try {
      feeds.upsert({ id: "feed_dup", title: "Dup Feed", feedUrl: "https://example.com/dup.xml", now: 1000 });
      embeddings.upsertProvider({
        id: "provider_dup",
        type: "openai_compatible",
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 1000
      });
      embeddings.createIndex({
        id: "index_dup",
        providerId: "provider_dup",
        model: "fixture",
        dimension: 3,
        now: 1000
      });
      insertArticleForFeed(articles, "dup_a", "feed_dup", "Breaking AI governance policy", "hash_dup_a", 2000);
      insertArticleForFeed(articles, "dup_b", "feed_dup", "Breaking AI governance policy!", "hash_dup_b", 2100);

      createMaintenanceService(db, 5000).handleJob(maintenanceJob("duplicate_group_rebuild"));
      expect(countRows(db, "duplicate_groups")).toBeGreaterThan(0);

      const ranking = new RecommendationRankingService({
        db,
        embeddings,
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        now: () => 5000
      });
      ranking.recalculateAll();
      const penalty = db
        .prepare(
          "select duplicate_penalty as duplicatePenalty from article_rank_scores where article_id = ? and rank_context = ?"
        )
        .get("dup_b", ranking.getActiveRankContext()) as { duplicatePenalty: number | null } | undefined;
      expect(penalty?.duplicatePenalty ?? 0).toBeLessThan(0);
    } finally {
      db.close();
    }
  });

  it("trains FTRL shadow weights and writes non-zero ftrlScore without changing final score", () => {
    const fixture = createProfileFixture();
    const { actions, db, profile } = fixture;

    try {
      const event = actions.record({ articleId: "article_liked", type: "favorite", now: 2000 });
      profile.processEvent(event!.eventId);
      const ranking = new RecommendationRankingService({
        db,
        embeddings: new SqliteEmbeddingRepository(db),
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        now: () => 5000
      });
      ranking.recalculateAll();
      const before = db
        .prepare(
          `
            select score
            from article_rank_scores
            where article_id = 'article_similar'
              and rank_context = ?
          `
        )
        .get(ranking.getActiveRankContext()) as { score: number } | undefined;
      createMaintenanceService(db, 5000).handleJob(maintenanceJob(FTRL_TRAIN_JOB_TYPE));
      ranking.recalculateAll();

      expect(countRows(db, "rank_model_weights")).toBeGreaterThan(0);
      const row = db
        .prepare(
          `
            select ftrl_score as ftrlScore, score, pre_rerank_score as preRerankScore
            from article_rank_scores
            where article_id = 'article_similar'
              and rank_context = ?
          `
        )
        .get(ranking.getActiveRankContext()) as
        | { ftrlScore: number | null; score: number; preRerankScore: number | null }
        | undefined;
      expect(row?.ftrlScore ?? 0).toBeGreaterThan(0);
      expect(row?.score).toBe(before?.score);
    } finally {
      db.close();
    }
  });

  it("queues ranking recalculation after derived maintenance jobs but not after evaluation", () => {
    const fixture = createProfileFixture();
    const { db } = fixture;

    try {
      const maintenance = createMaintenanceService(db, 7000);
      maintenance.handleJob(maintenanceJob(KEYWORD_PROFILE_REBUILD_JOB_TYPE));
      expect(countQueuedJobs(db, RANKING_RECALCULATE_JOB_TYPE)).toBe(1);

      db.prepare("delete from jobs where type = ?").run(RANKING_RECALCULATE_JOB_TYPE);
      maintenance.handleJob(maintenanceJob(RECENT_INTENT_REBUILD_JOB_TYPE));
      expect(countQueuedJobs(db, RANKING_RECALCULATE_JOB_TYPE)).toBe(1);

      db.prepare("delete from jobs where type = ?").run(RANKING_RECALCULATE_JOB_TYPE);
      maintenance.handleJob(maintenanceJob("duplicate_group_rebuild"));
      expect(countQueuedJobs(db, RANKING_RECALCULATE_JOB_TYPE)).toBe(1);

      db.prepare("delete from jobs where type = ?").run(RANKING_RECALCULATE_JOB_TYPE);
      maintenance.handleJob(maintenanceJob(FTRL_TRAIN_JOB_TYPE));
      expect(countQueuedJobs(db, RANKING_RECALCULATE_JOB_TYPE)).toBe(1);

      db.prepare("delete from jobs where type = ?").run(RANKING_RECALCULATE_JOB_TYPE);
      maintenance.handleJob(maintenanceJob(RANKING_EVAL_RUN_JOB_TYPE));
      expect(countQueuedJobs(db, RANKING_RECALCULATE_JOB_TYPE)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("uses FTRL only after explicit active promotion conditions are met", () => {
    const fixture = createProfileFixture();
    const { actions, db, profile } = fixture;

    try {
      const event = actions.record({ articleId: "article_liked", type: "favorite", now: 2000 });
      profile.processEvent(event!.eventId);
      const baseRanking = new RecommendationRankingService({
        db,
        embeddings: new SqliteEmbeddingRepository(db),
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        now: () => 5000
      });
      baseRanking.recalculateAll();
      const before = db
        .prepare(
          `
            select score
            from article_rank_scores
            where article_id = 'article_similar'
              and rank_context = ?
          `
        )
        .get(baseRanking.getActiveRankContext()) as { score: number } | undefined;

      db.prepare(
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
          values ('ftrl_active_test', 'rec_v3', 3, 'active', 60, 0.25, ?, 5000, 5000)
        `
      ).run(JSON.stringify({ highQualitySamples: 60 }));
      db.prepare(
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
          values ('ftrl_active_test', 'freshness', -5, 0, 0, 0, 5000)
        `
      ).run();

      const activeRanking = new RecommendationRankingService({
        db,
        embeddings: new SqliteEmbeddingRepository(db),
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        getRankingSettings: () => ({
          cocoonLevel: 5,
          localLearningEnabled: true,
          localLearningShadowMode: false,
          explorationEnabled: false,
          evaluationEnabled: false
        }),
        now: () => 5000
      });
      activeRanking.recalculateAll();
      const after = db
        .prepare(
          `
            select score, ftrl_score as ftrlScore
            from article_rank_scores
            where article_id = 'article_similar'
              and rank_context = ?
          `
        )
        .get(activeRanking.getActiveRankContext()) as
        | { score: number; ftrlScore: number | null }
        | undefined;

      expect(after?.ftrlScore ?? 0).toBeGreaterThan(0);
      expect(after?.score).not.toBe(before?.score);
    } finally {
      db.close();
    }
  });

  it("keeps micro-exploration bounded, local, and disabled when configured off", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const actions = new SqliteArticleActionRepository(db);
    const embeddings = new SqliteEmbeddingRepository(db);

    try {
      feeds.upsert({
        id: "feed_explore",
        title: "Explore Feed",
        feedUrl: "https://example.com/explore.xml",
        now: 1000
      });
      embeddings.upsertProvider({
        id: "provider_explore",
        type: "openai_compatible",
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 1000
      });
      embeddings.createIndex({
        id: "index_explore",
        providerId: "provider_explore",
        model: "fixture",
        dimension: 3,
        now: 1000
      });
      for (let index = 0; index < 30; index += 1) {
        insertArticleForFeed(
          articles,
          `explore_${index}`,
          "feed_explore",
          `Exploration candidate ${index}`,
          `hash_explore_${index}`,
          1000 + index
        );
      }
      actions.record({ articleId: "explore_25", type: "hide", now: 2000 });

      const rankingLevel1 = new RecommendationRankingService({
        db,
        embeddings,
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        getRankingSettings: () => ({
          cocoonLevel: 1,
          localLearningEnabled: false,
          localLearningShadowMode: true,
          explorationEnabled: true,
          evaluationEnabled: false
        }),
        now: () => 3000
      });
      rankingLevel1.recalculateAll();
      const level1Exploration = top20ExplorationRows(db, rankingLevel1.getActiveRankContext());
      expect(level1Exploration.length).toBeGreaterThan(0);
      expect(level1Exploration.length).toBeLessThanOrEqual(2);
      expect(
        db
          .prepare("select 1 from article_rank_scores where article_id = 'explore_25' and rank_context = ?")
          .get(rankingLevel1.getActiveRankContext())
      ).toBeUndefined();

      const explanation = db
        .prepare(
          `
            select payload_json as payloadJson
            from article_rank_explanations
            where article_id = ?
              and rank_context = ?
          `
        )
        .get(level1Exploration[0]!.articleId, rankingLevel1.getActiveRankContext()) as
        | { payloadJson: string }
        | undefined;
      const payload = JSON.parse(explanation?.payloadJson ?? "{}") as {
        components?: {
          wasExploration?: boolean;
          explorationBucket?: string | null;
          explorationReason?: string | null;
        };
      };
      expect(payload.components?.wasExploration).toBe(true);
      expect(payload.components?.explorationBucket).toEqual(expect.any(String));
      expect(payload.components?.explorationReason).toEqual(expect.any(String));
      expect(rankingLevel1.explainArticle(level1Exploration[0]!.articleId)?.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "exploration",
            label: "Break-cocoon exploration",
            impact: "neutral"
          })
        ])
      );

      const rankingLevel10 = new RecommendationRankingService({
        db,
        embeddings,
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        getRankingSettings: () => ({
          cocoonLevel: 10,
          localLearningEnabled: false,
          localLearningShadowMode: true,
          explorationEnabled: true,
          evaluationEnabled: false
        }),
        now: () => 3000
      });
      rankingLevel10.recalculateAll();
      expect(top20ExplorationRows(db, rankingLevel10.getActiveRankContext()).length).toBeLessThan(
        level1Exploration.length
      );

      const rankingDisabled = new RecommendationRankingService({
        db,
        embeddings,
        profiles: new SqliteProfileRepository(db),
        rankings: new SqliteRankingRepository(db),
        getRankingSettings: () => ({
          cocoonLevel: 1,
          localLearningEnabled: false,
          localLearningShadowMode: true,
          explorationEnabled: false,
          evaluationEnabled: false
        }),
        now: () => 3000
      });
      rankingDisabled.recalculateAll();
      const disabledRows = db
        .prepare(
          `
            select count(*) as count
            from article_rank_scores
            where rank_context = ?
              and coalesce(exploration_bonus, 0) > 0
          `
        )
        .get(rankingDisabled.getActiveRankContext()) as { count: number };
      expect(disabledRows.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("writes lightweight replay diagnostic metrics without blocking recommendations", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const actions = new SqliteArticleActionRepository(db);

    try {
      feeds.upsert({ id: "feed_eval_replay", title: "Replay Feed", feedUrl: "https://example.com/replay.xml", now: 1000 });
      insertArticleForFeed(articles, "replay_article", "feed_eval_replay", "Replay Article", "hash_replay", 1000);
      actions.record({ articleId: "replay_article", type: "open", now: 2000 });
      actions.record({ articleId: "replay_article", type: "favorite", now: 3000 });

      createMaintenanceService(db, 5000).handleJob(maintenanceJob(RANKING_EVAL_RUN_JOB_TYPE));
      const run = db
        .prepare("select metrics_json as metricsJson from ranking_eval_runs order by created_at desc limit 1")
        .get() as { metricsJson: string } | undefined;
      const metrics = JSON.parse(run?.metricsJson ?? "{}") as {
        evaluationMode?: string;
        strictReplay?: boolean;
        diagnosticOnly?: boolean;
        hitAt10?: number;
        ndcgAt10?: number;
        mrr?: number;
        cutoffCount?: number;
        labelCount?: number;
      };
      expect(metrics.evaluationMode).toBe("lightweight_replay_diagnostic");
      expect(metrics.strictReplay).toBe(false);
      expect(metrics.diagnosticOnly).toBe(true);
      expect(metrics.cutoffCount).toBeGreaterThan(0);
      expect(metrics.labelCount).toBeGreaterThanOrEqual(0);
      expect(metrics.hitAt10).toBeGreaterThanOrEqual(0);
      expect(metrics.ndcgAt10).toBeGreaterThanOrEqual(0);
      expect(metrics.mrr).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
    }
  });

  it("keeps profile decay stable within a day and more conservative for negative clusters", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const embeddings = new SqliteEmbeddingRepository(db);
    const jobs = new SqliteJobRepository(db);
    const profiles = new SqliteProfileRepository(db);
    const settings = new SqliteAppSettingsRepository(db);
    const rankings = new SqliteRankingRepository(db);
    const profile = new ProfileService({
      embeddings,
      profiles,
      now: () => 3 * 86_400_000
    });
    const rankingJobs = new RankingRecalculateJobService({
      jobs,
      ranking: new RecommendationRankingService({ rankings, now: () => 3 * 86_400_000 }),
      now: () => 3 * 86_400_000
    });
    const decayJobs = new ProfileDecayJobService({
      jobs,
      profile,
      rankingJobs,
      settings,
      now: () => 3 * 86_400_000
    });

    try {
      embeddings.upsertProvider({
        id: "provider_decay",
        type: "openai_compatible",
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 0
      });
      embeddings.createIndex({
        id: "index_decay",
        providerId: "provider_decay",
        model: "fixture",
        dimension: 3,
        now: 0
      });
      profiles.upsertCluster({
        id: "cluster_decay_positive",
        embeddingIndexId: "index_decay",
        polarity: "positive",
        centroidVectorBlob: toVectorBlob([1, 0, 0]),
        weight: 10,
        sampleCount: 3,
        lastMatchedAt: 86_400_000,
        now: 86_400_000
      });
      profiles.upsertCluster({
        id: "cluster_decay_negative",
        embeddingIndexId: "index_decay",
        polarity: "negative",
        centroidVectorBlob: toVectorBlob([0, 1, 0]),
        weight: 10,
        sampleCount: 3,
        lastMatchedAt: 86_400_000,
        now: 86_400_000
      });

      settings.setJson("profile.decayLastRunAt", 3 * 86_400_000 - 3_600_000, 3 * 86_400_000);
      decayJobs.handleProfileDecayJob({
        id: "job_decay_same_day",
        type: "profile_decay",
        status: "running",
        payloadJson: null,
        error: null,
        attempts: 1,
        maxAttempts: 1,
        priority: 0,
        runAfter: 0,
        startedAt: null,
        finishedAt: null,
        createdAt: 0,
        updatedAt: 0
      });
      expect(profiles.listClusters({ embeddingIndexId: "index_decay", polarity: "positive" })[0]?.weight).toBe(10);

      settings.setJson("profile.decayLastRunAt", 86_400_000, 3 * 86_400_000);
      decayJobs.handleProfileDecayJob({
        id: "job_decay_two_days",
        type: "profile_decay",
        status: "running",
        payloadJson: null,
        error: null,
        attempts: 1,
        maxAttempts: 1,
        priority: 0,
        runAfter: 0,
        startedAt: null,
        finishedAt: null,
        createdAt: 0,
        updatedAt: 0
      });

      const positive = profiles.listClusters({ embeddingIndexId: "index_decay", polarity: "positive" })[0]!;
      const negative = profiles.listClusters({ embeddingIndexId: "index_decay", polarity: "negative" })[0]!;
      expect(positive.weight).toBeLessThan(10);
      expect(negative.weight).toBeLessThan(10);
      expect(negative.weight).toBeGreaterThan(positive.weight);
    } finally {
      db.close();
    }
  });

  it("uses configured positive cluster limits when trimming profile clusters", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const embeddings = new SqliteEmbeddingRepository(db);
    const profiles = new SqliteProfileRepository(db);

    try {
      embeddings.upsertProvider({
        id: "provider_trim_config",
        type: "openai_compatible",
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 0
      });
      embeddings.createIndex({
        id: "index_trim_config",
        providerId: "provider_trim_config",
        model: "fixture",
        dimension: 3,
        now: 0
      });
      for (let index = 0; index < 30; index += 1) {
        profiles.upsertCluster({
          id: `cluster_trim_large_${index}`,
          embeddingIndexId: "index_trim_config",
          polarity: "positive",
          centroidVectorBlob: toVectorBlob([0, 0, 0]),
          weight: 30 - index,
          sampleCount: 2,
          lastMatchedAt: 1000,
          now: 1000 + index
        });
      }

      new ProfileService({
        embeddings,
        profiles,
        getClusterLimits: () => ({
          maxPositiveInterestClusters: 32,
          maxNegativeInterestClusters: 16
        }),
        now: () => 2000
      }).decayClusters();
      expect(profiles.listClusters({ embeddingIndexId: "index_trim_config", polarity: "positive" }))
        .toHaveLength(30);

      new ProfileService({
        embeddings,
        profiles,
        getClusterLimits: () => ({
          maxPositiveInterestClusters: 12,
          maxNegativeInterestClusters: 16
        }),
        now: () => 3000
      }).decayClusters();
      const remaining = profiles.listClusters({
        embeddingIndexId: "index_trim_config",
        polarity: "positive"
      });
      expect(remaining).toHaveLength(12);
      expect(remaining.map((cluster) => cluster.id)).toEqual(
        Array.from({ length: 12 }, (_, index) => `cluster_trim_large_${index}`)
      );
    } finally {
      db.close();
    }
  });

  it("trims older low-ranked clusters before newly created single-sample clusters", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    const embeddings = new SqliteEmbeddingRepository(db);
    const profiles = new SqliteProfileRepository(db);
    const now = 2 * 86_400_000;

    try {
      embeddings.upsertProvider({
        id: "provider_trim_new",
        type: "openai_compatible",
        name: "Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 0
      });
      embeddings.createIndex({
        id: "index_trim_new",
        providerId: "provider_trim_new",
        model: "fixture",
        dimension: 3,
        now: 0
      });
      for (const cluster of [
        { id: "cluster_keep_top_0", weight: 10, sampleCount: 3, createdAt: 0 },
        { id: "cluster_keep_top_1", weight: 9, sampleCount: 3, createdAt: 0 },
        { id: "cluster_delete_mature_tail", weight: 8, sampleCount: 3, createdAt: 0 },
        { id: "cluster_keep_new_tail", weight: 1, sampleCount: 1, createdAt: now },
        { id: "cluster_delete_old_tail", weight: 0.9, sampleCount: 3, createdAt: 0 }
      ]) {
        profiles.upsertCluster({
          id: cluster.id,
          embeddingIndexId: "index_trim_new",
          polarity: "positive",
          centroidVectorBlob: toVectorBlob([0, 0, 0]),
          weight: cluster.weight,
          sampleCount: cluster.sampleCount,
          lastMatchedAt: now,
          now: cluster.createdAt
        });
      }

      new ProfileService({
        embeddings,
        profiles,
        getClusterLimits: () => ({
          maxPositiveInterestClusters: 3,
          maxNegativeInterestClusters: 16
        }),
        now: () => now
      }).decayClusters();

      expect(
        profiles
          .listClusters({ embeddingIndexId: "index_trim_new", polarity: "positive" })
          .map((cluster) => cluster.id)
      ).toEqual(["cluster_keep_top_0", "cluster_keep_top_1", "cluster_keep_new_tail"]);
    } finally {
      db.close();
    }
  });
});

function createProfileFixture() {
  const db = openDatabase(tempDatabasePath(), { migrate: true });
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);
  const actions = new SqliteArticleActionRepository(db);
  const embeddings = new SqliteEmbeddingRepository(db);
  const jobs = new SqliteJobRepository(db);
  const profiles = new SqliteProfileRepository(db);
  const rankings = new SqliteRankingRepository(db);
  const vectorStore = new SqliteVecVectorStore(db);

  feeds.upsert({
    id: "feed_profile",
    title: "Profile Feed",
    feedUrl: "https://example.com/profile.xml",
    now: 1000
  });
  embeddings.upsertProvider({
    id: "provider_profile",
    type: "openai_compatible",
    name: "Provider",
    baseUrl: "https://api.example.com/v1",
    model: "fixture",
    dimension: 3,
    enabled: true,
    now: 1000
  });
  embeddings.createIndex({
    id: "index_profile",
    providerId: "provider_profile",
    model: "fixture",
    dimension: 3,
    now: 1000
  });

  insertArticle(articles, "article_liked", "Liked profile topic", "hash_liked", 1000);
  insertArticle(articles, "article_similar", "Similar profile topic", "hash_similar", 1100);
  insertArticle(articles, "article_other", "Other profile topic", "hash_other", 1200);
  vectorStore.upsertArticleVector({
    articleId: "article_liked",
    embeddingIndexId: "index_profile",
    vector: [1, 0, 0],
    contentHash: "hash_liked",
    now: 1000
  });
  vectorStore.upsertArticleVector({
    articleId: "article_similar",
    embeddingIndexId: "index_profile",
    vector: [0.98, 0.02, 0],
    contentHash: "hash_similar",
    now: 1000
  });
  vectorStore.upsertArticleVector({
    articleId: "article_other",
    embeddingIndexId: "index_profile",
    vector: [0, 1, 0],
    contentHash: "hash_other",
    now: 1000
  });

  const profile = new ProfileService({
    embeddings,
    profiles,
    clusterIdFactory: () => "cluster_profile",
    now: () => 5000
  });
  const ranking = new RecommendationRankingService({
    embeddings,
    profiles,
    rankings,
    now: () => 5000
  });

  return {
    actions,
    articles,
    db,
    embeddings,
    jobs,
    profile,
    profiles,
    rankings,
    ranking,
    vectorStore
  };
}

function createEvaluationFixture() {
  const db = openDatabase(tempDatabasePath(), { migrate: true });
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);
  const actions = new SqliteArticleActionRepository(db);
  const embeddings = new SqliteEmbeddingRepository(db);
  const profiles = new SqliteProfileRepository(db);
  const rankings = new SqliteRankingRepository(db);
  const vectorStore = new SqliteVecVectorStore(db);

  feeds.upsert({
    id: "feed_eval",
    title: "Evaluation Feed",
    feedUrl: "https://example.com/eval.xml",
    now: 1000
  });
  embeddings.upsertProvider({
    id: "provider_eval",
    type: "openai_compatible",
    name: "Provider",
    baseUrl: "https://api.example.com/v1",
    model: "fixture",
    dimension: 3,
    enabled: true,
    now: 1000
  });
  embeddings.createIndex({
    id: "index_eval",
    providerId: "provider_eval",
    model: "fixture",
    dimension: 3,
    now: 1000
  });

  const vectors: Record<string, [number, number, number]> = {
    seed_favorite: [1, 0, 0],
    candidate_favorite: [0.98, 0.02, 0],
    seed_later: [0, 1, 0],
    candidate_later: [0.02, 0.98, 0],
    seed_complete: [0, 0, 1],
    candidate_complete: [0, 0.02, 0.98],
    seed_negative: [0.7, 0.7, 0],
    candidate_negative: [0.68, 0.72, 0],
    candidate_other: [0.35, 0.2, 0.9],
    seed_open_1: [0.2, -0.9, 0.1],
    seed_open_2: [0.21, -0.9, 0.1],
    seed_open_3: [0.19, -0.91, 0.1],
    seed_open_4: [0.2, -0.89, 0.11],
    candidate_open: [0.2, -0.9, 0.1]
  };

  for (const [articleId, vector] of Object.entries(vectors)) {
    const publishedAt = articleId === "candidate_open" ? 500 : articleId.startsWith("candidate_") ? 3_000 : 1_000;
    insertArticleForFeed(
      articles,
      articleId,
      "feed_eval",
      articleId.replaceAll("_", " "),
      `hash_${articleId}`,
      publishedAt
    );
    vectorStore.upsertArticleVector({
      articleId,
      embeddingIndexId: "index_eval",
      vector,
      contentHash: `hash_${articleId}`,
      now: 1000
    });
  }

  let clusterCount = 0;
  const profile = new ProfileService({
    embeddings,
    profiles,
    clusterIdFactory: () => {
      clusterCount += 1;
      return `cluster_eval_${clusterCount}`;
    },
    now: () => 5_000
  });
  const ranking = new RecommendationRankingService({
    embeddings,
    profiles,
    rankings,
    now: () => 5_000
  });

  return {
    actions,
    articles,
    db,
    profile,
    ranking,
    vectorStore
  };
}

function insertArticle(
  articles: SqliteArticleRepository,
  articleId: string,
  title: string,
  contentHash: string,
  publishedAt: number
): void {
  articles.upsert({
    id: articleId,
    feedId: "feed_profile",
    url: `https://example.com/${articleId}`,
    canonicalUrl: `https://example.com/${articleId}`,
    title,
    summary: `${title} summary`,
    publishedAt,
    discoveredAt: publishedAt,
    contentHash,
    dedupeKey: articleId,
    now: publishedAt
  });
}

function insertArticleForFeed(
  articles: SqliteArticleRepository,
  articleId: string,
  feedId: string,
  title: string,
  contentHash: string,
  publishedAt: number
): void {
  articles.upsert({
    id: articleId,
    feedId,
    url: `https://example.com/${articleId}`,
    canonicalUrl: `https://example.com/${articleId}`,
    title,
    summary: `${title} summary`,
    publishedAt,
    discoveredAt: publishedAt,
    contentHash,
    dedupeKey: articleId,
    now: publishedAt
  });
}

function insertRankCandidate(
  articles: SqliteArticleRepository,
  vectorStore: SqliteVecVectorStore,
  input: {
    articleId: string;
    feedId: string;
    title: string;
    vector: [number, number, number];
    publishedAt: number;
  }
): void {
  insertArticleForFeed(
    articles,
    input.articleId,
    input.feedId,
    input.title,
    `hash_${input.articleId}`,
    input.publishedAt
  );
  vectorStore.upsertArticleVector({
    articleId: input.articleId,
    embeddingIndexId: "index_family_rank",
    vector: input.vector,
    contentHash: `hash_${input.articleId}`,
    now: input.publishedAt
  });
}

function insertRankingFamily(
  db: DibaoDatabase,
  profiles: SqliteProfileRepository,
  input: {
    familyId: string;
    displayLabel: string;
    clusters: Array<[string, [number, number, number]]>;
    dominanceRatio: number;
  }
): void {
  const now = 5_000;
  for (const [clusterId, vector] of input.clusters) {
    profiles.upsertCluster({
      id: clusterId,
      embeddingIndexId: "index_family_rank",
      polarity: "positive",
      label: input.displayLabel,
      centroidVectorBlob: toVectorBlob(vector),
      weight: 12,
      sampleCount: 6,
      now
    });
  }
  db.prepare(
    `
      insert into interest_families (
        id,
        embedding_index_id,
        polarity,
        display_label,
        centroid_vector_blob,
        weight,
        cluster_count,
        support_article_count,
        support_event_count,
        source_count,
        strong_signal_count,
        top_source_share,
        maturity,
        dominance_ratio,
        label_terms_json,
        representative_cluster_ids_json,
        diagnostics_json,
        created_at,
        updated_at
      )
      values (?, 'index_family_rank', 'positive', ?, ?, ?, ?, 12, 12, 3, 12, 0.34, 1, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    input.familyId,
    input.displayLabel,
    toVectorBlob(input.clusters[0]?.[1] ?? [1, 0, 0]),
    input.clusters.length * 12,
    input.clusters.length,
    input.dominanceRatio,
    JSON.stringify([input.displayLabel]),
    JSON.stringify(input.clusters.map(([clusterId]) => clusterId)),
    JSON.stringify({
      lowSupportClusterCount: 0,
      singleArticleClusterCount: 0,
      concentrationRisk: input.dominanceRatio > 0.5 ? "medium" : "low"
    }),
    now,
    now
  );
  const insertMember = db.prepare(
    `
      insert into interest_cluster_family_members (
        cluster_id,
        family_id,
        embedding_index_id,
        polarity,
        membership_confidence,
        centroid_similarity,
        created_at,
        updated_at
      )
      values (?, ?, 'index_family_rank', 'positive', 1, 1, ?, ?)
    `
  );
  for (const [clusterId] of input.clusters) {
    insertMember.run(clusterId, input.familyId, now, now);
  }
}

function recommendedIds(
  db: DibaoDatabase,
  rankContext = TEST_ACTIVE_RANK_CONTEXT,
  limit = 100
): string[] {
  return new SqliteArticleRepository(db)
    .list({ view: "recommended", rankContext, limit })
    .items.map((article) => article.id);
}

function activeScoreForContext(
  db: DibaoDatabase,
  articleId: string,
  rankContext: string
): number | null {
  const contexts =
    rankContext === "base"
      ? ["base"]
      : [rankContext, TEST_ACTIVE_RANK_CONTEXT];
  const row = db
    .prepare(
      `
        select score
        from article_rank_scores
          where article_id = ?
          and rank_context in (${contexts.map(() => "?").join(", ")})
        order by case when rank_context = ? then 0 else 1 end
      `
    )
    .get(articleId, ...contexts, TEST_ACTIVE_RANK_CONTEXT) as { score: number } | undefined;

  return row?.score ?? null;
}

function top20ExplorationRows(
  db: DibaoDatabase,
  rankContext: string
): Array<{ articleId: string; explorationBonus: number }> {
  return db
    .prepare(
      `
        select article_id as articleId, exploration_bonus as explorationBonus
        from article_rank_scores
        where rank_context = ?
          and rerank_position <= 20
          and coalesce(exploration_bonus, 0) > 0
        order by rerank_position asc
      `
    )
    .all(rankContext) as Array<{ articleId: string; explorationBonus: number }>;
}

function feedStats(db: DibaoDatabase, feedId: string): {
  positiveScore: number;
  negativeScore: number;
} {
  const row = db
    .prepare(
      `
        select
          positive_score as positiveScore,
          negative_score as negativeScore
        from feed_stats
        where feed_id = ?
      `
    )
    .get(feedId) as { positiveScore: number; negativeScore: number } | undefined;

  return row ?? { positiveScore: 0, negativeScore: 0 };
}

async function drainRankingJobs(db: DibaoDatabase, now: number): Promise<void> {
  await drainJobs(db, now, false);
}

async function drainProfileAndRankingJobs(db: DibaoDatabase, now: number): Promise<void> {
  await drainJobs(db, now, true);
}

async function drainJobs(
  db: DibaoDatabase,
  now: number,
  includeProfileEvents: boolean
): Promise<void> {
  const jobs = new SqliteJobRepository(db);
  const embeddings = new SqliteEmbeddingRepository(db);
  const profiles = new SqliteProfileRepository(db);
  const rankings = new SqliteRankingRepository(db);
  const ranking = new RecommendationRankingService({
    embeddings,
    profiles,
    rankings,
    now: () => now
  });
  const rankingJobs = new RankingRecalculateJobService({
    jobs,
    ranking,
    now: () => now
  });
  const profile = new ProfileService({
    embeddings,
    profiles,
    now: () => now
  });
  const profileEventJobs = new ProfileEventProcessJobService({
    jobs,
    profile,
    rankingJobs,
    now: () => now
  });
  const behaviorProjectionJobs = new BehaviorProjectionJobService({
    db,
    jobs,
    profile,
    rankingJobs,
    now: () => now
  });
  const runner = new JobRunner({
    jobs,
    handlers: {
      ...(includeProfileEvents
        ? {
            [BEHAVIOR_EVENT_PROJECT_JOB_TYPE]: (job) => {
              behaviorProjectionJobs.handleBehaviorEventProjectJob(job);
            },
            [PROFILE_EVENT_PROCESS_JOB_TYPE]: (job) =>
              profileEventJobs.handleProfileEventProcessJob(job)
          }
        : {}),
      [RANKING_RECALCULATE_JOB_TYPE]: (job) => {
        rankingJobs.handleRankingRecalculateJob(job);
      }
    },
    now: () => now
  });

  await runner.drainDue();
}

function activeScore(db: DibaoDatabase, articleId: string): number | null {
  const row = db
    .prepare(
      `
        select score
        from article_rank_scores
          where article_id = ?
          and rank_context in ('index_profile', ?)
        order by case when rank_context = ? then 0 else 1 end
      `
    )
    .get(articleId, TEST_ACTIVE_RANK_CONTEXT, TEST_ACTIVE_RANK_CONTEXT) as { score: number } | undefined;

  return row?.score ?? null;
}

function activeBm25Score(db: DibaoDatabase, articleId: string): number | null {
  const row = db
    .prepare(
      `
        select bm25_score as bm25Score
        from article_rank_scores
          where article_id = ?
          and rank_context = ?
      `
    )
    .get(articleId, TEST_ACTIVE_RANK_CONTEXT) as { bm25Score: number | null } | undefined;

  return row?.bm25Score ?? null;
}

function bm25ScoreForContext(
  db: DibaoDatabase,
  articleId: string,
  rankContext: string
): number | null {
  const row = db
    .prepare(
      `
        select bm25_score as bm25Score
        from article_rank_scores
        where article_id = ?
          and rank_context = ?
      `
    )
    .get(articleId, rankContext) as { bm25Score: number | null } | undefined;

  return row?.bm25Score ?? null;
}

function createMaintenanceService(db: DibaoDatabase, now: number): RecommendationMaintenanceService {
  const jobs = new SqliteJobRepository(db);
  const rankingJobs = new RankingRecalculateJobService({
    jobs,
    ranking: new RecommendationRankingService({
      db,
      embeddings: new SqliteEmbeddingRepository(db),
      profiles: new SqliteProfileRepository(db),
      rankings: new SqliteRankingRepository(db),
      now: () => now
    }),
    now: () => now
  });
  return new RecommendationMaintenanceService({
    db,
    jobs,
    rankingJobs,
    now: () => now
  });
}

function maintenanceJob(type: Parameters<RecommendationMaintenanceService["handleJob"]>[0]["type"]): Parameters<RecommendationMaintenanceService["handleJob"]>[0] {
  return {
    id: `job_${type}`,
    type,
    status: "running",
    payloadJson: null,
    error: null,
    attempts: 1,
    maxAttempts: 1,
    priority: 0,
    runAfter: 0,
    startedAt: null,
    finishedAt: null,
    createdAt: 0,
    updatedAt: 0
  };
}

function clusterEvidenceCount(db: DibaoDatabase): number {
  return countRows(db, "interest_cluster_evidence");
}

function countRows(db: DibaoDatabase, tableName: string): number {
  const row = db.prepare(`select count(*) as count from ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}

function countQueuedJobs(db: DibaoDatabase, type: string): number {
  const row = db
    .prepare("select count(*) as count from jobs where type = ? and status = 'queued'")
    .get(type) as { count: number };
  return row.count;
}

function waitForDeferredPostActionWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dibao-profile-ranking-"));
  tempDirs.push(dir);
  return join(dir, "test.sqlite");
}
