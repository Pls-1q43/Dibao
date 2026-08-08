import { randomBytes } from "node:crypto";
import type { JobRepository, JobRow } from "@dibao/db";
import { PermanentJobFailure } from "./job-runner.js";
import type { ArticleRankingRecalculator } from "./ranking-service.js";

export const RANKING_RECALCULATE_JOB_TYPE = "ranking_recalculate" as const;
export const RANKING_RECALCULATE_REFRESH_DELAY_MS = 10_000;
export const RANKING_RECALCULATE_JOB_PRIORITY = -20;

export type RankingRecalculateJobPayload = Record<string, never>;

export type RankingRecalculateEnqueueOptions = {
  delayMs?: number;
};

export type RankingRecalculateJobServiceOptions = {
  jobs: Pick<JobRepository, "cancel" | "enqueue" | "listOpenByType">;
  ranking: ArticleRankingRecalculator;
  now?: () => number;
  jobIdFactory?: () => string;
};

export class RankingRecalculateJobService {
  private readonly now: () => number;
  private readonly jobIdFactory: () => string;

  constructor(private readonly options: RankingRecalculateJobServiceOptions) {
    this.now = options.now ?? Date.now;
    this.jobIdFactory = options.jobIdFactory ?? randomJobId;
  }

  enqueueAll(options: RankingRecalculateEnqueueOptions = {}): JobRow {
    const existing = this.options.jobs
      .listOpenByType(RANKING_RECALCULATE_JOB_TYPE)
      .find((job) => parseRankingRecalculatePayload(job.payloadJson) !== null);
    if (existing) {
      return existing;
    }

    const now = this.now();
    return this.options.jobs.enqueue({
      id: this.jobIdFactory(),
      type: RANKING_RECALCULATE_JOB_TYPE,
      payloadJson: null,
      maxAttempts: 2,
      priority: RANKING_RECALCULATE_JOB_PRIORITY,
      runAfter: now + Math.max(0, options.delayMs ?? 0),
      now
    });
  }

  enqueueArticles(articleIds: string[], options: RankingRecalculateEnqueueOptions = {}): JobRow | null {
    if (uniqueStrings(articleIds).length === 0) {
      return null;
    }
    // A single article cannot receive a meaningful diversity/MMR position in
    // isolation. Coalesce its arrival into a refresh of the active window.
    return this.enqueueAll(options);
  }

  handleRankingRecalculateJob(job: JobRow): {
    processed: number;
  } {
    const payload = parseRankingRecalculatePayload(job.payloadJson);
    if (!payload) {
      throw new PermanentJobFailure("Invalid ranking_recalculate job payload");
    }
    return { processed: this.options.ranking.recalculateAll() };
  }

  cancelLegacyCursorJobs(): number {
    const now = this.now();
    let cancelled = 0;
    for (const job of this.options.jobs.listOpenByType(RANKING_RECALCULATE_JOB_TYPE)) {
      if (parseRankingRecalculatePayload(job.payloadJson) === null) {
        this.options.jobs.cancel(
          job.id,
          "Cancelled legacy full-history ranking cursor; active-window refresh supersedes it",
          now
        );
        cancelled += 1;
      }
    }
    return cancelled;
  }
}

export function parseRankingRecalculatePayload(
  payloadJson: string | null
): RankingRecalculateJobPayload | null {
  if (payloadJson === null) {
    return {};
  }

  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      Object.keys(payload).length === 0
    ) {
      return {};
    }

  } catch {
    return null;
  }

  return null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function randomJobId(): string {
  return `job_rank_${randomBytes(10).toString("hex")}`;
}
