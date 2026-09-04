import { describe, expect, it, vi } from "vitest";
import type {
  ArticleDetailRow,
  ArticleListInput,
  ArticleListItemRow,
  ArticleStateSnapshot,
  CreateRecommendedArticleSessionInput,
  OfflineArticleMetadataRow
} from "@dibao/db";
import {
  OFFLINE_READ_LATER_LIMIT,
  OfflineReadingService
} from "./offline-reading-service.js";

describe("OfflineReadingService", () => {
  it("keeps persisted recommendation order while paging past articles without readable content", () => {
    const recommended = Array.from({ length: 140 }, (_, index) => article(`recommended-${index}`, 500 - index));
    const readLater = Array.from({ length: 230 }, (_, index) =>
      article(`later-${index}`, 300 - index, { readLater: true, interactionStatus: "saved" })
    );
    const recent = Array.from({ length: 35 }, (_, index) =>
      article(`recent-${index}`, 100 - index, { openedAt: 10_000 - index })
    );
    const unreadable = new Set(recommended.filter((_, index) => index % 5 === 0).map((item) => item.id));
    const list = vi.fn((input: ArticleListInput) => {
      const rows = input.view === "recommended" ? recommended : readLater;
      const offset = input.cursor?.type === "recommended_session"
        ? input.cursor.position + 1
        : input.offset ?? 0;
      const limit = input.limit ?? 100;
      const items = rows.slice(offset, offset + limit);
      const hasMore = offset + items.length < rows.length;
      return {
        items,
        nextCursor:
          input.view === "recommended" && hasMore
            ? {
                type: "recommended_session" as const,
                sessionId: input.recommendationSessionId ?? "offline-session",
                position: offset + items.length - 1
              }
            : null,
        nextOffset: input.view === "read_later" && hasMore ? offset + items.length : null,
        unreadCount: null,
        timing: emptyTiming(),
        recommendationSession: null
      };
    });
    const findOfflineMetadataByIds = vi.fn((ids: string[]) =>
      ids.map((id) => metadata(id, !unreadable.has(id)))
    );
    const createRecommendedSession = vi.fn((input: CreateRecommendedArticleSessionInput) => ({
      id: input.id,
      rankContext: input.rankContext,
      rerankWindowId: "window:test",
      scopeKey: input.scopeKey,
      itemCount: recommended.length,
      createdAt: input.now,
      expiresAt: input.expiresAt
    }));
    const deleteRecommendedSession = vi.fn();
    const service = new OfflineReadingService({
      articles: {
        findDetailsByIds: () => [],
        findOfflineMetadataByIds,
        list,
        listRecentlyOpened: () => recent,
        createRecommendedSession,
        deleteRecommendedSession
      },
      getActiveRankContext: () => "rank:test",
      now: () => 42_000
    });

    const manifest = service.createManifest(100);

    expect(manifest.recommended).toHaveLength(100);
    expect(manifest.recommended.map((item) => item.article.id)).toEqual(
      recommended.filter((item) => !unreadable.has(item.id)).slice(0, 100).map((item) => item.id)
    );
    expect(manifest.recommended.map((item) => item.position)).toEqual(
      Array.from({ length: 100 }, (_, index) => index)
    );
    expect(manifest.readLater).toHaveLength(OFFLINE_READ_LATER_LIMIT);
    expect(manifest.readLater[0]?.article.id).toBe("later-0");
    expect(manifest.readLater.at(-1)?.article.id).toBe("later-199");
    expect(manifest.recent).toHaveLength(20);
    expect(manifest.recent.at(-1)?.article.id).toBe("recent-19");
    expect(manifest).toMatchObject({
      generatedAt: 42_000,
      rankContext: "rank:test",
      recommendedTarget: 100,
      snapshotId: expect.stringMatching(/^[a-f0-9]{24}$/)
    });
    expect(createRecommendedSession).toHaveBeenCalledWith(expect.objectContaining({
      rankContext: "rank:test",
      maxItems: 200,
      unreadOnly: true
    }));
    expect(deleteRecommendedSession).toHaveBeenCalledWith(
      expect.stringMatching(/^offline_session_/)
    );
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      view: "recommended",
      unreadOnly: true,
      recommendationSessionId: expect.stringMatching(/^offline_session_/),
      cursor: expect.objectContaining({ position: 99 })
    }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      view: "read_later",
      unreadOnly: false,
      sort: "read_later_desc"
    }));
  });

  it.each([
    [1, 50],
    [50, 50],
    [200, 200],
    [1_000, 1_000],
    [2_000, 1_000]
  ])("normalizes a requested target of %i to %i", (requested, expected) => {
    const service = new OfflineReadingService({
      articles: {
        findDetailsByIds: () => [],
        findOfflineMetadataByIds: () => [],
        list: () => ({
          items: [],
          nextCursor: null,
          nextOffset: null,
          unreadCount: null,
          timing: emptyTiming(),
          recommendationSession: null
        }),
        listRecentlyOpened: () => [],
        createRecommendedSession: (input) => ({
          id: input.id,
          rankContext: input.rankContext,
          rerankWindowId: null,
          scopeKey: input.scopeKey,
          itemCount: 0,
          createdAt: input.now,
          expiresAt: input.expiresAt
        }),
        deleteRecommendedSession: () => undefined
      },
      getActiveRankContext: () => "base"
    });

    expect(service.createManifest(requested).recommendedTarget).toBe(expected);
  });

  it("returns one ordered detail per unique requested id", () => {
    const findDetailsByIds = vi.fn((ids: string[]) => ids.map((id) => detail(id)));
    const service = new OfflineReadingService({
      articles: {
        findDetailsByIds,
        findOfflineMetadataByIds: () => [],
        list: () => ({
          items: [], nextCursor: null, nextOffset: null, unreadCount: null, timing: emptyTiming(), recommendationSession: null
        }),
        listRecentlyOpened: () => [],
        createRecommendedSession: (input) => ({
          id: input.id,
          rankContext: input.rankContext,
          rerankWindowId: null,
          scopeKey: input.scopeKey,
          itemCount: 0,
          createdAt: input.now,
          expiresAt: input.expiresAt
        }),
        deleteRecommendedSession: () => undefined
      },
      getActiveRankContext: () => "rank:test"
    });

    expect(service.getArticles(["two", "one", "two"]).map((item) => item.id)).toEqual(["two", "one"]);
    expect(findDetailsByIds).toHaveBeenCalledWith(["two", "one"], { rankContext: "rank:test" });
  });
});

function article(
  id: string,
  score: number,
  state: Partial<ArticleStateSnapshot> = {}
): ArticleListItemRow {
  return {
    id,
    feedId: "feed",
    feedTitle: "Feed",
    title: id,
    url: `https://example.com/${id}`,
    author: null,
    summary: `Summary ${id}`,
    publishedAt: score,
    discoveredAt: score,
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
    rank: { score, calculatedAt: 1_000 }
  };
}

function detail(id: string): ArticleDetailRow {
  return {
    ...article(id, 1),
    contentHtml: `<p>${id}</p>`,
    contentText: id,
    extractionStatus: "success",
    extractionError: null
  };
}

function metadata(id: string, hasReadableContent: boolean): OfflineArticleMetadataRow {
  return {
    articleId: id,
    contentRevision: `${id}:1`,
    hasReadableContent,
    favoritedAt: null,
    readLaterAt: null,
    openedAt: null
  };
}

function emptyTiming() {
  return {
    setupMs: 0,
    unreadCountMs: 0,
    candidateMs: 0,
    rankCandidateMs: 0,
    unrankedCandidateMs: 0,
    hydrateMs: 0,
    fallbackMs: 0,
    pageQueryMs: 0,
    mapMs: 0,
    totalMs: 0
  };
}
