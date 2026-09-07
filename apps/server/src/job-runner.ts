import type { JobRepository, JobRow, JobType } from "@dibao/db";

export type JobHandler = (job: JobRow) => Promise<void> | void;

export type JobRunDecision =
  | { run: true }
  | { run: false; deferUntil: number; reason: string };

export type JobRunnerEvent =
  | { event: "claimed"; job: JobRunnerEventJob }
  | { event: "deferred"; job: JobRunnerEventJob; reason: string; runAfter: number }
  | { event: "failed"; job: JobRunnerEventJob; error: string }
  | { event: "retry"; job: JobRunnerEventJob; error: string; runAfter: number }
  | { event: "succeeded"; job: JobRunnerEventJob };

export type JobRunnerEventJob = {
  id: string;
  type: JobType;
  status: JobRow["status"];
  attempts: number;
  maxAttempts: number;
};

export type JobRunnerOptions = {
  jobs: JobRepository;
  handlers: Partial<Record<JobType, JobHandler>>;
  pluginHandler?: JobHandler;
  beforeRun?: (job: JobRow) => JobRunDecision;
  now?: () => number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxJobsPerDrain?: number;
  onError?: (error: unknown) => void;
  onEvent?: (event: JobRunnerEvent) => void;
};

export class PermanentJobFailure extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "PermanentJobFailure";
  }
}

export class DeferredJobRun extends Error {
  constructor(message: string, readonly runAfter: number) {
    super(message);
    this.name = "DeferredJobRun";
  }
}

export class JobRunner {
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly maxJobsPerDrain: number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private followUpTimer: ReturnType<typeof setTimeout> | null = null;
  private isDraining = false;

  constructor(private readonly options: JobRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 60_000;
    this.maxJobsPerDrain =
      options.maxJobsPerDrain && options.maxJobsPerDrain > 0
        ? Math.floor(options.maxJobsPerDrain)
        : Number.POSITIVE_INFINITY;
  }

  start(): void {
    if (this.interval) {
      return;
    }

    this.recoverStaleRunningJobs();
    this.scheduleDrain(0);
    this.interval = setInterval(() => {
      void this.drainDue().catch((error) => this.options.onError?.(error));
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
    if (this.followUpTimer) {
      clearTimeout(this.followUpTimer);
      this.followUpTimer = null;
    }
  }

  recoverStaleRunningJobs(): number {
    return this.options.jobs.resetStaleRunning(this.now());
  }

  async waitForIdle(): Promise<void> {
    while (this.isDraining) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  async drainDue(): Promise<number> {
    if (this.isDraining) {
      return 0;
    }

    this.isDraining = true;
    let completed = 0;

    try {
      while (completed < this.maxJobsPerDrain && (await this.runDueOnce())) {
        completed += 1;
        await yieldToEventLoop();
      }
    } finally {
      this.isDraining = false;
    }

    if (
      this.interval &&
      completed >= this.maxJobsPerDrain &&
      Number.isFinite(this.maxJobsPerDrain)
    ) {
      this.scheduleDrain(0);
    }

    return completed;
  }

  async runDueOnce(): Promise<JobRow | null> {
    const job = this.options.jobs.claimNextDue(this.now());
    if (!job) {
      return null;
    }
    this.emit({ event: "claimed", job: eventJob(job) });

    const handler = this.options.handlers[job.type] ?? (
      isPluginJobType(job.type) ? this.options.pluginHandler : undefined
    );
    if (!handler) {
      if (isPluginJobType(job.type)) {
        const deferred = this.options.jobs.defer(
          job.id,
          `Plugin handler unavailable for job type: ${job.type}`,
          this.now() + this.retryDelayMs,
          this.now()
        );
        if (deferred) {
          this.emit({
            event: "deferred",
            job: eventJob(deferred),
            reason: deferred.error ?? `Plugin handler unavailable for job type: ${job.type}`,
            runAfter: deferred.runAfter
          });
        }
      } else {
        const failed = this.options.jobs.markFailed(
          job.id,
          `No handler registered for job type: ${job.type}`,
          this.now()
        );
        if (failed) {
          this.emit({
            event: "failed",
            job: eventJob(failed),
            error: failed.error ?? `No handler registered for job type: ${job.type}`
          });
        }
      }
      return job;
    }

    const decision = this.options.beforeRun?.(job) ?? { run: true };
    if (!decision.run) {
      const deferred = this.options.jobs.defer(job.id, decision.reason, decision.deferUntil, this.now());
      if (deferred) {
        this.emit({
          event: "deferred",
          job: eventJob(deferred),
          reason: decision.reason,
          runAfter: decision.deferUntil
        });
      }
      return job;
    }

    try {
      await handler(job);
      const succeeded = this.options.jobs.markSucceeded(job.id, this.now());
      if (succeeded) {
        this.emit({ event: "succeeded", job: eventJob(succeeded) });
      }
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof PermanentJobFailure) {
        const failed = this.options.jobs.markFailed(job.id, message, this.now());
        if (failed) {
          this.emit({ event: "failed", job: eventJob(failed), error: message });
        }
      } else if (error instanceof DeferredJobRun) {
        const deferred = this.options.jobs.defer(job.id, message, error.runAfter, this.now());
        if (deferred) {
          this.emit({
            event: "deferred",
            job: eventJob(deferred),
            reason: message,
            runAfter: error.runAfter
          });
        }
      } else {
        const updated = this.options.jobs.markFailedOrRetry(
          job.id,
          message,
          this.now(),
          this.retryDelayMs
        );
        if (updated?.status === "queued") {
          this.emit({
            event: "retry",
            job: eventJob(updated),
            error: message,
            runAfter: updated.runAfter
          });
        } else if (updated) {
          this.emit({ event: "failed", job: eventJob(updated), error: message });
        }
      }
    }

    return job;
  }

  private emit(event: JobRunnerEvent): void {
    this.options.onEvent?.(event);
  }

  private scheduleDrain(delayMs: number): void {
    if (this.followUpTimer) {
      return;
    }

    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = null;
      void this.drainDue().catch((error) => this.options.onError?.(error));
    }, Math.max(0, delayMs));
  }
}

function isPluginJobType(type: JobType): boolean {
  return type.startsWith("plugin:");
}

function eventJob(job: JobRow): JobRunnerEventJob {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
