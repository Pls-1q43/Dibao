import { randomBytes } from "node:crypto";
import type {
  ArticleEmbeddingCandidateRow,
  ArticleRepository,
  EmbeddingRepository,
  JobRepository,
  JobRow,
  VectorStore
} from "@dibao/db";
import {
  EmbeddingProviderError,
  type EmbeddingInput,
  type EmbeddingProviderAdapter,
  type EmbeddingProviderConfig,
  type EmbeddingVector
} from "./embedding/types.js";
import type { EmbeddingProviderService } from "./embedding-provider-service.js";
import { DeferredJobRun, PermanentJobFailure } from "./job-runner.js";
import type { ProfileService } from "./profile-service.js";
import {
  RANKING_RECALCULATE_REFRESH_DELAY_MS,
  type RankingRecalculateJobService
} from "./ranking-job-service.js";

export const EMBEDDING_GENERATE_JOB_TYPE = "embedding_generate" as const;
export const OPENAI_COMPATIBLE_EMBEDDING_BATCH_SIZE = 16;
export const OLLAMA_EMBEDDING_BATCH_SIZE = 4;
export const EMBEDDING_JOB_ARTICLE_LIMIT = OPENAI_COMPATIBLE_EMBEDDING_BATCH_SIZE;
export const EMBEDDING_TEXT_MAX_CHARS = 8_000;
export const EMBEDDING_BACKFILL_LIMIT = 1_000;

export type EmbeddingGenerateJobPayload = {
  embeddingIndexId: string;
  articleIds: string[];
};

export type EmbeddingBackfillEnqueueResult = {
  jobIds: string[];
  candidateCount: number;
  enqueuedArticleCount: number;
  dedupedArticleCount: number;
};

export type EmbeddingJobServiceOptions = {
  articles: Pick<ArticleRepository, "listEmbeddingCandidates">;
  embeddings: EmbeddingRepository;
  jobs: JobRepository;
  providerService: Pick<EmbeddingProviderService, "activeProviderConfig">;
  profile?: Pick<ProfileService, "processArticleEvents">;
  rankingJobs?: Pick<RankingRecalculateJobService, "enqueueAll" | "enqueueArticles">;
  recordUsage?: (input: {
    providerId: string;
    embeddingIndexId: string;
    model: string;
    itemCount: number;
    estimatedTokens: number;
    now: number;
  }) => void;
  requestCountSince?: (input: { providerId: string; since: number; now: number }) => number;
  vectorStore: Pick<VectorStore, "upsertArticleVector">;
  now?: () => number;
  jobIdFactory?: () => string;
};

export class EmbeddingJobService {
  private readonly now: () => number;
  private readonly jobIdFactory: () => string;

  constructor(private readonly options: EmbeddingJobServiceOptions) {
    this.now = options.now ?? Date.now;
    this.jobIdFactory = options.jobIdFactory ?? randomJobId;
  }

  enqueueArticlesForActiveIndex(articleIds: string[]): JobRow[] {
    const active = this.options.providerService.activeProviderConfig();
    if (!active || articleIds.length === 0) {
      return [];
    }

    const candidates = this.options.articles.listEmbeddingCandidates({
      embeddingIndexId: active.index.id,
      articleIds: uniqueStrings(articleIds),
      limit: EMBEDDING_BACKFILL_LIMIT
    });

    return this.enqueueCandidates(active.index.id, candidates, embeddingBatchSizeFor(active.provider.type)).jobs;
  }

  enqueueBackfillForActiveIndex(): JobRow[] {
    const active = this.options.providerService.activeProviderConfig();
    if (!active) {
      return [];
    }

    const candidates = this.options.articles.listEmbeddingCandidates({
      embeddingIndexId: active.index.id,
      limit: EMBEDDING_BACKFILL_LIMIT
    });

    return this.enqueueCandidates(active.index.id, candidates, embeddingBatchSizeFor(active.provider.type)).jobs;
  }

  enqueueBackfillForIndex(embeddingIndexId: string): EmbeddingBackfillEnqueueResult {
    const active = this.options.providerService.activeProviderConfig();
    if (!active || active.index.id !== embeddingIndexId) {
      return {
        jobIds: [],
        candidateCount: 0,
        enqueuedArticleCount: 0,
        dedupedArticleCount: 0
      };
    }

    const candidates = this.options.articles.listEmbeddingCandidates({
      embeddingIndexId,
      limit: EMBEDDING_BACKFILL_LIMIT
    });
    const result = this.enqueueCandidates(
      embeddingIndexId,
      candidates,
      embeddingBatchSizeFor(active.provider.type)
    );

    return {
      jobIds: result.jobs.map((job) => job.id),
      candidateCount: result.candidateCount,
      enqueuedArticleCount: result.enqueuedArticleCount,
      dedupedArticleCount: result.dedupedArticleCount
    };
  }

  async handleEmbeddingGenerateJob(job: JobRow): Promise<void> {
    const payload = parseEmbeddingGeneratePayload(job.payloadJson);
    if (!payload) {
      throw new PermanentJobFailure("Invalid embedding_generate job payload");
    }

    const index = this.options.embeddings.findIndexById(payload.embeddingIndexId);
    if (!index) {
      throw new PermanentJobFailure("Embedding index not found");
    }

    if (index.status !== "active") {
      return;
    }

    const provider = this.options.embeddings.findProviderById(index.providerId);
    if (!provider || !provider.enabled) {
      return;
    }

    const active = this.options.providerService.activeProviderConfig();
    if (!active || active.index.id !== index.id || active.provider.id !== provider.id) {
      return;
    }

    const candidates = this.options.articles.listEmbeddingCandidates({
      embeddingIndexId: index.id,
      articleIds: payload.articleIds,
      limit: EMBEDDING_JOB_ARTICLE_LIMIT
    });
    if (candidates.length === 0) {
      this.enqueueNextBackfillBatchIfDrained(index.id, provider.type);
      return;
    }

    const writtenArticleIds: string[] = [];

    try {
      for (const chunk of chunks(candidates, embeddingBatchSizeFor(provider.type))) {
        this.assertProviderRequestAllowed(provider);
        let items = chunk.map((candidate) => ({
          id: candidate.articleId,
          text: textForEmbedding(candidate, provider.textMaxChars)
        }));
        const embeddingResult = await embedBatchWithOllamaContextRetry({
          adapter: active.adapter,
          provider: active.provider,
          items
        });
        items = embeddingResult.items;
        const vectors = embeddingResult.vectors;
        this.options.recordUsage?.({
          providerId: provider.id,
          embeddingIndexId: index.id,
          model: provider.model,
          itemCount: items.length,
          estimatedTokens: items.reduce(
            (total, item) => total + estimateEmbeddingTokens(item.text),
            0
          ),
          now: this.now()
        });
        const vectorByArticleId = new Map(vectors.map((vector) => [vector.id, vector.vector]));
        const now = this.now();
        for (const candidate of chunk) {
          const vector = vectorByArticleId.get(candidate.articleId);
          if (!vector) {
            throw new PermanentJobFailure("Provider response did not include every article vector");
          }

          this.options.vectorStore.upsertArticleVector({
            articleId: candidate.articleId,
            embeddingIndexId: index.id,
            vector,
            contentHash: candidate.contentHash,
            now
          });
          writtenArticleIds.push(candidate.articleId);
        }
      }

      this.enqueueRankingForWrittenArticles(writtenArticleIds);

      this.enqueueNextBackfillBatchIfDrained(index.id, provider.type);
    } catch (error) {
      if (error instanceof DeferredJobRun) {
        this.enqueueRankingForWrittenArticles(writtenArticleIds);
        throw error;
      }
      if (error instanceof PermanentJobFailure) {
        throw error;
      }
      if (error instanceof EmbeddingProviderError) {
        if (error.retryable) {
          throw error;
        }
        throw new PermanentJobFailure(error.message, error.details);
      }
      if (error instanceof Error && error.message.includes("Vector dimension mismatch")) {
        throw new PermanentJobFailure(error.message);
      }
      throw error;
    }
  }

  private enqueueCandidates(
    embeddingIndexId: string,
    candidates: ArticleEmbeddingCandidateRow[],
    batchSize: number
  ): {
    jobs: JobRow[];
    candidateCount: number;
    enqueuedArticleCount: number;
    dedupedArticleCount: number;
  } {
    const openArticleIds = this.openArticleIdsForIndex(embeddingIndexId);
    const candidateArticleIds = uniqueStrings(candidates.map((candidate) => candidate.articleId));
    const articleIds = candidateArticleIds
      .filter((articleId) => !openArticleIds.has(articleId));
    const jobs: JobRow[] = [];
    const now = this.now();

    for (const chunk of chunks(articleIds, batchSize)) {
      if (chunk.length === 0) {
        continue;
      }

      jobs.push(
        this.options.jobs.enqueue({
          id: this.jobIdFactory(),
          type: EMBEDDING_GENERATE_JOB_TYPE,
          payloadJson: JSON.stringify({
            embeddingIndexId,
            articleIds: chunk
          } satisfies EmbeddingGenerateJobPayload),
          maxAttempts: 3,
          runAfter: now,
          now
        })
      );
    }

    return {
      jobs,
      candidateCount: candidateArticleIds.length,
      enqueuedArticleCount: articleIds.length,
      dedupedArticleCount: candidateArticleIds.length - articleIds.length
    };
  }

  private openArticleIdsForIndex(embeddingIndexId: string): Set<string> {
    const ids = new Set<string>();

    for (const { payload } of this.openEmbeddingJobsForIndex(embeddingIndexId)) {
      for (const articleId of payload.articleIds) {
        ids.add(articleId);
      }
    }

    return ids;
  }

  private enqueueRankingForWrittenArticles(writtenArticleIds: string[]): void {
    if (writtenArticleIds.length === 0) {
      return;
    }

    const profileResult = this.options.profile?.processArticleEvents(writtenArticleIds);
    if (profileResult?.profileChanged || profileResult?.feedStatsChanged) {
      this.options.rankingJobs?.enqueueAll({ delayMs: RANKING_RECALCULATE_REFRESH_DELAY_MS });
    } else {
      this.options.rankingJobs?.enqueueArticles(writtenArticleIds, {
        delayMs: RANKING_RECALCULATE_REFRESH_DELAY_MS
      });
    }
  }

  private enqueueNextBackfillBatchIfDrained(
    embeddingIndexId: string,
    providerType: string
  ): EmbeddingBackfillEnqueueResult | null {
    const openJobs = this.openEmbeddingJobsForIndex(embeddingIndexId);
    if (openJobs.length > 1) {
      return null;
    }

    const candidates = this.options.articles.listEmbeddingCandidates({
      embeddingIndexId,
      limit: EMBEDDING_BACKFILL_LIMIT
    });
    const result = this.enqueueCandidates(
      embeddingIndexId,
      candidates,
      embeddingBatchSizeFor(providerType)
    );

    return {
      jobIds: result.jobs.map((job) => job.id),
      candidateCount: result.candidateCount,
      enqueuedArticleCount: result.enqueuedArticleCount,
      dedupedArticleCount: result.dedupedArticleCount
    };
  }

  private openEmbeddingJobsForIndex(
    embeddingIndexId: string
  ): Array<{ job: JobRow; payload: EmbeddingGenerateJobPayload }> {
    const jobs: Array<{ job: JobRow; payload: EmbeddingGenerateJobPayload }> = [];

    for (const job of this.options.jobs.listOpenByType(EMBEDDING_GENERATE_JOB_TYPE)) {
      const payload = parseEmbeddingGeneratePayload(job.payloadJson);
      if (!payload || payload.embeddingIndexId !== embeddingIndexId) {
        continue;
      }

      jobs.push({ job, payload });
    }

    return jobs;
  }

  private assertProviderRequestAllowed(provider: {
    id: string;
    requestsPerMinute: number | null;
    requestsPerDay: number | null;
  }): void {
    if (!this.options.requestCountSince) {
      return;
    }

    const now = this.now();
    if (provider.requestsPerDay !== null) {
      const dayStart = startOfLocalDay(now);
      const requestsToday = this.options.requestCountSince({
        providerId: provider.id,
        since: dayStart,
        now
      });
      if (requestsToday >= provider.requestsPerDay) {
        throw new DeferredJobRun(
          `Embedding provider daily request limit reached (${requestsToday}/${provider.requestsPerDay})`,
          startOfNextLocalDay(now)
        );
      }
    }

    if (provider.requestsPerMinute !== null) {
      const since = now - 60_000;
      const requestsLastMinute = this.options.requestCountSince({
        providerId: provider.id,
        since,
        now
      });
      if (requestsLastMinute >= provider.requestsPerMinute) {
        throw new DeferredJobRun(
          `Embedding provider per-minute request limit reached (${requestsLastMinute}/${provider.requestsPerMinute})`,
          now + 60_001
        );
      }
    }
  }
}

export function parseEmbeddingGeneratePayload(
  payloadJson: string | null
): EmbeddingGenerateJobPayload | null {
  if (!payloadJson) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      Object.keys(payload).length === 2 &&
      typeof (payload as { embeddingIndexId?: unknown }).embeddingIndexId === "string" &&
      (payload as { embeddingIndexId: string }).embeddingIndexId.trim() !== "" &&
      Array.isArray((payload as { articleIds?: unknown }).articleIds) &&
      (payload as { articleIds: unknown[] }).articleIds.length >= 1 &&
      (payload as { articleIds: unknown[] }).articleIds.length <= EMBEDDING_JOB_ARTICLE_LIMIT &&
      (payload as { articleIds: unknown[] }).articleIds.every(
        (value) => typeof value === "string" && value.trim() !== ""
      )
    ) {
      return {
        embeddingIndexId: (payload as { embeddingIndexId: string }).embeddingIndexId,
        articleIds: (payload as { articleIds: string[] }).articleIds
      };
    }
  } catch {
    return null;
  }

  return null;
}

function textForEmbedding(article: ArticleEmbeddingCandidateRow, maxChars: number): string {
  return [article.title, article.summary, article.contentText]
    .map(plainTextForEmbedding)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, maxChars);
}

function plainTextForEmbedding(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const text = decodeHtmlEntities(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text || null;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return "\"";
    if (normalized === "apos") return "'";
    if (normalized === "nbsp") return " ";
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return decodeCodePoint(codePoint);
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return decodeCodePoint(codePoint);
    }
    return "";
  });
}

function decodeCodePoint(codePoint: number): string {
  return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : "";
}

export function estimateEmbeddingTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  const cjkCount = (trimmed.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const latinWords = trimmed
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/gu, " ")
    .split(/[^A-Za-z0-9_]+/u)
    .filter(Boolean).length;
  const otherChars = trimmed
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/gu, "")
    .replace(/[A-Za-z0-9_\s]+/gu, "").length;

  return Math.max(1, Math.ceil(cjkCount * 0.7 + latinWords * 1.3 + otherChars * 0.5));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function embeddingBatchSizeFor(type: string): number {
  return type === "ollama"
    ? OLLAMA_EMBEDDING_BATCH_SIZE
    : OPENAI_COMPATIBLE_EMBEDDING_BATCH_SIZE;
}

async function embedBatchWithOllamaContextRetry(input: {
  adapter: EmbeddingProviderAdapter;
  provider: EmbeddingProviderConfig;
  items: EmbeddingInput[];
}): Promise<{ items: EmbeddingInput[]; vectors: EmbeddingVector[] }> {
  try {
    return {
      items: input.items,
      vectors: await input.adapter.embedBatch({
        provider: input.provider,
        items: input.items
      })
    };
  } catch (error) {
    if (!shouldRetryOllamaContextLength(input.provider, input.items, error)) {
      throw error;
    }

    const retryTextMaxChars = retryTextMaxCharsFor(input.items);
    if (retryTextMaxChars === null) {
      throw error;
    }

    const retryItems = input.items.map((item) => ({
      ...item,
      text: item.text.slice(0, retryTextMaxChars)
    }));

    return {
      items: retryItems,
      vectors: await input.adapter.embedBatch({
        provider: input.provider,
        items: retryItems
      })
    };
  }
}

function shouldRetryOllamaContextLength(
  provider: EmbeddingProviderConfig,
  items: EmbeddingInput[],
  error: unknown
): boolean {
  return (
    provider.type === "ollama" &&
    items.length > 0 &&
    error instanceof EmbeddingProviderError &&
    !error.retryable &&
    embeddingProviderErrorText(error).includes("input length exceeds") &&
    embeddingProviderErrorText(error).includes("context length")
  );
}

function retryTextMaxCharsFor(items: EmbeddingInput[]): number | null {
  const maxLength = Math.max(...items.map((item) => item.text.length));
  if (maxLength <= 1_000) {
    return null;
  }
  return Math.max(1_000, Math.floor(maxLength * 0.5));
}

function embeddingProviderErrorText(error: EmbeddingProviderError): string {
  let details = "";
  try {
    details = error.details === undefined ? "" : JSON.stringify(error.details);
  } catch {
    details = String(error.details);
  }
  return `${error.message} ${details}`.toLowerCase();
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfNextLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function randomJobId(): string {
  return `job_embed_${randomBytes(10).toString("hex")}`;
}
