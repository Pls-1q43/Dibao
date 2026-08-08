import type { RecommendationMemoryService } from "./recommendation-memory-service.js";

const FLUSH_DELAY_MS = 10_000;
const MAX_PENDING_EXPOSURES = 1_000;

type ExposureInput = {
  clientSessionId: string;
  articleIds: string[];
  exposedAt?: number;
};

/** Passive recommendation telemetry is deliberately kept off the request path. */
export class PassiveExposureBuffer {
  private readonly pending = new Map<string, ExposureInput>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly service: Pick<RecommendationMemoryService, "recordExposures">) {}

  record(input: ExposureInput): { recorded: number; existing: number } {
    const clientSessionId = input.clientSessionId.trim();
    const articleIds = Array.from(new Set(input.articleIds.filter(Boolean))).slice(0, 100);
    if (!clientSessionId || articleIds.length === 0) return { recorded: 0, existing: 0 };
    for (const articleId of articleIds) {
      this.pending.set(`${clientSessionId}\u0000${articleId}`, {
        clientSessionId,
        articleIds: [articleId],
        exposedAt: input.exposedAt
      });
    }
    this.schedule(this.pending.size >= MAX_PENDING_EXPOSURES ? 0 : FLUSH_DELAY_MS);
    return { recorded: articleIds.length, existing: 0 };
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const entries = Array.from(this.pending.entries());
    const grouped = new Map<string, ExposureInput>();
    for (const [, entry] of entries) {
      const key = `${entry.clientSessionId}\u0000${entry.exposedAt ?? ""}`;
      const group = grouped.get(key) ?? {
        clientSessionId: entry.clientSessionId,
        articleIds: [],
        exposedAt: entry.exposedAt
      };
      group.articleIds.push(entry.articleIds[0]!);
      grouped.set(key, group);
    }
    this.pending.clear();
    try {
      for (const group of grouped.values()) {
        for (let index = 0; index < group.articleIds.length; index += 100) {
          this.service.recordExposures({ ...group, articleIds: group.articleIds.slice(index, index + 100) });
        }
      }
    } catch {
      // SQLite may briefly be busy with a foreground write. Keep the passive
      // batch in memory and retry; only a process crash may discard it.
      for (const [key, entry] of entries) this.pending.set(key, entry);
      this.schedule(FLUSH_DELAY_MS);
    }
  }

  dispose(): void {
    this.flush();
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), delayMs);
    this.timer.unref?.();
  }
}
