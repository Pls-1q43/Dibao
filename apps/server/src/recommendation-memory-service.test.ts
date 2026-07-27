import { describe, expect, it } from "vitest";
import { openDatabase } from "@dibao/db";
import { RecommendationMemoryService } from "./recommendation-memory-service.js";

describe("RecommendationMemoryService", () => {
  it("records a visible recommendation once without creating an ignored behavior event", () => {
    const db = openDatabase(":memory:", { loadSqliteVec: false, migrate: true });
    try {
      db.prepare(
        `insert into feeds (id, title, feed_url, enabled, source_weight, created_at, updated_at)
         values ('feed_1', 'Feed', 'https://example.com/feed.xml', 1, 0, 1, 1)`
      ).run();
      db.prepare(
        `insert into articles (id, feed_id, url, title, discovered_at, dedupe_key, created_at, updated_at)
         values ('article_1', 'feed_1', 'https://example.com/1', 'Article', 1, 'article_1', 1, 1)`
      ).run();
      db.prepare(
        `insert into article_rank_scores (
          article_id, rank_context, score, interest_score, source_score, freshness_score,
          state_score, diversity_score, penalty_score, calculated_at, rerank_position,
          was_exploration, exploration_bucket_key
        ) values ('article_1', 'rec_v3:embedding:cocoon_5:schema_4', 0.5, 0, 0, 0, 0, 0, 0, 1, 1, 1, 'feed:feed_1')`
      ).run();
      const service = new RecommendationMemoryService(db, () => 10_000);

      expect(
        service.recordExposures({ clientSessionId: "session_1", articleIds: ["article_1"] })
      ).toEqual({ recorded: 1, existing: 0 });
      expect(
        service.recordExposures({ clientSessionId: "session_1", articleIds: ["article_1"] })
      ).toEqual({ recorded: 0, existing: 1 });
      expect(db.prepare("select count(*) as count from recommendation_exposures").get()).toEqual({ count: 1 });
      expect(db.prepare("select count(*) as count from behavior_events").get()).toEqual({ count: 0 });
      expect(db.prepare("select impressions from exploration_buckets where bucket_key = 'feed:feed_1'").get()).toEqual({ impressions: 1 });
    } finally {
      db.close();
    }
  });
});
