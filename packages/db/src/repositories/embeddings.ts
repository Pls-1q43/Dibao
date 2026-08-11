import type {
  DibaoDatabase,
  ArticleVectorRow,
  EmbeddingIndexInput,
  EmbeddingIndexListRow,
  EmbeddingIndexRow,
  EmbeddingIndexUsage,
  EmbeddingProviderInput,
  EmbeddingProviderRow,
  EmbeddingProviderTestResultInput,
  EmbeddingUsageWindow,
  UpdateEmbeddingProviderInput
} from "../types.js";
import { safeVecTableName } from "../vector/sqlite-vec-vector-store.js";

const EMBEDDING_ELIGIBLE_TEXT_PREDICATE = `
  (
    trim(coalesce(a.title, '')) != ''
    or trim(coalesce(a.summary, '')) != ''
    or trim(substr(coalesce(ac.content_text, ''), 1, 256)) != ''
  )
`;
const DEFAULT_EMBEDDING_TEXT_MAX_CHARS = 8_000;
const DEFAULT_OLLAMA_EMBEDDING_TEXT_MAX_CHARS = 4_000;

export interface EmbeddingRepository {
  deleteProvider(id: string): boolean;
  disableOtherProviders(enabledProviderId: string, now?: number): void;
  findActiveIndex(): EmbeddingIndexRow | null;
  findActiveProvider(): EmbeddingProviderRow | null;
  findActiveProviderWithIndex(): { provider: EmbeddingProviderRow; index: EmbeddingIndexRow } | null;
  findArticleVectors(input: {
    embeddingIndexId: string;
    articleIds: string[];
  }): ArticleVectorRow[];
  upsertProvider(input: EmbeddingProviderInput): void;
  updateProvider(input: UpdateEmbeddingProviderInput): EmbeddingProviderRow | null;
  recordProviderTestResult(input: EmbeddingProviderTestResultInput): EmbeddingProviderRow | null;
  findProviderById(id: string): EmbeddingProviderRow | null;
  listProviders(): EmbeddingProviderRow[];
  createIndex(input: Omit<EmbeddingIndexInput, "tableName"> & { tableName?: string }): EmbeddingIndexRow;
  findIndexById(id: string): EmbeddingIndexRow | null;
  findActiveIndexForProvider(providerId: string): EmbeddingIndexRow | null;
  listIndexes(): EmbeddingIndexListRow[];
  markIndexStatus(id: string, status: EmbeddingIndexRow["status"], now?: number): EmbeddingIndexRow | null;
  providerHasIndexes(providerId: string): boolean;
  retireActiveIndexesForProvider(providerId: string, exceptIndexId?: string, now?: number): number;
}

export class SqliteEmbeddingRepository implements EmbeddingRepository {
  constructor(private readonly db: DibaoDatabase) {}

  deleteProvider(id: string): boolean {
    return this.db.prepare("delete from embedding_providers where id = ?").run(id).changes > 0;
  }

  disableOtherProviders(enabledProviderId: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `
          update embedding_providers
          set enabled = 0,
              updated_at = ?
          where id != ?
            and enabled = 1
        `
      )
      .run(now, enabledProviderId);
  }

  findActiveProvider(): EmbeddingProviderRow | null {
    const row = this.db
      .prepare(
        `
          ${baseProviderSelect()}
          where enabled = 1
          order by updated_at desc, id
          limit 1
        `
      )
      .get() as EmbeddingProviderDbRow | undefined;

    return row ? mapProvider(row) : null;
  }

  findActiveProviderWithIndex(): { provider: EmbeddingProviderRow; index: EmbeddingIndexRow } | null {
    const provider = this.findActiveProvider();
    if (!provider) {
      return null;
    }

    const index = this.findActiveIndexForProvider(provider.id);
    return index ? { provider, index } : null;
  }

  findArticleVectors(input: {
    embeddingIndexId: string;
    articleIds: string[];
  }): ArticleVectorRow[] {
    const articleIds = uniqueStrings(input.articleIds);
    if (articleIds.length === 0) {
      return [];
    }

    const values = articleIds.map(() => "(?)").join(", ");
    return this.db
      .prepare(
        `
          with requested(article_id) as (
            values ${values}
          )
          select
            ae.article_id as articleId,
            ae.vector_blob as vectorBlob,
            ae.content_hash as contentHash
          from requested r
          join article_embeddings ae
            on ae.article_id = r.article_id
           and ae.embedding_index_id = ?
        `
      )
      .all(...articleIds, input.embeddingIndexId) as ArticleVectorRow[];
  }

  upsertProvider(input: EmbeddingProviderInput): void {
    const now = input.now ?? Date.now();

    this.db.transaction(() => {
      if (input.enabled) {
        this.disableOtherProviders(input.id, now);
      }

      this.db
        .prepare(
          `
            insert into embedding_providers (
              id,
              type,
              name,
              base_url,
              model,
              dimension,
              text_max_chars,
              requests_per_minute,
              requests_per_day,
              api_key_encrypted,
              enabled,
              quality_tier,
              created_at,
              updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
              type = excluded.type,
              name = excluded.name,
              base_url = excluded.base_url,
              model = excluded.model,
              dimension = excluded.dimension,
              text_max_chars = excluded.text_max_chars,
              requests_per_minute = excluded.requests_per_minute,
              requests_per_day = excluded.requests_per_day,
              api_key_encrypted = excluded.api_key_encrypted,
              enabled = excluded.enabled,
              quality_tier = excluded.quality_tier,
              updated_at = excluded.updated_at
          `
        )
        .run(
          input.id,
          input.type,
          input.name,
          input.baseUrl ?? null,
          input.model,
          input.dimension,
          input.textMaxChars ?? defaultTextMaxCharsForProvider(input.type),
          input.requestsPerMinute ?? null,
          input.requestsPerDay ?? null,
          input.apiKeyEncrypted ?? null,
          input.enabled ? 1 : 0,
          input.qualityTier ?? "basic",
          now,
          now
        );
    })();
  }

  updateProvider(input: UpdateEmbeddingProviderInput): EmbeddingProviderRow | null {
    const existing = this.findProviderById(input.id);
    if (!existing) {
      return null;
    }

    const now = input.now ?? Date.now();
    const enabled = input.enabled ?? existing.enabled;

    return this.db.transaction(() => {
      if (enabled) {
        this.disableOtherProviders(input.id, now);
      }

      this.db
        .prepare(
          `
            update embedding_providers
            set
              type = ?,
              name = ?,
              base_url = ?,
              model = ?,
              dimension = ?,
              text_max_chars = ?,
              requests_per_minute = ?,
              requests_per_day = ?,
              api_key_encrypted = ?,
              enabled = ?,
              quality_tier = ?,
              updated_at = ?
            where id = ?
          `
        )
        .run(
          input.type ?? existing.type,
          input.name ?? existing.name,
          input.baseUrl === undefined ? existing.baseUrl : input.baseUrl,
          input.model ?? existing.model,
          input.dimension ?? existing.dimension,
          input.textMaxChars ?? existing.textMaxChars,
          input.requestsPerMinute === undefined ? existing.requestsPerMinute : input.requestsPerMinute,
          input.requestsPerDay === undefined ? existing.requestsPerDay : input.requestsPerDay,
          input.apiKeyEncrypted === undefined ? existing.apiKeyEncrypted : input.apiKeyEncrypted,
          enabled ? 1 : 0,
          input.qualityTier ?? existing.qualityTier,
          now,
          input.id
        );

      return this.findProviderById(input.id);
    })();
  }

  recordProviderTestResult(
    input: EmbeddingProviderTestResultInput
  ): EmbeddingProviderRow | null {
    const now = input.now ?? input.testedAt;
    this.db
      .prepare(
        `
          update embedding_providers
          set
            last_test_status = ?,
            last_test_error = ?,
            last_test_at = ?,
            updated_at = ?
          where id = ?
        `
      )
      .run(input.status, input.error ?? null, input.testedAt, now, input.id);

    return this.findProviderById(input.id);
  }

  findProviderById(id: string): EmbeddingProviderRow | null {
    const row = this.db
      .prepare(
        `
          ${baseProviderSelect()}
          where id = ?
        `
      )
      .get(id) as EmbeddingProviderDbRow | undefined;

    return row ? mapProvider(row) : null;
  }

  listProviders(): EmbeddingProviderRow[] {
    return (
      this.db
        .prepare(
          `
            ${baseProviderSelect()}
            order by enabled desc, updated_at desc, id
          `
        )
        .all() as EmbeddingProviderDbRow[]
    ).map(mapProvider);
  }

  createIndex(
    input: Omit<EmbeddingIndexInput, "tableName"> & { tableName?: string }
  ): EmbeddingIndexRow {
    const now = input.now ?? Date.now();
    const tableName = input.tableName ?? safeVecTableName(input.id);

    this.db
      .prepare(
        `
          insert into embedding_indexes (
            id,
            provider_id,
            model,
            dimension,
            text_max_chars,
            distance_metric,
            table_name,
            status,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.id,
        input.providerId,
        input.model,
        input.dimension,
        input.textMaxChars ?? DEFAULT_EMBEDDING_TEXT_MAX_CHARS,
        input.distanceMetric ?? "cosine",
        tableName,
        input.status ?? "active",
        now,
        now
      );

    const index = this.findIndexById(input.id);
    if (!index) {
      throw new Error(`Failed to create embedding index: ${input.id}`);
    }
    return index;
  }

  findIndexById(id: string): EmbeddingIndexRow | null {
    const row = this.db
      .prepare(
        `
          select
            id,
            provider_id as providerId,
            model,
            dimension,
            text_max_chars as textMaxChars,
            distance_metric as distanceMetric,
            table_name as tableName,
            status,
            created_at as createdAt,
            updated_at as updatedAt
          from embedding_indexes
          where id = ?
        `
      )
      .get(id) as EmbeddingIndexRow | undefined;

    return row ?? null;
  }

  findActiveIndex(): EmbeddingIndexRow | null {
    const row = this.db
      .prepare(
        `
          ${baseIndexSelect()}
          where status = 'active'
          order by updated_at desc, id
          limit 1
        `
      )
      .get() as EmbeddingIndexRow | undefined;

    return row ?? null;
  }

  findActiveIndexForProvider(providerId: string): EmbeddingIndexRow | null {
    const row = this.db
      .prepare(
        `
          ${baseIndexSelect()}
          where provider_id = ?
            and status = 'active'
          order by updated_at desc, id
          limit 1
        `
      )
      .get(providerId) as EmbeddingIndexRow | undefined;

    return row ?? null;
  }

  listIndexes(): EmbeddingIndexListRow[] {
    return (
      this.db
        .prepare(
          `
            with eligible_article_rows as (
              select
                a.id as articleId,
                coalesce(a.content_hash, a.id || ':' || a.updated_at) as contentHash
              from articles a
              join feeds f on f.id = a.feed_id
              left join article_contents ac on ac.article_id = a.id
              where a.deleted_at is null
                and a.status != 'deleted'
                and f.deleted_at is null
                and f.enabled = 1
                and ${EMBEDDING_ELIGIBLE_TEXT_PREDICATE}
            ),
            eligible_articles as (
              select count(*) as candidateCount
              from eligible_article_rows
            ),
            job_diagnostics as (
              select
                json_extract(j.payload_json, '$.embeddingIndexId') as embeddingIndexId,
                sum(case when j.status in ('queued', 'running') then 1 else 0 end) as pendingJobs
              from jobs j
              where j.type = 'embedding_generate'
                and j.payload_json is not null
                and json_valid(j.payload_json)
              group by json_extract(j.payload_json, '$.embeddingIndexId')
            ),
            failed_job_articles as (
              select
                json_extract(j.payload_json, '$.embeddingIndexId') as embeddingIndexId,
                j.id as jobId,
                j.error as error,
                coalesce(j.finished_at, j.updated_at) as failedAt,
                article.value as articleId
              from jobs j,
                json_each(j.payload_json, '$.articleIds') article
              where j.type = 'embedding_generate'
                and j.status = 'failed'
                and j.payload_json is not null
                and json_valid(j.payload_json)
            ),
            actionable_failed_jobs as (
              select
                fja.embeddingIndexId,
                count(distinct fja.jobId) as failedJobs,
                max(fja.failedAt) as lastFailedAt
              from failed_job_articles fja
              join eligible_article_rows ear on ear.articleId = fja.articleId
              left join article_embeddings ae
                on ae.article_id = ear.articleId
               and ae.embedding_index_id = fja.embeddingIndexId
              where ae.article_id is null
                or ae.content_hash != ear.contentHash
              group by fja.embeddingIndexId
            )
            select
              ei.id,
              ei.provider_id as providerId,
              ei.model,
              ei.dimension,
              ei.text_max_chars as textMaxChars,
              ei.distance_metric as distanceMetric,
              ei.table_name as tableName,
              ei.status,
              ei.created_at as createdAt,
              ei.updated_at as updatedAt,
              ea.candidateCount as candidateCount,
              ea.candidateCount as eligibleArticleCount,
              (
                select count(*)
                from eligible_article_rows ear
                left join article_embeddings ae
                  on ae.article_id = ear.articleId
                 and ae.embedding_index_id = ei.id
                where ae.article_id is null
              ) as missingEmbeddingCount,
              (
                select count(*)
                from eligible_article_rows ear
                join article_embeddings ae
                  on ae.article_id = ear.articleId
                 and ae.embedding_index_id = ei.id
                where ae.content_hash != ear.contentHash
              ) as staleEmbeddingCount,
              (
                select count(*)
                from eligible_article_rows ear
                join article_embeddings ae
                  on ae.article_id = ear.articleId
                 and ae.embedding_index_id = ei.id
                where ae.content_hash = ear.contentHash
              ) as coveredArticleCount,
              (
                select count(*)
                from article_embeddings ae
                where ae.embedding_index_id = ei.id
              ) as embeddingCount,
              0 as coverageRatio,
              coalesce(jd.pendingJobs, 0) as pendingJobs,
              coalesce(afj.failedJobs, 0) as failedJobs,
              afj.lastFailedAt as lastFailedAt,
              (
                select fja.error
                from failed_job_articles fja
                join eligible_article_rows ear on ear.articleId = fja.articleId
                left join article_embeddings ae
                  on ae.article_id = ear.articleId
                 and ae.embedding_index_id = fja.embeddingIndexId
                where fja.embeddingIndexId = ei.id
                  and (
                    ae.article_id is null
                    or ae.content_hash != ear.contentHash
                  )
                order by fja.failedAt desc, fja.jobId desc
                limit 1
              ) as lastError
            from embedding_indexes ei
            cross join eligible_articles ea
            left join job_diagnostics jd on jd.embeddingIndexId = ei.id
            left join actionable_failed_jobs afj on afj.embeddingIndexId = ei.id
            order by
              case ei.status
                when 'active' then 0
                when 'building' then 1
                when 'failed' then 2
                else 3
              end,
              ei.updated_at desc,
              ei.id
          `
        )
        .all() as EmbeddingIndexListRow[]
    ).map((row) => ({
      ...row,
      coverageRatio: coverageRatio(row.coveredArticleCount, row.candidateCount),
      usage: usageForIndex(this.db, row.id)
    }));
  }

  markIndexStatus(
    id: string,
    status: EmbeddingIndexRow["status"],
    now: number = Date.now()
  ): EmbeddingIndexRow | null {
    this.db
      .prepare(
        `
          update embedding_indexes
          set status = ?,
              updated_at = ?
          where id = ?
        `
      )
      .run(status, now, id);

    return this.findIndexById(id);
  }

  providerHasIndexes(providerId: string): boolean {
    const row = this.db
      .prepare("select 1 as found from embedding_indexes where provider_id = ? limit 1")
      .get(providerId) as { found: number } | undefined;

    return Boolean(row);
  }

  retireActiveIndexesForProvider(
    providerId: string,
    exceptIndexId?: string,
    now: number = Date.now()
  ): number {
    const result = this.db
      .prepare(
        `
          update embedding_indexes
          set status = 'retired',
              updated_at = ?
          where provider_id = ?
            and status = 'active'
            and (? is null or id != ?)
        `
      )
      .run(now, providerId, exceptIndexId ?? null, exceptIndexId ?? null);

    return result.changes;
  }
}

type EmbeddingProviderDbRow = Omit<EmbeddingProviderRow, "enabled"> & {
  enabled: 0 | 1;
};

function baseProviderSelect(): string {
  return `
    select
      id,
      type,
      name,
      base_url as baseUrl,
      model,
      dimension,
      text_max_chars as textMaxChars,
      requests_per_minute as requestsPerMinute,
      requests_per_day as requestsPerDay,
      api_key_encrypted as apiKeyEncrypted,
      enabled,
      quality_tier as qualityTier,
      last_test_status as lastTestStatus,
      last_test_error as lastTestError,
      last_test_at as lastTestAt,
      created_at as createdAt,
      updated_at as updatedAt
    from embedding_providers
  `;
}

function defaultTextMaxCharsForProvider(type: EmbeddingProviderInput["type"]): number {
  return type === "ollama"
    ? DEFAULT_OLLAMA_EMBEDDING_TEXT_MAX_CHARS
    : DEFAULT_EMBEDDING_TEXT_MAX_CHARS;
}

function mapProvider(row: EmbeddingProviderDbRow): EmbeddingProviderRow {
  return {
    ...row,
    enabled: row.enabled === 1
  };
}

function coverageRatio(coveredArticleCount: number, candidateCount: number): number {
  return candidateCount === 0 ? 0 : Math.min(1, coveredArticleCount / candidateCount);
}

function usageForIndex(db: DibaoDatabase, embeddingIndexId: string): EmbeddingIndexUsage {
  const now = Date.now();
  return {
    windows: {
      "24h": usageWindowForIndex(db, embeddingIndexId, now - 24 * 60 * 60 * 1000),
      "7d": usageWindowForIndex(db, embeddingIndexId, now - 7 * 24 * 60 * 60 * 1000),
      "30d": usageWindowForIndex(db, embeddingIndexId, now - 30 * 24 * 60 * 60 * 1000)
    }
  };
}

function usageWindowForIndex(
  db: DibaoDatabase,
  embeddingIndexId: string,
  since: number
): EmbeddingUsageWindow {
  const row = db
    .prepare(
      `
        select
          coalesce(sum(request_count), 0) as requestCount,
          coalesce(sum(item_count), 0) as itemCount,
          coalesce(sum(estimated_tokens), 0) as estimatedTokens
        from embedding_usage_events
        where embedding_index_id = ?
          and created_at >= ?
      `
    )
    .get(embeddingIndexId, since) as EmbeddingUsageWindow | undefined;

  return {
    requestCount: row?.requestCount ?? 0,
    itemCount: row?.itemCount ?? 0,
    estimatedTokens: row?.estimatedTokens ?? 0
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function baseIndexSelect(): string {
  return `
    select
      id,
      provider_id as providerId,
      model,
      dimension,
      text_max_chars as textMaxChars,
      distance_metric as distanceMetric,
      table_name as tableName,
      status,
      created_at as createdAt,
      updated_at as updatedAt
    from embedding_indexes
  `;
}
