import {
  calculateBaselineRankScore,
  clamp,
  cosineSimilarity,
  freshnessScore,
  profileAlgorithmDefaults
} from "@dibao/ranking";
import { performance } from "node:perf_hooks";
import {
  BASE_RANK_CONTEXT,
  fromVectorBlob,
  sanitizeFtsQuery,
  type ArticleRankExplanationSourceRow,
  type ArticleRankingCandidateRow,
  type DibaoDatabase,
  type EmbeddingRepository,
  type InterestClusterPolarity,
  type InterestClusterRow,
  type ProfileRepository,
  type RankingRepository,
  type UpsertArticleRankExplanationInput,
  type UpsertRankContextInput,
  type UpsertArticleRankScoreInput
} from "@dibao/db";
import { FTRL_ACTIVE_ALPHA_CAP } from "./recommendation-maintenance-service.js";

export interface ArticleRankingRecalculator {
  recalculateArticle(articleId: string): number;
  recalculateArticles(articleIds: string[]): number;
  recalculateAll(): number;
  recalculateChunk?(input: {
    cursor?: string | null;
    limit: number;
  }): RankingRecalculateChunkResult;
}

export type RankingPauseDecision =
  | { pause: true; resumeAfter: number }
  | { pause: false };

export type RankingRecalculateChunkResult = {
  processed: number;
  nextCursor: string | null;
  paused?: boolean;
  resumeAfter?: number;
  pauseReason?: "foreground" | "time_budget";
};

export type RankExplanationReasonType =
  | "interest"
  | "source"
  | "freshness"
  | "state"
  | "fallback"
  | "negative"
  | "penalty"
  | "exploration";

export type RankExplanationReason = {
  type: RankExplanationReasonType;
  label: string;
  impact: "positive" | "negative" | "neutral";
  family?: RankExplanationFamilyMatch;
  recentIntent?: RankExplanationRecentIntentMatch;
  cluster?: RankExplanationClusterMatch;
  clusters?: RankExplanationClusterMatch[];
};

export type RankExplanationFamilyMatch = {
  id: string;
  label: string;
  maturity: number;
  dominanceRatio: number;
  matchedFamilyCount: number;
};

export type RankExplanationRecentIntentMatch = {
  polarity: "positive";
};

export type RankExplanationClusterMatch = {
  id: string;
  polarity: InterestClusterPolarity;
  label: string | null;
  displayIndex: number;
  weight: number;
  sampleCount: number;
  similarity: number;
  lastMatchedAt: number | null;
  updatedAt: number;
};

export type RankExplanationResult = {
  articleId: string;
  status: ArticleRankExplanationSourceRow["rankingStatus"];
  reasons: RankExplanationReason[];
  generatedAt: number;
  components?: Record<string, unknown>;
};

export type RankingSettingsSnapshot = {
  cocoonLevel: number;
  localLearningEnabled: boolean;
  localLearningShadowMode: boolean;
  explorationEnabled: boolean;
  evaluationEnabled: boolean;
  recentHistoryMode?: "disabled" | "shadow" | "active";
  crossSessionFatigueMode?: "disabled" | "shadow" | "active";
  learnedExplorationMode?: "disabled" | "shadow" | "active";
};

export type RecommendationRankingServiceOptions = {
  db?: DibaoDatabase;
  embeddings?: Pick<EmbeddingRepository, "findActiveProviderWithIndex">;
  profiles?: Pick<ProfileRepository, "listClusters">;
  rankings: RankingRepository;
  getRankingSettings?: () => RankingSettingsSnapshot;
  shouldPause?: (checkpoint: {
    processed: number;
    lastArticleId: string | null;
  }) => RankingPauseDecision;
  maxChunkDurationMs?: number;
  now?: () => number;
};

type ClusterVector = {
  cluster: InterestClusterRow;
  polarity: InterestClusterPolarity;
  vector: number[];
  weightNorm: number;
  familyId: string;
  familyLabel: string | null;
  familyMaturity: number;
  familyDominanceRatio: number;
  familyClusterCount: number;
  supportArticleCount: number;
  sourceCount: number;
};

type CandidateOrigin =
  | "explicit"
  | "must_include"
  | "recency"
  | "semantic"
  | "lexical"
  | "diversity";

type LexicalFeature = {
  bm25Positive: number;
  bm25Recent: number;
  positiveOverlap: number;
  negativeOverlap: number;
  titleKeywordMatch: number;
  matchedTerms: Array<{ term: string; polarity: "positive" | "negative"; scope: "long" | "recent" }>;
};

type RecentIntentVector = {
  polarity: InterestClusterPolarity;
  vector: number[];
  weight: number;
  eventCount: number;
  updatedAt: number;
};

type RecentBehaviorVector = {
  polarity: "positive" | "negative";
  vector: number[];
  weight: number;
  createdAt: number;
};

type ExposureFatigueCounts = {
  feeds: Map<string, number>;
  families: Map<string, number>;
  duplicateGroups: Map<string, number>;
};

type DuplicateFeature = {
  groupId: string | null;
  groupSize: number;
  reason: string | null;
  confidence: number | null;
  representativeArticleId: string | null;
};

type SourceFeature = {
  clearSignalCount: number;
  smoothedPositiveRate: number;
  sourceConfidence: number;
};

type FtrlModel = {
  status: "shadow" | "active" | "retired" | "failed";
  sampleCount: number;
  blendAlpha: number;
  weights: Map<string, number>;
};

type V2Score = {
  score: number;
  baseScore: number;
  ftrlScore: number;
  semanticScore: number;
  bm25Score: number;
  sourceScore: number;
  freshnessScore: number;
  stateScore: number;
  diversityScore: number;
  penaltyScore: number;
  negativePenalty: number;
  duplicatePenalty: number;
  diversityPenalty: number;
  explorationBonus: number;
  recentHistoryScore: number;
  fatiguePenalty: number;
  explorationEligible: boolean;
  explorationBucket: string | null;
  explorationReason: string | null;
  wasExploration: boolean;
  pendingEmbeddingScore: number;
  exposurePenalty: number;
  preRerankScore: number;
  primaryFamilyId: string | null;
  primaryFamilyLabel: string | null;
  primaryClusterId: string | null;
  primaryClusterLabel: string | null;
  primaryFamilyMaturity: number;
  primaryFamilyDominanceRatio: number;
  matchedFamilyCount: number;
};

const RECOMMENDATION_ALGORITHM_VERSION = "rec_v3";
const RECOMMENDATION_FEATURE_SCHEMA_VERSION = 3;
const MMR_WINDOW_LIMIT = 500;
const DEFAULT_RANKING_CHUNK_TIME_BUDGET_MS = 2_000;
const RANKING_TIME_BUDGET_RESUME_DELAY_MS = 5_000;

export class RecommendationRankingService implements ArticleRankingRecalculator {
  private readonly now: () => number;

  constructor(private readonly options: RecommendationRankingServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  getActiveRankContext(): string {
    const settings = this.rankingSettings();
    const activeIndexId = this.activeEmbeddingIndexId();
    return activeIndexId
      ? rankContextFor({
          hasEmbedding: true,
          cocoonLevel: settings.cocoonLevel
        })
      : BASE_RANK_CONTEXT;
  }

  recalculateArticle(articleId: string): number {
    return this.recalculateArticles([articleId]);
  }

  recalculateArticles(articleIds: string[]): number {
    if (articleIds.length === 0) {
      return 0;
    }
    return this.writeScores(uniqueStrings(articleIds)).processed;
  }

  recalculateAll(): number {
    return this.writeScores().processed;
  }

  recalculateChunk(input: {
    cursor?: string | null;
    limit: number;
  }): RankingRecalculateChunkResult {
    const result = this.writeScores(undefined, {
      afterArticleId: input.cursor ?? null,
      limit: input.limit
    });
    return result;
  }

  explainArticle(articleId: string): RankExplanationResult | null {
    const rankContext = this.getActiveRankContext();
    const source = this.options.rankings.findExplanationSource({
      articleId,
      rankContext
    });
    if (!source) {
      return null;
    }

    const persisted = this.options.rankings.findExplanationPayload({
      articleId,
      rankContext
    });
    const clusterMatches = this.explanationClusterMatches(source);
    const persistedPayload = parseExplanationPayload(persisted?.payloadJson ?? null);

    return {
      articleId,
      status: source.rankingStatus,
      reasons: rankReasonsFor(source, clusterMatches, persistedPayload),
      components: persistedPayload?.components,
      generatedAt: source.rank?.calculatedAt ?? this.now()
    };
  }

  private explanationClusterMatches(
    source: ArticleRankExplanationSourceRow
  ): RankExplanationClusterMatch[] {
    const activeIndexId = this.activeEmbeddingIndexId();
    if (!activeIndexId || !source.vectorBlob || source.rankingStatus !== "ready") {
      return [];
    }

    const articleVector = fromVectorBlob(source.vectorBlob);
    return this.clusterVectorsFor(activeIndexId)
      .map((cluster, index) => ({
        cluster: cluster.cluster,
        similarity: cluster.polarity === "positive"
          ? cosineSimilarity(articleVector, cluster.vector)
          : -1,
        displayIndex: index + 1
      }))
      .filter(
        (match) =>
          match.cluster.polarity === "positive" &&
          match.similarity >= profileAlgorithmDefaults.positiveInterestMatchThreshold
      )
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, 3)
      .map((match) => ({
        id: match.cluster.id,
        polarity: match.cluster.polarity,
        label: null,
        displayIndex: match.displayIndex,
        weight: match.cluster.weight,
        sampleCount: match.cluster.sampleCount,
        similarity: match.similarity,
        lastMatchedAt: match.cluster.lastMatchedAt,
        updatedAt: match.cluster.updatedAt
      }));
  }

  private writeScores(
    articleIds?: string[],
    page?: { afterArticleId?: string | null; limit?: number }
  ): RankingRecalculateChunkResult {
    const paged = page?.limit !== undefined;
    const startingCursor = page?.afterArticleId ?? null;
    const chunkStartedAt = performance.now();
    const maxChunkDurationMs = Math.max(
      0,
      this.options.maxChunkDurationMs ?? DEFAULT_RANKING_CHUNK_TIME_BUDGET_MS
    );
    const timeBudgetExceeded = () =>
      paged &&
      maxChunkDurationMs > 0 &&
      performance.now() - chunkStartedAt >= maxChunkDurationMs;
    const timeBudgetPauseResult = (): RankingRecalculateChunkResult => ({
      processed: 0,
      nextCursor: startingCursor,
      paused: true,
      resumeAfter: this.now() + RANKING_TIME_BUDGET_RESUME_DELAY_MS,
      pauseReason: "time_budget"
    });
    const initialPause = paged ? this.pauseDecision(0, startingCursor) : null;
    if (initialPause?.pause) {
      return {
        processed: 0,
        nextCursor: startingCursor,
        paused: true,
        resumeAfter: initialPause.resumeAfter,
        pauseReason: "foreground"
      };
    }

    const activeIndexId = this.activeEmbeddingIndexId();
    const settings = this.rankingSettings();
    const activeRankContext = activeIndexId
      ? rankContextFor({
          hasEmbedding: true,
          cocoonLevel: settings.cocoonLevel
        })
      : BASE_RANK_CONTEXT;
    const candidateSet = this.listCandidatesForRanking({
      articleIds,
      afterArticleId: page?.afterArticleId,
      limit: page?.limit,
      embeddingIndexId: activeIndexId
    });
    if (timeBudgetExceeded()) {
      return timeBudgetPauseResult();
    }
    const candidates = candidateSet.candidates;
    const now = this.now();
    const clusters = activeIndexId ? this.clusterVectorsFor(activeIndexId) : [];
    if (timeBudgetExceeded()) {
      return timeBudgetPauseResult();
    }
    const recentIntent = activeIndexId ? this.recentIntentVectorsFor(activeIndexId) : [];
    // Shadow telemetry must not make a normal recommendation refresh do another
    // candidate-by-behaviour vector pass. Shadow evaluation belongs to an
    // explicitly scheduled diagnostic path; only an active module pays this
    // ranking cost.
    const recentBehavior =
      activeIndexId && settings.recentHistoryMode === "active"
        ? this.recentBehaviorVectorsFor(activeIndexId)
        : [];
    if (timeBudgetExceeded()) {
      return timeBudgetPauseResult();
    }
    const lexicalFeatures = this.lexicalFeaturesFor(candidates);
    if (timeBudgetExceeded()) {
      return timeBudgetPauseResult();
    }
    const duplicateFeatures = this.duplicateFeaturesFor(candidates);
    if (timeBudgetExceeded()) {
      return timeBudgetPauseResult();
    }
    const sourceFeatures = this.sourceFeaturesFor(candidates);
    if (timeBudgetExceeded()) {
      return timeBudgetPauseResult();
    }
    const ftrlModel = this.ftrlModel();
    const explorationBucketSamples =
      settings.learnedExplorationMode === "active"
        ? this.explorationBucketSamples()
        : new Map<string, number>();
    const duplicateStats = duplicateStatsFor(candidates, duplicateFeatures);
    const rerankWindowId = `${activeRankContext}:${now}`;
    const scored: Array<{ candidate: ArticleRankingCandidateRow; score: V2Score }> = [];
    const baseScores: UpsertArticleRankScoreInput[] = [];
    let processed = 0;
    let lastProcessedArticleId: string | null = startingCursor;
    let pauseDecision: RankingPauseDecision | null = null;
    let pauseReason: RankingRecalculateChunkResult["pauseReason"] | null = null;
    const activeRankContextInput: UpsertRankContextInput | null = activeIndexId
      ? {
        id: activeRankContext,
        algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
        featureSchemaVersion: RECOMMENDATION_FEATURE_SCHEMA_VERSION,
        embeddingIndexId: activeIndexId,
        cocoonLevel: settings.cocoonLevel,
        metadataJson: JSON.stringify({
          localLearning: {
            enabled: settings.localLearningEnabled,
            shadowMode: settings.localLearningShadowMode
          },
          exploration: {
            enabled: settings.explorationEnabled
          }
        }),
        now
      }
      : null;

    const pauseBeforeWriting = (): boolean => {
      if (!paged || processed <= 0 || pauseDecision !== null) {
        return false;
      }

      const decision = this.pauseDecision(processed, lastProcessedArticleId);
      if (decision.pause) {
        pauseDecision = decision;
        pauseReason = "foreground";
        return true;
      }
      if (timeBudgetExceeded()) {
        pauseDecision = {
          pause: true,
          resumeAfter: this.now() + RANKING_TIME_BUDGET_RESUME_DELAY_MS
        };
        pauseReason = "time_budget";
        return true;
      }
      return false;
    };

    for (const candidate of candidates) {
      if (paged && processed > 0) {
        const decision = this.pauseDecision(processed, lastProcessedArticleId);
        if (decision.pause) {
          pauseDecision = decision;
          pauseReason = "foreground";
          break;
        }
        if (timeBudgetExceeded()) {
          pauseDecision = {
            pause: true,
            resumeAfter: this.now() + RANKING_TIME_BUDGET_RESUME_DELAY_MS
          };
          pauseReason = "time_budget";
          break;
        }
      }

      const isRead = candidate.state.read || candidate.state.interactionStatus === "read";
      const baseScore = calculateBaselineRankScore({
        now,
        publishedAt: candidate.publishedAt,
        discoveredAt: candidate.discoveredAt,
        sourceWeight: candidate.sourceWeight,
        feedPositiveScore: candidate.feedPositiveScore,
        feedNegativeScore: candidate.feedNegativeScore,
        feedOpenRate: candidate.feedOpenRate,
        feedFavoriteRate: candidate.feedFavoriteRate,
        feedNotInterestedRate: candidate.feedNotInterestedRate,
        read: isRead,
        favorited: candidate.state.favorited,
        liked: candidate.state.liked,
        readLater: candidate.state.readLater,
        opened: candidate.state.interactionStatus === "opened",
        ignored: candidate.state.interactionStatus === "ignored",
        hidden: candidate.state.hidden,
        notInterested: candidate.state.notInterested,
        readingProgress: candidate.state.readingProgress,
        behaviorProjectionScore: candidate.behaviorProjectionScore,
        behaviorEventCount: candidate.behaviorEventCount
      });

      baseScores.push({
        articleId: candidate.articleId,
        ...baseScore
      });
      processed += 1;
      lastProcessedArticleId = candidate.articleId;

      if (!activeIndexId) {
        continue;
      }

      const baseV2Score = calculateV2Score({
        candidate,
        now,
        clusters,
        recentIntent,
        recentBehavior,
        settings,
        baseScore: baseScore.score,
        duplicateCount: duplicateStats.get(candidate.articleId) ?? 1,
        lexical: lexicalFeatures.get(candidate.articleId) ?? emptyLexicalFeature(),
        duplicate: duplicateFeatures.get(candidate.articleId) ?? emptyDuplicateFeature(),
        source: sourceFeatures.get(candidate.feedId) ?? emptySourceFeature(),
        ftrlModel
      });
      scored.push({ candidate, score: baseV2Score });
    }

    const scoredWithFatigue = (() => {
      if (settings.crossSessionFatigueMode !== "active") {
        return scored;
      }
      const exposureFatigue = this.exposureFatigueFor(scored, duplicateFeatures, now);
      return scored.map(({ candidate, score }) => ({
        candidate,
        score: applyExposureFatigue(
          score,
          candidate,
          duplicateFeatures.get(candidate.articleId) ?? emptyDuplicateFeature(),
          exposureFatigue,
          settings
        )
      }));
    })();
    const reranked = rerankCanonicalWindow(
      scoredWithFatigue,
      settings,
      MMR_WINDOW_LIMIT,
      explorationBucketSamples
    );
    const rankScores: UpsertArticleRankScoreInput[] = [];
    const explanations: UpsertArticleRankExplanationInput[] = [];
    for (const item of reranked) {
      rankScores.push({
        articleId: item.candidate.articleId,
        rankContext: activeRankContext,
        embeddingIndexId: activeIndexId,
        score: item.score.score,
        baseScore: item.score.baseScore,
        ftrlScore: item.score.ftrlScore,
        interestScore: item.score.semanticScore,
        semanticScore: item.score.semanticScore,
        bm25Score: item.score.bm25Score,
        sourceScore: item.score.sourceScore,
        freshnessScore: item.score.freshnessScore,
        stateScore: item.score.stateScore,
        diversityScore: item.score.diversityScore,
        penaltyScore: item.score.penaltyScore,
        negativePenalty: item.score.negativePenalty,
        duplicatePenalty: item.score.duplicatePenalty,
        diversityPenalty: item.score.diversityPenalty,
        explorationBonus: item.score.explorationBonus,
        explorationBucketKey: item.score.wasExploration ? item.score.explorationBucket : null,
        wasExploration: item.score.wasExploration,
        pendingEmbeddingScore: item.score.pendingEmbeddingScore,
        exposurePenalty: item.score.exposurePenalty,
        preRerankScore: item.score.preRerankScore,
        rerankScore: item.score.score,
        rerankPosition: item.position,
        rerankWindowId,
        algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
        featureSchemaVersion: RECOMMENDATION_FEATURE_SCHEMA_VERSION,
        cocoonLevel: settings.cocoonLevel,
        calculatedAt: now
      });
      explanations.push({
        articleId: item.candidate.articleId,
        rankContext: activeRankContext,
        embeddingIndexId: activeIndexId,
        payloadJson: JSON.stringify(
          explanationPayloadFor(item.candidate, item.score, settings, {
            origins: candidateSet.origins.get(item.candidate.articleId) ?? [],
            lexical: lexicalFeatures.get(item.candidate.articleId) ?? emptyLexicalFeature(),
            duplicate: duplicateFeatures.get(item.candidate.articleId) ?? emptyDuplicateFeature(),
            recentIntent
          })
        ),
        createdAt: now
      });
    }
    if (pauseBeforeWriting()) {
      return {
        processed: 0,
        nextCursor: startingCursor,
        paused: true,
        resumeAfter: pauseDecision?.pause ? pauseDecision.resumeAfter : this.now()
      };
    }
    this.writeRankingOutputs({
      rankContext: activeRankContextInput,
      baseScores,
      rankScores,
      explanations
    });

    const hasMoreAfterChunk = page?.limit !== undefined && candidates.length >= page.limit;
    if (paged && processed > 0 && pauseDecision === null && hasMoreAfterChunk) {
      const decision = this.pauseDecision(processed, lastProcessedArticleId);
      if (decision.pause) {
        pauseDecision = decision;
        pauseReason = "foreground";
      } else if (timeBudgetExceeded()) {
        pauseDecision = {
          pause: true,
          resumeAfter: this.now() + RANKING_TIME_BUDGET_RESUME_DELAY_MS
        };
        pauseReason = "time_budget";
      }
    }

    return {
      processed,
      nextCursor: pauseDecision?.pause
        ? lastProcessedArticleId
        : hasMoreAfterChunk
          ? candidates[candidates.length - 1]?.articleId ?? null
          : null,
      ...(pauseDecision?.pause
        ? {
            paused: true,
            resumeAfter: pauseDecision.resumeAfter,
            pauseReason: pauseReason ?? "foreground"
          }
        : {})
    };
  }

  private writeRankingOutputs(input: {
    rankContext?: UpsertRankContextInput | null;
    baseScores: UpsertArticleRankScoreInput[];
    rankScores: UpsertArticleRankScoreInput[];
    explanations: UpsertArticleRankExplanationInput[];
  }): void {
    const write = () => {
      if (input.rankContext) {
        this.options.rankings.upsertRankContext(input.rankContext);
      }
      for (const score of input.baseScores) {
        this.options.rankings.upsertBaseScore(score);
      }
      for (const score of input.rankScores) {
        this.options.rankings.upsertScore(score);
      }
      for (const explanation of input.explanations) {
        this.options.rankings.upsertExplanation(explanation);
      }
    };

    if (this.options.db) {
      this.options.db.transaction(write)();
      return;
    }

    write();
  }

  private pauseDecision(
    processed: number,
    lastArticleId: string | null
  ): RankingPauseDecision {
    return this.options.shouldPause?.({ processed, lastArticleId }) ?? { pause: false };
  }

  private activeEmbeddingIndexId(): string | null {
    return this.options.embeddings?.findActiveProviderWithIndex()?.index.id ?? null;
  }

  private listCandidatesForRanking(input: {
    articleIds?: string[];
    afterArticleId?: string | null;
    embeddingIndexId?: string | null;
    limit?: number;
  }): { candidates: ArticleRankingCandidateRow[]; origins: Map<string, CandidateOrigin[]> } {
    const db = this.options.db;
    if (!db || input.articleIds || input.afterArticleId || input.limit !== undefined) {
      const candidates = this.options.rankings.listCandidates(input);
      return {
        candidates,
        origins: new Map(candidates.map((candidate) => [candidate.articleId, ["explicit"]]))
      };
    }

    const origins = new Map<string, Set<CandidateOrigin>>();
    const add = (origin: CandidateOrigin, rows: Array<{ articleId: string }>) => {
      for (const row of rows) {
        const set = origins.get(row.articleId) ?? new Set<CandidateOrigin>();
        set.add(origin);
        origins.set(row.articleId, set);
      }
    };

    const now = this.now();
    const eligibleWhere = `
      a.deleted_at is null
      and a.status != 'deleted'
      and f.deleted_at is null
      and f.enabled = 1
      and s.hidden_at is null
      and s.not_interested_at is null
      and s.read_at is null
      and coalesce(s.reading_progress, 0) < 0.9
      and not (
        exists (
          select 1
          from behavior_events ignored
          where ignored.article_id = a.id
            and ignored.event_type = 'impression'
            and ignored.event_weight < 0
        )
        and coalesce(s.reading_progress, 0) = 0
        and s.last_opened_at is null
        and s.favorited_at is null
        and s.liked_at is null
        and s.read_later_at is null
      )
    `;

    add(
      "must_include",
      db
        .prepare(
          `
            select a.id as articleId
            from articles a
            join feeds f on f.id = a.feed_id
            left join article_states s on s.article_id = a.id
            left join article_embeddings ae
              on ae.article_id = a.id
             and ae.embedding_index_id = ?
            where ${eligibleWhere}
              and (
                s.favorited_at is not null
                or s.read_later_at is not null
                or (s.last_opened_at is not null and s.read_at is null and coalesce(s.reading_progress, 0) < 0.9)
                or (ae.article_id is null and coalesce(a.published_at, a.discovered_at) >= ?)
                or abs(f.source_weight) >= 0.75
              )
            order by coalesce(a.published_at, a.discovered_at) desc, a.id desc
            limit 300
          `
        )
        .all(input.embeddingIndexId ?? "", now - 72 * 3_600_000) as Array<{ articleId: string }>
    );

    add(
      "recency",
      db
        .prepare(
          `
            select a.id as articleId
            from articles a
            join feeds f on f.id = a.feed_id
            left join article_states s on s.article_id = a.id
            where ${eligibleWhere}
              and coalesce(a.published_at, a.discovered_at) >= ?
            order by coalesce(a.published_at, a.discovered_at) desc, a.id desc
            limit 500
          `
        )
        .all(now - 14 * 86_400_000) as Array<{ articleId: string }>
    );

    add("lexical", this.lexicalCandidateRows(500));
    add("diversity", this.diversityCandidateRows(200));
    if (input.embeddingIndexId) {
      add("semantic", this.semanticCandidateRows(input.embeddingIndexId, 400));
    }

    const mustInclude = Array.from(origins.entries())
      .filter(([, set]) => set.has("must_include"))
      .map(([articleId]) => articleId);
    const other = Array.from(origins.keys()).filter((articleId) => !mustInclude.includes(articleId));
    const articleIds = [...mustInclude, ...other.slice(0, MMR_WINDOW_LIMIT)];
    const candidates = this.options.rankings.listCandidates({
      articleIds,
      embeddingIndexId: input.embeddingIndexId
    });

    return {
      candidates,
      origins: new Map(
        candidates.map((candidate) => [
          candidate.articleId,
          Array.from(origins.get(candidate.articleId) ?? ["explicit"])
        ])
      )
    };
  }

  private lexicalCandidateRows(limit: number): Array<{ articleId: string }> {
    const db = this.options.db;
    if (!db) {
      return [];
    }
    const terms = this.profileTerms({
      polarity: "positive",
      scopes: ["recent", "long"],
      limit: 32
    });
    const query = sanitizeFtsQuery(terms.map((term) => term.term).join(" "));
    if (!query) {
      return [];
    }
    return db
      .prepare(
        `
          select article_id as articleId
          from article_fts
          where article_fts match ?
          order by bm25(article_fts, 5.0, 2.0, 0.6)
          limit ?
        `
      )
      .all(query, Math.max(1, Math.min(limit, 1000))) as Array<{ articleId: string }>;
  }

  private semanticCandidateRows(embeddingIndexId: string, limit: number): Array<{ articleId: string }> {
    const db = this.options.db;
    if (!db) {
      return [];
    }
    const vectors = [
      ...representativeFamilyVectors(
        this.clusterVectorsFor(embeddingIndexId).filter((cluster) => cluster.polarity === "positive"),
        8
      ),
      ...this.recentIntentVectorsFor(embeddingIndexId)
        .filter((intent) => intent.polarity === "positive")
        .slice(0, 2)
        .map((intent) => intent.vector)
    ];
    if (vectors.length === 0) {
      return [];
    }
    const rows = db
      .prepare(
        `
          select
            a.id as articleId,
            ae.vector_blob as vectorBlob
          from articles a
          join feeds f on f.id = a.feed_id
          join article_embeddings ae
            on ae.article_id = a.id
           and ae.embedding_index_id = ?
          left join article_states s on s.article_id = a.id
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and s.hidden_at is null
            and s.not_interested_at is null
          order by coalesce(a.published_at, a.discovered_at) desc, a.id desc
          limit 1500
        `
      )
      .all(embeddingIndexId) as Array<{ articleId: string; vectorBlob: Buffer }>;

    return rows
      .map((row) => {
        const vector = fromVectorBlob(row.vectorBlob);
        return {
          articleId: row.articleId,
          score: Math.max(...vectors.map((profileVector) => cosineSimilarity(vector, profileVector)))
        };
      })
      .filter((row) => row.score >= profileAlgorithmDefaults.positiveInterestMatchThreshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((row) => ({ articleId: row.articleId }));
  }

  private diversityCandidateRows(limit: number): Array<{ articleId: string }> {
    const db = this.options.db;
    if (!db) {
      return [];
    }
    return db
      .prepare(
        `
          select a.id as articleId
          from articles a
          join feeds f on f.id = a.feed_id
          left join article_states s on s.article_id = a.id
          left join article_behavior_summaries abs on abs.article_id = a.id
          where a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
            and f.enabled = 1
            and s.hidden_at is null
            and s.not_interested_at is null
            and abs.article_id is null
          order by coalesce(a.published_at, a.discovered_at) desc, a.id desc
          limit ?
        `
      )
      .all(Math.max(1, Math.min(limit, 500))) as Array<{ articleId: string }>;
  }

  private profileTerms(input: {
    polarity: "positive" | "negative";
    scopes: Array<"long" | "recent">;
    limit: number;
  }): Array<{ term: string; polarity: "positive" | "negative"; scope: "long" | "recent"; weight: number }> {
    const db = this.options.db;
    if (!db || input.scopes.length === 0) {
      return [];
    }
    return db
      .prepare(
        `
          select
            term,
            polarity,
            scope,
            weight
          from profile_terms
          where polarity = ?
            and scope in (${input.scopes.map(() => "?").join(", ")})
          order by weight desc, evidence_count desc, term
          limit ?
        `
      )
      .all(input.polarity, ...input.scopes, input.limit) as Array<{
      term: string;
      polarity: "positive" | "negative";
      scope: "long" | "recent";
      weight: number;
    }>;
  }

  private lexicalFeaturesFor(
    candidates: ArticleRankingCandidateRow[]
  ): Map<string, LexicalFeature> {
    const db = this.options.db;
    const result = new Map<string, LexicalFeature>();
    for (const candidate of candidates) {
      result.set(candidate.articleId, emptyLexicalFeature());
    }
    if (!db || candidates.length === 0) {
      return result;
    }

    const ids = candidates.map((candidate) => candidate.articleId);
    const positiveLong = this.profileTerms({ polarity: "positive", scopes: ["long"], limit: 24 });
    const positiveRecent = this.profileTerms({ polarity: "positive", scopes: ["recent"], limit: 24 });
    const negativeTerms = this.profileTerms({
      polarity: "negative",
      scopes: ["long", "recent"],
      limit: 32
    });
    const applyBm25 = (
      terms: Array<{ term: string; polarity: "positive" | "negative"; scope: "long" | "recent"; weight: number }>,
      field: "bm25Positive" | "bm25Recent"
    ) => {
      const query = sanitizeFtsQuery(terms.map((term) => term.term).join(" "));
      if (!query) {
        return;
      }
      const rows = db
        .prepare(
          `
            select article_id as articleId, bm25(article_fts, 5.0, 2.0, 0.6) as rank
            from article_fts
            where article_fts match ?
              and article_id in (${ids.map(() => "?").join(", ")})
            order by rank
          `
        )
        .all(query, ...ids) as Array<{ articleId: string; rank: number }>;
      for (const row of rows) {
        const feature = result.get(row.articleId);
        if (!feature) {
          continue;
        }
        feature[field] = Math.max(feature[field], 1 / (1 + Math.max(0, row.rank)));
      }
    };
    applyBm25(positiveLong, "bm25Positive");
    applyBm25(positiveRecent, "bm25Recent");

    const allTerms = [...positiveLong, ...positiveRecent, ...negativeTerms];
    for (const candidate of candidates) {
      const feature = result.get(candidate.articleId) ?? emptyLexicalFeature();
      const title = normalizeForTermMatch(candidate.title);
      const text = normalizeForTermMatch(
        `${candidate.title} ${candidate.summary ?? ""} ${(candidate.contentText ?? "").slice(0, 2000)}`
      );
      let positiveWeight = 0;
      let negativeWeight = 0;
      const matched: LexicalFeature["matchedTerms"] = [];
      for (const term of allTerms) {
        const normalized = normalizeForTermMatch(term.term);
        if (!normalized || !text.includes(normalized)) {
          continue;
        }
        matched.push({ term: term.term, polarity: term.polarity, scope: term.scope });
        if (term.polarity === "positive") {
          positiveWeight += term.weight;
          if (title.includes(normalized)) {
            feature.titleKeywordMatch = Math.max(feature.titleKeywordMatch, 1);
          }
        } else {
          negativeWeight += term.weight;
        }
      }
      feature.positiveOverlap = clamp(Math.log1p(positiveWeight) / Math.log1p(20), 0, 1);
      feature.negativeOverlap = clamp(Math.log1p(negativeWeight) / Math.log1p(20), 0, 1);
      feature.matchedTerms = matched.slice(0, 12);
      result.set(candidate.articleId, feature);
    }

    return result;
  }

  private recentIntentVectorsFor(embeddingIndexId: string): RecentIntentVector[] {
    const db = this.options.db;
    if (!db) {
      return [];
    }
    return (
      db
        .prepare(
          `
            select
              polarity,
              centroid_vector_blob as centroidVectorBlob,
              weight,
              event_count as eventCount,
              updated_at as updatedAt
            from recent_intent_profiles
            where embedding_index_id = ?
              and centroid_vector_blob is not null
            order by weight desc, updated_at desc
          `
        )
        .all(embeddingIndexId) as Array<{
        polarity: InterestClusterPolarity;
        centroidVectorBlob: Buffer;
        weight: number;
        eventCount: number;
        updatedAt: number;
      }>
    ).map((row) => ({
      polarity: row.polarity,
      vector: fromVectorBlob(row.centroidVectorBlob),
      weight: row.weight,
      eventCount: row.eventCount,
      updatedAt: row.updatedAt
    }));
  }

  private recentBehaviorVectorsFor(embeddingIndexId: string): RecentBehaviorVector[] {
    const db = this.options.db;
    if (!db) {
      return [];
    }
    const rows = db
      .prepare(
        `
          select be.event_type as eventType, be.metadata_json as metadataJson, be.created_at as createdAt,
            ae.vector_blob as vectorBlob
          from behavior_events be
          join article_embeddings ae on ae.article_id = be.article_id and ae.embedding_index_id = ?
          where ae.vector_blob is not null
            and (
              be.event_type in ('favorite', 'like', 'read_later', 'read_complete', 'hide', 'not_interested')
              or (be.event_type = 'read_progress' and coalesce(json_extract(be.metadata_json, '$.progress'), 0) >= 0.75)
            )
          order by be.created_at desc, be.id desc
          limit 50
        `
      )
      .all(embeddingIndexId) as Array<{
      eventType: string;
      metadataJson: string | null;
      createdAt: number;
      vectorBlob: Buffer;
    }>;
    return rows.map((row) => ({
      polarity: row.eventType === "hide" || row.eventType === "not_interested" ? "negative" : "positive",
      vector: fromVectorBlob(row.vectorBlob),
      weight: recentBehaviorWeight(row.eventType, row.metadataJson),
      createdAt: row.createdAt
    }));
  }

  private exposureFatigueFor(
    scored: Array<{ candidate: ArticleRankingCandidateRow; score: V2Score }>,
    duplicateFeatures: Map<string, DuplicateFeature>,
    now: number
  ): ExposureFatigueCounts {
    const result: ExposureFatigueCounts = {
      feeds: new Map(),
      families: new Map(),
      duplicateGroups: new Map()
    };
    const db = this.options.db;
    if (!db || scored.length === 0) {
      return result;
    }
    const feedIds = uniqueStrings(scored.map(({ candidate }) => candidate.feedId));
    const familyIds = uniqueStrings(
      scored.map(({ score }) => score.primaryFamilyId).filter((id): id is string => id !== null)
    );
    const duplicateGroupIds = uniqueStrings(
      scored
        .map(({ candidate }) => duplicateFeatures.get(candidate.articleId)?.groupId ?? null)
        .filter((id): id is string => id !== null)
    );
    const cutoff = now - 7 * 86_400_000;
    this.collectExposureCounts("feed_id", feedIds, cutoff, result.feeds);
    this.collectExposureCounts("interest_family_id", familyIds, cutoff, result.families);
    this.collectExposureCounts("duplicate_group_id", duplicateGroupIds, cutoff, result.duplicateGroups);
    return result;
  }

  private collectExposureCounts(
    column: "feed_id" | "interest_family_id" | "duplicate_group_id",
    ids: string[],
    cutoff: number,
    target: Map<string, number>
  ): void {
    const db = this.options.db;
    if (!db || ids.length === 0) {
      return;
    }
    const rows = db
      .prepare(
        `
          select ${column} as id, count(*) as count
          from recommendation_exposures
          where exposed_at >= ? and ${column} in (${ids.map(() => "?").join(", ")})
          group by ${column}
        `
      )
      .all(cutoff, ...ids) as Array<{ id: string; count: number }>;
    for (const row of rows) {
      target.set(row.id, row.count);
    }
  }

  private explorationBucketSamples(): Map<string, number> {
    const db = this.options.db;
    if (!db) {
      return new Map();
    }
    const rows = db
      .prepare(`select bucket_key as bucketKey, alpha, beta from exploration_buckets`)
      .all() as Array<{ bucketKey: string; alpha: number; beta: number }>;
    return new Map(rows.map((row) => [row.bucketKey, sampleBeta(row.alpha, row.beta)]));
  }

  private duplicateFeaturesFor(
    candidates: ArticleRankingCandidateRow[]
  ): Map<string, DuplicateFeature> {
    const db = this.options.db;
    const result = new Map<string, DuplicateFeature>();
    for (const candidate of candidates) {
      result.set(candidate.articleId, emptyDuplicateFeature());
    }
    if (!db || candidates.length === 0) {
      return result;
    }
    const ids = candidates.map((candidate) => candidate.articleId);
    const rows = db
      .prepare(
        `
          select
            dgm.article_id as articleId,
            dgm.duplicate_group_id as groupId,
            dg.article_count as groupSize,
            dgm.reason,
            dgm.confidence,
            dg.representative_article_id as representativeArticleId
          from duplicate_group_members dgm
          join duplicate_groups dg on dg.id = dgm.duplicate_group_id
          where dgm.article_id in (${ids.map(() => "?").join(", ")})
          order by dg.article_count desc, dgm.confidence desc
        `
      )
      .all(...ids) as Array<{
      articleId: string;
      groupId: string;
      groupSize: number;
      reason: string;
      confidence: number;
      representativeArticleId: string | null;
    }>;
    for (const row of rows) {
      if (result.get(row.articleId)?.groupId) {
        continue;
      }
      result.set(row.articleId, row);
    }
    return result;
  }

  private sourceFeaturesFor(
    candidates: ArticleRankingCandidateRow[]
  ): Map<string, SourceFeature> {
    const db = this.options.db;
    const feedIds = uniqueStrings(candidates.map((candidate) => candidate.feedId));
    const result = new Map<string, SourceFeature>();
    if (!db || feedIds.length === 0) {
      return result;
    }
    const rows = db
      .prepare(
        `
          select
            feed_id as feedId,
            clear_signal_count as clearSignalCount,
            smoothed_positive_rate as smoothedPositiveRate,
            source_confidence as sourceConfidence
          from feed_stats
          where feed_id in (${feedIds.map(() => "?").join(", ")})
        `
      )
      .all(...feedIds) as Array<{
      feedId: string;
      clearSignalCount: number;
      smoothedPositiveRate: number;
      sourceConfidence: number;
    }>;
    for (const row of rows) {
      result.set(row.feedId, row);
    }
    return result;
  }

  private ftrlModel(): FtrlModel | null {
    const db = this.options.db;
    if (!db) {
      return null;
    }
    const version = db
      .prepare(
        `
          select
            id,
            status,
            sample_count as sampleCount,
            blend_alpha as blendAlpha
          from rank_model_versions
          where status in ('active', 'shadow')
          order by case when status = 'active' then 0 else 1 end, updated_at desc
          limit 1
        `
      )
      .get() as
      | { id: string; status: FtrlModel["status"]; sampleCount: number; blendAlpha: number }
      | undefined;
    if (!version) {
      return null;
    }
    const rows = db
      .prepare(
        `
          select feature_name as featureName, weight
          from rank_model_weights
          where model_version_id = ?
        `
      )
      .all(version.id) as Array<{ featureName: string; weight: number }>;
    return {
      status: version.status,
      sampleCount: version.sampleCount,
      blendAlpha: version.blendAlpha,
      weights: new Map(rows.map((row) => [row.featureName, row.weight]))
    };
  }

  private rankingSettings(): RankingSettingsSnapshot {
    return (
      this.options.getRankingSettings?.() ?? {
        cocoonLevel: 5,
        localLearningEnabled: true,
        localLearningShadowMode: false,
        explorationEnabled: true,
        evaluationEnabled: false
      }
    );
  }

  private clusterVectorsFor(embeddingIndexId: string): ClusterVector[] {
    if (!this.options.profiles) {
      return [];
    }

    const clusters = this.options.profiles.listClusters({ embeddingIndexId });
    const familyMap = this.clusterFamilyMap(clusters.map((cluster) => cluster.id));
    const supportMap = this.clusterSupportMap(clusters.map((cluster) => cluster.id));
    return clusters.map((cluster) => {
      const family = familyMap.get(cluster.id);
      const support = supportMap.get(cluster.id);
      const fallbackMaturity = clusterMaturityFor({
        supportArticleCount: support?.supportArticleCount ?? 0,
        sourceCount: support?.sourceCount ?? 0,
        sampleCount: cluster.sampleCount
      });
      const familyId = family?.familyId ?? cluster.id;
      const familyMaturity = semanticFamilyMaturity({
        maturity: family?.maturity ?? fallbackMaturity,
        dominanceRatio: family?.dominanceRatio ?? 0,
        clusterCount: family?.clusterCount ?? 1
      });
      return {
        cluster,
        polarity: cluster.polarity,
        vector: fromVectorBlob(cluster.centroidVectorBlob),
        weightNorm: clamp(
          Math.log1p(cluster.weight) / Math.log1p(profileAlgorithmDefaults.maxClusterWeight),
          0,
          1
        ),
        familyId,
        familyLabel: family?.displayLabel ?? cluster.label,
        familyMaturity,
        familyDominanceRatio: clamp(family?.dominanceRatio ?? 0, 0, 1),
        familyClusterCount: family?.clusterCount ?? 1,
        supportArticleCount: family?.supportArticleCount ?? support?.supportArticleCount ?? 0,
        sourceCount: family?.sourceCount ?? support?.sourceCount ?? 0
      };
    });
  }

  private clusterFamilyMap(clusterIds: string[]): Map<string, {
    familyId: string;
    displayLabel: string;
    maturity: number;
    dominanceRatio: number;
    clusterCount: number;
    supportArticleCount: number;
    sourceCount: number;
  }> {
    const db = this.options.db;
    if (!db || clusterIds.length === 0) {
      return new Map();
    }

    const rows = db
      .prepare(
        `
          select
            m.cluster_id as clusterId,
            f.id as familyId,
            f.display_label as displayLabel,
            f.maturity,
            f.dominance_ratio as dominanceRatio,
            f.cluster_count as clusterCount,
            f.support_article_count as supportArticleCount,
            f.source_count as sourceCount
          from interest_cluster_family_members m
          join interest_families f on f.id = m.family_id
          where m.cluster_id in (${clusterIds.map(() => "?").join(", ")})
        `
      )
      .all(...clusterIds) as Array<{
      clusterId: string;
      familyId: string;
      displayLabel: string;
      maturity: number;
      dominanceRatio: number;
      clusterCount: number;
      supportArticleCount: number;
      sourceCount: number;
    }>;

    return new Map(rows.map((row) => [row.clusterId, row]));
  }

  private clusterSupportMap(clusterIds: string[]): Map<string, {
    supportArticleCount: number;
    sourceCount: number;
  }> {
    const db = this.options.db;
    if (!db || clusterIds.length === 0) {
      return new Map();
    }

    const rows = db
      .prepare(
        `
          select
            ice.cluster_id as clusterId,
            count(distinct ice.article_id) as supportArticleCount,
            count(distinct coalesce(ice.feed_id_snapshot, a.feed_id, ice.feed_title_snapshot, '')) as sourceCount
          from interest_cluster_evidence ice
          left join articles a on a.id = ice.article_id
          where ice.cluster_id in (${clusterIds.map(() => "?").join(", ")})
          group by ice.cluster_id
        `
      )
      .all(...clusterIds) as Array<{
      clusterId: string;
      supportArticleCount: number;
      sourceCount: number;
    }>;

    return new Map(rows.map((row) => [row.clusterId, row]));
  }
}

export class BaselineRankingService extends RecommendationRankingService {
  constructor(options: Omit<RecommendationRankingServiceOptions, "embeddings" | "profiles">) {
    super(options);
  }
}

const MIN_REASON_SCORE = 0.001;
const MAX_REASONS = 5;

function interestMatchesFor(
  candidate: ArticleRankingCandidateRow,
  clusters: ClusterVector[]
): {
  positiveInterestMatch: number;
  negativeInterestMatch: number;
  negativeSimilarity: number;
  primaryFamilyId: string | null;
  primaryFamilyLabel: string | null;
  primaryClusterId: string | null;
  primaryClusterLabel: string | null;
  primaryFamilyMaturity: number;
  primaryFamilyDominanceRatio: number;
  matchedFamilyCount: number;
} {
  if (!candidate.vectorBlob || clusters.length === 0) {
    return {
      positiveInterestMatch: 0,
      negativeInterestMatch: 0,
      negativeSimilarity: 0,
      primaryFamilyId: null,
      primaryFamilyLabel: null,
      primaryClusterId: null,
      primaryClusterLabel: null,
      primaryFamilyMaturity: 0,
      primaryFamilyDominanceRatio: 0,
      matchedFamilyCount: 0
    };
  }

  const articleVector = fromVectorBlob(candidate.vectorBlob);
  const positiveByFamily = new Map<string, {
    value: number;
    similarity: number;
    clusterId: string;
    clusterLabel: string | null;
    familyLabel: string | null;
    familyMaturity: number;
    familyDominanceRatio: number;
  }>();
  const negativeByFamily = new Map<string, { value: number; similarity: number }>();

  for (const cluster of clusters) {
    const similarity = cosineSimilarity(articleVector, cluster.vector);
    const maturity = cluster.familyMaturity;
    const weightedMatch = Math.max(0, similarity) * cluster.weightNorm * maturity;

    if (cluster.polarity === "positive") {
      if (similarity >= profileAlgorithmDefaults.positiveInterestMatchThreshold) {
        const existing = positiveByFamily.get(cluster.familyId);
        if (!existing || weightedMatch > existing.value) {
          positiveByFamily.set(cluster.familyId, {
            value: weightedMatch,
            similarity,
            clusterId: cluster.cluster.id,
            clusterLabel: cluster.cluster.label ?? cluster.familyLabel,
            familyLabel: cluster.familyLabel,
            familyMaturity: cluster.familyMaturity,
            familyDominanceRatio: cluster.familyDominanceRatio
          });
        }
      }
    } else {
      const negativeValue = Math.max(0, similarity) * cluster.weightNorm * Math.max(0.65, maturity);
      const existing = negativeByFamily.get(cluster.familyId);
      if (!existing || negativeValue > existing.value) {
        negativeByFamily.set(cluster.familyId, { value: negativeValue, similarity });
      }
    }
  }

  const positive = Array.from(positiveByFamily.entries()).map(([familyId, match]) => ({
    familyId,
    ...match
  }));
  const negative = Array.from(negativeByFamily.values());
  const primary = positive
    .slice()
    .sort((left, right) => right.value - left.value || right.similarity - left.similarity)[0];
  const positiveInterestMatch = topKWeightedAverage(positive, 4);
  const negativeInterestMatch = topKWeightedAverage(negative, 3);
  const negativeSimilarity = Math.max(0, ...negative.map((item) => item.similarity));

  return {
    positiveInterestMatch,
    negativeInterestMatch,
    negativeSimilarity,
    primaryFamilyId: primary?.familyId ?? null,
    primaryFamilyLabel: primary?.familyLabel ?? null,
    primaryClusterId: primary?.clusterId ?? null,
    primaryClusterLabel: primary?.clusterLabel ?? null,
    primaryFamilyMaturity: primary?.familyMaturity ?? 0,
    primaryFamilyDominanceRatio: primary?.familyDominanceRatio ?? 0,
    matchedFamilyCount: positive.length
  };
}

function topKWeightedAverage(matches: Array<{ value: number }>, k: number): number {
  const top = matches
    .filter((match) => Number.isFinite(match.value) && match.value > 0)
    .sort((left, right) => right.value - left.value)
    .slice(0, k);
  if (top.length === 0) {
    return 0;
  }
  const weightedSum = top.reduce((sum, match, index) => sum + match.value / (index + 1), 0);
  const divisor = top.reduce((sum, _match, index) => sum + 1 / (index + 1), 0);
  return divisor > 0 ? weightedSum / divisor : 0;
}

function representativeFamilyVectors(clusters: ClusterVector[], limit: number): number[][] {
  const bestByFamily = new Map<string, ClusterVector>();
  for (const cluster of clusters) {
    const existing = bestByFamily.get(cluster.familyId);
    if (!existing || cluster.weightNorm > existing.weightNorm) {
      bestByFamily.set(cluster.familyId, cluster);
    }
  }
  return Array.from(bestByFamily.values())
    .sort(
      (left, right) =>
        right.weightNorm * right.familyMaturity -
        left.weightNorm * left.familyMaturity ||
        right.cluster.updatedAt - left.cluster.updatedAt
    )
    .slice(0, limit)
    .map((cluster) => cluster.vector);
}

function clusterMaturityFor(input: {
  supportArticleCount: number;
  sourceCount: number;
  sampleCount: number;
}): number {
  const supportArticleCount =
    input.supportArticleCount > 0
      ? input.supportArticleCount
      : Math.min(input.sampleCount, 2);
  const value = clamp(
    0.24 +
      Math.min(supportArticleCount, 6) * 0.1 +
      Math.min(input.sourceCount, 4) * 0.08,
    0.24,
    1
  );
  return supportArticleCount <= 1 ? Math.min(value, 0.38) : value;
}

function semanticFamilyMaturity(input: {
  maturity: number;
  dominanceRatio: number;
  clusterCount: number;
}): number {
  let multiplier = 1;
  if (input.clusterCount >= 5 && input.dominanceRatio >= 0.62) {
    multiplier = 0.55;
  } else if (input.clusterCount >= 5 && input.dominanceRatio >= 0.45) {
    multiplier = 0.75;
  }
  return clamp(input.maturity * multiplier, 0.2, 1);
}

function recentIntentMatchesFor(
  candidate: ArticleRankingCandidateRow,
  recentIntent: RecentIntentVector[]
): { positive: number; negative: number } {
  if (!candidate.vectorBlob || recentIntent.length === 0) {
    return { positive: 0, negative: 0 };
  }
  const articleVector = fromVectorBlob(candidate.vectorBlob);
  let positive = 0;
  let negative = 0;
  for (const intent of recentIntent) {
    const strength = clamp(Math.log1p(intent.weight) / Math.log1p(20), 0, 1);
    const similarity = Math.max(0, cosineSimilarity(articleVector, intent.vector)) * strength;
    if (intent.polarity === "positive") {
      positive = Math.max(positive, similarity);
    } else {
      negative = Math.max(negative, similarity);
    }
  }
  return { positive, negative };
}

function recentBehaviorMatchesFor(
  candidate: ArticleRankingCandidateRow,
  recentBehavior: RecentBehaviorVector[],
  now: number
): { positive: number; negative: number } {
  if (!candidate.vectorBlob || recentBehavior.length === 0) {
    return { positive: 0, negative: 0 };
  }
  const vector = fromVectorBlob(candidate.vectorBlob);
  let positive = 0;
  let negative = 0;
  for (const behavior of recentBehavior) {
    const ageHours = Math.max(0, (now - behavior.createdAt) / 3_600_000);
    const value =
      Math.max(0, cosineSimilarity(vector, behavior.vector)) *
      behavior.weight *
      Math.pow(0.5, ageHours / 24);
    if (behavior.polarity === "positive") {
      positive = Math.max(positive, value);
    } else {
      negative = Math.max(negative, value);
    }
  }
  return { positive: clamp(positive, 0, 1), negative: clamp(negative, 0, 1) };
}

function recentBehaviorWeight(eventType: string, metadataJson: string | null): number {
  if (eventType === "like" || eventType === "favorite") return 1;
  if (eventType === "read_later" || eventType === "read_complete") return 0.85;
  if (eventType === "hide" || eventType === "not_interested") return 1;
  if (eventType === "read_progress") {
    try {
      const metadata = JSON.parse(metadataJson ?? "{}") as { progress?: unknown };
      return typeof metadata.progress === "number" && metadata.progress >= 0.9 ? 0.8 : 0.55;
    } catch {
      return 0.55;
    }
  }
  return 0.5;
}

function ftrlFeaturesFor(input: {
  semanticScore: number;
  negativePenalty: number;
  bm25Score: number;
  keywordNegativePenalty: number;
  freshness: number;
  pendingEmbeddingScore: number;
  sourceScore: number;
  stateScore: number;
  duplicatePenalty: number;
  exposurePenalty: number;
  explorationBonus: number;
  ageHours: number;
  candidate: ArticleRankingCandidateRow;
  source: SourceFeature;
}): Map<string, number> {
  return new Map(
    Object.entries({
      semantic: clamp(input.semanticScore / 0.68, 0, 1),
      semantic_negative: clamp(Math.abs(input.negativePenalty) / 0.5, 0, 1),
      bm25: clamp(input.bm25Score / 0.14, 0, 1),
      keyword_negative: clamp(Math.abs(input.keywordNegativePenalty) / 0.12, 0, 1),
      freshness: clamp(input.freshness / 0.2, 0, 1),
      source: clamp((input.sourceScore + 0.14) / 0.28, 0, 1),
      source_confidence: clamp(input.source.sourceConfidence, 0, 1),
      state: clamp((input.stateScore + 0.12) / 0.36, 0, 1),
      pending_embedding: input.pendingEmbeddingScore > 0 ? 1 : 0,
      duplicate_penalty: clamp(Math.abs(input.duplicatePenalty) / 0.2, 0, 1),
      exposure_penalty: input.exposurePenalty < 0 ? 1 : 0,
      exploration_bonus: input.explorationBonus > 0 ? 1 : 0,
      age_bucket_recent: input.ageHours <= 24 ? 1 : 0,
      age_bucket_week: input.ageHours > 24 && input.ageHours <= 168 ? 1 : 0,
      favorite: input.candidate.state.favorited ? 1 : 0,
      read_later: input.candidate.state.readLater ? 1 : 0,
      opened_unfinished:
        input.candidate.state.interactionStatus === "opened" && !input.candidate.state.read ? 1 : 0
    })
  );
}

function ftrlPredict(model: FtrlModel, features: Map<string, number>): number {
  let logit = 0;
  for (const [name, value] of features) {
    logit += (model.weights.get(name) ?? 0) * value;
  }
  return clamp(1 / (1 + Math.exp(-logit)), 0, 1);
}

function rankContextFor(input: { hasEmbedding: boolean; cocoonLevel: number }): string {
  return `${RECOMMENDATION_ALGORITHM_VERSION}:${input.hasEmbedding ? "embedding" : "base"}:cocoon_${input.cocoonLevel}:schema_${RECOMMENDATION_FEATURE_SCHEMA_VERSION}`;
}

function cocoonParameters(level: number) {
  const c = clamp((level - 1) / 9, 0, 1);
  return {
    personalizationStrength: lerp(0.65, 1.25, c),
    diversityStrength: lerp(1.25, 0.55, c),
    mmrLambda: lerp(0.55, 0.88, c),
    explorationRatio: lerp(0.08, 0.005, c),
    sourceCap: Math.round(lerp(3, 12, c)),
    familyCapTop20: Math.round(lerp(4, 7, c)),
    familyCapTop50: Math.round(lerp(8, 14, c)),
    familyDiversityStrength: lerp(1.35, 0.85, c),
    pendingEmbeddingFloor: lerp(0.12, 0.03, c),
    freshnessWeight: lerp(1.15, 0.75, c),
    negativeSemanticStrength: lerp(0.75, 1.15, c),
    recentIntentStrength: lerp(0.75, 1.2, c),
    keywordProfileStrength: lerp(0.75, 1.15, c)
  };
}

function calculateV2Score(input: {
  candidate: ArticleRankingCandidateRow;
  now: number;
  clusters: ClusterVector[];
  recentIntent: RecentIntentVector[];
  recentBehavior: RecentBehaviorVector[];
  settings: RankingSettingsSnapshot;
  baseScore: number;
  duplicateCount: number;
  lexical: LexicalFeature;
  duplicate: DuplicateFeature;
  source: SourceFeature;
  ftrlModel: FtrlModel | null;
}): V2Score {
  const params = cocoonParameters(input.settings.cocoonLevel);
  const candidate = input.candidate;
  const ageHours = Math.max(
    0,
    (input.now - (candidate.publishedAt ?? candidate.discoveredAt)) / 3_600_000
  );
  const matches = interestMatchesFor(candidate, input.clusters);
  const recentMatches = recentIntentMatchesFor(candidate, input.recentIntent);
  const recentBehaviorMatches = recentBehaviorMatchesFor(candidate, input.recentBehavior, input.now);
  const recentHistoryScore = clamp(
    recentBehaviorMatches.positive * 0.08 - recentBehaviorMatches.negative * 0.08,
    -0.08,
    0.08
  );
  const activeRecentHistoryScore = input.settings.recentHistoryMode === "active" ? recentHistoryScore : 0;
  const semanticScore = clamp(
    matches.positiveInterestMatch * 0.42 * params.personalizationStrength +
      recentMatches.positive * 0.18 * params.recentIntentStrength,
    0,
    0.68
  );
  const negativePenalty =
    matches.negativeSimilarity >= profileAlgorithmDefaults.negativePenaltyThreshold ||
    recentMatches.negative >= profileAlgorithmDefaults.negativePenaltyThreshold
      ? -clamp(
          (matches.negativeInterestMatch + recentMatches.negative * 0.65) *
            0.42 *
            params.negativeSemanticStrength,
          0,
          0.5
        )
      : 0;
  const bm25Score =
    clamp(
      input.lexical.bm25Positive * 0.65 +
        input.lexical.bm25Recent * 0.8 +
        input.lexical.positiveOverlap * 0.35 +
        input.lexical.titleKeywordMatch * 0.25,
      0,
      1
    ) *
    0.12 *
    params.keywordProfileStrength;
  const keywordNegativePenalty = -input.lexical.negativeOverlap * 0.12;
  const freshness = freshnessScore(ageHours, 0.18, profileAlgorithmDefaults.freshnessHalfLifeHours) *
    params.freshnessWeight;
  const pendingEmbeddingScore =
    candidate.embeddingStatus === "embedding_pending" && ageHours <= 72
      ? Math.max(0, params.pendingEmbeddingFloor - freshness)
      : 0;
  const sourceScore = normalizedSourceScore(candidate, input.source);
  const stateScore = stateScoreForV2(candidate);
  const duplicatePenalty =
    input.duplicateCount > 1 && !candidate.state.favorited && !candidate.state.readLater
      ? -Math.min(
          0.2,
          (input.duplicateCount - 1) * 0.04 + (input.duplicate.confidence ?? 0) * 0.06
        )
      : 0;
  const exposurePenalty = candidate.state.interactionStatus === "ignored" ? -0.04 : 0;
  const exploration = explorationEligibilityFor(candidate, input.settings, ageHours);
  const explorationBonus = 0;
  const preRerankScore =
    semanticScore +
    bm25Score +
    freshness +
    pendingEmbeddingScore +
    sourceScore +
    stateScore +
    negativePenalty +
    keywordNegativePenalty +
    duplicatePenalty +
    exposurePenalty +
    activeRecentHistoryScore +
    explorationBonus;
  const ftrlFeatures = ftrlFeaturesFor({
    semanticScore,
    negativePenalty,
    bm25Score,
    keywordNegativePenalty,
    freshness,
    pendingEmbeddingScore,
    sourceScore,
    stateScore,
    duplicatePenalty,
    exposurePenalty,
    explorationBonus,
    ageHours,
    candidate,
    source: input.source
  });
  const ftrlScore = input.ftrlModel ? ftrlPredict(input.ftrlModel, ftrlFeatures) : 0;
  const ftrlBlendAlpha =
    input.settings.localLearningEnabled &&
    !input.settings.localLearningShadowMode &&
    input.ftrlModel?.status === "active" &&
    input.ftrlModel.sampleCount >= 50
      ? clamp(input.ftrlModel.blendAlpha, 0, FTRL_ACTIVE_ALPHA_CAP)
      : 0;
  const score = clamp(
    ftrlBlendAlpha > 0
      ? preRerankScore * (1 - ftrlBlendAlpha) + ftrlScore * ftrlBlendAlpha
      : preRerankScore,
    0,
    1
  );

  return {
    score: roundScore(score),
    baseScore: roundScore(input.baseScore),
    ftrlScore,
    semanticScore: roundScore(semanticScore),
    bm25Score: roundScore(bm25Score),
    sourceScore: roundScore(sourceScore),
    freshnessScore: roundScore(freshness),
    stateScore: roundScore(stateScore),
    diversityScore: 0,
    penaltyScore: roundScore(negativePenalty + keywordNegativePenalty + duplicatePenalty + exposurePenalty + Math.min(0, activeRecentHistoryScore)),
    negativePenalty: roundScore(negativePenalty + keywordNegativePenalty),
    duplicatePenalty: roundScore(duplicatePenalty),
    diversityPenalty: 0,
    explorationBonus: roundScore(explorationBonus),
    recentHistoryScore: roundScore(recentHistoryScore),
    fatiguePenalty: 0,
    explorationEligible: exploration.eligible,
    explorationBucket: exploration.bucket,
    explorationReason: exploration.reason,
    wasExploration: false,
    pendingEmbeddingScore: roundScore(pendingEmbeddingScore),
    exposurePenalty: roundScore(exposurePenalty),
    preRerankScore: roundScore(preRerankScore),
    primaryFamilyId: matches.primaryFamilyId,
    primaryFamilyLabel: matches.primaryFamilyLabel,
    primaryClusterId: matches.primaryClusterId,
    primaryClusterLabel: matches.primaryClusterLabel,
    primaryFamilyMaturity: roundScore(matches.primaryFamilyMaturity),
    primaryFamilyDominanceRatio: roundScore(matches.primaryFamilyDominanceRatio),
    matchedFamilyCount: matches.matchedFamilyCount
  };
}

function applyExposureFatigue(
  score: V2Score,
  candidate: ArticleRankingCandidateRow,
  duplicate: DuplicateFeature,
  fatigue: ExposureFatigueCounts,
  settings: RankingSettingsSnapshot
): V2Score {
  if (candidate.state.favorited || candidate.state.liked || candidate.state.readLater) {
    return score;
  }
  const duplicatePenalty = duplicate.groupId
    ? -Math.min(0.06, (fatigue.duplicateGroups.get(duplicate.groupId) ?? 0) * 0.015)
    : 0;
  const familyPenalty = score.primaryFamilyId
    ? -Math.min(0.03, (fatigue.families.get(score.primaryFamilyId) ?? 0) * 0.006)
    : 0;
  const sourcePenalty = -Math.min(0.015, (fatigue.feeds.get(candidate.feedId) ?? 0) * 0.003);
  const fatiguePenalty = roundScore(duplicatePenalty + familyPenalty + sourcePenalty);
  if (settings.crossSessionFatigueMode !== "active") {
    return { ...score, fatiguePenalty };
  }
  return {
    ...score,
    score: roundScore(clamp(score.score + fatiguePenalty, 0, 1)),
    preRerankScore: roundScore(clamp(score.preRerankScore + fatiguePenalty, 0, 1)),
    penaltyScore: roundScore(score.penaltyScore + fatiguePenalty),
    fatiguePenalty
  };
}

function normalizedSourceScore(
  candidate: ArticleRankingCandidateRow,
  source: SourceFeature = emptySourceFeature()
): number {
  if (source.clearSignalCount > 0) {
    const manual = clamp(candidate.sourceWeight, -1, 1) * 0.08;
    const learned =
      clamp((source.smoothedPositiveRate - 0.5) * 2, -1, 1) *
      source.sourceConfidence *
      0.06;
    const openOnly = clamp(candidate.feedOpenRate, 0, 1) * 0.002;
    return clamp(manual + learned + openOnly, -0.14, 0.14);
  }
  const clearSignalScore = Math.tanh(
    (candidate.feedPositiveScore - candidate.feedNegativeScore) / 16
  );
  const rateScore = clamp(candidate.feedFavoriteRate - candidate.feedNotInterestedRate, -1, 1);
  const manual = clamp(candidate.sourceWeight, -1, 1) * 0.08;
  const learned = clearSignalScore * 0.045 + rateScore * 0.025;
  const openOnly = clamp(candidate.feedOpenRate, 0, 1) * 0.004;
  return clamp(manual + learned + openOnly, -0.14, 0.14);
}

function stateScoreForV2(candidate: ArticleRankingCandidateRow): number {
  const read = candidate.state.read || candidate.state.interactionStatus === "read";
  return (
    (!read ? 0.04 : -0.06) +
    (candidate.state.readLater ? 0.08 : 0) +
    (candidate.state.favorited ? 0.14 : 0) +
    (candidate.state.liked ? 0.08 : 0) +
    (candidate.state.interactionStatus === "opened" && !read ? 0.012 : 0) +
    clamp(candidate.state.readingProgress, 0, 1) * 0.08
  );
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .slice(0, 64)
    )
  );
}

function normalizeForTermMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function emptyLexicalFeature(): LexicalFeature {
  return {
    bm25Positive: 0,
    bm25Recent: 0,
    positiveOverlap: 0,
    negativeOverlap: 0,
    titleKeywordMatch: 0,
    matchedTerms: []
  };
}

function emptyDuplicateFeature(): DuplicateFeature {
  return {
    groupId: null,
    groupSize: 1,
    reason: null,
    confidence: null,
    representativeArticleId: null
  };
}

function emptySourceFeature(): SourceFeature {
  return {
    clearSignalCount: 0,
    smoothedPositiveRate: 0,
    sourceConfidence: 0
  };
}

function explorationEligibilityFor(
  candidate: ArticleRankingCandidateRow,
  settings: RankingSettingsSnapshot,
  ageHours: number
): { eligible: boolean; bucket: string | null; reason: string | null } {
  if (!settings.explorationEnabled || candidate.state.hidden || candidate.state.notInterested) {
    return { eligible: false, bucket: null, reason: null };
  }
  if (candidate.embeddingStatus === "embedding_pending" && ageHours <= 72) {
    return {
      eligible: true,
      bucket: "pending_embedding",
      reason: "Embedding is pending, so this item can use a bounded local exploration slot."
    };
  }
  if (candidate.behaviorEventCount === 0 && ageHours <= 48) {
    return {
      eligible: true,
      bucket: `feed:${candidate.feedId}`,
      reason: "Low-exposure recent item from a subscribed feed."
    };
  }
  return { eligible: false, bucket: null, reason: null };
}

function duplicateStatsFor(
  candidates: ArticleRankingCandidateRow[],
  duplicateFeatures: Map<string, DuplicateFeature> = new Map()
): Map<string, number> {
  const keys = new Map<string, number>();
  for (const candidate of candidates) {
    const key = duplicateFeatures.get(candidate.articleId)?.groupId ?? duplicateKeyFor(candidate);
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }

  const result = new Map<string, number>();
  for (const candidate of candidates) {
    const feature = duplicateFeatures.get(candidate.articleId);
    result.set(
      candidate.articleId,
      Math.max(feature?.groupSize ?? 1, keys.get(feature?.groupId ?? duplicateKeyFor(candidate)) ?? 1)
    );
  }
  return result;
}

function duplicateKeyFor(candidate: ArticleRankingCandidateRow): string {
  return (
    candidate.dedupeKey ||
    candidate.contentHash ||
    normalizeUrl(candidate.canonicalUrl ?? candidate.url) ||
    normalizeTitle(candidate.title)
  );
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function rerankCanonicalWindow(
  items: Array<{ candidate: ArticleRankingCandidateRow; score: V2Score }>,
  settings: RankingSettingsSnapshot,
  limit: number,
  explorationBucketSamples: Map<string, number> = new Map()
): Array<{ candidate: ArticleRankingCandidateRow; score: V2Score; position: number }> {
  const params = cocoonParameters(settings.cocoonLevel);
  const remaining = items
    .slice()
    .sort((left, right) => right.score.score - left.score.score || right.candidate.discoveredAt - left.candidate.discoveredAt)
    .slice(0, limit);
  const selected: Array<{ candidate: ArticleRankingCandidateRow; score: V2Score; position: number }> = [];
  const sourceCounts = new Map<string, number>();
  const familyCounts = new Map<string, number>();
  const duplicateGroups = new Set<string>();

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index]!;
      const sourceCount = sourceCounts.get(item.candidate.feedId) ?? 0;
      const sourcePenalty =
        sourceCount >= params.sourceCap ? 0.12 * params.diversityStrength : sourceCount * 0.01;
      const duplicateKey = duplicateKeyFor(item.candidate);
      const duplicatePenalty = duplicateGroups.has(duplicateKey) && !item.candidate.state.favorited && !item.candidate.state.readLater
        ? 0.18 * params.diversityStrength
        : 0;
      const familyCount =
        item.score.primaryFamilyId !== null
          ? familyCounts.get(item.score.primaryFamilyId) ?? 0
          : 0;
      const familyCap =
        selected.length < 20 ? params.familyCapTop20 : params.familyCapTop50;
      const familyPenalty =
        item.score.primaryFamilyId === null
          ? 0
          : familyCount >= familyCap
            ? (0.22 + (familyCount - familyCap + 1) * 0.05) *
                params.familyDiversityStrength
            : familyCount * 0.008 * params.familyDiversityStrength;
      const mmrScore =
        params.mmrLambda * item.score.score -
        (1 - params.mmrLambda) * (sourcePenalty + duplicatePenalty + familyPenalty);
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = index;
      }
    }

    const [next] = remaining.splice(bestIndex, 1);
    if (!next) {
      break;
    }
    const diversityPenalty = Math.min(0, bestScore - next.score.score);
    next.score = {
      ...next.score,
      diversityPenalty: roundScore(diversityPenalty),
      diversityScore: roundScore(diversityPenalty),
      score: roundScore(clamp(next.score.score + diversityPenalty, 0, 1))
    };
    sourceCounts.set(next.candidate.feedId, (sourceCounts.get(next.candidate.feedId) ?? 0) + 1);
    if (next.score.primaryFamilyId !== null) {
      familyCounts.set(
        next.score.primaryFamilyId,
        (familyCounts.get(next.score.primaryFamilyId) ?? 0) + 1
      );
    }
    duplicateGroups.add(duplicateKeyFor(next.candidate));
    selected.push({
      ...next,
      position: selected.length + 1
    });
  }

  return applyExplorationSlots(selected, settings, explorationBucketSamples);
}

function applyExplorationSlots(
  selected: Array<{ candidate: ArticleRankingCandidateRow; score: V2Score; position: number }>,
  settings: RankingSettingsSnapshot,
  explorationBucketSamples: Map<string, number> = new Map()
): Array<{ candidate: ArticleRankingCandidateRow; score: V2Score; position: number }> {
  if (!settings.explorationEnabled || selected.length === 0) {
    return selected;
  }
  const params = cocoonParameters(settings.cocoonLevel);
  const maxTop20Slots = params.explorationRatio >= 0.04 ? 2 : params.explorationRatio >= 0.015 ? 1 : 0;
  if (maxTop20Slots === 0) {
    return selected;
  }
  const top20 = selected.slice(0, 20);
  const currentExploration = top20.filter((item) => item.score.wasExploration).length;
  let remainingSlots = Math.max(0, maxTop20Slots - currentExploration);
  if (remainingSlots === 0) {
    return selected;
  }

  const candidates = selected
    .slice(20)
    .filter(
      (item) =>
        item.score.score >= 0.05 &&
        item.score.explorationEligible &&
        !item.candidate.state.hidden &&
        !item.candidate.state.notInterested
    )
    .sort((left, right) => {
      if (settings.learnedExplorationMode === "active") {
        const leftSample = explorationBucketSamples.get(left.score.explorationBucket ?? "") ?? 0.5;
        const rightSample = explorationBucketSamples.get(right.score.explorationBucket ?? "") ?? 0.5;
        return rightSample - leftSample || explorationSeedScore(left, settings) - explorationSeedScore(right, settings);
      }
      return explorationSeedScore(left, settings) - explorationSeedScore(right, settings);
    });

  const next = selected.slice();
  const slotPositions = maxTop20Slots === 2 ? [10, 20] : [20];
  for (const slotPosition of slotPositions) {
    if (remainingSlots <= 0) {
      break;
    }
    const candidate = candidates.shift();
    if (!candidate) {
      break;
    }
    const currentIndex = next.findIndex((item) => item.candidate.articleId === candidate.candidate.articleId);
    if (currentIndex < 0) {
      continue;
    }
    const targetIndex = Math.min(slotPosition - 1, next.length - 1);
    const [removed] = next.splice(currentIndex, 1);
    if (!removed) {
      continue;
    }
    removed.score = {
      ...removed.score,
      score: roundScore(clamp(removed.score.score + params.explorationRatio, 0, 1)),
      preRerankScore: roundScore(clamp(removed.score.preRerankScore + params.explorationRatio, 0, 1)),
      explorationBonus: roundScore(params.explorationRatio),
      wasExploration: true
    };
    next.splice(targetIndex, 0, removed);
    remainingSlots -= 1;
  }

  return next.map((item, index) => ({ ...item, position: index + 1 }));
}

function explorationSeedScore(
  item: { candidate: ArticleRankingCandidateRow; score: V2Score },
  settings: RankingSettingsSnapshot
): number {
  const key = `${settings.cocoonLevel}:${item.candidate.articleId}`;
  let hash = 0;
  for (const char of key) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash / 0xffffffff;
}

function sampleBeta(alpha: number, beta: number): number {
  const left = sampleGamma(Math.max(alpha, 0.001));
  const right = sampleGamma(Math.max(beta, 0.001));
  return left / Math.max(left + right, Number.EPSILON);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    const normal = Math.sqrt(-2 * Math.log(Math.max(Math.random(), Number.EPSILON))) *
      Math.cos(2 * Math.PI * Math.random());
    const value = 1 + c * normal;
    if (value <= 0) continue;
    const cube = value * value * value;
    const uniform = Math.random();
    if (uniform < 1 - 0.0331 * normal * normal * normal * normal) return d * cube;
    if (Math.log(uniform) < 0.5 * normal * normal + d * (1 - cube + Math.log(cube))) return d * cube;
  }
}

function explanationPayloadFor(
  candidate: ArticleRankingCandidateRow,
  score: V2Score,
  settings: RankingSettingsSnapshot,
  evidence: {
    origins?: CandidateOrigin[];
    lexical?: LexicalFeature;
    duplicate?: DuplicateFeature;
    recentIntent?: RecentIntentVector[];
  } = {}
): Record<string, unknown> {
  const lexical = evidence.lexical ?? emptyLexicalFeature();
  const duplicate = evidence.duplicate ?? emptyDuplicateFeature();
  return {
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    featureSchemaVersion: RECOMMENDATION_FEATURE_SCHEMA_VERSION,
    cocoonLevel: settings.cocoonLevel,
    components: {
      final: score.score,
      preRerank: score.preRerankScore,
      semantic: score.semanticScore,
      bm25: score.bm25Score,
      source: score.sourceScore,
      freshness: score.freshnessScore,
      state: score.stateScore,
      negativePenalty: score.negativePenalty,
      duplicatePenalty: score.duplicatePenalty,
      diversityPenalty: score.diversityPenalty,
      pendingEmbedding: score.pendingEmbeddingScore,
      exploration: score.explorationBonus,
      wasExploration: score.wasExploration,
      explorationBucket: score.wasExploration ? score.explorationBucket : null,
      explorationReason: score.wasExploration ? score.explorationReason : null,
      exposurePenalty: score.exposurePenalty,
      ftrl: score.ftrlScore,
      primaryFamilyId: score.primaryFamilyId,
      primaryFamilyLabel: score.primaryFamilyLabel,
      primaryClusterId: score.primaryClusterId,
      primaryClusterLabel: score.primaryClusterLabel,
      primaryFamilyMaturity: score.primaryFamilyMaturity,
      primaryFamilyDominanceRatio: score.primaryFamilyDominanceRatio,
      matchedFamilyCount: score.matchedFamilyCount
    },
    evidence: {
      feedId: candidate.feedId,
      embeddingStatus: candidate.embeddingStatus,
      dedupeKey: candidate.dedupeKey,
      contentHash: candidate.contentHash,
      titleTerms: tokenize(candidate.title).slice(0, 8),
      candidateOrigins: evidence.origins ?? [],
      matchedTerms: lexical.matchedTerms,
      duplicateGroup: duplicate.groupId
        ? {
            id: duplicate.groupId,
            size: duplicate.groupSize,
            reason: duplicate.reason,
            confidence: duplicate.confidence,
            representativeArticleId: duplicate.representativeArticleId
          }
        : null,
      recentIntent: (evidence.recentIntent ?? []).map((intent) => ({
        polarity: intent.polarity,
        eventCount: intent.eventCount,
        weight: roundScore(intent.weight),
        updatedAt: intent.updatedAt
      }))
    },
    readiness: {
      bm25ProfileTerms: lexical.matchedTerms.length > 0 || score.bm25Score > 0 ? "active" : "empty",
      recentIntent: (evidence.recentIntent ?? []).length > 0 ? "active" : "missing",
      ftrl: "not_trained",
      evaluation: "diagnostic_only"
    },
    flags: {
      localLearningEnabled: settings.localLearningEnabled,
      localLearningShadowMode: settings.localLearningShadowMode,
      explorationEnabled: settings.explorationEnabled,
      evaluationEnabled: settings.evaluationEnabled
    }
  };
}

function parseExplanationPayload(payloadJson: string | null): { components?: Record<string, unknown> } | null {
  if (!payloadJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { components?: Record<string, unknown> })
      : null;
  } catch {
    return null;
  }
}

function lerp(left: number, right: number, t: number): number {
  return left + (right - left) * t;
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

function rankReasonsFor(
  source: ArticleRankExplanationSourceRow,
  clusterMatches: RankExplanationClusterMatch[],
  persistedPayload?: { components?: Record<string, unknown> } | null
): RankExplanationReason[] {
  const rank = source.rank;
  if (!rank) {
    return [
      {
        type: "fallback",
        label: "Ranking has not been calculated yet",
        impact: "neutral"
      }
    ];
  }

  const candidates: Array<RankExplanationReason & { magnitude: number; priority: number }> = [];
  const components = persistedPayload?.components ?? {};
  const bm25Score = typeof components.bm25 === "number" ? components.bm25 : rank.bm25Score ?? 0;
  const pendingScore =
    typeof components.pendingEmbedding === "number"
      ? components.pendingEmbedding
      : rank.pendingEmbeddingScore ?? 0;
  const duplicatePenalty =
    typeof components.duplicatePenalty === "number"
      ? components.duplicatePenalty
      : rank.duplicatePenalty ?? 0;
  const diversityPenalty =
    typeof components.diversityPenalty === "number"
      ? components.diversityPenalty
      : rank.diversityPenalty ?? 0;
  const explorationScore =
    typeof components.exploration === "number"
      ? components.exploration
      : rank.explorationBonus ?? 0;
  const wasExploration = components.wasExploration === true || (rank.explorationBonus ?? 0) > MIN_REASON_SCORE;
  const familyMatch = familyMatchFromComponents(components);
  const semanticScore = rank.semanticScore ?? 0;
  const explorationReason: RankExplanationReason & { magnitude: number; priority: number } | null =
    wasExploration
      ? {
          type: "exploration",
          label: "Break-cocoon exploration",
          impact: "neutral",
          magnitude: Math.max(explorationScore, MIN_REASON_SCORE),
          priority: 0
        }
      : null;

  if (explorationReason) {
    candidates.push(explorationReason);
  }

  if ((rank.semanticScore ?? rank.interestScore) > MIN_REASON_SCORE) {
    candidates.push({
      type: "interest",
      label: familyMatch
        ? "Interest family match"
        : clusterMatches[0]
          ? "Interest match"
          : semanticScore > MIN_REASON_SCORE
            ? "Recent interest trend"
            : "Interest match",
      impact: "positive",
      ...(clusterMatches[0] ? { cluster: clusterMatches[0], clusters: clusterMatches } : {}),
      ...(!clusterMatches[0] && familyMatch ? { family: familyMatch } : {}),
      ...(!clusterMatches[0] && !familyMatch && semanticScore > MIN_REASON_SCORE
        ? { recentIntent: { polarity: "positive" as const } }
        : {}),
      magnitude: rank.semanticScore ?? rank.interestScore,
      priority: 1
    });
  }

  if (bm25Score > MIN_REASON_SCORE && (rank.semanticScore ?? rank.interestScore) <= MIN_REASON_SCORE) {
    candidates.push({
      type: "interest",
      label: "Keyword/BM25 match",
      impact: "positive",
      magnitude: bm25Score,
      priority: 2
    });
  }

  if (rank.sourceScore > MIN_REASON_SCORE) {
    candidates.push({
      type: "source",
      label: source.feedTitle,
      impact: "positive",
      magnitude: rank.sourceScore,
      priority: 2
    });
  } else if (rank.sourceScore < -MIN_REASON_SCORE) {
    candidates.push({
      type: "source",
      label: source.feedTitle,
      impact: "negative",
      magnitude: Math.abs(rank.sourceScore),
      priority: 2
    });
  }

  if (rank.freshnessScore > MIN_REASON_SCORE) {
    candidates.push({
      type: "freshness",
      label: "Recent article",
      impact: "positive",
      magnitude: rank.freshnessScore,
      priority: 3
    });
  }

  const positiveStateLabel = positiveStateLabelFor(source);
  if (rank.stateScore > MIN_REASON_SCORE && positiveStateLabel) {
    candidates.push({
      type: "state",
      label: positiveStateLabel,
      impact: "positive",
      magnitude: rank.stateScore,
      priority: 4
    });
  } else if (rank.stateScore < -MIN_REASON_SCORE) {
    candidates.push({
      type: "state",
      label: source.state.interactionStatus === "ignored"
        ? "Ignored in the list"
        : "Read state lowers priority",
      impact: "negative",
      magnitude: Math.abs(rank.stateScore),
      priority: 4
    });
  }

  if (rank.penaltyScore < -MIN_REASON_SCORE) {
    candidates.push({
      type: rank.penaltyScore <= -0.2 ? "negative" : "penalty",
      label: source.state.notInterested
        ? "Marked not interested"
        : source.state.hidden
          ? "Hidden article"
          : "Negative interest match",
      impact: "negative",
      magnitude: Math.abs(rank.penaltyScore),
      priority: 0
    });
  }

  if (pendingScore > MIN_REASON_SCORE) {
    candidates.push({
      type: "fallback",
      label: "Fresh article is waiting for embedding",
      impact: "neutral",
      magnitude: pendingScore,
      priority: 6
    });
  }

  if (duplicatePenalty < -MIN_REASON_SCORE || diversityPenalty < -MIN_REASON_SCORE) {
    candidates.push({
      type: "penalty",
      label: duplicatePenalty < -MIN_REASON_SCORE ? "Near-duplicate penalty" : "Diversity rerank penalty",
      impact: "negative",
      magnitude: Math.abs(duplicatePenalty + diversityPenalty),
      priority: 5
    });
  }

  const sortedReasons = candidates.sort(
    (left, right) => right.magnitude - left.magnitude || left.priority - right.priority
  );
  const selectedReasons =
    explorationReason && !sortedReasons.slice(0, MAX_REASONS).some((reason) => reason.type === "exploration")
      ? [
          explorationReason,
          ...sortedReasons
            .filter((reason) => reason.type !== "exploration")
            .slice(0, MAX_REASONS - 1)
        ]
      : sortedReasons.slice(0, MAX_REASONS);
  const reasons = selectedReasons.map(({ magnitude: _magnitude, priority: _priority, ...reason }) => reason);

  return reasons.length > 0
    ? reasons
    : [
        {
          type: "fallback",
          label: fallbackLabelFor(source),
          impact: "neutral"
        }
      ];
}

function familyMatchFromComponents(components: Record<string, unknown>): RankExplanationFamilyMatch | null {
  const id = typeof components.primaryFamilyId === "string" ? components.primaryFamilyId.trim() : "";
  const label = typeof components.primaryFamilyLabel === "string" ? components.primaryFamilyLabel.trim() : "";
  const maturity = typeof components.primaryFamilyMaturity === "number" &&
    Number.isFinite(components.primaryFamilyMaturity)
    ? components.primaryFamilyMaturity
    : 0;
  const dominanceRatio = typeof components.primaryFamilyDominanceRatio === "number" &&
    Number.isFinite(components.primaryFamilyDominanceRatio)
    ? components.primaryFamilyDominanceRatio
    : 0;
  const matchedFamilyCount = typeof components.matchedFamilyCount === "number" &&
    Number.isFinite(components.matchedFamilyCount)
    ? Math.max(0, Math.trunc(components.matchedFamilyCount))
    : 0;

  if (!id || !label || matchedFamilyCount <= 0) {
    return null;
  }

  return {
    id,
    label,
    maturity: roundScore(clamp(maturity, 0, 1)),
    dominanceRatio: roundScore(clamp(dominanceRatio, 0, 1)),
    matchedFamilyCount
  };
}

function fallbackLabelFor(source: ArticleRankExplanationSourceRow): string {
  if (source.rankingStatus === "no_provider") {
    return "Using baseline ranking because embedding is not configured";
  }
  if (source.rankingStatus === "embedding_pending") {
    return "Using baseline signals while embedding is pending";
  }
  if (source.rankingStatus === "rank_pending") {
    return "Ranking signals are still being prepared";
  }
  return "Ranking has not been calculated yet";
}

function positiveStateLabelFor(source: ArticleRankExplanationSourceRow): string | null {
  const labels: string[] = [];

  if (source.state.favorited) {
    labels.push("Favorited");
  }
  if (source.state.readLater) {
    labels.push("Saved for later");
  }
  if (source.state.readingProgress > 0) {
    labels.push("Reading progress");
  }
  if (source.state.interactionStatus === "opened") {
    labels.push("Opened article");
  }

  return labels.length > 0 ? labels.join(", ") : null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
