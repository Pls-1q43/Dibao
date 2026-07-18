import type {
  ArticleInteractionStatus,
  ArticleRankExplanationPayloadRow,
  ArticleRankExplanationSourceRow,
  ArticleRankingCandidateRow,
  DibaoDatabase,
  RankedArticleCountsRow,
  UpsertArticleRankExplanationInput,
  UpsertRankContextInput,
  UpsertArticleRankScoreInput
} from "../types.js";

export const BASE_RANK_CONTEXT = "base";

type ArticleRankingCandidateDbRow = {
  articleId: string;
  feedId: string;
  title: string;
  summary: string | null;
  contentText: string | null;
  dedupeKey: string;
  contentHash: string | null;
  canonicalUrl: string | null;
  url: string;
  publishedAt: number | null;
  discoveredAt: number;
  sourceWeight: number;
  feedPositiveScore: number;
  feedNegativeScore: number;
  feedOpenRate: number;
  feedFavoriteRate: number;
  feedNotInterestedRate: number;
  read: 0 | 1;
  favorited: 0 | 1;
  liked: 0 | 1;
  readLater: 0 | 1;
  hidden: 0 | 1;
  notInterested: 0 | 1;
  readingProgress: number;
  lastOpenedAt: number | null;
  lastIgnoredAt: number | null;
  lastActionAt: number | null;
  behaviorProjectionScore: number;
  behaviorEventCount: number;
  vectorBlob: Buffer | null;
  embeddingContentHash: string | null;
  embeddingStatus: ArticleRankingCandidateRow["embeddingStatus"];
};

type ArticleRankExplanationSourceDbRow = {
  articleId: string;
  feedTitle: string;
  publishedAt: number | null;
  discoveredAt: number;
  read: 0 | 1;
  favorited: 0 | 1;
  liked: 0 | 1;
  readLater: 0 | 1;
  hidden: 0 | 1;
  notInterested: 0 | 1;
  readingProgress: number;
  lastOpenedAt: number | null;
  lastIgnoredAt: number | null;
  lastActionAt: number | null;
  score: number | null;
  baseScore: number | null;
  ftrlScore: number | null;
  interestScore: number | null;
  semanticScore: number | null;
  bm25Score: number | null;
  sourceScore: number | null;
  freshnessScore: number | null;
  stateScore: number | null;
  diversityScore: number | null;
  penaltyScore: number | null;
  negativePenalty: number | null;
  duplicatePenalty: number | null;
  diversityPenalty: number | null;
  explorationBonus: number | null;
  pendingEmbeddingScore: number | null;
  exposurePenalty: number | null;
  preRerankScore: number | null;
  rerankScore: number | null;
  rerankPosition: number | null;
  rerankWindowId: string | null;
  algorithmVersion: string | null;
  featureSchemaVersion: number | null;
  cocoonLevel: number | null;
  calculatedAt: number | null;
  vectorBlob: Buffer | null;
  rankingStatus: ArticleRankExplanationSourceRow["rankingStatus"];
};

export interface RankingRepository {
  countRankedArticles(input: { activeRankContext: string }): RankedArticleCountsRow;
  findExplanationPayload(input: {
    articleId: string;
    rankContext: string;
  }): ArticleRankExplanationPayloadRow | null;
  findExplanationSource(input: {
    articleId: string;
    rankContext?: string;
  }): ArticleRankExplanationSourceRow | null;
  findBaseExplanationSource(articleId: string): ArticleRankExplanationSourceRow | null;
  getLastRankingUpdate(input: { activeRankContext: string }): number | null;
  upsertRankContext(input: UpsertRankContextInput): void;
  listCandidates(input?: {
    articleIds?: string[];
    afterArticleId?: string | null;
    embeddingIndexId?: string | null;
    limit?: number;
  }): ArticleRankingCandidateRow[];
  listBaseCandidates(input?: { articleIds?: string[] }): ArticleRankingCandidateRow[];
  upsertScore(input: UpsertArticleRankScoreInput): void;
  upsertBaseScore(input: UpsertArticleRankScoreInput): void;
  upsertExplanation(input: UpsertArticleRankExplanationInput): void;
}

export class SqliteRankingRepository implements RankingRepository {
  constructor(private readonly db: DibaoDatabase) {}

  countRankedArticles(input: { activeRankContext: string }): RankedArticleCountsRow {
    const countByContext = this.db.prepare(
      `
        select count(*) as count
        from article_rank_scores
        where rank_context = ?
      `
    );
    const baseRow = countByContext.get(BASE_RANK_CONTEXT) as { count: number } | undefined;
    const activeRow =
      input.activeRankContext === BASE_RANK_CONTEXT
        ? null
        : (countByContext.get(input.activeRankContext) as { count: number } | undefined);

    return {
      base: baseRow?.count ?? 0,
      active: activeRow?.count ?? 0
    };
  }

  getLastRankingUpdate(input: { activeRankContext: string }): number | null {
    const row = this.db
      .prepare(
        `
          select max(calculated_at) as calculatedAt
          from article_rank_scores
          where rank_context in (?, ?)
        `
      )
      .get(BASE_RANK_CONTEXT, input.activeRankContext) as
      | { calculatedAt: number | null }
      | undefined;

    return row?.calculatedAt ?? null;
  }

  findExplanationPayload(input: {
    articleId: string;
    rankContext: string;
  }): ArticleRankExplanationPayloadRow | null {
    const row = this.db
      .prepare(
        `
          select
            article_id as articleId,
            rank_context as rankContext,
            embedding_index_id as embeddingIndexId,
            payload_json as payloadJson,
            created_at as createdAt
          from article_rank_explanations
          where article_id = ?
            and rank_context = ?
        `
      )
      .get(input.articleId, input.rankContext) as ArticleRankExplanationPayloadRow | undefined;

    return row ?? null;
  }

  upsertRankContext(input: UpsertRankContextInput): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `
          insert into rank_contexts (
            id,
            algorithm_version,
            feature_schema_version,
            embedding_index_id,
            cocoon_level,
            status,
            metadata_json,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            algorithm_version = excluded.algorithm_version,
            feature_schema_version = excluded.feature_schema_version,
            embedding_index_id = excluded.embedding_index_id,
            cocoon_level = excluded.cocoon_level,
            status = excluded.status,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `
      )
      .run(
        input.id,
        input.algorithmVersion,
        input.featureSchemaVersion,
        input.embeddingIndexId ?? null,
        input.cocoonLevel,
        input.status ?? "active",
        input.metadataJson ?? null,
        now,
        now
      );
  }

  findExplanationSource(input: {
    articleId: string;
    rankContext?: string;
  }): ArticleRankExplanationSourceRow | null {
    const rankContext = input.rankContext ?? BASE_RANK_CONTEXT;
    const activeEmbeddingIndexId =
      rankContext === BASE_RANK_CONTEXT ? null : this.embeddingIndexIdForRankContext(rankContext);
    const row = this.db
      .prepare(
        `
          select
            a.id as articleId,
            f.title as feedTitle,
            a.published_at as publishedAt,
            a.discovered_at as discoveredAt,
            case when s.read_at is not null then 1 else 0 end as read,
            case when s.favorited_at is not null then 1 else 0 end as favorited,
            case when s.liked_at is not null then 1 else 0 end as liked,
            case when s.read_later_at is not null then 1 else 0 end as readLater,
            case when s.hidden_at is not null then 1 else 0 end as hidden,
            case when s.not_interested_at is not null then 1 else 0 end as notInterested,
            coalesce(s.reading_progress, 0) as readingProgress,
            s.last_opened_at as lastOpenedAt,
            (
              select max(be.created_at)
              from behavior_events be
              where be.article_id = a.id
                and be.event_type = 'impression'
                and be.event_weight < 0
            ) as lastIgnoredAt,
            (
              select max(be.created_at)
              from behavior_events be
              where be.article_id = a.id
            ) as lastActionAt,
            coalesce(rs.score, base_rs.score) as score,
            coalesce(rs.base_score, base_rs.base_score) as baseScore,
            coalesce(rs.ftrl_score, base_rs.ftrl_score) as ftrlScore,
            coalesce(rs.interest_score, base_rs.interest_score) as interestScore,
            coalesce(rs.semantic_score, base_rs.semantic_score) as semanticScore,
            coalesce(rs.bm25_score, base_rs.bm25_score) as bm25Score,
            coalesce(rs.source_score, base_rs.source_score) as sourceScore,
            coalesce(rs.freshness_score, base_rs.freshness_score) as freshnessScore,
            coalesce(rs.state_score, base_rs.state_score) as stateScore,
            coalesce(rs.diversity_score, base_rs.diversity_score) as diversityScore,
            coalesce(rs.penalty_score, base_rs.penalty_score) as penaltyScore,
            coalesce(rs.negative_penalty, base_rs.negative_penalty) as negativePenalty,
            coalesce(rs.duplicate_penalty, base_rs.duplicate_penalty) as duplicatePenalty,
            coalesce(rs.diversity_penalty, base_rs.diversity_penalty) as diversityPenalty,
            coalesce(rs.exploration_bonus, base_rs.exploration_bonus) as explorationBonus,
            coalesce(rs.pending_embedding_score, base_rs.pending_embedding_score) as pendingEmbeddingScore,
            coalesce(rs.exposure_penalty, base_rs.exposure_penalty) as exposurePenalty,
            coalesce(rs.pre_rerank_score, base_rs.pre_rerank_score) as preRerankScore,
            coalesce(rs.rerank_score, base_rs.rerank_score) as rerankScore,
            coalesce(rs.rerank_position, base_rs.rerank_position) as rerankPosition,
            coalesce(rs.rerank_window_id, base_rs.rerank_window_id) as rerankWindowId,
            coalesce(rs.algorithm_version, base_rs.algorithm_version) as algorithmVersion,
            coalesce(rs.feature_schema_version, base_rs.feature_schema_version) as featureSchemaVersion,
            coalesce(rs.cocoon_level, base_rs.cocoon_level) as cocoonLevel,
            coalesce(rs.calculated_at, base_rs.calculated_at) as calculatedAt,
            ae.vector_blob as vectorBlob,
            case
              when ? is null then 'no_provider'
              when ae.vector_blob is null then 'embedding_pending'
              when coalesce(rs.score, base_rs.score) is null then 'rank_pending'
              else 'ready'
            end as rankingStatus
          from articles a
          join feeds f on f.id = a.feed_id
          left join article_states s on s.article_id = a.id
          left join article_embeddings ae
            on ae.article_id = a.id
            and ae.embedding_index_id = ?
          left join article_rank_scores rs
            on rs.article_id = a.id
            and rs.rank_context = ?
          left join article_rank_scores base_rs
            on base_rs.article_id = a.id
            and base_rs.rank_context = ?
          where a.id = ?
            and a.deleted_at is null
            and a.status != 'deleted'
            and f.deleted_at is null
        `
      )
      .get(activeEmbeddingIndexId, activeEmbeddingIndexId ?? "", rankContext, BASE_RANK_CONTEXT, input.articleId) as
      | ArticleRankExplanationSourceDbRow
      | undefined;

    return row ? mapExplanationSource(row) : null;
  }

  findBaseExplanationSource(articleId: string): ArticleRankExplanationSourceRow | null {
    return this.findExplanationSource({ articleId, rankContext: BASE_RANK_CONTEXT });
  }

  listCandidates(
    input: {
      articleIds?: string[];
      afterArticleId?: string | null;
      embeddingIndexId?: string | null;
      limit?: number;
    } = {}
  ): ArticleRankingCandidateRow[] {
    const articleIds = input.articleIds;
    if (articleIds !== undefined && articleIds.length === 0) {
      return [];
    }

    const articleFilter =
      articleIds === undefined ? "" : `and a.id in (${articleIds.map(() => "?").join(", ")})`;
    const cursorFilter =
      articleIds === undefined && input.afterArticleId ? "and a.id > ?" : "";
    const limit = input.limit === undefined ? null : normalizeCandidateLimit(input.limit);
    const limitClause = limit === null ? "" : "limit ?";
    const filterParams: unknown[] = [];
    if (articleIds) {
      filterParams.push(...articleIds);
    } else if (input.afterArticleId) {
      filterParams.push(input.afterArticleId);
    }
    if (limit !== null) {
      filterParams.push(limit);
    }

    return (
      this.db
        .prepare(
          `
            with eligible_articles as (
              select a.id
              from articles a
              join feeds f on f.id = a.feed_id
              left join article_states s on s.article_id = a.id
              where a.deleted_at is null
                and a.status != 'deleted'
                and s.hidden_at is null
                and s.not_interested_at is null
                and s.read_at is null
                and coalesce(s.reading_progress, 0) < 0.9
                and f.deleted_at is null
                and f.enabled = 1
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
                ${articleFilter}
                ${cursorFilter}
              order by a.id
              ${limitClause}
            ),
            event_stats as (
              select
                be.article_id,
                coalesce(sum(
                  case
                    when be.event_type = 'impression'
                      and be.event_weight < 0
                      and s.read_at is null
                      and coalesce(s.reading_progress, 0) = 0
                      and s.last_opened_at is null
                      and s.favorited_at is null
                      and s.liked_at is null
                      and s.read_later_at is null then -0.025
                    when be.event_type = 'open' then 0.005
                    when be.event_type = 'read_progress' then
                      case
                        when coalesce(json_extract(be.metadata_json, '$.progress'), 0) >= 0.9 then 0.10
                        when coalesce(json_extract(be.metadata_json, '$.progress'), 0) >= 0.75 then 0.06
                        when coalesce(json_extract(be.metadata_json, '$.progress'), 0) >= 0.5 then 0.04
                        when coalesce(json_extract(be.metadata_json, '$.progress'), 0) >= 0.25 then 0.01
                        else 0
                      end
                    when be.event_type = 'read_complete' then 0.10
                    when be.event_type = 'favorite' then 0.12
                    when be.event_type = 'like' then 0.16
                    when be.event_type = 'unlike' then -0.04
                    when be.event_type = 'read_later' then 0.08
                    when be.event_type = 'quick_bounce' then -0.04
                    else 0
                  end
                ), 0) as behaviorProjectionScore,
                count(*) as behaviorEventCount
              from behavior_events be
              join eligible_articles ea on ea.id = be.article_id
              left join article_states s on s.article_id = be.article_id
              group by be.article_id
            )
            select
            a.id as articleId,
            a.feed_id as feedId,
            a.title,
            a.summary,
            ac.content_text as contentText,
            a.dedupe_key as dedupeKey,
            a.content_hash as contentHash,
            a.canonical_url as canonicalUrl,
            a.url,
            a.published_at as publishedAt,
              a.discovered_at as discoveredAt,
              f.source_weight as sourceWeight,
              coalesce(fs.positive_score, 0) as feedPositiveScore,
              coalesce(fs.negative_score, 0) as feedNegativeScore,
              coalesce(fs.open_rate, 0) as feedOpenRate,
              coalesce(fs.favorite_rate, 0) as feedFavoriteRate,
              coalesce(fs.not_interested_rate, 0) as feedNotInterestedRate,
              case when s.read_at is not null then 1 else 0 end as read,
              case when s.favorited_at is not null then 1 else 0 end as favorited,
              case when s.liked_at is not null then 1 else 0 end as liked,
              case when s.read_later_at is not null then 1 else 0 end as readLater,
              case when s.hidden_at is not null then 1 else 0 end as hidden,
              case when s.not_interested_at is not null then 1 else 0 end as notInterested,
              coalesce(s.reading_progress, 0) as readingProgress,
              s.last_opened_at as lastOpenedAt,
              (
                select max(be.created_at)
                from behavior_events be
                where be.article_id = a.id
                  and be.event_type = 'impression'
                  and be.event_weight < 0
              ) as lastIgnoredAt,
              (
                select max(be.created_at)
                from behavior_events be
                where be.article_id = a.id
              ) as lastActionAt,
              coalesce(es.behaviorProjectionScore, 0) as behaviorProjectionScore,
              coalesce(es.behaviorEventCount, 0) as behaviorEventCount,
              ae.vector_blob as vectorBlob,
              ae.content_hash as embeddingContentHash,
              case
                when ? = '' then 'no_provider'
                when ae.vector_blob is null then 'embedding_pending'
                else 'ready'
              end as embeddingStatus
            from eligible_articles ea
            join articles a on a.id = ea.id
            join feeds f on f.id = a.feed_id
            left join article_states s on s.article_id = a.id
            left join article_contents ac on ac.article_id = a.id
            left join feed_stats fs on fs.feed_id = a.feed_id
            left join event_stats es on es.article_id = a.id
            left join article_embeddings ae
              on ae.article_id = a.id
             and ae.embedding_index_id = ?
            order by a.id
          `
        )
        .all(...filterParams, input.embeddingIndexId ?? "", input.embeddingIndexId ?? "") as ArticleRankingCandidateDbRow[]
    ).map(mapCandidate);
  }

  listBaseCandidates(input: { articleIds?: string[] } = {}): ArticleRankingCandidateRow[] {
    return this.listCandidates(input);
  }

  upsertScore(input: UpsertArticleRankScoreInput): void {
    this.db
      .prepare(
        `
          insert into article_rank_scores (
            article_id,
            rank_context,
            embedding_index_id,
            score,
            base_score,
            ftrl_score,
            interest_score,
            semantic_score,
            bm25_score,
            source_score,
            freshness_score,
            state_score,
            diversity_score,
            penalty_score,
            negative_penalty,
            duplicate_penalty,
            diversity_penalty,
            exploration_bonus,
            exploration_bucket_key,
            was_exploration,
            pending_embedding_score,
            exposure_penalty,
            pre_rerank_score,
            rerank_score,
            rerank_position,
            rerank_window_id,
            algorithm_version,
            feature_schema_version,
            cocoon_level,
            calculated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(article_id, rank_context) do update set
            embedding_index_id = excluded.embedding_index_id,
            score = excluded.score,
            base_score = excluded.base_score,
            ftrl_score = excluded.ftrl_score,
            interest_score = excluded.interest_score,
            semantic_score = excluded.semantic_score,
            bm25_score = excluded.bm25_score,
            source_score = excluded.source_score,
            freshness_score = excluded.freshness_score,
            state_score = excluded.state_score,
            diversity_score = excluded.diversity_score,
            penalty_score = excluded.penalty_score,
            negative_penalty = excluded.negative_penalty,
            duplicate_penalty = excluded.duplicate_penalty,
            diversity_penalty = excluded.diversity_penalty,
            exploration_bonus = excluded.exploration_bonus,
            exploration_bucket_key = excluded.exploration_bucket_key,
            was_exploration = excluded.was_exploration,
            pending_embedding_score = excluded.pending_embedding_score,
            exposure_penalty = excluded.exposure_penalty,
            pre_rerank_score = excluded.pre_rerank_score,
            rerank_score = excluded.rerank_score,
            rerank_position = excluded.rerank_position,
            rerank_window_id = excluded.rerank_window_id,
            algorithm_version = excluded.algorithm_version,
            feature_schema_version = excluded.feature_schema_version,
            cocoon_level = excluded.cocoon_level,
            calculated_at = excluded.calculated_at
        `
      )
      .run(
        input.articleId,
        input.rankContext ?? BASE_RANK_CONTEXT,
        input.embeddingIndexId ?? null,
        input.score,
        input.baseScore ?? null,
        input.ftrlScore ?? null,
        input.interestScore,
        input.semanticScore ?? input.interestScore,
        input.bm25Score ?? null,
        input.sourceScore,
        input.freshnessScore,
        input.stateScore,
        input.diversityScore,
        input.penaltyScore,
        input.negativePenalty ?? null,
        input.duplicatePenalty ?? null,
        input.diversityPenalty ?? null,
        input.explorationBonus ?? null,
        input.explorationBucketKey ?? null,
        input.wasExploration ? 1 : 0,
        input.pendingEmbeddingScore ?? null,
        input.exposurePenalty ?? null,
        input.preRerankScore ?? null,
        input.rerankScore ?? null,
        input.rerankPosition ?? null,
        input.rerankWindowId ?? null,
        input.algorithmVersion ?? null,
        input.featureSchemaVersion ?? null,
        input.cocoonLevel ?? null,
        input.calculatedAt
      );
  }

  upsertBaseScore(input: UpsertArticleRankScoreInput): void {
    this.upsertScore({
      ...input,
      rankContext: input.rankContext ?? BASE_RANK_CONTEXT,
      embeddingIndexId: null
    });
  }

  upsertExplanation(input: UpsertArticleRankExplanationInput): void {
    this.db
      .prepare(
        `
          insert into article_rank_explanations (
            article_id,
            rank_context,
            embedding_index_id,
            payload_json,
            created_at
          )
          values (?, ?, ?, ?, ?)
          on conflict(article_id, rank_context) do update set
            embedding_index_id = excluded.embedding_index_id,
            payload_json = excluded.payload_json,
            created_at = excluded.created_at
        `
      )
      .run(
        input.articleId,
        input.rankContext,
        input.embeddingIndexId ?? null,
        input.payloadJson,
        input.createdAt
      );
  }

  private embeddingIndexIdForRankContext(rankContext: string): string | null {
    const row = this.db
      .prepare(
        `
          select embedding_index_id as embeddingIndexId
          from rank_contexts
          where id = ?
        `
      )
      .get(rankContext) as { embeddingIndexId: string | null } | undefined;

    return row?.embeddingIndexId ?? rankContext;
  }
}

function normalizeCandidateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    return 500;
  }
  return Math.min(limit, 1_000);
}

function mapExplanationSource(
  row: ArticleRankExplanationSourceDbRow
): ArticleRankExplanationSourceRow {
  const state = {
    read: row.read === 1,
    favorited: row.favorited === 1,
    liked: row.liked === 1,
    readLater: row.readLater === 1,
    hidden: row.hidden === 1,
    notInterested: row.notInterested === 1,
    readingProgress: row.readingProgress,
    interactionStatus: interactionStatusForRankingState(row),
    openedAt: row.lastOpenedAt,
    ignoredAt: ignoredAtForRankingState(row)
  };

  return {
    articleId: row.articleId,
    feedTitle: row.feedTitle,
    publishedAt: row.publishedAt,
    discoveredAt: row.discoveredAt,
    state,
    vectorBlob: row.vectorBlob,
    rankingStatus: row.rankingStatus,
    rank:
      row.score === null ||
      row.interestScore === null ||
      row.sourceScore === null ||
      row.freshnessScore === null ||
      row.stateScore === null ||
      row.diversityScore === null ||
      row.penaltyScore === null ||
      row.calculatedAt === null
        ? null
        : {
            score: row.score,
            baseScore: row.baseScore,
            ftrlScore: row.ftrlScore,
            interestScore: row.interestScore,
            semanticScore: row.semanticScore,
            bm25Score: row.bm25Score,
            sourceScore: row.sourceScore,
            freshnessScore: row.freshnessScore,
            stateScore: row.stateScore,
            diversityScore: row.diversityScore,
            penaltyScore: row.penaltyScore,
            negativePenalty: row.negativePenalty,
            duplicatePenalty: row.duplicatePenalty,
            diversityPenalty: row.diversityPenalty,
            explorationBonus: row.explorationBonus,
            pendingEmbeddingScore: row.pendingEmbeddingScore,
            exposurePenalty: row.exposurePenalty,
            preRerankScore: row.preRerankScore,
            rerankScore: row.rerankScore,
            rerankPosition: row.rerankPosition,
            rerankWindowId: row.rerankWindowId,
            algorithmVersion: row.algorithmVersion,
            featureSchemaVersion: row.featureSchemaVersion,
            cocoonLevel: row.cocoonLevel,
            calculatedAt: row.calculatedAt
          }
  };
}

function mapCandidate(row: ArticleRankingCandidateDbRow): ArticleRankingCandidateRow {
  return {
    articleId: row.articleId,
    feedId: row.feedId,
    title: row.title,
    summary: row.summary,
    contentText: row.contentText,
    dedupeKey: row.dedupeKey,
    contentHash: row.contentHash,
    canonicalUrl: row.canonicalUrl,
    url: row.url,
    publishedAt: row.publishedAt,
    discoveredAt: row.discoveredAt,
    sourceWeight: row.sourceWeight,
    feedPositiveScore: row.feedPositiveScore,
    feedNegativeScore: row.feedNegativeScore,
    feedOpenRate: row.feedOpenRate,
    feedFavoriteRate: row.feedFavoriteRate,
    feedNotInterestedRate: row.feedNotInterestedRate,
    state: {
      read: row.read === 1,
      favorited: row.favorited === 1,
      liked: row.liked === 1,
      readLater: row.readLater === 1,
      hidden: row.hidden === 1,
      notInterested: row.notInterested === 1,
      readingProgress: row.readingProgress,
      interactionStatus: interactionStatusForRankingState(row),
      openedAt: row.lastOpenedAt,
      ignoredAt: ignoredAtForRankingState(row)
    },
    behaviorProjectionScore: row.behaviorProjectionScore,
    behaviorEventCount: row.behaviorEventCount,
    vectorBlob: row.vectorBlob,
    embeddingContentHash: row.embeddingContentHash,
    embeddingStatus: row.embeddingStatus
  };
}

function interactionStatusForRankingState(row: {
  read: 0 | 1;
  readingProgress: number;
  favorited: 0 | 1;
  liked: 0 | 1;
  readLater: 0 | 1;
  lastOpenedAt: number | null;
  lastIgnoredAt: number | null;
  lastActionAt: number | null;
}): ArticleInteractionStatus {
  if (row.read === 1 || row.readingProgress >= 0.9) {
    return "read";
  }
  if (row.readingProgress >= 0.25) {
    return "reading";
  }
  if (row.lastOpenedAt !== null) {
    return "opened";
  }
  if (row.favorited === 1 || row.liked === 1 || row.readLater === 1) {
    return "saved";
  }
  if (row.lastIgnoredAt !== null) {
    return "ignored";
  }
  if (row.lastActionAt !== null) {
    return "seen";
  }
  return "unseen";
}

function ignoredAtForRankingState(row: {
  read: 0 | 1;
  readingProgress: number;
  favorited: 0 | 1;
  liked: 0 | 1;
  readLater: 0 | 1;
  lastOpenedAt: number | null;
  lastIgnoredAt: number | null;
}): number | null {
  if (
    row.read === 1 ||
    row.readingProgress > 0 ||
    row.lastOpenedAt !== null ||
    row.favorited === 1 ||
    row.liked === 1 ||
    row.readLater === 1
  ) {
    return null;
  }

  return row.lastIgnoredAt;
}
