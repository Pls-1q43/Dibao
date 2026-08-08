import { randomBytes } from "node:crypto";
import type {
  ArticleRepository,
  ArticleScope,
  MarkScopeReadCommandInput,
  MarkScopeReadCommandPreview,
  MarkScopeReadCommandResult,
  ReaderCommandEventRepository
} from "@dibao/db";
import type { RankingRecalculateJobService } from "./ranking-job-service.js";

export class ReaderCommandServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ReaderCommandServiceError";
  }
}

export type ReaderCommandServiceOptions = {
  articles: Pick<ArticleRepository, "countUnreadForScope" | "markScopeRead">;
  commandEvents: ReaderCommandEventRepository;
  rankingJobs?: Pick<RankingRecalculateJobService, "enqueueAll" | "enqueueArticles">;
  now?: () => number;
  commandIdFactory?: () => string;
};

export class ReaderCommandService {
  private readonly now: () => number;
  private readonly commandIdFactory: () => string;

  constructor(private readonly options: ReaderCommandServiceOptions) {
    this.now = options.now ?? Date.now;
    this.commandIdFactory = options.commandIdFactory ?? randomCommandId;
  }

  markScopeRead(input: MarkScopeReadCommandInput): MarkScopeReadCommandResult {
    const now = input.now ?? this.now();
    const scope = normalizeScope(input.scope, now);
    const commandId = this.commandIdFactory();

    return this.options.commandEvents.transaction(() => {
      const audit = this.options.articles.markScopeRead(scope, now);
      const result = {
        commandId,
        markedReadCount: audit.markedReadCount,
        sampleArticleIds: audit.sampleArticleIds,
        limitedAudit: audit.limitedAudit
      } satisfies MarkScopeReadCommandResult;

      this.options.commandEvents.record({
        id: commandId,
        commandType: "mark_scope_read",
        scope,
        result: {
          markedReadCount: result.markedReadCount,
          sampleArticleIds: audit.sampleArticleIds,
          limitedAudit: audit.limitedAudit
        },
        createdAt: now
      });

      this.enqueueRankingUpdate(result.markedReadCount);

      return result;
    });
  }

  previewMarkScopeRead(input: MarkScopeReadCommandInput): MarkScopeReadCommandPreview {
    const now = input.now ?? this.now();
    const scope = normalizeScope(input.scope, now);

    return {
      markedReadCount: this.options.articles.countUnreadForScope(scope)
    };
  }

  private enqueueRankingUpdate(markedReadCount: number): void {
    if (!this.options.rankingJobs || markedReadCount === 0) {
      return;
    }

    // The bounded active window decides which candidates remain relevant; a
    // broad mark-read command must not resurrect a full-history ranking loop.
    this.options.rankingJobs.enqueueAll();
  }
}

function normalizeScope(scope: ArticleScope, now: number): ArticleScope {
  if (scope.feedId && scope.folderId) {
    throw new ReaderCommandServiceError(
      400,
      "VALIDATION_ERROR",
      "feedId and folderId cannot be used together",
      { fields: ["feedId", "folderId"] }
    );
  }

  if (scope.type === "search") {
    const query = scope.query.trim();
    if (!query) {
      throw new ReaderCommandServiceError(400, "VALIDATION_ERROR", "q is required", {
        field: "q"
      });
    }

    return {
      ...scope,
      query
    };
  }

  const clearWindow = scope.clearWindow ?? scope.timeWindow ?? "all";
  if (clearWindow === "all") {
    return {
      ...scope,
      clearWindow,
      timeWindow: undefined,
      beforeAt: undefined,
      todayStartAt: undefined,
      todayEndAt: undefined
    };
  }

  const range = rollingTimeRange(now, clearWindow);
  return {
    ...scope,
    clearWindow,
    timeWindow: undefined,
    beforeAt: scope.beforeAt ?? range.startAt,
    todayStartAt: undefined,
    todayEndAt: undefined
  };
}

function rollingTimeRange(
  timestamp: number,
  window: "24h" | "7d" | "30d"
): { startAt: number; endAt: number } {
  const durationMs =
    window === "24h"
      ? 24 * 60 * 60 * 1000
      : window === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return {
    startAt: timestamp - durationMs,
    endAt: timestamp
  };
}

function randomCommandId(): string {
  return `cmd_${randomBytes(10).toString("hex")}`;
}
