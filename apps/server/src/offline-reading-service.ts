import { createHash } from "node:crypto";
import type {
  ArticleDetailRow,
  ArticleListItemRow,
  ArticleRepository,
  OfflineArticleMetadataRow
} from "@dibao/db";

const OFFLINE_PAGE_SIZE = 100;
export const OFFLINE_RECOMMENDED_LIMIT_MIN = 50;
export const OFFLINE_RECOMMENDED_LIMIT_MAX = 1_000;
export const OFFLINE_READ_LATER_LIMIT = 200;
export const OFFLINE_RECENT_LIMIT = 20;
export const OFFLINE_ARTICLE_BATCH_LIMIT = 50;

export type OfflineManifestArticle = {
  article: ArticleListItemRow;
  contentRevision: string;
  position: number;
  favoritedAt: number | null;
  readLaterAt: number | null;
  openedAt: number | null;
};

export type OfflineManifest = {
  snapshotId: string;
  generatedAt: number;
  rankContext: string;
  recommendedTarget: number;
  recommended: OfflineManifestArticle[];
  readLater: OfflineManifestArticle[];
  recent: OfflineManifestArticle[];
};

export class OfflineReadingService {
  constructor(
    private readonly options: {
      articles: Pick<
        ArticleRepository,
        | "findDetailsByIds"
        | "findOfflineMetadataByIds"
        | "list"
        | "listRecentlyOpened"
      >;
      getActiveRankContext: () => string;
      now?: () => number;
    }
  ) {}

  createManifest(recommendedLimit: number): OfflineManifest {
    const rankContext = this.options.getActiveRankContext();
    const normalizedRecommendedLimit = clampInteger(
      recommendedLimit,
      OFFLINE_RECOMMENDED_LIMIT_MIN,
      OFFLINE_RECOMMENDED_LIMIT_MAX
    );
    const recommended = this.listReadableView({
      rankContext,
      target: normalizedRecommendedLimit,
      view: "recommended"
    });
    const readLater = this.listReadableView({
      rankContext,
      target: OFFLINE_READ_LATER_LIMIT,
      view: "read_later"
    });
    const recentRows = this.options.articles.listRecentlyOpened({
      limit: OFFLINE_RECENT_LIMIT * 5,
      rankContext
    });
    const recent = this.readableManifestArticles(recentRows, 0).slice(
      0,
      OFFLINE_RECENT_LIMIT
    );
    const generatedAt = this.options.now?.() ?? Date.now();
    const snapshotId = createSnapshotId({ rankContext, recommended, readLater, recent });

    return {
      snapshotId,
      generatedAt,
      rankContext,
      recommendedTarget: normalizedRecommendedLimit,
      recommended,
      readLater,
      recent
    };
  }

  getArticles(articleIds: string[]): ArticleDetailRow[] {
    const uniqueIds = uniqueStrings(articleIds).slice(0, OFFLINE_ARTICLE_BATCH_LIMIT);
    return this.options.articles.findDetailsByIds(uniqueIds, {
      rankContext: this.options.getActiveRankContext()
    });
  }

  private listReadableView(input: {
    rankContext: string;
    target: number;
    view: "recommended" | "read_later";
  }): OfflineManifestArticle[] {
    const result: OfflineManifestArticle[] = [];
    let offset = 0;
    let exhausted = false;

    while (!exhausted && result.length < input.target) {
      const page = this.options.articles.list({
        view: input.view,
        unreadOnly: input.view === "recommended",
        sort: input.view === "read_later" ? "read_later_desc" : undefined,
        rankContext: input.rankContext,
        limit: OFFLINE_PAGE_SIZE,
        offset,
        includeUnreadCount: false
      });
      result.push(...this.readableManifestArticles(page.items, result.length));
      if (page.nextOffset === null || page.items.length === 0) {
        exhausted = true;
      } else {
        offset = page.nextOffset;
      }
    }

    return result.slice(0, input.target);
  }

  private readableManifestArticles(
    articles: ArticleListItemRow[],
    startingPosition: number
  ): OfflineManifestArticle[] {
    const metadata = this.options.articles.findOfflineMetadataByIds(
      articles.map((article) => article.id)
    );
    const metadataById = new Map(metadata.map((item) => [item.articleId, item]));
    const result: OfflineManifestArticle[] = [];
    for (const article of articles) {
      const item = metadataById.get(article.id);
      if (!item?.hasReadableContent) {
        continue;
      }
      result.push(manifestArticle(article, item, startingPosition + result.length));
    }
    return result;
  }
}

function manifestArticle(
  article: ArticleListItemRow,
  metadata: OfflineArticleMetadataRow,
  startingPosition: number
): OfflineManifestArticle {
  return {
    article,
    contentRevision: metadata.contentRevision,
    position: startingPosition,
    favoritedAt: metadata.favoritedAt,
    readLaterAt: metadata.readLaterAt,
    openedAt: metadata.openedAt
  };
}

function createSnapshotId(input: {
  rankContext: string;
  recommended: OfflineManifestArticle[];
  readLater: OfflineManifestArticle[];
  recent: OfflineManifestArticle[];
}): string {
  const fingerprint = JSON.stringify({
    rankContext: input.rankContext,
    recommended: input.recommended.map(articleFingerprint),
    readLater: input.readLater.map(articleFingerprint),
    recent: input.recent.map(articleFingerprint)
  });
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
}

function articleFingerprint(article: OfflineManifestArticle): [string, string] {
  return [article.article.id, article.contentRevision];
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
