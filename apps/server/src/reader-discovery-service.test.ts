import { describe, expect, it } from "vitest";
import {
  openDatabase,
  SqliteArticleRepository,
  SqliteEmbeddingRepository,
  SqliteFeedRepository,
  SqliteRankingRepository,
  SqliteVecVectorStore,
  toVectorBlob,
  type ArticleDetailRow,
  type ArticleListItemRow,
  type ArticleStateSnapshot,
  type DibaoDatabase,
  type EmbeddingIndexRow
} from "@dibao/db";
import { ReaderDiscoveryService } from "./reader-discovery-service.js";

const RANK_CONTEXT = "reader_discovery:test";

describe("ReaderDiscoveryService", () => {
  it("finds semantic related articles while filtering self, hidden, deleted, disabled, and duplicate candidates", () => {
    const fixture = createFixture();
    try {
      fixture.addArticle("current", [1, 0]);
      fixture.addArticle("valid", [0.99, 0.04]);
      fixture.addArticle("self_near_duplicate", [0.98, 0.05]);
      fixture.addArticle("hidden", [0.97, 0.05]);
      fixture.addArticle("not_interested", [0.96, 0.05]);
      fixture.addArticle("deleted", [0.95, 0.05], { status: "deleted" });
      fixture.addArticle("disabled_feed", [0.94, 0.05], { feedId: "feed_disabled" });
      fixture.markState("hidden", { hiddenAt: 1000 });
      fixture.markState("not_interested", { notInterestedAt: 1000 });
      fixture.addDuplicateGroup("dup_current", ["current", "self_near_duplicate"]);

      const result = fixture.service.findRelatedArticles({ articleId: "current", limit: 5 });

      expect(result).toEqual({
        status: "ready",
        items: [expect.objectContaining({ id: "valid" })]
      });
    } finally {
      fixture.db.close();
    }
  });

  it("returns unavailable for related articles when active vectors are missing", () => {
    const fixture = createFixture();
    try {
      fixture.addArticle("current");

      expect(fixture.service.findRelatedArticles({ articleId: "current" })).toEqual({
        status: "unavailable",
        items: [],
        reason: "article_embedding_missing"
      });
    } finally {
      fixture.db.close();
    }
  });

  it("returns unavailable for related articles when there is no active embedding index", () => {
    const fixture = createFixture({ activeIndex: false });
    try {
      fixture.addArticle("current");

      expect(fixture.service.findRelatedArticles({ articleId: "current" })).toEqual({
        status: "unavailable",
        items: [],
        reason: "no_active_embedding"
      });
    } finally {
      fixture.db.close();
    }
  });

  it("finds related search articles above the similarity threshold with pagination", () => {
    const fixture = createFixture();
    try {
      fixture.addArticle("current", [1, 0]);
      fixture.addArticle("read_candidate", [0.99, 0.03]);
      fixture.addArticle("favorited_candidate", [0.98, 0.05]);
      fixture.addArticle("liked_candidate", [0.97, 0.06]);
      fixture.addArticle("duplicate_current", [0.96, 0.07]);
      fixture.addArticle("below_threshold", [0, 1]);
      fixture.addArticle("hidden", [0.95, 0.08]);
      fixture.markState("read_candidate", { readAt: 1000 });
      fixture.markState("favorited_candidate", { favoritedAt: 1000 });
      fixture.markState("liked_candidate", { likedAt: 1000 });
      fixture.markState("hidden", { hiddenAt: 1000 });
      fixture.addDuplicateGroup("dup_current", ["current", "duplicate_current"]);

      const firstPage = fixture.service.findRelatedSearchArticles({
        articleId: "current",
        limit: 2,
        threshold: 0.35
      });
      const secondPage = fixture.service.findRelatedSearchArticles({
        articleId: "current",
        limit: 2,
        offset: 2,
        threshold: 0.35
      });
      const favoriteResults = fixture.service.findRelatedSearchArticles({
        articleId: "current",
        state: "favorites",
        threshold: 0.35
      });

      expect(firstPage).toMatchObject({
        status: "ready",
        sourceArticle: expect.objectContaining({ id: "current" }),
        threshold: 0.35,
        totalCount: 3,
        nextOffset: 2,
        items: [
          expect.objectContaining({ id: "read_candidate" }),
          expect.objectContaining({ id: "favorited_candidate" })
        ]
      });
      expect(secondPage).toMatchObject({
        status: "ready",
        totalCount: 3,
        nextOffset: null,
        items: [expect.objectContaining({ id: "liked_candidate" })]
      });
      expect(favoriteResults).toMatchObject({
        status: "ready",
        totalCount: 1,
        items: [expect.objectContaining({ id: "favorited_candidate" })]
      });
    } finally {
      fixture.db.close();
    }
  });

  it("reranks personalized candidates by current liked article context without running KNN", () => {
    const fixture = createFixture({
      vectorStore: {
        searchSimilarArticles: () => {
          throw new Error("personalized related must not run sqlite-vec KNN");
        }
      }
    });
    try {
      fixture.addArticle("current", [1, 0]);
      fixture.addRankedArticle("a", 4, [5, 1]);
      fixture.addRankedArticle("b", 3, [1, 1]);
      fixture.addRankedArticle("c", 2, [10, 0]);
      fixture.addRankedArticle("d", 1, [0, 1]);
      fixture.addRankedArticle("hidden", 10, [10, 0]);
      fixture.addRankedArticle("read", 9, [10, 0]);
      fixture.addRankedArticle("duplicate_current", 8, [10, 0]);
      fixture.addRankedArticle("missing_vector", 7);
      fixture.markState("hidden", { hiddenAt: 1000 });
      fixture.markState("read", { readAt: 1000 });
      fixture.addDuplicateGroup("dup_current", ["current", "duplicate_current"]);

      const result = fixture.service.findPersonalizedRelatedArticles({
        articleId: "current",
        limit: 4
      });

      expect(result?.status).toBe("ready");
      expect(result?.items.map((item) => item.id)).toEqual(["a", "c", "b", "d"]);
    } finally {
      fixture.db.close();
    }
  });

  it("excludes read, favorited, and liked articles from personalized related candidates", () => {
    const vectors = new Map<string, readonly number[]>([
      ["current", [1, 0]],
      ["read_candidate", [10, 0]],
      ["favorited_candidate", [10, 0]],
      ["liked_candidate", [10, 0]],
      ["valid_a", [5, 1]],
      ["valid_b", [1, 1]]
    ]);
    const service = new ReaderDiscoveryService({
      articles: {
        findDetailById: (articleId: string) =>
          articleId === "current" ? makeArticleDetail("current") : null,
        findDuplicateGroupMemberships: () => [],
        findListItemsByIds: () => [],
        list: () => ({
          items: [
            makeArticleListItem("read_candidate", 10, {
              read: true,
              interactionStatus: "read"
            }),
            makeArticleListItem("favorited_candidate", 9, {
              favorited: true,
              interactionStatus: "saved"
            }),
            makeArticleListItem("liked_candidate", 8, {
              liked: true,
              interactionStatus: "saved"
            }),
            makeArticleListItem("valid_a", 7),
            makeArticleListItem("valid_b", 6)
          ],
          nextOffset: null,
          nextCursor: null,
          unreadCount: null
        })
      },
      embeddings: {
        findActiveIndex: () => makeEmbeddingIndex(),
        findArticleVectors: (input: { articleIds: string[] }) =>
          input.articleIds.flatMap((articleId) => {
            const vector = vectors.get(articleId);
            return vector
              ? [
                  {
                    articleId,
                    embeddingIndexId: "index",
                    vectorBlob: toVectorBlob(vector),
                    contentHash: `hash_${articleId}`
                  }
                ]
              : [];
          })
      },
      vectorStore: {
        searchSimilarArticles: () => {
          throw new Error("personalized related must not run sqlite-vec KNN");
        }
      },
      getActiveRankContext: () => RANK_CONTEXT
    });

    const result = service.findPersonalizedRelatedArticles({
      articleId: "current",
      limit: 3
    });

    expect(result).toEqual({
      status: "ready",
      items: [
        expect.objectContaining({ id: "valid_a" }),
        expect.objectContaining({ id: "valid_b" })
      ]
    });
  });

  it("returns unavailable for personalized related when current or candidate vectors are insufficient", () => {
    const fixture = createFixture();
    try {
      fixture.addArticle("current", [1, 0]);
      fixture.addRankedArticle("missing_vector", 10);

      expect(fixture.service.findPersonalizedRelatedArticles({ articleId: "current" })).toEqual({
        status: "unavailable",
        items: [],
        reason: "insufficient_candidates"
      });
    } finally {
      fixture.db.close();
    }
  });
});

function makeArticleDetail(articleId: string): ArticleDetailRow {
  return {
    ...makeArticleListItem(articleId, 1),
    contentHtml: null,
    contentText: null,
    extractionStatus: "feed_only",
    extractionError: null
  };
}

function makeArticleListItem(
  articleId: string,
  score: number,
  state: Partial<ArticleStateSnapshot> = {}
): ArticleListItemRow {
  return {
    id: articleId,
    feedId: "feed_active",
    feedTitle: "Active Feed",
    title: `Article ${articleId}`,
    url: `https://example.com/${articleId}`,
    author: null,
    summary: `Summary ${articleId}`,
    publishedAt: null,
    discoveredAt: 1000,
    state: {
      read: false,
      favorited: false,
      liked: false,
      readLater: false,
      hidden: false,
      notInterested: false,
      readingProgress: 0,
      interactionStatus: "unseen",
      openedAt: null,
      ignoredAt: null,
      ...state
    },
    rank: {
      score,
      calculatedAt: 1000
    }
  };
}

function makeEmbeddingIndex(): EmbeddingIndexRow {
  return {
    id: "index",
    providerId: "provider",
    model: "fixture-2d",
    dimension: 2,
    textMaxChars: 8000,
    distanceMetric: "cosine",
    tableName: "vec_fixture",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000
  };
}

function createFixture(input: {
  activeIndex?: boolean;
  vectorStore?: Pick<SqliteVecVectorStore, "searchSimilarArticles">;
} = {}) {
  const db = openDatabase(":memory:", { migrate: true });
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);
  const embeddings = new SqliteEmbeddingRepository(db);
  const rankings = new SqliteRankingRepository(db);
  const storageVectorStore = new SqliteVecVectorStore(db);
  const vectorStore = input.vectorStore ?? storageVectorStore;

  feeds.upsert({
    id: "feed_active",
    title: "Active Feed",
    feedUrl: "https://example.com/feed.xml",
    now: 1000
  });
  feeds.upsert({
    id: "feed_disabled",
    title: "Disabled Feed",
    feedUrl: "https://example.com/disabled.xml",
    enabled: false,
    now: 1000
  });
  embeddings.upsertProvider({
    id: "provider",
    type: "embedded_local",
    name: "Provider",
    model: "fixture-2d",
    dimension: 2,
    enabled: true,
    now: 1000
  });
  if (input.activeIndex ?? true) {
    embeddings.createIndex({
      id: "index",
      providerId: "provider",
      model: "fixture-2d",
      dimension: 2,
      now: 1000
    });
    rankings.upsertRankContext({
      id: RANK_CONTEXT,
      algorithmVersion: "reader-discovery-test",
      featureSchemaVersion: 1,
      embeddingIndexId: "index",
      cocoonLevel: 5,
      now: 1000
    });
  }

  const service = new ReaderDiscoveryService({
    articles,
    embeddings,
    vectorStore,
    getActiveRankContext: () => RANK_CONTEXT
  });

  return {
    db,
    service,
    addArticle: (
      articleId: string,
      vector?: readonly number[],
      options: { feedId?: string; status?: "active" | "deleted" } = {}
    ) => {
      articles.upsert({
        id: articleId,
        feedId: options.feedId ?? "feed_active",
        url: `https://example.com/${articleId}`,
        title: `Article ${articleId}`,
        summary: `Summary ${articleId}`,
        dedupeKey: articleId,
        status: options.status ?? "active",
        discoveredAt: 1000,
        now: 1000
      });
      if (vector && (input.activeIndex ?? true)) {
        storageVectorStore.upsertArticleVector({
          articleId,
          embeddingIndexId: "index",
          vector,
          contentHash: `hash_${articleId}`,
          now: 1000
        });
      }
    },
    addRankedArticle: (articleId: string, score: number, vector?: readonly number[]) => {
      articles.upsert({
        id: articleId,
        feedId: "feed_active",
        url: `https://example.com/${articleId}`,
        title: `Article ${articleId}`,
        summary: `Summary ${articleId}`,
        dedupeKey: articleId,
        discoveredAt: 1000,
        now: 1000
      });
      rankings.upsertScore({
        articleId,
        rankContext: RANK_CONTEXT,
        embeddingIndexId: "index",
        score,
        interestScore: 0,
        sourceScore: 0,
        freshnessScore: 0,
        stateScore: 0,
        diversityScore: 0,
        penaltyScore: 0,
        calculatedAt: 1000
      });
      if (vector) {
        storageVectorStore.upsertArticleVector({
          articleId,
          embeddingIndexId: "index",
          vector,
          contentHash: `hash_${articleId}`,
          now: 1000
        });
      }
    },
    markState: (
      articleId: string,
      state: {
        readAt?: number;
        favoritedAt?: number;
        likedAt?: number;
        hiddenAt?: number;
        notInterestedAt?: number;
      }
    ) => markState(db, articleId, state),
    addDuplicateGroup: (groupId: string, articleIds: string[]) =>
      addDuplicateGroup(db, groupId, articleIds)
  };
}

function markState(
  db: DibaoDatabase,
  articleId: string,
  state: {
    readAt?: number;
    favoritedAt?: number;
    likedAt?: number;
    hiddenAt?: number;
    notInterestedAt?: number;
  }
) {
  db.prepare(
    `
      insert into article_states (
        article_id,
        read_at,
        favorited_at,
        liked_at,
        read_later_at,
        hidden_at,
        not_interested_at,
        reading_progress,
        last_opened_at,
        updated_at
      )
      values (?, ?, ?, ?, null, ?, ?, ?, null, ?)
      on conflict(article_id) do update set
        read_at = excluded.read_at,
        favorited_at = excluded.favorited_at,
        liked_at = excluded.liked_at,
        hidden_at = excluded.hidden_at,
        not_interested_at = excluded.not_interested_at,
        reading_progress = excluded.reading_progress,
        updated_at = excluded.updated_at
    `
  ).run(
    articleId,
    state.readAt ?? null,
    state.favoritedAt ?? null,
    state.likedAt ?? null,
    state.hiddenAt ?? null,
    state.notInterestedAt ?? null,
    state.readAt ? 1 : 0,
    1000
  );
}

function addDuplicateGroup(db: DibaoDatabase, groupId: string, articleIds: string[]) {
  db.prepare(
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
      values (?, ?, 'near_title', 0.95, ?, 1000, 1000)
    `
  ).run(groupId, articleIds[0] ?? null, articleIds.length);

  const insertMember = db.prepare(
    `
      insert into duplicate_group_members (
        duplicate_group_id,
        article_id,
        confidence,
        reason,
        is_representative,
        created_at
      )
      values (?, ?, 0.95, 'near_title', ?, 1000)
    `
  );
  articleIds.forEach((articleId, index) => {
    insertMember.run(groupId, articleId, index === 0 ? 1 : 0);
  });
}
