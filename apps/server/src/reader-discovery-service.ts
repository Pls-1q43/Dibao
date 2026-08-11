import {
  fromVectorBlob,
  type ArticleListItemRow,
  type ArticleRepository,
  type ArticleVectorRow,
  type EmbeddingRepository,
  type VectorStore
} from "@dibao/db";
import { cosineSimilarity } from "@dibao/ranking";

export type ReaderDiscoveryUnavailableReason =
  | "no_active_embedding"
  | "article_embedding_missing"
  | "insufficient_candidates";

export type ReaderDiscoveryResponse =
  | {
      status: "ready";
      items: ArticleListItemRow[];
    }
  | {
      status: "unavailable";
      items: [];
      reason: ReaderDiscoveryUnavailableReason;
    };

export type ReaderDiscoveryResult = ReaderDiscoveryResponse | null;

const DEFAULT_DISCOVERY_LIMIT = 5;
const MAX_DISCOVERY_LIMIT = 10;
const RELATED_KNN_OVERFETCH = 30;
const PERSONALIZED_CANDIDATE_LIMIT = 80;
const PERSONALIZED_RANK_WEIGHT = 0.65;
const CONTEXT_RANK_WEIGHT = 0.35;

export class ReaderDiscoveryService {
  constructor(
    private readonly options: {
      articles: Pick<
        ArticleRepository,
        "findDetailById" | "findDuplicateGroupMemberships" | "findListItemsByIds" | "list"
      >;
      embeddings: Pick<EmbeddingRepository, "findActiveIndex" | "findArticleVectors">;
      vectorStore: Pick<VectorStore, "searchSimilarArticles">;
      getActiveRankContext: () => string;
    }
  ) {}

  findRelatedArticles(input: { articleId: string; limit?: number }): ReaderDiscoveryResult {
    const rankContext = this.options.getActiveRankContext();
    const article = this.options.articles.findDetailById(input.articleId, { rankContext });
    if (!article) {
      return null;
    }

    const index = this.options.embeddings.findActiveIndex();
    if (!index) {
      return unavailable("no_active_embedding");
    }

    const currentVector = this.findArticleVector(index.id, input.articleId);
    if (!currentVector) {
      return unavailable("article_embedding_missing");
    }

    const limit = normalizeDiscoveryLimit(input.limit);
    const relatedIds = uniqueStrings(
      this.options.vectorStore
        .searchSimilarArticles({
          embeddingIndexId: index.id,
          vector: currentVector.vectorBlob,
          limit: Math.max(RELATED_KNN_OVERFETCH, limit * 4)
        })
        .map((result) => result.articleId)
        .filter((articleId) => articleId !== input.articleId)
    );
    if (relatedIds.length === 0) {
      return {
        status: "ready",
        items: []
      };
    }

    const duplicateGroupsByArticle = duplicateGroupMap(
      this.options.articles.findDuplicateGroupMemberships([input.articleId, ...relatedIds])
    );
    const currentDuplicateGroups = duplicateGroupsByArticle.get(input.articleId) ?? new Set();
    const hydratedItems = this.options.articles.findListItemsByIds(relatedIds, { rankContext });
    const itemsById = new Map(hydratedItems.map((item) => [item.id, item]));
    const items: ArticleListItemRow[] = [];

    for (const articleId of relatedIds) {
      if (hasAnyDuplicateGroup(duplicateGroupsByArticle.get(articleId), currentDuplicateGroups)) {
        continue;
      }
      const item = itemsById.get(articleId);
      if (!item || item.state.hidden || item.state.notInterested) {
        continue;
      }
      items.push(item);
      if (items.length >= limit) {
        break;
      }
    }

    return {
      status: "ready",
      items
    };
  }

  findPersonalizedRelatedArticles(input: {
    articleId: string;
    limit?: number;
  }): ReaderDiscoveryResult {
    const rankContext = this.options.getActiveRankContext();
    const article = this.options.articles.findDetailById(input.articleId, { rankContext });
    if (!article) {
      return null;
    }

    const index = this.options.embeddings.findActiveIndex();
    if (!index) {
      return unavailable("no_active_embedding");
    }

    const currentVector = this.findArticleVector(index.id, input.articleId);
    if (!currentVector) {
      return unavailable("article_embedding_missing");
    }

    const limit = normalizeDiscoveryLimit(input.limit);
    const recommendedItems = this.options.articles.list({
      view: "recommended",
      unreadOnly: true,
      limit: PERSONALIZED_CANDIDATE_LIMIT,
      includeUnreadCount: false,
      rankContext
    }).items;
    const recommendedIds = recommendedItems.map((item) => item.id);
    const duplicateGroupsByArticle = duplicateGroupMap(
      this.options.articles.findDuplicateGroupMemberships([input.articleId, ...recommendedIds])
    );
    const currentDuplicateGroups = duplicateGroupsByArticle.get(input.articleId) ?? new Set();
    const personalizedCandidates = recommendedItems.filter(
      (item) =>
        item.id !== input.articleId &&
        !item.state.read &&
        !item.state.hidden &&
        !item.state.notInterested &&
        !hasAnyDuplicateGroup(duplicateGroupsByArticle.get(item.id), currentDuplicateGroups)
    );
    const candidateVectors = new Map(
      this.options.embeddings
        .findArticleVectors({
          embeddingIndexId: index.id,
          articleIds: personalizedCandidates.map((item) => item.id)
        })
        .map((row) => [row.articleId, row])
    );
    const currentVectorValues = fromVectorBlob(currentVector.vectorBlob);
    const candidatesWithVectors = personalizedCandidates
      .flatMap((item, indexInPersonalized) => {
        const vector = candidateVectors.get(item.id);
        if (!vector) {
          return [];
        }
        const similarity = cosineSimilarity(currentVectorValues, fromVectorBlob(vector.vectorBlob));
        return [
          {
            item,
            indexInPersonalized,
            similarity
          }
        ];
      })
      .map((candidate, personalizedRankIndex) => ({
        ...candidate,
        personalizedRankIndex
      }));
    const minimumVectorCandidates = Math.min(limit, 2);
    if (candidatesWithVectors.length < minimumVectorCandidates) {
      return unavailable("insufficient_candidates");
    }

    const contextRankByArticle = new Map<string, number>();
    [...candidatesWithVectors]
      .sort((left, right) =>
        right.similarity - left.similarity ||
        left.indexInPersonalized - right.indexInPersonalized
      )
      .forEach((candidate, contextRank) => {
        contextRankByArticle.set(candidate.item.id, contextRank);
      });

    const denominator = Math.max(candidatesWithVectors.length - 1, 1);
    const ranked = candidatesWithVectors
      .map((candidate) => {
        const personalizedRankScore =
          candidatesWithVectors.length === 1
            ? 1
            : 1 - candidate.personalizedRankIndex / denominator;
        const contextRank = contextRankByArticle.get(candidate.item.id) ?? denominator;
        const contextRankScore =
          candidatesWithVectors.length === 1 ? 1 : 1 - contextRank / denominator;
        return {
          ...candidate,
          finalScore:
            PERSONALIZED_RANK_WEIGHT * personalizedRankScore +
            CONTEXT_RANK_WEIGHT * contextRankScore
        };
      })
      .sort((left, right) =>
        right.finalScore - left.finalScore ||
        left.indexInPersonalized - right.indexInPersonalized
      );

    const items: ArticleListItemRow[] = [];
    const usedDuplicateGroups = new Set<string>();
    for (const candidate of ranked) {
      const duplicateGroups = duplicateGroupsByArticle.get(candidate.item.id) ?? new Set();
      if (hasAnyDuplicateGroup(duplicateGroups, usedDuplicateGroups)) {
        continue;
      }
      for (const duplicateGroupId of duplicateGroups) {
        usedDuplicateGroups.add(duplicateGroupId);
      }
      items.push(candidate.item);
      if (items.length >= limit) {
        break;
      }
    }

    if (items.length === 0) {
      return unavailable("insufficient_candidates");
    }

    return {
      status: "ready",
      items
    };
  }

  private findArticleVector(
    embeddingIndexId: string,
    articleId: string
  ): ArticleVectorRow | null {
    return this.options.embeddings.findArticleVectors({
      embeddingIndexId,
      articleIds: [articleId]
    })[0] ?? null;
  }
}

function unavailable(reason: ReaderDiscoveryUnavailableReason): ReaderDiscoveryResponse {
  return {
    status: "unavailable",
    items: [],
    reason
  };
}

function normalizeDiscoveryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_DISCOVERY_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_DISCOVERY_LIMIT);
}

function duplicateGroupMap(
  memberships: Array<{ articleId: string; duplicateGroupId: string }>
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const existing = map.get(membership.articleId) ?? new Set<string>();
    existing.add(membership.duplicateGroupId);
    map.set(membership.articleId, existing);
  }
  return map;
}

function hasAnyDuplicateGroup(
  left: Set<string> | undefined,
  right: Set<string>
): boolean {
  if (!left || left.size === 0 || right.size === 0) {
    return false;
  }
  for (const duplicateGroupId of left) {
    if (right.has(duplicateGroupId)) {
      return true;
    }
  }
  return false;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
