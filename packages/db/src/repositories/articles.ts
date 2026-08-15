import { SqliteArticleFtsIndex, sanitizeFtsQuery } from "../fts/article-fts.js";
import { performance } from "node:perf_hooks";
import type {
  ArticleDetailRow,
  ArticleDuplicateGroupMembershipRow,
  ArticleEmbeddingCandidateRow,
  ArticleInteractionStatus,
  ArticleListCursor,
  ArticleListInput,
  ArticleListItemRow,
  ArticleListResult,
  ArticleListTiming,
  OfflineArticleMetadataRow,
  ArticleRetentionCandidateRow,
  ArticleRetentionCleanupResult,
  RecommendedArticleInventory,
  ArticleRow,
  ArticleScope,
  ArticleSearchInput,
  ArticleSearchResult,
  DibaoDatabase,
  MarkScopeReadAuditResult,
  ArticleFavoriteSort,
  ArticleReadLaterSort,
  UpsertArticleContentInput,
  UpsertArticleContentResult,
  UpsertArticleInput
} from "../types.js";
import { BASE_RANK_CONTEXT } from "./ranking.js";

const RECOMMENDED_FALLBACK_PAGE_LIMIT = 20;

const EMBEDDING_ELIGIBLE_TEXT_PREDICATE = `
  (
    trim(coalesce(a.title, '')) != ''
    or trim(coalesce(a.summary, '')) != ''
    or trim(substr(coalesce(ac.content_text, ''), 1, 256)) != ''
  )
`;

type ArticleDbRow = {
  id: string;
  feedId: string;
  guid: string | null;
  url: string;
  canonicalUrl: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  publishedAt: number | null;
  discoveredAt: number;
  contentHash: string | null;
  dedupeKey: string;
  status: ArticleRow["status"];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

type ArticleReadDbRow = ArticleDbRow & {
  feedTitle: string;
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
  favoritedAt: number | null;
  readLaterAt: number | null;
  sortPublishedAt: number;
  sortRerankMissing: 0 | 1 | null;
  sortRerankPosition: number | null;
  sortRankMissing: 0 | 1 | 2 | null;
  rankScore: number | null;
  rankCalculatedAt: number | null;
};

type ArticleDetailDbRow = ArticleReadDbRow & {
  contentHtml: string | null;
  contentText: string | null;
  extractionStatus: ArticleDetailRow["extractionStatus"];
  extractionError: string | null;
};

type RecommendedCandidateRow = {
  id: string;
  sortScore: number | null;
  sortRerankMissing: 0 | 1;
  sortRerankPosition: number | null;
  sortRankMissing: 0 | 1 | 2;
  sortPublishedAt: number;
};

type RecommendedListPage = {
  rows: ArticleReadDbRow[];
  pageLimit: number;
};

export interface ArticleRepository {
  cleanupForRetention(articleIds: string[], now: number): ArticleRetentionCleanupResult;
  countUnreadForScope(scope: ArticleScope): number;
  findById(id: string): ArticleRow | null;
  findDetailById(id: string, input?: { rankContext?: string }): ArticleDetailRow | null;
  findDetailsByIds(articleIds: string[], input?: { rankContext?: string }): ArticleDetailRow[];
  findOfflineMetadataByIds(articleIds: string[]): OfflineArticleMetadataRow[];
  findDuplicateGroupMemberships(articleIds: string[]): ArticleDuplicateGroupMembershipRow[];
  findListItemsByIds(articleIds: string[], input?: { rankContext?: string }): ArticleListItemRow[];
  listUnreadArticleIdsForScope(scope: ArticleScope, limit?: number): string[];
  markScopeRead(scope: ArticleScope, now: number, auditSampleLimit?: number): MarkScopeReadAuditResult;
  listEmbeddingCandidates(input: {
    embeddingIndexId: string;
    articleIds?: string[];
    limit?: number;
  }): ArticleEmbeddingCandidateRow[];
  listRetentionCandidates(input: {
    cutoff: number;
    keepFavorites?: boolean;
    keepReadLater?: boolean;
    limit?: number;
  }): ArticleRetentionCandidateRow[];
  list(input?: ArticleListInput): ArticleListResult;
  listRecentlyOpened(input?: { limit?: number; rankContext?: string }): ArticleListItemRow[];
  getRecommendedInventory(input: ArticleListInput & { rankContext: string }): RecommendedArticleInventory;
  markArticleIdsRead(articleIds: string[], now: number): number;
  search(input: ArticleSearchInput): ArticleSearchResult;
  upsert(input: UpsertArticleInput): ArticleRow;
  upsertContent(input: UpsertArticleContentInput): UpsertArticleContentResult;
}

export class SqliteArticleRepository implements ArticleRepository {
  private readonly fts: SqliteArticleFtsIndex;

  constructor(private readonly db: DibaoDatabase) {
    this.fts = new SqliteArticleFtsIndex(db);
  }

  countUnreadForScope(scope: ArticleScope): number {
    const candidates = buildArticleScopeUnreadCandidates(scope);
    const row = this.db
      .prepare(
        `
          ${candidates.sql}
          select count(*) as count
          from candidates
        `
      )
      .get(...candidates.params) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  listUnreadArticleIdsForScope(scope: ArticleScope, limit?: number): string[] {
    const candidates = buildArticleScopeUnreadCandidates(scope);
    const limitClause =
      typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? "limit ?" : "";
    const params = limitClause ? [...candidates.params, limit] : candidates.params;
    const rows = this.db
      .prepare(
        `
          ${candidates.sql}
          select article_id as articleId
          from candidates
          order by article_id
          ${limitClause}
        `
      )
      .all(...params) as Array<{ articleId: string }>;

    return rows.map((row) => row.articleId);
  }

  markScopeRead(
    scope: ArticleScope,
    now: number,
    auditSampleLimit = 200
  ): MarkScopeReadAuditResult {
    const candidates = buildArticleScopeUnreadCandidates(scope);
    const sampleLimit = Math.max(Math.trunc(auditSampleLimit), 0);

    return this.db.transaction(() => {
      const sampleArticleIds =
        sampleLimit > 0 ? this.listUnreadArticleIdsForScope(scope, sampleLimit + 1) : [];
      const markedReadCount = this.db
        .prepare(
          `
            ${candidates.sql}
            insert or ignore into article_states (
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
            select article_id, ?, null, null, null, null, null, 1, null, ?
            from candidates
          `
        )
        .run(...candidates.params, now, now).changes;

      return {
        markedReadCount,
        sampleArticleIds: sampleArticleIds.slice(0, sampleLimit),
        limitedAudit: sampleArticleIds.length > sampleLimit || markedReadCount > sampleLimit
      };
    })();
  }

  markArticleIdsRead(articleIds: string[], now: number): number {
    const uniqueArticleIds = uniqueStrings(articleIds);
    if (uniqueArticleIds.length === 0) {
      return 0;
    }

    const insertState = this.db.prepare(
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
        values (?, null, null, null, null, null, null, 0, null, ?)
        on conflict(article_id) do nothing
      `
    );

    for (const articleId of uniqueArticleIds) {
      insertState.run(articleId, now);
    }

    let changed = 0;
    for (const chunk of chunkStrings(uniqueArticleIds, 400)) {
      const placeholders = chunk.map(() => "?").join(", ");
      changed += this.db
        .prepare(
          `
            update article_states
            set
              read_at = ?,
              reading_progress = 1,
              updated_at = ?
            where article_id in (${placeholders})
          `
        )
        .run(now, now, ...chunk).changes;
    }

    return changed;
  }

  cleanupForRetention(articleIds: string[], now: number): ArticleRetentionCleanupResult {
    if (articleIds.length === 0) {
      return {
        articlesSoftDeleted: 0,
        contentsDeleted: 0,
        ftsRowsDeleted: 0,
        rankScoresDeleted: 0,
        rankExplanationsDeleted: 0
      };
    }

    const placeholders = articleIds.map(() => "?").join(", ");

    return this.db.transaction(() => {
      const contentsDeleted = this.db
        .prepare(`delete from article_contents where article_id in (${placeholders})`)
        .run(...articleIds).changes;
      const rankScoresDeleted = this.db
        .prepare(`delete from article_rank_scores where article_id in (${placeholders})`)
        .run(...articleIds).changes;
      const rankExplanationsDeleted = this.db
        .prepare(`delete from article_rank_explanations where article_id in (${placeholders})`)
        .run(...articleIds).changes;
      const articlesSoftDeleted = this.db
        .prepare(
          `
            update articles
            set
              status = 'deleted',
              deleted_at = ?,
              updated_at = ?
            where id in (${placeholders})
              and deleted_at is null
              and status != 'deleted'
          `
        )
        .run(now, now, ...articleIds).changes;

      for (const articleId of articleIds) {
        this.fts.delete(articleId);
      }

      return {
        articlesSoftDeleted,
        contentsDeleted,
        ftsRowsDeleted: articleIds.length,
        rankScoresDeleted,
        rankExplanationsDeleted
      };
    })();
  }

  findById(id: string): ArticleRow | null {
    const row = this.db
      .prepare(
        `
          ${baseArticleSelect()}
          where id = ?
        `
      )
      .get(id) as ArticleDbRow | undefined;
    return row ? mapArticle(row) : null;
  }

  findDetailById(id: string, input: { rankContext?: string } = {}): ArticleDetailRow | null {
    const rankContext = input.rankContext ?? BASE_RANK_CONTEXT;
    const row = this.db
      .prepare(
        `
          ${baseArticleReadSelect()},
          ac.content_html as contentHtml,
          ac.content_text as contentText,
          coalesce(ac.extraction_status, 'pending') as extractionStatus,
          ac.extraction_error as extractionError
          ${baseArticleReadFrom()}
          left join article_contents ac on ac.article_id = a.id
          where a.id = ?
            and a.deleted_at is null
            and a.status != 'deleted'
        `
      )
      .get(rankContext, BASE_RANK_CONTEXT, id) as ArticleDetailDbRow | undefined;

    return row ? mapArticleDetail(row) : null;
  }

  findDetailsByIds(
    articleIds: string[],
    input: { rankContext?: string } = {}
  ): ArticleDetailRow[] {
    const uniqueArticleIds = uniqueStrings(articleIds);
    if (uniqueArticleIds.length === 0) {
      return [];
    }
    const rankContext = input.rankContext ?? BASE_RANK_CONTEXT;
    const placeholders = uniqueArticleIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
          ${baseArticleReadSelect()},
          ac.content_html as contentHtml,
          ac.content_text as contentText,
          coalesce(ac.extraction_status, 'pending') as extractionStatus,
          ac.extraction_error as extractionError
          ${baseArticleReadFrom()}
          left join article_contents ac on ac.article_id = a.id
          where a.id in (${placeholders})
            and a.deleted_at is null
            and a.status != 'deleted'
        `
      )
      .all(rankContext, BASE_RANK_CONTEXT, ...uniqueArticleIds) as ArticleDetailDbRow[];
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return uniqueArticleIds.flatMap((articleId) => {
      const row = rowsById.get(articleId);
      return row ? [mapArticleDetail(row)] : [];
    });
  }

  findOfflineMetadataByIds(articleIds: string[]): OfflineArticleMetadataRow[] {
    const uniqueArticleIds = uniqueStrings(articleIds);
    if (uniqueArticleIds.length === 0) {
      return [];
    }
    const placeholders = uniqueArticleIds.map(() => "?").join(", ");
    return this.db
      .prepare(
        `
          select
            a.id as articleId,
            coalesce(a.content_hash, '') || ':' || a.updated_at || ':' ||
              coalesce(ac.updated_at, 0) as contentRevision,
            case
              when trim(coalesce(ac.content_text, '')) != '' then 1
              when trim(coalesce(ac.content_html, '')) != '' then 1
              when trim(coalesce(a.summary, '')) != '' then 1
              else 0
            end as hasReadableContent,
            s.favorited_at as favoritedAt,
            s.read_later_at as readLaterAt,
            s.last_opened_at as openedAt
          from articles a
          left join article_contents ac on ac.article_id = a.id
          left join article_states s on s.article_id = a.id
          where a.id in (${placeholders})
            and a.deleted_at is null
            and a.status != 'deleted'
        `
      )
      .all(...uniqueArticleIds)
      .map((row) => {
        const typed = row as Omit<OfflineArticleMetadataRow, "hasReadableContent"> & {
          hasReadableContent: 0 | 1;
        };
        return {
          ...typed,
          hasReadableContent: typed.hasReadableContent === 1
        };
      });
  }

  findDuplicateGroupMemberships(articleIds: string[]): ArticleDuplicateGroupMembershipRow[] {
    const uniqueArticleIds = uniqueStrings(articleIds);
    if (uniqueArticleIds.length === 0) {
      return [];
    }

    const values = uniqueArticleIds.map(() => "(?)").join(", ");
    return this.db
      .prepare(
        `
          with requested(article_id) as (
            values ${values}
          )
          select
            dgm.article_id as articleId,
            dgm.duplicate_group_id as duplicateGroupId
          from requested r
          join duplicate_group_members dgm on dgm.article_id = r.article_id
          order by dgm.article_id, dgm.duplicate_group_id
        `
      )
      .all(...uniqueArticleIds) as ArticleDuplicateGroupMembershipRow[];
  }

  findListItemsByIds(
    articleIds: string[],
    input: { rankContext?: string } = {}
  ): ArticleListItemRow[] {
    const uniqueArticleIds = uniqueStrings(articleIds);
    if (uniqueArticleIds.length === 0) {
      return [];
    }

    const rankContext = input.rankContext ?? BASE_RANK_CONTEXT;
    const values = uniqueArticleIds.map(() => "(?, ?)").join(", ");
    const params = uniqueArticleIds.flatMap((articleId, index) => [articleId, index]);
    return (
      this.db
        .prepare(
          `
            with requested(id, displayOrder) as (
              values ${values}
            )
            ${baseArticleReadSelect()}
            from requested
            join articles a on a.id = requested.id
            join feeds f on f.id = a.feed_id
              and f.deleted_at is null
              and f.enabled = 1
            left join article_states s on s.article_id = a.id
            left join article_rank_scores rs
              on rs.article_id = a.id
              and rs.rank_context = ?
            left join article_rank_scores base_rs
              on base_rs.article_id = a.id
              and base_rs.rank_context = ?
            where a.deleted_at is null
              and a.status != 'deleted'
            order by requested.displayOrder asc
          `
        )
        .all(...params, rankContext, BASE_RANK_CONTEXT) as ArticleReadDbRow[]
    ).map(mapArticleListItem);
  }

  listEmbeddingCandidates(input: {
    embeddingIndexId: string;
    articleIds?: string[];
    limit?: number;
  }): ArticleEmbeddingCandidateRow[] {
    const limit = normalizeEmbeddingCandidateLimit(input.limit);
    const params: unknown[] = [input.embeddingIndexId];
    const articleFilter =
      input.articleIds && input.articleIds.length > 0
        ? `and a.id in (${input.articleIds.map(() => "?").join(", ")})`
        : "";

    if (input.articleIds && input.articleIds.length > 0) {
      params.push(...input.articleIds);
    }
    params.push(limit);

    return (
      this.db
        .prepare(
          `
            select
              a.id as articleId,
              a.title,
              a.summary,
              ac.content_text as contentText,
              coalesce(a.content_hash, a.id || ':' || a.updated_at) as contentHash
            from articles a
            join feeds f on f.id = a.feed_id
            left join article_contents ac on ac.article_id = a.id
            left join article_embeddings ae
              on ae.article_id = a.id
             and ae.embedding_index_id = ?
            where a.deleted_at is null
              and a.status != 'deleted'
              and f.deleted_at is null
              and f.enabled = 1
              and ${EMBEDDING_ELIGIBLE_TEXT_PREDICATE}
              and (
                ae.article_id is null
                or ae.content_hash != coalesce(a.content_hash, a.id || ':' || a.updated_at)
              )
              ${articleFilter}
            order by a.discovered_at desc, a.id
            limit ?
          `
        )
        .all(...params) as ArticleEmbeddingCandidateRow[]
    );
  }

  listRetentionCandidates(input: {
    cutoff: number;
    keepFavorites?: boolean;
    keepReadLater?: boolean;
    limit?: number;
  }): ArticleRetentionCandidateRow[] {
    const limit = normalizeLimit(input.limit);
    const conditions = [
      "a.deleted_at is null",
      "a.status != 'deleted'",
      "coalesce(a.published_at, a.discovered_at) < ?"
    ];
    const params: unknown[] = [input.cutoff];

    if (input.keepFavorites ?? true) {
      conditions.push("s.favorited_at is null");
    }

    if (input.keepReadLater ?? true) {
      conditions.push("s.read_later_at is null");
    }
    params.push(limit);

    return (
      this.db
        .prepare(
          `
            select
              a.id as articleId,
              coalesce(a.published_at, a.discovered_at) as retainedAt
            from articles a
            left join article_states s on s.article_id = a.id
            where ${conditions.join("\n              and ")}
            order by coalesce(a.published_at, a.discovered_at), a.id
            limit ?
          `
        )
        .all(...params) as ArticleRetentionCandidateRow[]
    );
  }

  list(input: ArticleListInput = {}): ArticleListResult {
    const totalStartedAt = performance.now();
    const timing = createArticleListTiming();
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);
    const baseConditions = [
      "a.deleted_at is null",
      "a.status != 'deleted'",
      "s.hidden_at is null",
      "s.not_interested_at is null"
    ];
    const rankContext = input.rankContext ?? BASE_RANK_CONTEXT;
    const filterParams: unknown[] = [];

    if (input.feedId) {
      baseConditions.push("a.feed_id = ?");
      filterParams.push(input.feedId);
    }

    if (input.folderId) {
      baseConditions.push("f.folder_id = ?");
      filterParams.push(input.folderId);
    }

    if (typeof input.todayStartAt === "number" && typeof input.todayEndAt === "number") {
      baseConditions.push("coalesce(a.published_at, a.discovered_at) >= ?");
      filterParams.push(input.todayStartAt);
      baseConditions.push("coalesce(a.published_at, a.discovered_at) < ?");
      filterParams.push(input.todayEndAt);
    }

    if (input.view === "favorites") {
      baseConditions.push("s.favorited_at is not null");
    } else if (input.view === "read_later") {
      baseConditions.push("s.read_later_at is not null");
    }

    const includeUnreadCount = input.includeUnreadCount ?? true;
    let unreadCount: number | null = null;
    if (includeUnreadCount) {
      const startedAt = performance.now();
      unreadCount = this.countForConditions([...baseConditions, unreadArticleCondition()], filterParams);
      timing.unreadCountMs = elapsedMs(startedAt);
    }

    const conditions = [...baseConditions];

    if (input.status === "read") {
      conditions.push("(s.read_at is not null or coalesce(s.reading_progress, 0) >= 0.9)");
    } else if (input.status === "unread") {
      conditions.push(unreadArticleCondition());
    }

    if (input.unreadOnly && input.status !== "unread") {
      conditions.push(unreadArticleCondition());
    }

    const needsRank = needsRankForArticleList(input.view, input.sort);
    const rankParams: unknown[] = needsRank ? [rankContext, BASE_RANK_CONTEXT] : [];
    const keyset = keysetConditionForArticleList(input.view, input.sort, input.cursor);
    const pageConditions =
      keyset && input.view !== "recommended" ? [...conditions, keyset.sql] : conditions;
    const pageParams =
      keyset && input.view !== "recommended" ? [...filterParams, ...keyset.params] : filterParams;
    let pageLimit = limit;
    const rows = (() => {
      if (input.view === "recommended") {
        const page = this.listRecommendedByRank({
          rankContext,
          conditions,
          filterParams,
          limit,
          offset,
          cursor: input.cursor?.type === "recommended" ? input.cursor : null,
          timing
        });
        pageLimit = page.pageLimit;
        return page.rows;
      }

      return measureArticleListTiming(timing, "pageQueryMs", () =>
        this.db
          .prepare(
            `
              ${baseArticleReadSelect({ includeRank: needsRank })}
              ${baseArticleReadFrom({ includeRank: needsRank })}
              where ${pageConditions.join(" and ")}
              ${orderByForView(input.view, input.sort)}
              limit ?
              ${keyset ? "" : "offset ?"}
            `
          )
          .all(
            ...rankParams,
            ...pageParams,
            ...(keyset ? [limit + 1] : [limit + 1, offset])
          ) as ArticleReadDbRow[]
      );
    })();

    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
    const mapStartedAt = performance.now();
    const items = pageRows.map(mapArticleListItem);
    timing.mapMs = elapsedMs(mapStartedAt);
    const nextCursor = hasMore
      ? cursorForArticleListRow(input.view, input.sort, pageRows.at(-1) ?? null)
      : null;
    timing.totalMs = elapsedMs(totalStartedAt);

    return {
      items,
      nextOffset: hasMore ? offset + pageLimit : null,
      nextCursor,
      unreadCount,
      timing
    };
  }

  listRecentlyOpened(
    input: { limit?: number; rankContext?: string } = {}
  ): ArticleListItemRow[] {
    const limit = normalizeOfflineLimit(input.limit, 200);
    const rankContext = input.rankContext ?? BASE_RANK_CONTEXT;
    const rows = this.db
      .prepare(
        `
          ${baseArticleReadSelect({ includeRank: true })}
          ${baseArticleReadFrom({ includeRank: true })}
          where a.deleted_at is null
            and a.status != 'deleted'
            and s.last_opened_at is not null
            and s.hidden_at is null
            and s.not_interested_at is null
          order by s.last_opened_at desc, a.id desc
          limit ?
        `
      )
      .all(rankContext, BASE_RANK_CONTEXT, limit) as ArticleReadDbRow[];
    return rows.map(mapArticleListItem);
  }

  getRecommendedInventory(
    input: ArticleListInput & { rankContext: string }
  ): RecommendedArticleInventory {
    const rankContext = input.rankContext;
    const latestRerankWindowId =
      rankContext === BASE_RANK_CONTEXT ? null : this.latestRerankWindowId(rankContext);
    const conditions = [
      "a.deleted_at is null",
      "a.status != 'deleted'",
      "s.hidden_at is null",
      "s.not_interested_at is null"
    ];
    const filterParams: unknown[] = [];

    if (input.feedId) {
      conditions.push("a.feed_id = ?");
      filterParams.push(input.feedId);
    }

    if (input.folderId) {
      conditions.push("f.folder_id = ?");
      filterParams.push(input.folderId);
    }

    if (typeof input.todayStartAt === "number" && typeof input.todayEndAt === "number") {
      conditions.push("coalesce(a.published_at, a.discovered_at) >= ?");
      filterParams.push(input.todayStartAt);
      conditions.push("coalesce(a.published_at, a.discovered_at) < ?");
      filterParams.push(input.todayEndAt);
    }

    if (input.status === "read") {
      conditions.push("(s.read_at is not null or coalesce(s.reading_progress, 0) >= 0.9)");
    } else if (input.status === "unread") {
      conditions.push(unreadArticleCondition());
    }

    if (input.unreadOnly && input.status !== "unread") {
      conditions.push(unreadArticleCondition());
    }

    const row = this.db
      .prepare(
        `
          with eligible as (
            select a.id
            ${baseArticleFilterFrom()}
            where ${conditions.join(" and ")}
          )
          select
            count(*) as eligibleCount,
            coalesce(sum(case when active.article_id is not null then 1 else 0 end), 0) as sortedCount,
            coalesce(
              sum(
                case
                  when active.article_id is not null
                    and (? is null or active.rerank_window_id = ?)
                  then 1
                  else 0
                end
              ),
              0
            ) as latestActiveCount,
            coalesce(
              sum(
                case
                  when active.article_id is not null
                    and ? is not null
                    and (active.rerank_window_id is null or active.rerank_window_id != ?)
                  then 1
                  else 0
                end
              ),
              0
            ) as staleActiveCount,
            coalesce(
              sum(
                case
                  when active.article_id is null and base.article_id is not null then 1
                  else 0
                end
              ),
              0
            ) as baseFallbackCount,
            coalesce(
              sum(
                case
                  when active.article_id is null and base.article_id is null then 1
                  else 0
                end
              ),
              0
            ) as unrankedFallbackCount,
            max(active.calculated_at) as lastRankedAt
          from eligible e
          left join article_rank_scores active
            on active.article_id = e.id
            and active.rank_context = ?
          left join article_rank_scores base
            on base.article_id = e.id
            and base.rank_context = ?
        `
      )
      .get(
        ...filterParams,
        latestRerankWindowId,
        latestRerankWindowId,
        latestRerankWindowId,
        latestRerankWindowId,
        rankContext,
        BASE_RANK_CONTEXT
      ) as
      | {
          eligibleCount: number;
          sortedCount: number;
          latestActiveCount: number;
          staleActiveCount: number;
          baseFallbackCount: number;
          unrankedFallbackCount: number;
          lastRankedAt: number | null;
        }
      | undefined;

    return {
      rankContext,
      latestRerankWindowId,
      eligibleCount: row?.eligibleCount ?? 0,
      latestActiveCount: row?.latestActiveCount ?? 0,
      staleActiveCount: row?.staleActiveCount ?? 0,
      sortedCount: row?.sortedCount ?? 0,
      baseFallbackCount: row?.baseFallbackCount ?? 0,
      unrankedFallbackCount: row?.unrankedFallbackCount ?? 0,
      lastRankedAt: row?.lastRankedAt ?? null
    };
  }

  private listRecommendedByRank(input: {
    rankContext: string;
    conditions: string[];
    filterParams: unknown[];
    limit: number;
    offset: number;
    cursor: Extract<ArticleListCursor, { type: "recommended" }> | null;
    timing: ArticleListTiming;
  }): RecommendedListPage {
    const requestedTargetCount = input.cursor ? input.limit + 1 : input.offset + input.limit + 1;
    const latestActiveCandidates = this.listLatestActiveRecommendedCandidates(
      input,
      requestedTargetCount
    );
    const staleActiveCandidates =
      input.rankContext !== BASE_RANK_CONTEXT && latestActiveCandidates.length < requestedTargetCount
        ? this.listStaleActiveRecommendedCandidates(
            input,
            Math.max(0, requestedTargetCount - latestActiveCandidates.length)
          )
        : [];
    const rankedCandidates = [...latestActiveCandidates, ...staleActiveCandidates];
    const shouldUseFallbackLimit =
      input.rankContext !== BASE_RANK_CONTEXT && rankedCandidates.length < requestedTargetCount;
    const pageLimit = shouldUseFallbackLimit
      ? Math.min(input.limit, RECOMMENDED_FALLBACK_PAGE_LIMIT)
      : input.limit;
    const targetCount = input.cursor ? pageLimit + 1 : input.offset + pageLimit + 1;
    const shouldBackfillCandidates =
      input.rankContext === BASE_RANK_CONTEXT || rankedCandidates.length > 0 || input.cursor !== null;
    const missingBaseCount =
      !shouldBackfillCandidates || input.rankContext === BASE_RANK_CONTEXT
        ? 0
        : Math.max(0, targetCount - rankedCandidates.length);
    const baseFallbackCandidates =
      missingBaseCount > 0
        ? this.listBaseRecommendedCandidates(input, missingBaseCount)
        : [];
    const missingUnrankedCount = shouldBackfillCandidates
      ? Math.max(0, targetCount - rankedCandidates.length - baseFallbackCandidates.length)
      : 0;
    const unrankedCandidates =
      missingUnrankedCount > 0
        ? this.listUnrankedRecommendedCandidates(input, missingUnrankedCount)
        : [];
    const candidates = [
      ...rankedCandidates,
      ...baseFallbackCandidates,
      ...unrankedCandidates
    ];
    const pageCandidates = input.cursor
      ? candidates.slice(0, pageLimit + 1)
      : candidates.slice(input.offset, input.offset + pageLimit + 1);
    return {
      rows: measureArticleListTiming(input.timing, "hydrateMs", () =>
        this.hydrateRecommendedCandidates(input.rankContext, pageCandidates)
      ),
      pageLimit
    };
  }

  private listLatestActiveRecommendedCandidates(
    input: {
      rankContext: string;
      conditions: string[];
      filterParams: unknown[];
      cursor: Extract<ArticleListCursor, { type: "recommended" }> | null;
      timing: ArticleListTiming;
    },
    targetCount: number
  ): RecommendedCandidateRow[] {
    let candidates: RecommendedCandidateRow[] = [];
    const windows = recommendedCandidateWindows(targetCount);
    const latestRerankWindowId =
      input.rankContext === BASE_RANK_CONTEXT ? null : this.latestRerankWindowId(input.rankContext);
    for (const candidateLimit of windows) {
      const active = measureArticleListTiming(input.timing, "rankCandidateMs", () =>
        this.selectRankedRecommendedCandidates({
          rankContext: input.rankContext,
          excludeRankContext: null,
          rerankWindowId: latestRerankWindowId,
          sortRankMissing: 0,
          conditions: input.conditions,
          filterParams: input.filterParams,
          cursor: input.cursor,
          limit: candidateLimit
        })
      );
      candidates = active;
      if (
        candidates.length >= targetCount ||
        active.length < candidateLimit
      ) {
        return candidates;
      }
    }
    return candidates;
  }

  private listStaleActiveRecommendedCandidates(
    input: {
      rankContext: string;
      conditions: string[];
      filterParams: unknown[];
      cursor: Extract<ArticleListCursor, { type: "recommended" }> | null;
      timing: ArticleListTiming;
    },
    targetCount: number
  ): RecommendedCandidateRow[] {
    if (targetCount <= 0 || input.rankContext === BASE_RANK_CONTEXT) {
      return [];
    }

    let candidates: RecommendedCandidateRow[] = [];
    const windows = recommendedCandidateWindows(targetCount);
    const latestRerankWindowId = this.latestRerankWindowId(input.rankContext);
    if (!latestRerankWindowId) {
      return [];
    }
    for (const candidateLimit of windows) {
      const stale = measureArticleListTiming(input.timing, "rankCandidateMs", () =>
        this.selectRankedRecommendedCandidates({
          rankContext: input.rankContext,
          excludeRankContext: null,
          rerankWindowId: null,
          excludeRerankWindowId: latestRerankWindowId,
          sortRankMissing: 1,
          conditions: input.conditions,
          filterParams: input.filterParams,
          cursor: input.cursor,
          limit: candidateLimit
        })
      );
      candidates = stale;
      if (candidates.length >= targetCount || stale.length < candidateLimit) {
        return candidates;
      }
    }
    return candidates;
  }

  private selectRankedRecommendedCandidates(input: {
    rankContext: string;
    excludeRankContext: string | null;
    rerankWindowId: string | null;
    excludeRerankWindowId?: string | null;
    sortRankMissing: 0 | 1 | 2;
    conditions: string[];
    filterParams: unknown[];
    cursor: Extract<ArticleListCursor, { type: "recommended" }> | null;
    limit: number;
  }): RecommendedCandidateRow[] {
    if (
      input.cursor &&
      (input.cursor.rankMissing ?? 0) > input.sortRankMissing
    ) {
      return [];
    }
    const excludeActive = input.excludeRankContext
      ? `
        and not exists (
          select 1
          from article_rank_scores active
          where active.article_id = ars.article_id
            and active.rank_context = ?
        )
      `
      : "";
    const excludeParams = input.excludeRankContext ? [input.excludeRankContext] : [];
    const rerankWindowFilter = input.rerankWindowId ? "and ars.rerank_window_id = ?" : "";
    const rerankWindowParams = input.rerankWindowId ? [input.rerankWindowId] : [];
    const excludeRerankWindowFilter = input.excludeRerankWindowId
      ? "and (ars.rerank_window_id is null or ars.rerank_window_id != ?)"
      : "";
    const excludeRerankWindowParams = input.excludeRerankWindowId
      ? [input.excludeRerankWindowId]
      : [];
    const keyset = rankedRecommendedKeysetCondition(input.cursor, {
      applyWhenRankMissing: input.sortRankMissing
    });
    return this.db
      .prepare(
        `
          select
            a.id,
            ars.score as sortScore,
            case when ars.rerank_position is null then 1 else 0 end as sortRerankMissing,
            ars.rerank_position as sortRerankPosition,
            ${input.sortRankMissing} as sortRankMissing,
            coalesce(a.published_at, a.discovered_at) as sortPublishedAt
          from article_rank_scores ars
          join articles a on a.id = ars.article_id
          join feeds f on f.id = a.feed_id and f.deleted_at is null
          left join article_states s on s.article_id = a.id
          where ars.rank_context = ?
            ${rerankWindowFilter}
            ${excludeRerankWindowFilter}
            ${excludeActive}
            and ${input.conditions.join(" and ")}
            ${keyset ? `and ${keyset.sql}` : ""}
          order by
            ars.score desc,
            case when ars.rerank_position is null then 1 else 0 end,
            ars.rerank_position asc,
            coalesce(a.published_at, a.discovered_at) desc,
            a.id desc
          limit ?
        `
      )
      .all(
        input.rankContext,
        ...rerankWindowParams,
        ...excludeRerankWindowParams,
        ...excludeParams,
        ...input.filterParams,
        ...(keyset?.params ?? []),
        input.limit
      ) as RecommendedCandidateRow[];
  }

  private listBaseRecommendedCandidates(
    input: {
      rankContext: string;
      conditions: string[];
      filterParams: unknown[];
      cursor: Extract<ArticleListCursor, { type: "recommended" }> | null;
      timing: ArticleListTiming;
    },
    limit: number
  ): RecommendedCandidateRow[] {
    if (limit <= 0 || input.rankContext === BASE_RANK_CONTEXT) {
      return [];
    }

    let candidates: RecommendedCandidateRow[] = [];
    const windows = recommendedCandidateWindows(limit);
    for (const candidateLimit of windows) {
      const base = measureArticleListTiming(input.timing, "rankCandidateMs", () =>
        this.selectRankedRecommendedCandidates({
          rankContext: BASE_RANK_CONTEXT,
          excludeRankContext: input.rankContext,
          rerankWindowId: null,
          sortRankMissing: 2,
          conditions: input.conditions,
          filterParams: input.filterParams,
          cursor: input.cursor,
          limit: candidateLimit
        })
      );
      candidates = base;
      if (candidates.length >= limit || base.length < candidateLimit) {
        return candidates;
      }
    }
    return candidates;
  }

  private latestRerankWindowId(rankContext: string): string | null {
    const row = this.db
      .prepare(
        `
          select rerank_window_id as rerankWindowId
          from article_rank_scores
          where rank_context = ?
            and rerank_window_id is not null
          order by calculated_at desc, rerank_window_id desc
          limit 1
        `
      )
      .get(rankContext) as { rerankWindowId: string | null } | undefined;
    return row?.rerankWindowId ?? null;
  }

  private listUnrankedRecommendedCandidates(
    input: {
      rankContext: string;
      conditions: string[];
      filterParams: unknown[];
      cursor: Extract<ArticleListCursor, { type: "recommended" }> | null;
      timing: ArticleListTiming;
    },
    limit: number
  ): RecommendedCandidateRow[] {
    if (limit <= 0) {
      return [];
    }
    const keyset = unrankedRecommendedKeysetCondition(input.cursor);
    return measureArticleListTiming(input.timing, "unrankedCandidateMs", () =>
      this.db
        .prepare(
          `
            select
              a.id,
              null as sortScore,
              1 as sortRerankMissing,
              null as sortRerankPosition,
              2 as sortRankMissing,
              coalesce(a.published_at, a.discovered_at) as sortPublishedAt
            ${baseArticleReadFrom()}
            where ${input.conditions.join(" and ")}
              and rs.article_id is null
              and base_rs.article_id is null
              ${keyset ? `and ${keyset.sql}` : ""}
            order by
              coalesce(a.published_at, a.discovered_at) desc,
              a.id desc
            limit ?
          `
        )
        .all(
          input.rankContext,
          BASE_RANK_CONTEXT,
          ...input.filterParams,
          ...(keyset?.params ?? []),
          limit
        ) as RecommendedCandidateRow[]
    );
  }

  private hydrateRecommendedCandidates(
    rankContext: string,
    candidates: RecommendedCandidateRow[]
  ): ArticleReadDbRow[] {
    if (candidates.length === 0) {
      return [];
    }
    const values = candidates.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = candidates.flatMap((candidate, index) => [
      candidate.id,
      candidate.sortScore,
      candidate.sortRerankMissing,
      candidate.sortRerankPosition,
      candidate.sortRankMissing,
      candidate.sortPublishedAt,
      index
    ]);
    return this.db
      .prepare(
        `
          with recommended_ids (
            id,
            sortScore,
            sortRerankMissing,
            sortRerankPosition,
            sortRankMissing,
            sortPublishedAt,
            displayOrder
          ) as (
            values ${values}
          )
          ${baseArticleReadSelect({ rankSource: "recommended_ids" })}
          from recommended_ids
          join articles a on a.id = recommended_ids.id
          join feeds f on f.id = a.feed_id and f.deleted_at is null
          left join article_states s on s.article_id = a.id
          left join article_rank_scores rs
            on rs.article_id = a.id
            and rs.rank_context = ?
          left join article_rank_scores base_rs
            on base_rs.article_id = a.id
            and base_rs.rank_context = ?
          order by
            displayOrder asc
        `
      )
      .all(...params, rankContext, BASE_RANK_CONTEXT) as ArticleReadDbRow[];
  }

  search(input: ArticleSearchInput): ArticleSearchResult {
    const totalStartedAt = performance.now();
    const timing = createArticleListTiming();
    const query = input.query.trim();
    if (!query) {
      return {
        items: [],
        nextOffset: null,
        unreadCount: 0
      };
    }

    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);
    const rankContext = input.rankContext ?? BASE_RANK_CONTEXT;
    const includeUnreadCount = input.includeUnreadCount ?? true;
    const search = buildSearchHitsCte(query, input.scope ?? "default");
    const baseConditions = [
      "a.deleted_at is null",
      "a.status != 'deleted'",
      "f.deleted_at is null",
      "s.hidden_at is null",
      "s.not_interested_at is null"
    ];
    const filterParams: unknown[] = [];

    if (input.feedId) {
      baseConditions.push("a.feed_id = ?");
      filterParams.push(input.feedId);
    }

    if (input.folderId) {
      baseConditions.push("f.folder_id = ?");
      filterParams.push(input.folderId);
    }

    if (typeof input.from === "number") {
      baseConditions.push("coalesce(a.published_at, a.discovered_at) >= ?");
      filterParams.push(input.from);
    }

    if (typeof input.to === "number") {
      baseConditions.push("coalesce(a.published_at, a.discovered_at) <= ?");
      filterParams.push(input.to);
    }

    let unreadCount: number | null = null;
    if (includeUnreadCount) {
      const startedAt = performance.now();
      unreadCount = this.countForSearchConditions(search, [...baseConditions, unreadArticleCondition()], filterParams);
      timing.unreadCountMs = elapsedMs(startedAt);
    }

    const conditions = [...baseConditions];
    switch (input.state ?? "all") {
      case "unread":
        conditions.push(unreadArticleCondition());
        break;
      case "read":
        conditions.push("(s.read_at is not null or coalesce(s.reading_progress, 0) >= 0.9)");
        break;
      case "favorites":
        conditions.push("s.favorited_at is not null");
        break;
      case "read_later":
        conditions.push("s.read_later_at is not null");
        break;
      case "all":
        break;
    }

    const rows = measureArticleListTiming(timing, "pageQueryMs", () =>
      this.db
        .prepare(
          `
            ${search.sql}
            ${baseArticleReadSelect()}
            ${baseArticleReadFrom()}
            join search_hits on search_hits.article_id = a.id
            where ${conditions.join(" and ")}
            ${orderByForSearch(input.sort ?? "relevance")}
            limit ?
            offset ?
          `
        )
        .all(
          ...search.params,
          rankContext,
          BASE_RANK_CONTEXT,
          ...filterParams,
          limit + 1,
          offset
        ) as ArticleReadDbRow[]
    );

    const hasMore = rows.length > limit;
    const mapStartedAt = performance.now();
    const items = (hasMore ? rows.slice(0, limit) : rows).map(mapArticleListItem);
    timing.mapMs = elapsedMs(mapStartedAt);
    timing.totalMs = elapsedMs(totalStartedAt);

    return {
      items,
      nextOffset: hasMore ? offset + limit : null,
      unreadCount,
      timing
    };
  }

  private countForConditions(conditions: string[], params: unknown[]): number {
    const row = this.db
      .prepare(
        `
          select count(*) as count
          ${baseArticleFilterFrom()}
          where ${conditions.join(" and ")}
        `
      )
      .get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  private countForSearchConditions(
    search: SearchHitsCte,
    conditions: string[],
    filterParams: unknown[]
  ): number {
    const row = this.db
      .prepare(
        `
          ${search.sql}
          select count(*) as count
          ${baseArticleFilterFrom()}
          join search_hits on search_hits.article_id = a.id
          where ${conditions.join(" and ")}
        `
      )
      .get(...search.params, ...filterParams) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  upsert(input: UpsertArticleInput): ArticleRow {
    const now = input.now ?? Date.now();
    const discoveredAt = input.discoveredAt ?? now;

    this.db
      .prepare(
        `
          insert into articles (
            id,
            feed_id,
            guid,
            url,
            canonical_url,
            title,
            author,
            summary,
            published_at,
            discovered_at,
            content_hash,
            dedupe_key,
            status,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            feed_id = excluded.feed_id,
            guid = excluded.guid,
            url = excluded.url,
            canonical_url = excluded.canonical_url,
            title = excluded.title,
            author = excluded.author,
            summary = excluded.summary,
            published_at = excluded.published_at,
            content_hash = excluded.content_hash,
            dedupe_key = excluded.dedupe_key,
            status = case
              when articles.deleted_at is not null or articles.status = 'deleted' then 'deleted'
              else excluded.status
            end,
            updated_at = excluded.updated_at
        `
      )
      .run(
        input.id,
        input.feedId,
        input.guid ?? null,
        input.url,
        input.canonicalUrl ?? null,
        input.title,
        input.author ?? null,
        input.summary ?? null,
        input.publishedAt ?? null,
        discoveredAt,
        input.contentHash ?? null,
        input.dedupeKey,
        input.status ?? "active",
        now,
        now
      );

    this.syncFts(input.id);

    const row = this.findById(input.id);
    if (!row) {
      throw new Error(`Failed to upsert article: ${input.id}`);
    }
    return row;
  }

  upsertContent(input: UpsertArticleContentInput): UpsertArticleContentResult {
    const now = input.now ?? Date.now();
    const result = this.db.transaction((): UpsertArticleContentResult => {
      const current = this.db
        .prepare("select content_hash as contentHash from articles where id = ?")
        .get(input.articleId) as { contentHash: string | null } | undefined;
      const nextHash = input.contentHash ?? null;
      const shouldUpdateHash = input.contentHash !== undefined;
      const contentHashChanged = shouldUpdateHash && (current?.contentHash ?? null) !== nextHash;

      this.db
        .prepare(
          `
            insert into article_contents (
              article_id,
              content_html,
              content_text,
              extraction_status,
              extraction_error,
              extracted_at,
              updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?)
            on conflict(article_id) do update set
              content_html = excluded.content_html,
              content_text = excluded.content_text,
              extraction_status = excluded.extraction_status,
              extraction_error = excluded.extraction_error,
              extracted_at = excluded.extracted_at,
              updated_at = excluded.updated_at
          `
        )
        .run(
          input.articleId,
          input.contentHtml ?? null,
          input.contentText ?? null,
          input.extractionStatus ?? "pending",
          input.extractionError ?? null,
          input.extractedAt ?? null,
          now
        );

      if (shouldUpdateHash && contentHashChanged) {
        this.db
          .prepare(
            `
              update articles
              set content_hash = ?, updated_at = ?
              where id = ?
            `
          )
          .run(nextHash, now, input.articleId);
      }

      this.syncFts(input.articleId);
      return { contentHashChanged };
    })();

    return result;
  }

  private syncFts(articleId: string): void {
    const row = this.db
      .prepare(
        `
          select
            a.id as articleId,
            a.title,
            a.summary,
            ac.content_text as contentText
          from articles a
          left join article_contents ac on ac.article_id = a.id
          where a.id = ? and a.deleted_at is null
            and a.status != 'deleted'
        `
      )
      .get(articleId) as
      | {
          articleId: string;
          title: string;
          summary: string | null;
          contentText: string | null;
        }
      | undefined;

    if (!row) {
      this.fts.delete(articleId);
      return;
    }

    this.fts.upsert(row);
  }
}

type ArticleScopeUnreadCandidates = {
  sql: string;
  params: unknown[];
};

function buildArticleScopeUnreadCandidates(scope: ArticleScope): ArticleScopeUnreadCandidates {
  if (scope.type === "search") {
    return buildSearchUnreadCandidates(scope);
  }

  return buildArticleListUnreadCandidates(scope);
}

function buildArticleListUnreadCandidates(
  scope: Extract<ArticleScope, { type: "article_list" }>
): ArticleScopeUnreadCandidates {
  const conditions = [
    "a.deleted_at is null",
    "a.status != 'deleted'",
    "f.deleted_at is null",
    "s.hidden_at is null",
    "s.not_interested_at is null",
    unreadArticleCondition()
  ];
  const params: unknown[] = [];

  if (scope.feedId) {
    conditions.push("a.feed_id = ?");
    params.push(scope.feedId);
  }

  if (scope.folderId) {
    conditions.push("f.folder_id = ?");
    params.push(scope.folderId);
  }

  if (typeof scope.beforeAt === "number") {
    conditions.push("coalesce(a.published_at, a.discovered_at) < ?");
    params.push(scope.beforeAt);
  } else if (typeof scope.todayStartAt === "number" && typeof scope.todayEndAt === "number") {
    conditions.push("coalesce(a.published_at, a.discovered_at) >= ?");
    params.push(scope.todayStartAt);
    conditions.push("coalesce(a.published_at, a.discovered_at) < ?");
    params.push(scope.todayEndAt);
  }

  return {
    sql: `
      with candidates as (
        select a.id as article_id
        from articles a
        join feeds f on f.id = a.feed_id
        left join article_states s on s.article_id = a.id
        where ${conditions.join("\n          and ")}
      )
    `,
    params
  };
}

function buildSearchUnreadCandidates(
  scope: Extract<ArticleScope, { type: "search" }>
): ArticleScopeUnreadCandidates {
  const query = scope.query.trim();
  if (!query || (scope.state ?? "all") === "read") {
    return {
      sql: `
        with candidates as (
          select a.id as article_id
          from articles a
          where 1 = 0
        )
      `,
      params: []
    };
  }

  const search = buildSearchHitsCte(query);
  const conditions = [
    "a.deleted_at is null",
    "a.status != 'deleted'",
    "f.deleted_at is null",
    "s.hidden_at is null",
    "s.not_interested_at is null",
    unreadArticleCondition()
  ];
  const filterParams: unknown[] = [];

  if (scope.feedId) {
    conditions.push("a.feed_id = ?");
    filterParams.push(scope.feedId);
  }

  if (scope.folderId) {
    conditions.push("f.folder_id = ?");
    filterParams.push(scope.folderId);
  }

  if (typeof scope.from === "number") {
    conditions.push("coalesce(a.published_at, a.discovered_at) >= ?");
    filterParams.push(scope.from);
  }

  if (typeof scope.to === "number") {
    conditions.push("coalesce(a.published_at, a.discovered_at) <= ?");
    filterParams.push(scope.to);
  }

  switch (scope.state ?? "all") {
    case "favorites":
      conditions.push("s.favorited_at is not null");
      break;
    case "read_later":
      conditions.push("s.read_later_at is not null");
      break;
    case "unread":
    case "all":
      break;
    case "read":
      break;
  }

  return {
    sql: `
      ${search.sql},
      candidates as (
        select a.id as article_id
        from articles a
        join feeds f on f.id = a.feed_id
        left join article_states s on s.article_id = a.id
        join search_hits on search_hits.article_id = a.id
        where ${conditions.join("\n          and ")}
      )
    `,
    params: [...search.params, ...filterParams]
  };
}

function baseArticleSelect(): string {
  return `
    select
      id,
      feed_id as feedId,
      guid,
      url,
      canonical_url as canonicalUrl,
      title,
      author,
      summary,
      published_at as publishedAt,
      discovered_at as discoveredAt,
      content_hash as contentHash,
      dedupe_key as dedupeKey,
      status,
      created_at as createdAt,
      updated_at as updatedAt,
      deleted_at as deletedAt
    from articles
  `;
}

function unreadArticleCondition(): string {
  return `
    s.article_id is null
  `;
}

function baseArticleReadSelect(
  options: { includeRank?: boolean; rankSource?: "joined" | "recommended_ids" } = {}
): string {
  const includeRank = options.includeRank ?? true;
  const useRecommendedIdsRank = includeRank && options.rankSource === "recommended_ids";
  return `
    select
      a.id,
      a.feed_id as feedId,
      a.guid,
      a.url,
      a.canonical_url as canonicalUrl,
      a.title,
      a.author,
      a.summary,
      a.published_at as publishedAt,
      a.discovered_at as discoveredAt,
      a.content_hash as contentHash,
      a.dedupe_key as dedupeKey,
      a.status,
      a.created_at as createdAt,
      a.updated_at as updatedAt,
      a.deleted_at as deletedAt,
      f.title as feedTitle,
      case when s.read_at is not null then 1 else 0 end as read,
      case when s.favorited_at is not null then 1 else 0 end as favorited,
      case when s.liked_at is not null then 1 else 0 end as liked,
      case when s.read_later_at is not null then 1 else 0 end as readLater,
      case when s.hidden_at is not null then 1 else 0 end as hidden,
      case when s.not_interested_at is not null then 1 else 0 end as notInterested,
      coalesce(s.reading_progress, 0) as readingProgress,
      s.last_opened_at as lastOpenedAt,
      s.last_ignored_at as lastIgnoredAt,
      s.last_action_at as lastActionAt,
      s.favorited_at as favoritedAt,
      s.read_later_at as readLaterAt,
      coalesce(a.published_at, a.discovered_at) as sortPublishedAt,
      ${
        includeRank
          ? useRecommendedIdsRank
            ? "recommended_ids.sortRerankMissing"
            : "case when rs.rerank_position is null then 1 else 0 end"
          : "null"
      } as sortRerankMissing,
      ${
        includeRank
          ? useRecommendedIdsRank
            ? "recommended_ids.sortRerankPosition"
            : "rs.rerank_position"
          : "null"
      } as sortRerankPosition,
      ${
        includeRank
          ? useRecommendedIdsRank
            ? "recommended_ids.sortRankMissing"
            : "case when coalesce(rs.score, base_rs.score) is null then 1 else 0 end"
          : "null"
      } as sortRankMissing,
      ${
        includeRank
          ? useRecommendedIdsRank
            ? "recommended_ids.sortScore"
            : "coalesce(rs.score, base_rs.score)"
          : "null"
      } as rankScore,
      ${includeRank ? "coalesce(rs.calculated_at, base_rs.calculated_at)" : "null"} as rankCalculatedAt
  `;
}

function baseArticleReadFrom(options: { includeRank?: boolean } = {}): string {
  const includeRank = options.includeRank ?? true;
  return `
    from articles a
    join feeds f on f.id = a.feed_id and f.deleted_at is null
    left join article_states s on s.article_id = a.id
    ${
      includeRank
        ? `left join article_rank_scores rs
      on rs.article_id = a.id
      and rs.rank_context = ?
    left join article_rank_scores base_rs
      on base_rs.article_id = a.id
      and base_rs.rank_context = ?`
        : ""
    }
  `;
}

function needsRankForArticleList(
  view: ArticleListInput["view"],
  sort: ArticleListInput["sort"]
): boolean {
  return view === "recommended" || (view === "read_later" && (sort ?? "ranked") === "ranked");
}

function keysetConditionForArticleList(
  view: ArticleListInput["view"],
  sort: ArticleListInput["sort"],
  cursor: ArticleListInput["cursor"]
): { sql: string; params: unknown[] } | null {
  if (!cursor || cursor.type === "offset" || view === "recommended") {
    return null;
  }

  if ((view ?? "latest") === "latest" && cursor.type === "latest") {
    return desc2("coalesce(a.published_at, a.discovered_at)", "a.id", cursor.publishedAt, cursor.id);
  }

  if (view === "favorites" && cursor.type === "favorites") {
    const activeSort = sort ?? "favorited_desc";
    if (cursor.sort !== activeSort || cursor.favoritedAt === undefined) {
      return null;
    }
    switch (activeSort) {
      case "favorited_asc":
        return ascDescId("s.favorited_at", "coalesce(a.published_at, a.discovered_at)", cursor.favoritedAt, cursor.publishedAt, cursor.id);
      case "published_desc":
        return descDescId("coalesce(a.published_at, a.discovered_at)", "s.favorited_at", cursor.publishedAt, cursor.favoritedAt, cursor.id);
      case "published_asc":
        return ascDescId("coalesce(a.published_at, a.discovered_at)", "s.favorited_at", cursor.publishedAt, cursor.favoritedAt, cursor.id);
      case "favorited_desc":
      default:
        return descDescId("s.favorited_at", "coalesce(a.published_at, a.discovered_at)", cursor.favoritedAt, cursor.publishedAt, cursor.id);
    }
  }

  if (view === "read_later" && cursor.type === "read_later") {
    const activeSort = sort ?? "ranked";
    if (cursor.sort !== activeSort || cursor.readLaterAt === undefined) {
      return null;
    }
    switch (activeSort) {
      case "read_later_desc":
        return descDescId("s.read_later_at", "coalesce(a.published_at, a.discovered_at)", cursor.readLaterAt, cursor.publishedAt, cursor.id);
      case "read_later_asc":
        return ascAscId("s.read_later_at", "coalesce(a.published_at, a.discovered_at)", cursor.readLaterAt, cursor.publishedAt, cursor.id);
      case "published_desc":
        return descDescId("coalesce(a.published_at, a.discovered_at)", "s.read_later_at", cursor.publishedAt, cursor.readLaterAt, cursor.id);
      case "published_asc":
        return ascDescId("coalesce(a.published_at, a.discovered_at)", "s.read_later_at", cursor.publishedAt, cursor.readLaterAt, cursor.id);
      case "ranked":
      default:
        return rankedReadLaterKeysetCondition(cursor);
    }
  }

  return null;
}

function cursorForArticleListRow(
  view: ArticleListInput["view"],
  sort: ArticleListInput["sort"],
  row: ArticleReadDbRow | null
): ArticleListCursor | null {
  if (!row) {
    return null;
  }
  if ((view ?? "latest") === "latest") {
    return { type: "latest", publishedAt: row.sortPublishedAt, id: row.id };
  }
  if (view === "recommended") {
    return {
      type: "recommended",
      rankMissing: row.sortRankMissing ?? 1,
      rerankMissing: row.sortRerankMissing ?? 1,
      rerankPosition: row.sortRerankPosition,
      score: row.rankScore,
      publishedAt: row.sortPublishedAt,
      id: row.id
    };
  }
  if (view === "favorites" && row.favoritedAt !== null) {
    return {
      type: "favorites",
      sort: (sort ?? "favorited_desc") as ArticleFavoriteSort,
      favoritedAt: row.favoritedAt,
      publishedAt: row.sortPublishedAt,
      id: row.id
    };
  }
  if (view === "read_later" && row.readLaterAt !== null) {
    return {
      type: "read_later",
      sort: (sort ?? "ranked") as ArticleReadLaterSort,
      rankMissing: row.sortRankMissing ?? 1,
      rerankMissing: row.sortRerankMissing ?? 1,
      rerankPosition: row.sortRerankPosition,
      score: row.rankScore,
      readLaterAt: row.readLaterAt,
      publishedAt: row.sortPublishedAt,
      id: row.id
    };
  }
  return null;
}

function rankedRecommendedKeysetCondition(
  cursor: Extract<ArticleListCursor, { type: "recommended" }> | null,
  options: { applyWhenRankMissing?: 0 | 1 | 2 } = {}
): { sql: string; params: unknown[] } | null {
  if (!cursor) {
    return null;
  }
  if (
    options.applyWhenRankMissing !== undefined &&
    (cursor.rankMissing ?? 0) !== options.applyWhenRankMissing
  ) {
    return null;
  }

  const scoreExpr = "coalesce(ars.score, -1.0e308)";
  const rerankMissingExpr = "case when ars.rerank_position is null then 1 else 0 end";
  const rerankPositionExpr = "coalesce(ars.rerank_position, 9223372036854775807)";
  const score = cursor.score ?? -1.0e308;
  const rerankMissing = cursor.rerankMissing ?? 1;
  const rerankPosition = cursor.rerankPosition ?? 9223372036854775807;
  return {
    sql: `(
      ${scoreExpr} < ?
      or (${scoreExpr} = ? and ${rerankMissingExpr} > ?)
      or (${scoreExpr} = ? and ${rerankMissingExpr} = ? and ${rerankPositionExpr} > ?)
      or (${scoreExpr} = ? and ${rerankMissingExpr} = ? and ${rerankPositionExpr} = ? and coalesce(a.published_at, a.discovered_at) < ?)
      or (${scoreExpr} = ? and ${rerankMissingExpr} = ? and ${rerankPositionExpr} = ? and coalesce(a.published_at, a.discovered_at) = ? and a.id < ?)
    )`,
    params: [
      score,
      score, rerankMissing,
      score, rerankMissing, rerankPosition,
      score, rerankMissing, rerankPosition, cursor.publishedAt,
      score, rerankMissing, rerankPosition, cursor.publishedAt, cursor.id
    ]
  };
}

function unrankedRecommendedKeysetCondition(
  cursor: Extract<ArticleListCursor, { type: "recommended" }> | null
): { sql: string; params: unknown[] } | null {
  if (!cursor || (cursor.rankMissing ?? 0) === 0 || cursor.score !== null) {
    return null;
  }

  return desc2("coalesce(a.published_at, a.discovered_at)", "a.id", cursor.publishedAt, cursor.id);
}

function createArticleListTiming(): ArticleListTiming {
  return {
    unreadCountMs: 0,
    rankCandidateMs: 0,
    unrankedCandidateMs: 0,
    hydrateMs: 0,
    pageQueryMs: 0,
    mapMs: 0,
    totalMs: 0
  };
}

function measureArticleListTiming<T>(
  timing: ArticleListTiming,
  field: keyof Omit<ArticleListTiming, "totalMs">,
  work: () => T
): T {
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    timing[field] += elapsedMs(startedAt);
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function rankedReadLaterKeysetCondition(cursor: Extract<ArticleListCursor, { type: "read_later" }>): {
  sql: string;
  params: unknown[];
} {
  const missingExpr = "case when rs.rerank_position is null then 1 else 0 end";
  const positionExpr = "coalesce(rs.rerank_position, 9223372036854775807)";
  const scoreExpr = "coalesce(coalesce(rs.score, base_rs.score), -1.0e308)";
  const missing = cursor.rerankMissing ?? 1;
  const position = cursor.rerankPosition ?? 9223372036854775807;
  const score = cursor.score ?? -1.0e308;
  return {
    sql: `(
      ${missingExpr} > ?
      or (${missingExpr} = ? and ${positionExpr} > ?)
      or (${missingExpr} = ? and ${positionExpr} = ? and ${scoreExpr} < ?)
      or (${missingExpr} = ? and ${positionExpr} = ? and ${scoreExpr} = ? and s.read_later_at < ?)
      or (${missingExpr} = ? and ${positionExpr} = ? and ${scoreExpr} = ? and s.read_later_at = ? and coalesce(a.published_at, a.discovered_at) < ?)
      or (${missingExpr} = ? and ${positionExpr} = ? and ${scoreExpr} = ? and s.read_later_at = ? and coalesce(a.published_at, a.discovered_at) = ? and a.id < ?)
    )`,
    params: [
      missing,
      missing, position,
      missing, position, score,
      missing, position, score, cursor.readLaterAt,
      missing, position, score, cursor.readLaterAt, cursor.publishedAt,
      missing, position, score, cursor.readLaterAt, cursor.publishedAt, cursor.id
    ]
  };
}

function desc2(
  firstExpr: string,
  idExpr: string,
  first: number,
  id: string
): { sql: string; params: unknown[] } {
  return {
    sql: `(${firstExpr} < ? or (${firstExpr} = ? and ${idExpr} < ?))`,
    params: [first, first, id]
  };
}

function descDescId(
  firstExpr: string,
  secondExpr: string,
  first: number,
  second: number,
  id: string
): { sql: string; params: unknown[] } {
  return {
    sql: `(
      ${firstExpr} < ?
      or (${firstExpr} = ? and ${secondExpr} < ?)
      or (${firstExpr} = ? and ${secondExpr} = ? and a.id < ?)
    )`,
    params: [first, first, second, first, second, id]
  };
}

function ascDescId(
  firstExpr: string,
  secondExpr: string,
  first: number,
  second: number,
  id: string
): { sql: string; params: unknown[] } {
  return {
    sql: `(
      ${firstExpr} > ?
      or (${firstExpr} = ? and ${secondExpr} < ?)
      or (${firstExpr} = ? and ${secondExpr} = ? and a.id < ?)
    )`,
    params: [first, first, second, first, second, id]
  };
}

function ascAscId(
  firstExpr: string,
  secondExpr: string,
  first: number,
  second: number,
  id: string
): { sql: string; params: unknown[] } {
  return {
    sql: `(
      ${firstExpr} > ?
      or (${firstExpr} = ? and ${secondExpr} > ?)
      or (${firstExpr} = ? and ${secondExpr} = ? and a.id < ?)
    )`,
    params: [first, first, second, first, second, id]
  };
}

function baseArticleFilterFrom(): string {
  return `
    from articles a
    join feeds f on f.id = a.feed_id and f.deleted_at is null
    left join article_states s on s.article_id = a.id
  `;
}

function recommendedCandidateWindows(targetCount: number): number[] {
  const firstWindow = Math.max(256, targetCount * 4);
  const windows = [firstWindow, 1_024, 2_048, 4_096, 8_192]
    .filter((value) => value >= firstWindow)
    .map((value) => Math.min(value, 20_000));
  return Array.from(new Set(windows));
}

function orderByForView(
  view: ArticleListInput["view"],
  sort: ArticleListInput["sort"]
): string {
  if (view === "recommended") {
    return `
      order by
        coalesce(rs.score, base_rs.score) desc,
        case when rs.rerank_position is null then 1 else 0 end,
        rs.rerank_position asc,
        coalesce(a.published_at, a.discovered_at) desc,
        a.id desc
    `;
  }

  if (view === "favorites") {
    switch (sort ?? "favorited_desc") {
      case "favorited_asc":
        return `
          order by
            s.favorited_at asc,
            coalesce(a.published_at, a.discovered_at) desc,
            a.id desc
        `;
      case "published_desc":
        return `
          order by
            coalesce(a.published_at, a.discovered_at) desc,
            s.favorited_at desc,
            a.id desc
        `;
      case "published_asc":
        return `
          order by
            coalesce(a.published_at, a.discovered_at) asc,
            s.favorited_at desc,
            a.id desc
        `;
      case "favorited_desc":
      default:
        return `
          order by
            s.favorited_at desc,
            coalesce(a.published_at, a.discovered_at) desc,
            a.id desc
        `;
    }
  }

  if (view === "read_later") {
    switch (sort ?? "ranked") {
      case "read_later_desc":
        return `
          order by
            s.read_later_at desc,
            coalesce(a.published_at, a.discovered_at) desc,
            a.id desc
        `;
      case "read_later_asc":
        return `
          order by
            s.read_later_at asc,
            coalesce(a.published_at, a.discovered_at) asc,
            a.id desc
        `;
      case "published_desc":
        return `
          order by
            coalesce(a.published_at, a.discovered_at) desc,
            s.read_later_at desc,
            a.id desc
        `;
      case "published_asc":
        return `
          order by
            coalesce(a.published_at, a.discovered_at) asc,
            s.read_later_at desc,
            a.id desc
        `;
      case "ranked":
      case "favorited_desc":
      case "favorited_asc":
        break;
    }

    return `
      order by
        case when rs.rerank_position is null then 1 else 0 end,
        rs.rerank_position asc,
        coalesce(rs.score, base_rs.score) desc,
        s.read_later_at desc,
        coalesce(a.published_at, a.discovered_at) desc,
        a.id desc
    `;
  }

  return `
    order by
      coalesce(a.published_at, a.discovered_at) desc,
      a.id desc
  `;
}

type SearchHitsCte = {
  sql: string;
  params: unknown[];
};

function buildSearchHitsCte(
  query: string,
  scope: ArticleSearchInput["scope"] = "default"
): SearchHitsCte {
  const sanitizedFtsQuery = sanitizeFtsQuery(query);
  const useLikeFallback = sanitizedFtsQuery.length === 0 || containsHanScript(query);
  const includeFullTextFallback = scope === "full_text";
  const ctes: string[] = [];
  const hitSources: string[] = [];
  const params: unknown[] = [];

  if (sanitizedFtsQuery) {
    ctes.push(`
      fts_hits as materialized (
      select
        article_id,
        bm25(article_fts, 5.0, 2.0, 0.6) as search_rank
      from article_fts
      where article_fts match ?
      )
    `);
    hitSources.push("select article_id, search_rank from fts_hits");
    params.push(sanitizedFtsQuery);
  }

  if (useLikeFallback) {
    const likeQuery = `%${escapeLikePattern(query)}%`;
    ctes.push(`
      like_hits as (
      select
        article_id,
        case
          when title like ? escape '\\' then 8.0
          when summary like ? escape '\\' then 14.0
          else 20.0
        end as search_rank
      from article_fts
      where title like ? escape '\\'
         or summary like ? escape '\\'
         ${includeFullTextFallback ? "or content_text like ? escape '\\\\'" : ""}
      )
    `);
    hitSources.push("select article_id, search_rank from like_hits");
    params.push(likeQuery, likeQuery, likeQuery, likeQuery);
    if (includeFullTextFallback) {
      params.push(likeQuery);
    }
  }

  return {
    sql: `
      with
      ${ctes.join(",\n      ")},
      search_hits as (
        select
          article_id,
          min(search_rank) as search_rank
        from (
          ${hitSources.join("\n          union all\n")}
        )
        group by article_id
      )
    `,
    params
  };
}

function containsHanScript(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function chunkStrings(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function orderByForSearch(sort: ArticleSearchInput["sort"]): string {
  switch (sort) {
    case "recommended":
      return `
        order by
          case when rs.rerank_position is null then 1 else 0 end,
          rs.rerank_position asc,
          coalesce(rs.score, base_rs.score) desc,
          search_hits.search_rank asc,
          coalesce(a.published_at, a.discovered_at) desc,
          a.id desc
      `;
    case "latest":
      return `
        order by
          coalesce(a.published_at, a.discovered_at) desc,
          search_hits.search_rank asc,
          coalesce(rs.score, base_rs.score) desc,
          a.id desc
      `;
    case "relevance":
    default:
      return `
        order by
          search_hits.search_rank asc,
          case when rs.rerank_position is null then 1 else 0 end,
          rs.rerank_position asc,
          coalesce(rs.score, base_rs.score) desc,
          coalesce(a.published_at, a.discovered_at) desc,
          a.id desc
      `;
  }
}

function mapArticle(row: ArticleDbRow): ArticleRow {
  return row;
}

function mapArticleListItem(row: ArticleReadDbRow): ArticleListItemRow {
  return {
    id: row.id,
    feedId: row.feedId,
    feedTitle: row.feedTitle,
    title: row.title,
    url: row.url,
    author: row.author,
    summary: row.summary,
    publishedAt: row.publishedAt,
    discoveredAt: row.discoveredAt,
    state: {
      read: row.read === 1,
      favorited: row.favorited === 1,
      liked: row.liked === 1,
      readLater: row.readLater === 1,
      hidden: row.hidden === 1,
      notInterested: row.notInterested === 1,
      readingProgress: row.readingProgress,
      interactionStatus: interactionStatusForArticle(row),
      openedAt: row.lastOpenedAt,
      ignoredAt: ignoredAtForArticle(row)
    },
    rank:
      row.rankScore === null || row.rankCalculatedAt === null
        ? null
        : {
            score: row.rankScore,
            calculatedAt: row.rankCalculatedAt
          }
  };
}

function mapArticleDetail(row: ArticleDetailDbRow): ArticleDetailRow {
  return {
    ...mapArticleListItem(row),
    contentHtml: row.contentHtml,
    contentText: row.contentText,
    extractionStatus: row.extractionStatus,
    extractionError: row.extractionError
  };
}

function interactionStatusForArticle(row: ArticleReadDbRow): ArticleInteractionStatus {
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

function ignoredAtForArticle(row: ArticleReadDbRow): number | null {
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

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function normalizeEmbeddingCandidateLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 1_000);
}

function normalizeOfflineLimit(limit: number | undefined, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return Math.min(50, max);
  }
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) {
    return 0;
  }

  return Math.max(Math.trunc(offset), 0);
}
