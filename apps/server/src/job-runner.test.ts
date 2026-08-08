import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  SqliteArticleRepository,
  SqliteAppSettingsRepository,
  SqliteEmbeddingRepository,
  SqliteFeedRepository,
  SqliteJobRepository,
  SqliteProfileRepository,
  SqliteRankingRepository,
  SqliteVecVectorStore,
  type DibaoDatabase,
  type JobRow
} from "@dibao/db";
import {
  ArticleRetentionService,
  DEFAULT_ARTICLE_RETENTION_DAYS,
  RETENTION_ARTICLE_DAYS_SETTING_KEY
} from "./article-retention-service.js";
import {
  EmbeddingJobService,
  EMBEDDING_GENERATE_JOB_TYPE
} from "./embedding-job-service.js";
import { EmbeddingProviderService } from "./embedding-provider-service.js";
import { EmbeddingProviderError, type EmbeddingProviderAdapter } from "./embedding/types.js";
import {
  DEFAULT_FEED_REFRESH_INTERVAL_MS,
  FeedRefreshCoordinator,
  FeedRefreshJobService,
  FeedRefreshScheduler
} from "./feed-refresh-job-service.js";
import { FeedRefreshService, type FeedFetcher } from "./feed-refresh-service.js";
import { DeferredJobRun, JobRunner } from "./job-runner.js";
import { JobHistoryCleanupScheduler } from "./job-history-cleanup-scheduler.js";
import type { HostnameResolver } from "./controlled-fetch.js";
import {
  ProfileDecayJobService,
  PROFILE_DECAY_JOB_TYPE
} from "./profile-decay-job-service.js";
import { ProfileService } from "./profile-service.js";
import {
  RankingRecalculateJobService,
  RANKING_RECALCULATE_JOB_TYPE
} from "./ranking-job-service.js";
import { RecommendationRankingService } from "./ranking-service.js";
import {
  RetentionCleanupJobService,
  RetentionCleanupScheduler
} from "./retention-cleanup-job-service.js";

const tempDirs: string[] = [];
const publicTestResolver: HostnameResolver = async () => ["203.0.113.10"];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("job runner foundation", () => {
  it("defers a job without spending an attempt when a handler requests a future run time", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);

    try {
      jobs.enqueue({
        id: "job_deferred",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: "feed_deferred" }),
        maxAttempts: 3,
        runAfter: 1000,
        now: 1000
      });
      const runner = new JobRunner({
        jobs,
        handlers: {
          feed_refresh: () => {
            throw new DeferredJobRun("rate limited", 60_000);
          }
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({ id: "job_deferred" });
      expect(jobs.findById("job_deferred")).toMatchObject({
        status: "queued",
        attempts: 0,
        runAfter: 60_000,
        error: "rate limited"
      });
    } finally {
      db.close();
    }
  });

  it("continues running queued jobs after one job fails", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    const calls: string[] = [];

    try {
      jobs.enqueue({
        id: "job_fail",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: "feed_fail" }),
        maxAttempts: 1,
        runAfter: 1000,
        now: 1000
      });
      jobs.enqueue({
        id: "job_success",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: "feed_success" }),
        maxAttempts: 1,
        runAfter: 1000,
        now: 1000
      });

      const runner = new JobRunner({
        jobs,
        handlers: {
          feed_refresh: (job) => {
            calls.push(job.id);
            if (job.id === "job_fail") {
              throw new Error("fixture failure");
            }
          }
        },
        now: () => 2000,
        retryDelayMs: 1000
      });

      await expect(runner.drainDue()).resolves.toBe(2);
      expect(calls).toEqual(["job_fail", "job_success"]);
      expect(jobs.findById("job_fail")).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "fixture failure"
      });
      expect(jobs.findById("job_success")).toMatchObject({
        status: "succeeded",
        attempts: 1,
        error: null
      });
    } finally {
      db.close();
    }
  });

  it("limits each drain pass when maxJobsPerDrain is configured", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    const calls: string[] = [];

    try {
      for (const id of ["job_1", "job_2", "job_3"]) {
        jobs.enqueue({
          id,
          type: "feed_refresh",
          payloadJson: JSON.stringify({ feedId: id }),
          maxAttempts: 1,
          runAfter: 1000,
          now: 1000
        });
      }

      const runner = new JobRunner({
        jobs,
        handlers: {
          feed_refresh: (job) => {
            calls.push(job.id);
          }
        },
        maxJobsPerDrain: 2,
        now: () => 2000
      });

      await expect(runner.drainDue()).resolves.toBe(2);
      expect(calls).toEqual(["job_1", "job_2"]);
      expect(jobs.findById("job_1")).toMatchObject({ status: "succeeded" });
      expect(jobs.findById("job_2")).toMatchObject({ status: "succeeded" });
      expect(jobs.findById("job_3")).toMatchObject({ status: "queued" });

      await expect(runner.drainDue()).resolves.toBe(1);
      expect(calls).toEqual(["job_1", "job_2", "job_3"]);
      expect(jobs.findById("job_3")).toMatchObject({ status: "succeeded" });
    } finally {
      db.close();
    }
  });

  it("keeps polling for jobs enqueued after start by another database connection", async () => {
    const databasePath = tempDatabasePath();
    const workerDb = openDatabase(databasePath, { migrate: true });
    const writerDb = openDatabase(databasePath);
    const workerJobs = new SqliteJobRepository(workerDb);
    const writerJobs = new SqliteJobRepository(writerDb);
    const calls: string[] = [];
    const events: string[] = [];
    const runner = new JobRunner({
      jobs: workerJobs,
      handlers: {
        feed_refresh: (job) => {
          calls.push(job.id);
        }
      },
      pollIntervalMs: 20,
      now: () => Date.now(),
      onEvent: (event) => {
        events.push(`${event.event}:${event.job.id}`);
      }
    });

    try {
      runner.start();
      const now = Date.now();
      writerJobs.enqueue({
        id: "job_cross_connection",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: "feed_cross_connection" }),
        maxAttempts: 1,
        runAfter: now,
        now
      });

      await waitUntil(() => writerJobs.findById("job_cross_connection")?.status === "succeeded");
      expect(calls).toEqual(["job_cross_connection"]);
      expect(events).toEqual([
        "claimed:job_cross_connection",
        "succeeded:job_cross_connection"
      ]);
    } finally {
      runner.stop();
      writerDb.close();
      workerDb.close();
    }
  });

  it("continues draining immediately when a started runner hits its per-pass job limit", async () => {
    const databasePath = tempDatabasePath();
    const workerDb = openDatabase(databasePath, { migrate: true });
    const writerDb = openDatabase(databasePath);
    const workerJobs = new SqliteJobRepository(workerDb);
    const writerJobs = new SqliteJobRepository(writerDb);
    const calls: string[] = [];
    const runner = new JobRunner({
      jobs: workerJobs,
      handlers: {
        feed_refresh: (job) => {
          calls.push(job.id);
          if (job.id === "job_5" && !writerJobs.findById("job_cross_connection_late")) {
            const now = Date.now();
            writerJobs.enqueue({
              id: "job_cross_connection_late",
              type: "feed_refresh",
              payloadJson: JSON.stringify({ feedId: "feed_cross_connection_late" }),
              maxAttempts: 1,
              runAfter: now,
              now
            });
          }
        }
      },
      maxJobsPerDrain: 5,
      pollIntervalMs: 60_000,
      now: () => Date.now()
    });

    try {
      const now = Date.now();
      for (let index = 1; index <= 10; index += 1) {
        writerJobs.enqueue({
          id: `job_${index}`,
          type: "feed_refresh",
          payloadJson: JSON.stringify({ feedId: `feed_${index}` }),
          maxAttempts: 1,
          runAfter: now,
          now
        });
      }

      runner.start();

      await waitUntil(
        () => writerJobs.findById("job_cross_connection_late")?.status === "succeeded",
        1000
      );
      expect(calls).toEqual([
        "job_1",
        "job_10",
        "job_2",
        "job_3",
        "job_4",
        "job_5",
        "job_6",
        "job_7",
        "job_8",
        "job_9",
        "job_cross_connection_late"
      ]);
    } finally {
      runner.stop();
      writerDb.close();
      workerDb.close();
    }
  });

  it("defers a job before handler execution when the runner gate asks for quiet time", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    let handlerCalled = false;

    try {
      jobs.enqueue({
        id: "job_quiet_window",
        type: "ranking_recalculate",
        payloadJson: null,
        maxAttempts: 3,
        runAfter: 1000,
        now: 1000
      });

      const runner = new JobRunner({
        jobs,
        handlers: {
          ranking_recalculate: () => {
            handlerCalled = true;
          }
        },
        beforeRun: (job) =>
          job.type === "ranking_recalculate"
            ? {
                run: false,
                deferUntil: 32_000,
                reason: "foreground quiet window"
              }
            : { run: true },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({ id: "job_quiet_window" });
      expect(handlerCalled).toBe(false);
      expect(jobs.findById("job_quiet_window")).toMatchObject({
        status: "queued",
        attempts: 0,
        runAfter: 32_000,
        error: "foreground quiet window"
      });
    } finally {
      db.close();
    }
  });

  it("fails invalid feed refresh payloads without crashing the runner", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    const feeds = new SqliteFeedRepository(db);
    let refreshCalled = false;

    try {
      jobs.enqueue({
        id: "job_invalid_payload",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: 42 }),
        maxAttempts: 3,
        runAfter: 1000,
        now: 1000
      });
      const refreshJobs = new FeedRefreshJobService({
        feeds,
        jobs,
        refresher: {
          async refreshFeed() {
            refreshCalled = true;
            throw new Error("should not refresh invalid payload");
          }
        },
        now: () => 2000
      });
      const runner = new JobRunner({
        jobs,
        handlers: {
          feed_refresh: (job) => refreshJobs.handleFeedRefreshJob(job)
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({
        id: "job_invalid_payload"
      });
      expect(refreshCalled).toBe(false);
      expect(jobs.findById("job_invalid_payload")).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "Invalid feed_refresh job payload"
      });
    } finally {
      db.close();
    }
  });

  it("resolves retention days using setting, env, then default with invalid fallback", () => {
    const db = createEmptyDatabase();

    try {
      const settings = new SqliteAppSettingsRepository(db);
      const retention = new ArticleRetentionService({
        settings,
        articles: new SqliteArticleRepository(db),
        vectorStore: new SqliteVecVectorStore(db),
        env: {
          DIBAO_ARTICLE_RETENTION_DAYS: "45"
        }
      });

      expect(retention.getRetentionDays()).toBe(45);

      settings.setJson(RETENTION_ARTICLE_DAYS_SETTING_KEY, 30, 1000);
      expect(retention.getRetentionDays()).toBe(30);

      settings.setJson(RETENTION_ARTICLE_DAYS_SETTING_KEY, 0, 1000);
      expect(retention.getRetentionDays()).toBe(0);

      settings.setJson(RETENTION_ARTICLE_DAYS_SETTING_KEY, "invalid", 1000);
      expect(retention.getRetentionDays()).toBe(DEFAULT_ARTICLE_RETENTION_DAYS);

      settings.delete(RETENTION_ARTICLE_DAYS_SETTING_KEY);
      const invalidEnv = new ArticleRetentionService({
        settings,
        articles: new SqliteArticleRepository(db),
        vectorStore: new SqliteVecVectorStore(db),
        env: {
          DIBAO_ARTICLE_RETENTION_DAYS: "-1"
        }
      });
      expect(invalidEnv.getRetentionDays()).toBe(DEFAULT_ARTICLE_RETENTION_DAYS);
    } finally {
      db.close();
    }
  });

  it("skips article retention cleanup when retention days is zero", () => {
    const db = createEmptyDatabase();

    try {
      const settings = new SqliteAppSettingsRepository(db);
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const vectorStore = new SqliteVecVectorStore(db);
      const now = Date.parse("2026-05-15T00:00:00.000Z");
      settings.setJson(RETENTION_ARTICLE_DAYS_SETTING_KEY, 0, now);
      feeds.upsert({
        id: "feed_retention_zero",
        title: "Retention Zero Feed",
        feedUrl: "https://example.com/retention-zero.xml",
        now
      });
      const article = articles.upsert({
        id: "article_retention_zero",
        feedId: "feed_retention_zero",
        url: "https://example.com/retention-zero",
        canonicalUrl: "https://example.com/retention-zero",
        title: "Kept forever",
        summary: "Retention zero should not clean this article.",
        publishedAt: now - 400 * 24 * 60 * 60 * 1000,
        discoveredAt: now - 400 * 24 * 60 * 60 * 1000,
        dedupeKey: "article_retention_zero",
        now
      });

      const retention = new ArticleRetentionService({
        settings,
        articles,
        vectorStore,
        now: () => now,
        env: {}
      });

      expect(retention.runCleanup()).toMatchObject({
        retentionDays: 0,
        cutoff: 0,
        candidateArticles: 0,
        articlesSoftDeleted: 0
      });
      expect(articles.findById(article.id)).toMatchObject({
        id: article.id,
        deletedAt: null
      });
    } finally {
      db.close();
    }
  });

  it("fails invalid retention cleanup payloads without retrying", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    let cleanupRuns = 0;

    try {
      jobs.enqueue({
        id: "job_invalid_retention",
        type: "retention_cleanup",
        payloadJson: JSON.stringify({ articleId: "not-accepted" }),
        maxAttempts: 3,
        runAfter: 1000,
        now: 1000
      });
      const cleanupJobs = new RetentionCleanupJobService({
        jobs,
        retention: {
          runCleanup() {
            cleanupRuns += 1;
            return undefined as never;
          }
        },
        now: () => 2000
      });
      const runner = new JobRunner({
        jobs,
        handlers: {
          retention_cleanup: (job) => cleanupJobs.handleRetentionCleanupJob(job)
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({
        id: "job_invalid_retention"
      });
      expect(cleanupRuns).toBe(0);
      expect(jobs.findById("job_invalid_retention")).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "Invalid retention_cleanup job payload"
      });
    } finally {
      db.close();
    }
  });

  it("defers retention cleanup after one batch when more candidates remain", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    const calls: Array<{ maxBatches?: number }> = [];

    try {
      jobs.enqueue({
        id: "job_retention_batch",
        type: "retention_cleanup",
        payloadJson: null,
        maxAttempts: 1,
        runAfter: 1000,
        now: 1000
      });
      const cleanupJobs = new RetentionCleanupJobService({
        jobs,
        retention: {
          runCleanup(options) {
            calls.push(options ?? {});
            return {
              retentionDays: 30,
              cutoff: 1000,
              candidateArticles: 100,
              vectorsDeleted: 100,
              hasMoreCandidates: true,
              articlesSoftDeleted: 100,
              contentsDeleted: 100,
              ftsRowsDeleted: 100,
              rankScoresDeleted: 100,
              rankExplanationsDeleted: 100
            };
          }
        },
        now: () => 2000
      });
      const runner = new JobRunner({
        jobs,
        handlers: {
          retention_cleanup: (job) => cleanupJobs.handleRetentionCleanupJob(job)
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({
        id: "job_retention_batch"
      });
      expect(calls).toEqual([{ maxBatches: 1 }]);
      expect(jobs.findById("job_retention_batch")).toMatchObject({
        status: "queued",
        attempts: 0,
        runAfter: 4000,
        error: "Retention cleanup deferred after one batch"
      });
    } finally {
      db.close();
    }
  });

  it("retention cleanup prevents deleted articles from being restored by feed refresh", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const settings = new SqliteAppSettingsRepository(db);
    const vectorStore = new SqliteVecVectorStore(db);
    const embeddings = new SqliteEmbeddingRepository(db);
    const rankings = new SqliteRankingRepository(db);
    const now = Date.parse("2026-05-15T00:00:00.000Z");

    try {
      settings.setJson(RETENTION_ARTICLE_DAYS_SETTING_KEY, 60, now);
      feeds.upsert({
        id: "feed_retention",
        title: "Retention Feed",
        feedUrl: "https://example.com/retention.xml",
        now
      });
      const refreshService = new FeedRefreshService({
        db,
        feeds,
        articles,
        fetcher: fixtureFetcher({
          "https://example.com/retention.xml": retentionFixtureRss
        }),
        resolveHostname: publicTestResolver,
        now: () => now
      });

      const firstRefresh = await refreshService.refreshFeed("feed_retention");
      const article = articles.list({ feedId: "feed_retention" }).items[0];
      expect(article).toMatchObject({
        title: "Retention deleted article"
      });
      expect(firstRefresh.effectiveContentChangedArticleIds).toEqual([article.id]);

      rankings.upsertBaseScore({
        articleId: article.id,
        score: 0.5,
        interestScore: 0,
        sourceScore: 0,
        freshnessScore: 0,
        stateScore: 0,
        diversityScore: 0,
        penaltyScore: 0,
        calculatedAt: now
      });
      embeddings.upsertProvider({
        id: "provider_retention",
        type: "embedded_local",
        name: "Retention Fixture",
        model: "fixture-4d",
        dimension: 4,
        enabled: true,
        now
      });
      embeddings.createIndex({
        id: "index_retention",
        providerId: "provider_retention",
        model: "fixture-4d",
        dimension: 4,
        now
      });
      vectorStore.upsertArticleVector({
        articleId: article.id,
        embeddingIndexId: "index_retention",
        vector: [0.9, 0.1, 0.05, 0.02],
        contentHash: "hash_retention",
        now
      });

      const retention = new ArticleRetentionService({
        settings,
        articles,
        vectorStore,
        now: () => now,
        env: {}
      });
      expect(retention.runCleanup()).toMatchObject({
        candidateArticles: 1,
        articlesSoftDeleted: 1,
        contentsDeleted: 1,
        rankScoresDeleted: 1,
        vectorsDeleted: 1
      });
      expect(articles.findDetailById(article.id)).toBeNull();
      expect(countRows(db, "article_contents", article.id)).toBe(0);
      expect(countRows(db, "article_embeddings", article.id)).toBe(0);
      expect(countRows(db, "article_rank_scores", article.id)).toBe(0);

      const secondRefresh = await refreshService.refreshFeed("feed_retention");

      expect(articles.findById(article.id)).toMatchObject({
        status: "deleted",
        deletedAt: now
      });
      expect(articles.findDetailById(article.id)).toBeNull();
      expect(articles.list({ feedId: "feed_retention" }).items).toHaveLength(0);
      expect(countRows(db, "article_contents", article.id)).toBe(0);
      expect(countRows(db, "article_embeddings", article.id)).toBe(0);
      expect(countRows(db, "article_rank_scores", article.id)).toBe(0);
      expect(secondRefresh.effectiveContentChangedArticleIds).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("refreshes enabled feeds through jobs and isolates feed failures", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const jobs = new SqliteJobRepository(db);
    let jobSequence = 0;

    try {
      feeds.upsert({
        id: "feed_success",
        title: "Alpha Success Feed",
        feedUrl: "https://example.com/success.xml",
        enabled: true,
        now: 1000
      });
      feeds.upsert({
        id: "feed_failure",
        title: "Zulu Failure Feed",
        feedUrl: "https://example.com/failure.xml",
        enabled: true,
        now: 1000
      });
      feeds.upsert({
        id: "feed_disabled",
        title: "Disabled Feed",
        feedUrl: "https://example.com/disabled.xml",
        enabled: false,
        now: 1000
      });
      feeds.upsert({
        id: "feed_not_due",
        title: "Not Due Feed",
        feedUrl: "https://example.com/not-due.xml",
        enabled: true,
        now: 1000
      });
      feeds.recordFetchSuccess("feed_not_due", 1500);

      const refreshService = new FeedRefreshService({
        db,
        feeds,
        articles,
        fetcher: fixtureFetcher({
          "https://example.com/success.xml": fixtureRss
        }),
        resolveHostname: publicTestResolver,
        now: () => 3000
      });
      const refreshJobs = new FeedRefreshJobService({
        feeds,
        jobs,
        refresher: new FeedRefreshCoordinator({ refreshService }),
        jobIdFactory: () => `job_${++jobSequence}`,
        maxAttempts: 1,
        now: () => 2000
      });
      const runner = new JobRunner({
        jobs,
        handlers: {
          feed_refresh: (job) => refreshJobs.handleFeedRefreshJob(job)
        },
        now: () => 3000,
        retryDelayMs: 1000
      });

      const firstBatch = refreshJobs.enqueueAllEnabledFeeds();
      const secondBatch = refreshJobs.enqueueAllEnabledFeeds();
      expect(firstBatch.map((job) => job.id)).toEqual(["job_1", "job_2"]);
      expect(secondBatch.map((job) => job.id)).toEqual(["job_1", "job_2"]);
      expect(jobs.listOpenByType("feed_refresh")).toHaveLength(2);

      await expect(runner.drainDue()).resolves.toBe(2);
      expect(articles.list({ feedId: "feed_success" })).toMatchObject({
        items: [
          expect.objectContaining({
            title: "Job runner article"
          })
        ]
      });
      expect(feeds.findById("feed_success")).toMatchObject({
        lastFetchedAt: 3000,
        lastSuccessAt: 3000,
        lastError: null
      });
      expect(feeds.findById("feed_failure")).toMatchObject({
        lastFetchedAt: 3000,
        lastSuccessAt: null,
        lastError: "Feed fetch failed"
      });
      expect(feeds.findById("feed_disabled")).toMatchObject({
        lastFetchedAt: null,
        lastSuccessAt: null,
        lastError: null
      });
      expect(feeds.findById("feed_not_due")).toMatchObject({
        lastFetchedAt: 1500,
        lastSuccessAt: 1500,
        lastError: null
      });
      expect(jobs.findById("job_1")).toMatchObject({
        status: "succeeded"
      });
      expect(jobs.findById("job_2")).toMatchObject({
        status: "failed",
        error: "Feed fetch failed"
      });
    } finally {
      db.close();
    }
  });

  it("fails invalid embedding payloads without retrying", async () => {
    const fixture = createEmbeddingPipelineFixture();
    const { db, jobs, embeddingJobs } = fixture;
    let adapterCalls = 0;

    try {
      jobs.enqueue({
        id: "job_invalid_embedding",
        type: EMBEDDING_GENERATE_JOB_TYPE,
        payloadJson: JSON.stringify({ embeddingIndexId: "index_openai", articleIds: [] }),
        maxAttempts: 3,
        runAfter: 1000,
        now: 1000
      });
      fixture.adapter.embedBatch = async () => {
        adapterCalls += 1;
        return [];
      };
      const runner = new JobRunner({
        jobs,
        handlers: {
          embedding_generate: (job) => embeddingJobs.handleEmbeddingGenerateJob(job)
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({
        id: "job_invalid_embedding"
      });
      expect(adapterCalls).toBe(0);
      expect(jobs.findById("job_invalid_embedding")).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "Invalid embedding_generate job payload"
      });
    } finally {
      db.close();
    }
  });

  it("filters retention-deleted embedding payload articles before provider calls", async () => {
    const fixture = createEmbeddingPipelineFixture();
    const { db, articles, jobs, embeddingJobs } = fixture;

    try {
      const disabledFeeds = new SqliteFeedRepository(db);
      disabledFeeds.upsert({
        id: "feed_embedding_disabled",
        title: "Disabled Embedding Feed",
        feedUrl: "https://example.com/disabled-embedding.xml",
        enabled: false,
        now: 1000
      });
      insertEmbeddingArticleFixture(db, articles, "article_active", "Active embedding article");
      insertEmbeddingArticleFixture(db, articles, "article_deleted", "Deleted embedding article");
      insertEmbeddingArticleFixture(
        db,
        articles,
        "article_disabled_feed",
        "Disabled feed embedding article",
        "feed_embedding_disabled"
      );
      db.prepare("update articles set status = 'deleted', deleted_at = ? where id = ?").run(
        1500,
        "article_deleted"
      );
      jobs.enqueue({
        id: "job_embedding_batch",
        type: EMBEDDING_GENERATE_JOB_TYPE,
        payloadJson: JSON.stringify({
          embeddingIndexId: "index_openai",
          articleIds: ["article_active", "article_deleted", "article_disabled_feed"]
        }),
        maxAttempts: 1,
        runAfter: 1000,
        now: 1000
      });
      const seenIds: string[] = [];
      fixture.adapter.embedBatch = async ({ items }) => {
        seenIds.push(...items.map((input) => input.id));
        return items.map((input) => ({
          id: input.id,
          vector: [0.1, 0.2, 0.3]
        }));
      };
      const runner = new JobRunner({
        jobs,
        handlers: {
          embedding_generate: (job) => embeddingJobs.handleEmbeddingGenerateJob(job)
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({
        id: "job_embedding_batch"
      });
      expect(seenIds).toEqual(["article_active"]);
      expect(countRows(db, "article_embeddings", "article_active")).toBe(1);
      expect(countRows(db, "article_embeddings", "article_deleted")).toBe(0);
      expect(countRows(db, "article_embeddings", "article_disabled_feed")).toBe(0);
      expect(countRows(db, "article_vector_rows", "article_active")).toBe(1);
      expect(countRows(db, "article_vector_rows", "article_deleted")).toBe(0);
      expect(countRows(db, "article_vector_rows", "article_disabled_feed")).toBe(0);
      expect(jobs.findById("job_embedding_batch")).toMatchObject({
        status: "succeeded"
      });
    } finally {
      db.close();
    }
  });

  it("strips HTML from embedding provider input text", async () => {
    const fixture = createEmbeddingPipelineFixture();
    const { db, articles, jobs, embeddingJobs } = fixture;

    try {
      insertEmbeddingArticleFixture(db, articles, "article_html_embedding", "HTML embedding article");
      db.prepare("update articles set title = ?, summary = ? where id = ?").run(
        "Plain <em>title</em>",
        "<p>Summary &amp; <strong>context</strong><script>discard()</script></p>",
        "article_html_embedding"
      );
      articles.upsertContent({
        articleId: "article_html_embedding",
        contentHtml: "<article><p>Body <b>HTML</b></p></article>",
        contentText: "Body <b>HTML</b> &nbsp; text<style>.hidden{}</style>",
        extractionStatus: "success",
        extractedAt: 1000,
        now: 1000
      });
      jobs.enqueue({
        id: "job_embedding_html",
        type: EMBEDDING_GENERATE_JOB_TYPE,
        payloadJson: JSON.stringify({
          embeddingIndexId: "index_openai",
          articleIds: ["article_html_embedding"]
        }),
        maxAttempts: 1,
        runAfter: 1000,
        now: 1000
      });
      const seenTexts: string[] = [];
      fixture.adapter.embedBatch = async ({ items }) => {
        seenTexts.push(...items.map((input) => input.text));
        return items.map((input) => ({
          id: input.id,
          vector: [0.1, 0.2, 0.3]
        }));
      };
      const runner = new JobRunner({
        jobs,
        handlers: {
          embedding_generate: (job) => embeddingJobs.handleEmbeddingGenerateJob(job)
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({
        id: "job_embedding_html"
      });
      expect(seenTexts).toEqual([
        "Plain title\n\nSummary & context\n\nBody HTML text"
      ]);
      expect(seenTexts[0]).not.toMatch(/<[^>]+>|discard|hidden/u);
    } finally {
      db.close();
    }
  });

  it("uses the active provider text slice length for embedding input", async () => {
    const fixture = createEmbeddingPipelineFixture();
    const { articles, adapter, db, embeddingJobs, embeddings, jobs } = fixture;
    const seenTexts: string[] = [];

    try {
      embeddings.updateProvider({
        id: "provider_openai",
        textMaxChars: 1000,
        now: 1000
      });
      insertEmbeddingArticleFixture(
        db,
        articles,
        "article_short_slice",
        "Long embedding article title"
      );
      articles.upsertContent({
        articleId: "article_short_slice",
        contentHtml: null,
        contentText: "x".repeat(2000),
        extractionStatus: "success",
        extractedAt: 1000,
        now: 1000
      });
      const [job] = embeddingJobs.enqueueArticlesForActiveIndex(["article_short_slice"]);
      adapter.embedBatch = async ({ items }) => {
        seenTexts.push(...items.map((input) => input.text));
        return items.map((input) => ({
          id: input.id,
          vector: [0.1, 0.2, 0.3]
        }));
      };
      const runner = new JobRunner({
        jobs,
        handlers: {
          [EMBEDDING_GENERATE_JOB_TYPE]: (queuedJob) =>
            embeddingJobs.handleEmbeddingGenerateJob(queuedJob)
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({ id: job.id });
      expect(seenTexts).toHaveLength(1);
      expect(seenTexts[0]).toHaveLength(1000);
      expect(seenTexts[0]).toContain("Long embedding article title");
    } finally {
      db.close();
    }
  });

  it("retries Ollama context length failures with a shorter text slice", async () => {
    const fixture = createEmbeddingPipelineFixture({ providerType: "ollama" });
    const { articles, adapter, db, embeddingJobs, jobs } = fixture;
    const seenTexts: string[] = [];

    try {
      insertEmbeddingArticleFixture(
        db,
        articles,
        "article_ollama_context_retry",
        "Ollama context retry article"
      );
      articles.upsertContent({
        articleId: "article_ollama_context_retry",
        contentHtml: null,
        contentText: "中".repeat(6000),
        extractionStatus: "success",
        extractedAt: 1000,
        now: 1000
      });
      const [job] = embeddingJobs.enqueueArticlesForActiveIndex([
        "article_ollama_context_retry"
      ]);
      adapter.embedBatch = async ({ items }) => {
        seenTexts.push(...items.map((input) => input.text));
        if (seenTexts.length === 1) {
          throw new EmbeddingProviderError(
            "Ollama provider rejected the embedding request",
            false,
            {
              category: "bad_request",
              providerMessage: "the input length exceeds the context length",
              status: 400
            }
          );
        }
        return items.map((input) => ({
          id: input.id,
          vector: [0.1, 0.2, 0.3]
        }));
      };
      const runner = new JobRunner({
        jobs,
        handlers: {
          [EMBEDDING_GENERATE_JOB_TYPE]: (queuedJob) =>
            embeddingJobs.handleEmbeddingGenerateJob(queuedJob)
        },
        now: () => 2000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({ id: job.id });
      expect(seenTexts).toHaveLength(2);
      expect(seenTexts[0]).toHaveLength(4000);
      expect(seenTexts[1]).toHaveLength(2000);
      expect(jobs.findById(job.id)).toMatchObject({ status: "succeeded" });
      expect(countRows(db, "article_embeddings", "article_ollama_context_retry")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("defers embedding jobs when provider QPM is exhausted", async () => {
    const fixture = createEmbeddingPipelineFixture();
    const { articles, adapter, db, embeddings, jobs, providerService, vectorStore } = fixture;
    let adapterCalls = 0;

    try {
      embeddings.updateProvider({
        id: "provider_openai",
        requestsPerMinute: 1,
        now: 1000
      });
      insertEmbeddingArticleFixture(db, articles, "article_qpm_limited", "QPM limited article");
      const limitedEmbeddingJobs = new EmbeddingJobService({
        articles,
        embeddings,
        jobs,
        providerService,
        vectorStore,
        requestCountSince: () => 1,
        jobIdFactory: () => `job_embedding_${randomFixtureId()}`,
        now: () => 10_000
      });
      const [job] = limitedEmbeddingJobs.enqueueArticlesForActiveIndex(["article_qpm_limited"]);
      adapter.embedBatch = async ({ items }) => {
        adapterCalls += 1;
        return items.map((input) => ({
          id: input.id,
          vector: [0.1, 0.2, 0.3]
        }));
      };
      const runner = new JobRunner({
        jobs,
        handlers: {
          [EMBEDDING_GENERATE_JOB_TYPE]: (queuedJob) =>
            limitedEmbeddingJobs.handleEmbeddingGenerateJob(queuedJob)
        },
        now: () => 10_000
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({ id: job.id });
      expect(adapterCalls).toBe(0);
      expect(jobs.findById(job.id)).toMatchObject({
        status: "queued",
        attempts: 0,
        runAfter: 70_001
      });
    } finally {
      db.close();
    }
  });

  it("defers embedding jobs until the next local day when provider QPD is exhausted", async () => {
    const fixture = createEmbeddingPipelineFixture();
    const { articles, db, embeddings, jobs, providerService, vectorStore } = fixture;
    const now = new Date(2026, 4, 22, 13, 30, 0, 0).getTime();
    const nextDay = new Date(now);
    nextDay.setHours(24, 0, 0, 0);

    try {
      embeddings.updateProvider({
        id: "provider_openai",
        requestsPerDay: 2,
        now: 1000
      });
      insertEmbeddingArticleFixture(db, articles, "article_qpd_limited", "QPD limited article");
      const limitedEmbeddingJobs = new EmbeddingJobService({
        articles,
        embeddings,
        jobs,
        providerService,
        vectorStore,
        requestCountSince: () => 2,
        jobIdFactory: () => `job_embedding_${randomFixtureId()}`,
        now: () => now
      });
      const [job] = limitedEmbeddingJobs.enqueueArticlesForActiveIndex(["article_qpd_limited"]);
      const runner = new JobRunner({
        jobs,
        handlers: {
          [EMBEDDING_GENERATE_JOB_TYPE]: (queuedJob) =>
            limitedEmbeddingJobs.handleEmbeddingGenerateJob(queuedJob)
        },
        now: () => now
      });

      await expect(runner.runDueOnce()).resolves.toMatchObject({ id: job.id });
      expect(jobs.findById(job.id)).toMatchObject({
        status: "queued",
        attempts: 0,
        runAfter: nextDay.getTime()
      });
    } finally {
      db.close();
    }
  });

  it("does not let old succeeded embedding jobs block future enqueue", () => {
    const fixture = createEmbeddingPipelineFixture();
    const { db, articles, jobs, embeddingJobs } = fixture;

    try {
      insertEmbeddingArticleFixture(db, articles, "article_requeue", "Requeue embedding article");
      const firstBatch = embeddingJobs.enqueueArticlesForActiveIndex(["article_requeue"]);
      expect(firstBatch).toHaveLength(1);
      jobs.markSucceeded(firstBatch[0].id, 2000);

      const secondBatch = embeddingJobs.enqueueArticlesForActiveIndex(["article_requeue"]);
      expect(secondBatch).toHaveLength(1);
      expect(secondBatch[0].id).not.toBe(firstBatch[0].id);
    } finally {
      db.close();
    }
  });

  it("deletes only old finished job history and keeps open or referenced jobs", () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    const day = 24 * 60 * 60 * 1000;
    const cutoff = 30 * day;

    try {
      enqueueFeedJob(jobs, "job_old_succeeded", 1);
      jobs.claimById("job_old_succeeded", 2);
      jobs.markSucceeded("job_old_succeeded", 5 * day);

      enqueueFeedJob(jobs, "job_old_failed", 1);
      jobs.claimById("job_old_failed", 2);
      jobs.markFailed("job_old_failed", "failed fixture", 6 * day);

      enqueueFeedJob(jobs, "job_old_cancelled", 1);
      jobs.cancel("job_old_cancelled", "cancelled fixture", 7 * day);

      enqueueFeedJob(jobs, "job_new_succeeded", 1);
      jobs.claimById("job_new_succeeded", 2);
      jobs.markSucceeded("job_new_succeeded", cutoff + 1);

      enqueueFeedJob(jobs, "job_old_queued", 1);
      enqueueFeedJob(jobs, "job_old_running", 1);
      jobs.claimById("job_old_running", 2);

      enqueueFeedJob(jobs, "job_referenced_succeeded", 1);
      jobs.claimById("job_referenced_succeeded", 2);
      jobs.markSucceeded("job_referenced_succeeded", 8 * day);
      db.prepare(
        `
          insert into recommendation_maintenance_schedule_state (
            task_key,
            last_enqueued_at,
            last_completed_at,
            last_skipped_reason,
            last_job_id,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?)
        `
      ).run("fixture_task", 8 * day, 8 * day, null, "job_referenced_succeeded", 8 * day);

      expect(jobs.deleteFinishedBefore({ cutoff, limit: 10 })).toBe(3);
      expect(jobs.findById("job_old_succeeded")).toBeNull();
      expect(jobs.findById("job_old_failed")).toBeNull();
      expect(jobs.findById("job_old_cancelled")).toBeNull();
      expect(jobs.findById("job_new_succeeded")).toMatchObject({ status: "succeeded" });
      expect(jobs.findById("job_old_queued")).toMatchObject({ status: "queued" });
      expect(jobs.findById("job_old_running")).toMatchObject({ status: "running" });
      expect(jobs.findById("job_referenced_succeeded")).toMatchObject({
        status: "succeeded"
      });
    } finally {
      db.close();
    }
  });

  it("cleans job history using the configured retention window", () => {
    const day = 24 * 60 * 60 * 1000;
    const calls: Array<{ cutoff: number; limit?: number }> = [];
    const scheduler = new JobHistoryCleanupScheduler({
      jobs: {
        deleteFinishedBefore(input) {
          calls.push(input);
          return 4;
        }
      },
      retentionDays: 30,
      batchSize: 7,
      now: () => 45 * day
    });

    expect(scheduler.runOnce()).toEqual({
      cutoff: 15 * day,
      deleted: 4
    });
    expect(calls).toEqual([{ cutoff: 15 * day, limit: 7 }]);
  });

  it("continues active index backfill until remaining embedding candidates are covered", async () => {
    const fixture = createEmbeddingPipelineFixture();
    const { db, articles, embeddingJobs, jobs } = fixture;

    try {
      for (let index = 0; index < 1005; index += 1) {
        insertEmbeddingArticleFixture(
          db,
          articles,
          `article_backfill_${String(index).padStart(4, "0")}`,
          `Backfill article ${index}`
        );
      }

      const initialJobs = embeddingJobs.enqueueBackfillForActiveIndex();
      expect(initialJobs).toHaveLength(63);

      const runner = new JobRunner({
        jobs,
        handlers: {
          [EMBEDDING_GENERATE_JOB_TYPE]: (job) => embeddingJobs.handleEmbeddingGenerateJob(job)
        },
        now: () => 2000
      });

      await runner.runDueOnce();

      expect(
        (
          db
            .prepare("select count(*) as count from jobs where type = ? and status = 'queued'")
            .get(EMBEDDING_GENERATE_JOB_TYPE) as { count: number }
        ).count
      ).toBe(62);

      await runner.drainDue();

      expect(
        (
          db
            .prepare("select count(*) as count from article_embeddings where embedding_index_id = ?")
            .get("index_openai") as { count: number }
        ).count
      ).toBe(1005);
      expect(
        (
          db
            .prepare(
              "select count(*) as count from jobs where type = ? and status in ('queued', 'running')"
            )
            .get(EMBEDDING_GENERATE_JOB_TYPE) as { count: number }
        ).count
      ).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);

  it("retries retryable provider failures and permanently fails malformed provider responses", async () => {
    const retryable = createEmbeddingPipelineFixture();

    try {
      insertEmbeddingArticleFixture(
        retryable.db,
        retryable.articles,
        "article_retryable_provider",
        "Retryable provider article"
      );
      const [retryableJob] = retryable.embeddingJobs.enqueueArticlesForActiveIndex([
        "article_retryable_provider"
      ]);
      retryable.adapter.embedBatch = async () => {
        throw new EmbeddingProviderError("Provider request failed", true, {
          status: 429,
          authorization: "Bearer should-not-leak"
        });
      };
      const retryRunner = new JobRunner({
        jobs: retryable.jobs,
        handlers: {
          embedding_generate: (job) => retryable.embeddingJobs.handleEmbeddingGenerateJob(job)
        },
        now: () => 2000,
        retryDelayMs: 5000
      });

      await expect(retryRunner.runDueOnce()).resolves.toMatchObject({
        id: retryableJob.id
      });
      expect(retryable.jobs.findById(retryableJob.id)).toMatchObject({
        status: "queued",
        attempts: 1,
        error: "Provider request failed",
        runAfter: 7000
      });
    } finally {
      retryable.db.close();
    }

    const permanent = createEmbeddingPipelineFixture();
    try {
      insertEmbeddingArticleFixture(
        permanent.db,
        permanent.articles,
        "article_permanent_provider",
        "Permanent provider article"
      );
      const [permanentJob] = permanent.embeddingJobs.enqueueArticlesForActiveIndex([
        "article_permanent_provider"
      ]);
      permanent.adapter.embedBatch = async () => {
        throw new EmbeddingProviderError("Provider response must include data array", false, {
          apiKey: "should-not-leak"
        });
      };
      const permanentRunner = new JobRunner({
        jobs: permanent.jobs,
        handlers: {
          embedding_generate: (job) => permanent.embeddingJobs.handleEmbeddingGenerateJob(job)
        },
        now: () => 2000,
        retryDelayMs: 5000
      });

      await expect(permanentRunner.runDueOnce()).resolves.toMatchObject({
        id: permanentJob.id
      });
      expect(permanent.jobs.findById(permanentJob.id)).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "Provider response must include data array"
      });
    } finally {
      permanent.db.close();
    }
  });

  it("scheduler tick enqueues refresh jobs and wakes the runner without using a real interval", async () => {
    let drained = false;
    const scheduler = new FeedRefreshScheduler({
      refreshJobs: {
        enqueueDueFeeds: () => [minimalJob("job_1")]
      },
      runner: {
        async drainDue() {
          drained = true;
          return 0;
        }
      },
      intervalMs: 60_000
    });

    await expect(scheduler.tick()).resolves.toEqual(["job_1"]);
    expect(drained).toBe(true);
  });

  it("feed refresh scheduler scans due feeds at startup and defaults to ten minutes", async () => {
    expect(DEFAULT_FEED_REFRESH_INTERVAL_MS).toBe(10 * 60 * 1000);

    let enqueued = 0;
    let drained = 0;
    const scheduler = new FeedRefreshScheduler({
      refreshJobs: {
        enqueueDueFeeds: () => {
          enqueued += 1;
          return [minimalJob("job_startup")];
        }
      },
      runner: {
        async drainDue() {
          drained += 1;
          return 0;
        }
      },
      intervalMs: 60_000
    });

    scheduler.start();
    expect(enqueued).toBe(0);
    expect(drained).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduler.stop();

    expect(enqueued).toBe(1);
    expect(drained).toBe(1);
  });

  it("feed refresh scheduler honors an initial startup delay", async () => {
    let enqueued = 0;
    const scheduler = new FeedRefreshScheduler({
      refreshJobs: {
        enqueueDueFeeds: () => {
          enqueued += 1;
          return [minimalJob("job_delayed_startup")];
        }
      },
      intervalMs: 60_000,
      initialDelayMs: 25
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(enqueued).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 35));
    scheduler.stop();
    expect(enqueued).toBe(1);
  });

  it("feed refresh jobs enqueue only feeds due for refresh", () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const jobs = new SqliteJobRepository(db);

    try {
      feeds.upsert({
        id: "feed_due",
        title: "Due Feed",
        feedUrl: "https://example.com/due.xml",
        now: 1000
      });
      feeds.upsert({
        id: "feed_fresh",
        title: "Fresh Feed",
        feedUrl: "https://example.com/fresh.xml",
        now: 1000
      });
      feeds.recordFetchSuccess("feed_due", 1_000);
      feeds.recordFetchSuccess("feed_fresh", 3_500_000);

      const refreshJobs = new FeedRefreshJobService({
        feeds,
        jobs,
        refresher: {
          async refreshFeed() {
            throw new Error("not used");
          }
        },
        jobIdFactory: () => "job_due",
        now: () => 3_700_000
      });

      expect(refreshJobs.enqueueAllEnabledFeeds().map((job) => job.payloadJson)).toEqual([
        JSON.stringify({ feedId: "feed_due" })
      ]);
    } finally {
      db.close();
    }
  });

  it("backs off consecutive feed refresh failures and resets after success", () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    try {
      feeds.upsert({
        id: "feed_backoff",
        title: "Backoff Feed",
        feedUrl: "https://example.com/backoff.xml",
        now: 0
      });
      feeds.recordFetchFailure("feed_backoff", "offline", 1_000);
      const first = feeds.findById("feed_backoff")!;
      const firstDelay = first.nextRefreshAt! - first.lastFetchedAt!;

      feeds.recordFetchFailure("feed_backoff", "offline", first.nextRefreshAt!);
      const second = feeds.findById("feed_backoff")!;
      const secondDelay = second.nextRefreshAt! - second.lastFetchedAt!;
      expect(secondDelay).toBeGreaterThan(firstDelay);

      feeds.recordFetchSuccess("feed_backoff", second.nextRefreshAt!);
      const recovered = feeds.findById("feed_backoff")!;
      expect(recovered.nextRefreshAt! - recovered.lastFetchedAt!).toBeLessThan(secondDelay);
    } finally {
      db.close();
    }
  });

  it("retention scheduler enqueues one cleanup job and wakes the runner", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    let drained = false;

    try {
      const cleanupJobs = new RetentionCleanupJobService({
        jobs,
        retention: {
          runCleanup() {
            return undefined as never;
          }
        },
        jobIdFactory: () => "job_retention_cleanup",
        now: () => 1000
      });
      const scheduler = new RetentionCleanupScheduler({
        cleanupJobs,
        runner: {
          async drainDue() {
            drained = true;
            return 0;
          }
        },
        intervalMs: 60_000
      });

      await expect(scheduler.tick()).resolves.toBe("job_retention_cleanup");
      await expect(scheduler.tick()).resolves.toBe("job_retention_cleanup");
      expect(drained).toBe(true);
      expect(jobs.listOpenByType("retention_cleanup")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("fails invalid ranking and profile decay payloads without retrying", async () => {
    const db = createEmptyDatabase();
    try {
      const jobs = new SqliteJobRepository(db);
      const settings = new SqliteAppSettingsRepository(db);
      const embeddings = new SqliteEmbeddingRepository(db);
      const profiles = new SqliteProfileRepository(db);
      const rankings = new SqliteRankingRepository(db);
      const ranking = new RecommendationRankingService({
        embeddings,
        profiles,
        rankings,
        now: () => 1000
      });
      const rankingJobs = new RankingRecalculateJobService({
        jobs,
        ranking,
        now: () => 1000
      });
      const profile = new ProfileService({
        embeddings,
        profiles,
        now: () => 1000
      });
      const profileDecayJobs = new ProfileDecayJobService({
        jobs,
        profile,
        rankingJobs,
        settings,
        now: () => 1000
      });

      jobs.enqueue({
        id: "job_invalid_rank",
        type: RANKING_RECALCULATE_JOB_TYPE,
        payloadJson: JSON.stringify({ articleIds: [] }),
        maxAttempts: 3,
        runAfter: 1000,
        now: 1000
      });
      jobs.enqueue({
        id: "job_invalid_profile_decay",
        type: PROFILE_DECAY_JOB_TYPE,
        payloadJson: JSON.stringify({ force: true }),
        maxAttempts: 3,
        runAfter: 1000,
        now: 1000
      });

      const runner = new JobRunner({
        jobs,
        handlers: {
          [RANKING_RECALCULATE_JOB_TYPE]: (job) => {
            rankingJobs.handleRankingRecalculateJob(job);
          },
          [PROFILE_DECAY_JOB_TYPE]: (job) => profileDecayJobs.handleProfileDecayJob(job)
        },
        now: () => 1000
      });

      await expect(runner.drainDue()).resolves.toBe(2);
      expect(jobs.findById("job_invalid_rank")).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "Invalid ranking_recalculate job payload"
      });
      expect(jobs.findById("job_invalid_profile_decay")).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "Invalid profile_decay job payload"
      });
    } finally {
      db.close();
    }
  });

  it("runs one coalesced active-window ranking refresh", async () => {
    const db = createEmptyDatabase();
    try {
      const jobs = new SqliteJobRepository(db);
      let now = 1000;
      let refreshes = 0;
      const rankingJobs = new RankingRecalculateJobService({
        jobs,
        ranking: {
          recalculateArticle() {
            return 1;
          },
          recalculateArticles(articleIds: string[]) {
            return articleIds.length;
          },
          recalculateAll() {
            refreshes += 1;
            return 42;
          }
        },
        jobIdFactory: () => `job_rank_${randomFixtureId()}`,
        now: () => now
      });
      rankingJobs.enqueueAll();
      rankingJobs.enqueueArticles(["article_new"]);
      const runner = new JobRunner({
        jobs,
        handlers: {
          [RANKING_RECALCULATE_JOB_TYPE]: (job) => {
            rankingJobs.handleRankingRecalculateJob(job);
          }
        },
        now: () => now
      });

      await expect(runner.drainDue()).resolves.toBe(1);
      expect(refreshes).toBe(1);
      expect(jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "succeeded")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("cancels legacy cursor ranking jobs without running a full-history scan", () => {
    const db = createEmptyDatabase();
    try {
      const jobs = new SqliteJobRepository(db);
      const rankingJobs = new RankingRecalculateJobService({
        jobs,
        ranking: {
          recalculateArticle() {
            return 1;
          },
          recalculateArticles(articleIds: string[]) {
            return articleIds.length;
          },
          recalculateAll() {
            return 0;
          }
        },
        now: () => 1000
      });
      jobs.enqueue({
        id: "job_rank_legacy",
        type: RANKING_RECALCULATE_JOB_TYPE,
        payloadJson: JSON.stringify({ cursor: "cursor_legacy", limit: 500 }),
        maxAttempts: 2,
        runAfter: 1000,
        now: 1000
      });
      expect(rankingJobs.cancelLegacyCursorJobs()).toBe(1);
      expect(jobs.findById("job_rank_legacy")).toMatchObject({
        status: "cancelled",
        error: expect.stringContaining("active-window refresh")
      });
    } finally {
      db.close();
    }
  });
});

function createEmptyDatabase(): DibaoDatabase {
  return openDatabase(tempDatabasePath(), { migrate: true });
}

function createEmbeddingPipelineFixture(
  options: { providerType?: "openai_compatible" | "ollama" } = {}
) {
  const db = createEmptyDatabase();
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);
  const embeddings = new SqliteEmbeddingRepository(db);
  const jobs = new SqliteJobRepository(db);
  const vectorStore = new SqliteVecVectorStore(db);
  const adapter = embeddingAdapterFixture();
  const providerType = options.providerType ?? "openai_compatible";
  const providerId = providerType === "ollama" ? "provider_ollama" : "provider_openai";
  const indexId = providerType === "ollama" ? "index_ollama" : "index_openai";
  const providerName = providerType === "ollama" ? "Ollama" : "OpenAI Compatible";
  const providerBaseUrl =
    providerType === "ollama" ? "http://127.0.0.1:11434" : "https://api.example.com/v1";

  feeds.upsert({
    id: "feed_embedding",
    title: "Embedding Feed",
    feedUrl: "https://example.com/embedding.xml",
    enabled: true,
    now: 1000
  });
  embeddings.upsertProvider({
    id: providerId,
    type: providerType,
    name: providerName,
    baseUrl: providerBaseUrl,
    model: "fixture-embedding",
    dimension: 3,
    enabled: true,
    qualityTier: "recommended",
    now: 1000
  });
  embeddings.createIndex({
    id: indexId,
    providerId,
    model: "fixture-embedding",
    dimension: 3,
    textMaxChars: providerType === "ollama" ? 4000 : undefined,
    now: 1000
  });

  const providerService = new EmbeddingProviderService({
    embeddings,
    vectorStore,
    adapters: {
      [providerType]: adapter
    },
    now: () => 1000
  });
  const embeddingJobs = new EmbeddingJobService({
    articles,
    embeddings,
    jobs,
    providerService,
    vectorStore,
    jobIdFactory: () => `job_embedding_${randomFixtureId()}`,
    now: () => 1000
  });

  return {
    db,
    articles,
    adapter,
    embeddingJobs,
    embeddings,
    providerService,
    vectorStore,
    jobs
  };
}

function insertEmbeddingArticleFixture(
  db: DibaoDatabase,
  articles: SqliteArticleRepository,
  articleId: string,
  title: string,
  feedId = "feed_embedding"
): void {
  articles.upsert({
    id: articleId,
    feedId,
    url: `https://example.com/${articleId}`,
    canonicalUrl: `https://example.com/${articleId}`,
    title,
    summary: `${title} summary`,
    publishedAt: 1000,
    discoveredAt: 1000,
    dedupeKey: articleId,
    now: 1000
  });
  articles.upsertContent({
    articleId,
    contentHtml: null,
    contentText: `${title} full text`,
    extractionStatus: "success",
    extractedAt: 1000,
    now: 1000
  });
  db.prepare("update articles set content_hash = ? where id = ?").run(
    `hash_${articleId}`,
    articleId
  );
}

function embeddingAdapterFixture(): EmbeddingProviderAdapter {
  return {
    async embedBatch({ items }) {
      return items.map((input) => ({
        id: input.id,
        vector: [0.1, 0.2, 0.3]
      }));
    },
    async test() {
      return {
        status: "success",
        dimension: 3,
        latencyMs: 1
      };
    }
  };
}

let fixtureId = 0;

function randomFixtureId(): string {
  fixtureId += 1;
  return String(fixtureId);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  expect(predicate()).toBe(true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dibao-server-jobs-"));
  tempDirs.push(dir);
  return join(dir, "dibao.sqlite");
}

function enqueueFeedJob(jobs: SqliteJobRepository, id: string, now: number): JobRow {
  return jobs.enqueue({
    id,
    type: "feed_refresh",
    payloadJson: JSON.stringify({ feedId: `feed_${id}` }),
    maxAttempts: 3,
    runAfter: now,
    now
  });
}

function fixtureFetcher(fixtures: Record<string, string>): FeedFetcher {
  return async (url) =>
    new Response(fixtures[url] ?? "", {
      status: fixtures[url] === undefined ? 502 : 200,
      statusText: fixtures[url] === undefined ? "Bad Gateway" : "OK"
    });
}

function minimalJob(id: string): JobRow {
  return {
    id,
    type: "feed_refresh",
    status: "queued",
    payloadJson: JSON.stringify({ feedId: "feed_fixture" }),
    error: null,
    attempts: 0,
    maxAttempts: 3,
    priority: 0,
    runAfter: 1000,
    startedAt: null,
    finishedAt: null,
    createdAt: 1000,
    updatedAt: 1000
  };
}

function countRows(db: DibaoDatabase, table: string, articleId: string): number {
  return (
    db
      .prepare(`select count(*) as count from ${table} where article_id = ?`)
      .get(articleId) as { count: number }
  ).count;
}

const fixtureRss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Job Runner Feed</title>
    <link>https://example.com</link>
    <description>Fixture feed</description>
    <item>
      <title>Job runner article</title>
      <link>https://example.com/job-runner</link>
      <guid>job-runner</guid>
      <pubDate>Thu, 14 May 2026 08:00:00 GMT</pubDate>
      <description>Queued refresh content.</description>
    </item>
  </channel>
</rss>`;

const retentionFixtureRss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Retention Feed</title>
    <link>https://example.com</link>
    <description>Retention fixture feed</description>
    <item>
      <title>Retention deleted article</title>
      <link>https://example.com/retention-deleted</link>
      <guid>retention-deleted</guid>
      <pubDate>Thu, 01 Jan 2026 08:00:00 GMT</pubDate>
      <description>cleanuprestoreguard</description>
      <content:encoded><![CDATA[<p>cleanuprestoreguard full text</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;
