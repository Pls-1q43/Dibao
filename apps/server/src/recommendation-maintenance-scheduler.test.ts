import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  SqliteAppSettingsRepository,
  SqliteArticleRepository,
  SqliteEmbeddingRepository,
  SqliteFeedRepository,
  SqliteJobRepository,
  SqliteProfileRepository,
  SqliteRankingRepository,
  SqliteVecVectorStore,
  type DibaoDatabase
} from "@dibao/db";
import { EmbeddingJobService } from "./embedding-job-service.js";
import { EmbeddingProviderService } from "./embedding-provider-service.js";
import { RecommendationMaintenanceScheduler } from "./recommendation-maintenance-scheduler.js";
import { RecommendationMaintenanceService } from "./recommendation-maintenance-service.js";
import { RecommendationRankingService } from "./ranking-service.js";
import { RankingRecalculateJobService } from "./ranking-job-service.js";
import { DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS } from "./settings-service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RecommendationMaintenanceScheduler", () => {
  it("records disabled skips and does not enqueue when maintenance is off", async () => {
    const fixture = createFixture(1_000_000);
    try {
      const scheduler = createScheduler(fixture, {
        maintenanceEnabled: false
      });

      expect(await scheduler.tick()).toEqual([]);
      expect(fixture.jobs.list({ status: "queued" })).toHaveLength(0);
      expect(
        fixture.db
          .prepare(
            "select last_skipped_reason as reason from recommendation_maintenance_schedule_state where task_key = 'recent_intent_periodic'"
          )
          .get()
      ).toEqual({ reason: "disabled" });
    } finally {
      fixture.db.close();
    }
  });

  it("enqueues periodic recent intent and FTRL for strong untrained behavior", async () => {
    const fixture = createFixture(1_000_000);
    try {
      insertStrongBehavior(fixture.db, 990_000);
      const scheduler = createScheduler(fixture);

      const enqueued = await scheduler.tick();

      expect(enqueued.map((item) => item.taskKey)).toContain("recent_intent_periodic");
      expect(enqueued.map((item) => item.taskKey)).toContain("ftrl_train_periodic");
      expect(fixture.jobs.countByTypeAndStatus("recent_intent_rebuild", "queued")).toBe(1);
      expect(fixture.jobs.countByTypeAndStatus("ftrl_train", "queued")).toBe(1);
    } finally {
      fixture.db.close();
    }
  });

  it("dedupes hourly recent intent and duplicate rebuild jobs across repeated ticks", async () => {
    const fixture = createFixture(1_000_000);
    try {
      const scheduler = createScheduler(fixture);
      await scheduler.tick();
      await scheduler.tick();

      expect(fixture.jobs.countByTypeAndStatus("recent_intent_rebuild", "queued")).toBe(1);
      expect(fixture.jobs.countByTypeAndStatus("duplicate_group_rebuild", "queued")).toBe(1);
      expect(
        fixture.maintenance.scheduleStateFor("duplicate_hourly")?.lastSkippedReason
      ).toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  it("enqueues daily maintenance work without scheduling a periodic ranking refresh", async () => {
    const fixture = createFixture(10 * 86_400_000);
    try {
      const scheduler = createScheduler(fixture);
      await scheduler.tick();

      expect(fixture.maintenance.scheduleStateFor("keyword_profile_daily")?.lastJobId).toEqual(expect.any(String));
      expect(fixture.maintenance.scheduleStateFor("duplicate_daily")?.lastJobId).toEqual(expect.any(String));
      expect(fixture.maintenance.scheduleStateFor("recent_intent_daily")?.lastJobId).toEqual(expect.any(String));
      expect(fixture.maintenance.scheduleStateFor("ftrl_train_daily")?.lastJobId).toEqual(expect.any(String));
      expect(fixture.maintenance.scheduleStateFor("cluster_label_daily")?.lastJobId).toEqual(expect.any(String));
      expect(fixture.maintenance.scheduleStateFor("cluster_merge_diagnostics_daily")?.lastJobId).toEqual(expect.any(String));
      expect(fixture.maintenance.scheduleStateFor("interest_family_daily")?.lastJobId).toEqual(expect.any(String));
      expect(fixture.maintenance.scheduleStateFor("ranking_recalculate_daily")).toBeNull();
      expect(fixture.jobs.countByTypeAndStatus("interest_cluster_label_rebuild", "queued")).toBe(1);
      expect(fixture.jobs.countByTypeAndStatus("interest_cluster_merge_diagnostics", "queued")).toBe(1);
      expect(fixture.jobs.countByTypeAndStatus("interest_family_rebuild", "queued")).toBe(1);
      expect(fixture.jobs.countByTypeAndStatus("interest_cluster_auto_merge", "queued")).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  it("keeps evaluation disabled by default and only enqueues it when the interval is due", async () => {
    const fixture = createFixture(10 * 86_400_000);
    try {
      await createScheduler(fixture).tick();
      expect(fixture.jobs.countByTypeAndStatus("ranking_eval_run", "queued")).toBe(0);
      expect(fixture.maintenance.scheduleStateFor("evaluation_weekly")?.lastSkippedReason).toBe("disabled");

      await createScheduler(fixture, { evaluationAutoRunEnabled: true }).tick();
      expect(fixture.jobs.countByTypeAndStatus("ranking_eval_run", "queued")).toBe(1);
    } finally {
      fixture.db.close();
    }
  });

  it("skips embedding health without an active index and when embedding jobs are open", async () => {
    const fixture = createFixture(1_000_000);
    try {
      await createScheduler(fixture).tick();
      expect(fixture.maintenance.scheduleStateFor("embedding_health_hourly")?.lastSkippedReason).toBe(
        "no_active_index"
      );

      insertActiveIndex(fixture.db);
      fixture.jobs.enqueue({
        id: "job_embedding_open",
        type: "embedding_generate",
        payloadJson: JSON.stringify({ embeddingIndexId: "index_health", articleIds: ["article_health"] }),
        now: 1_000_001
      });
      fixture.maintenance.recordScheduleSkip("embedding_health_hourly", "reset");
      await createScheduler(fixture, {}, 2_000_000).tick();
      expect(fixture.maintenance.scheduleStateFor("embedding_health_hourly")?.lastSkippedReason).toBe(
        "existing_job"
      );
    } finally {
      fixture.db.close();
    }
  });
});

function createFixture(now: number) {
  const db = openDatabase(tempDatabasePath(), { migrate: true });
  const jobs = new SqliteJobRepository(db);
  const embeddings = new SqliteEmbeddingRepository(db);
  const profiles = new SqliteProfileRepository(db);
  const rankings = new SqliteRankingRepository(db);
  const ranking = new RecommendationRankingService({
    db,
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
  const maintenance = new RecommendationMaintenanceService({
    db,
    jobs,
    rankingJobs,
    now: () => now
  });
  const settings = new SqliteAppSettingsRepository(db);

  return { db, jobs, maintenance, settings };
}

function createScheduler(
  fixture: ReturnType<typeof createFixture>,
  settingsPatch: Partial<typeof DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS> = {},
  now = 1_000_000
): RecommendationMaintenanceScheduler {
  const articles = new SqliteArticleRepository(fixture.db);
  const embeddings = new SqliteEmbeddingRepository(fixture.db);
  const vectorStore = new SqliteVecVectorStore(fixture.db);
  const providerService = new EmbeddingProviderService({
    embeddings,
    vectorStore,
    adapters: {
      openai_compatible: {
        embedBatch: async () => [],
        test: async () => ({ dimension: 3, latencyMs: 1 })
      },
      ollama: {
        embedBatch: async () => [],
        test: async () => ({ dimension: 3, latencyMs: 1 })
      }
    },
    now: () => now
  });
  const embeddingJobs = new EmbeddingJobService({
    articles,
    embeddings,
    jobs: fixture.jobs,
    providerService,
    vectorStore,
    now: () => now
  });

  return new RecommendationMaintenanceScheduler({
    db: fixture.db,
    jobs: fixture.jobs,
    maintenance: fixture.maintenance,
    embeddingJobs,
    settings: () => ({
      ...DEFAULT_RECOMMENDATION_MAINTENANCE_SETTINGS,
      ...settingsPatch
    }),
    now: () => now
  });
}

function insertStrongBehavior(db: DibaoDatabase, createdAt: number): void {
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);
  feeds.upsert({
    id: "feed_behavior",
    title: "Behavior Feed",
    feedUrl: "https://example.com/feed.xml",
    now: createdAt
  });
  articles.upsert({
    id: "article_behavior",
    feedId: "feed_behavior",
    url: "https://example.com/article",
    title: "Behavior Article",
    discoveredAt: createdAt,
    dedupeKey: "article_behavior",
    now: createdAt
  });
  db.prepare(
    `
      insert into behavior_events (
        id,
        article_id,
        event_type,
        event_weight,
        created_at
      )
      values ('event_behavior', 'article_behavior', 'favorite', 1.5, ?)
    `
  ).run(createdAt);
}

function insertActiveIndex(db: DibaoDatabase): void {
  const embeddings = new SqliteEmbeddingRepository(db);
  embeddings.upsertProvider({
    id: "provider_health",
    type: "openai_compatible",
    name: "Provider",
    baseUrl: "https://api.example.com/v1",
    model: "fixture",
    dimension: 3,
    enabled: true,
    now: 1_000_000
  });
  embeddings.createIndex({
    id: "index_health",
    providerId: "provider_health",
    model: "fixture",
    dimension: 3,
    now: 1_000_000
  });
}

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dibao-maintenance-scheduler-"));
  tempDirs.push(dir);
  return join(dir, "test.sqlite");
}
