import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { AppSettingsRepository, DibaoDatabase } from "@dibao/db";
import { dibaoVersion } from "@dibao/shared";
import type { ProfileRebuildProgress, ProfileRebuildResult, ProfileRebuildService } from "./profile-rebuild-service.js";

export const DERIVED_DATA_UPGRADE_ID = "recommendation-contract" as const;
export const DERIVED_DATA_UPGRADE_TARGET_VERSION = dibaoVersion;
export const DERIVED_DATA_UPGRADE_SETTING_KEY = `upgrade.derivedData.${DERIVED_DATA_UPGRADE_ID}`;
const OWNER_LEASE_MS = 60_000;

export type DerivedDataUpgradeState = "not_required" | "pending" | "running" | "completed" | "failed";
export type DerivedDataUpgradeStep = "detecting" | ProfileRebuildProgress["step"] | "cleanup" | "completed" | "failed" | "skipped";
type RankContract = ReturnType<ProfileRebuildService["getRankContract"]>;
export type UpgradeOwner = {
  token: string;
  host: string;
  pid: number;
  startTicks: string | null;
  heartbeatAt: number;
};

export type DerivedDataUpgradeStatus = RankContract & {
  id: typeof DERIVED_DATA_UPGRADE_ID;
  targetVersion: string;
  state: DerivedDataUpgradeState;
  blocking: boolean;
  step: DerivedDataUpgradeStep;
  activeIndexId: string | null;
  reason: string | null;
  progress: { current: number; total: number; chunksProcessed: number; percent: number };
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  result: ProfileRebuildResult | null;
  owner?: UpgradeOwner;
};

export type DerivedDataUpgradeServiceOptions = {
  db: DibaoDatabase;
  settings: AppSettingsRepository;
  profileRebuild: Pick<ProfileRebuildService, "rebuildActiveIndexProfileAsync" | "getRankContract" | "rebuildAllRankingsAsync">;
  now?: () => number;
  targetVersion?: string;
  isOwnerAlive?: (owner: UpgradeOwner) => boolean;
  onError?: (error: unknown) => void;
};

export class DerivedDataUpgradeService {
  private readonly now: () => number;
  private readonly token = randomUUID();
  private running: Promise<DerivedDataUpgradeStatus> | null = null;
  private stopping = false;

  constructor(private readonly options: DerivedDataUpgradeServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  getStatus(): DerivedDataUpgradeStatus {
    const stored = this.readStoredStatus();
    // Status reads must respect another process's owner and never rewrite it.
    if (stored?.state === "running" && stored.owner && this.ownerAlive(stored.owner)) {
      return stored;
    }
    const expected = this.expectedStatus();
    if (stored && this.sameContract(stored, expected)) {
      if (stored.state !== "running") {
        return stored;
      }
      return { ...stored, owner: undefined, state: "pending", step: "detecting", blocking: true, reason: "interrupted_owner" };
    }
    return expected;
  }

  isBlocking(): boolean {
    return this.getStatus().blocking;
  }

  startIfRequired(): Promise<DerivedDataUpgradeStatus> {
    if (this.running) {
      return this.running;
    }
    if (this.stopping) {
      return Promise.resolve(this.getStatus());
    }
    const claimed = this.options.db.transaction(() => {
      const status = this.getStatus();
      if (status.state === "running" || status.state === "failed" || !status.blocking) {
        const stored = this.readStoredStatus();
        if (!status.blocking && (!stored || !this.sameContract(stored, status))) {
          this.writeStatus(status);
        }
        return { acquired: false, status };
      }
      const now = this.now();
      const running: DerivedDataUpgradeStatus = {
        ...status, state: "running", step: "detecting", startedAt: now, finishedAt: null, error: null,
        owner: { token: this.token, pid: process.pid, host: hostname(), startTicks: processStartTicks(process.pid), heartbeatAt: now }
      };
      this.writeStatus(running);
      return { acquired: true, status: running };
    }).immediate();
    if (!claimed.acquired) {
      return Promise.resolve(claimed.status);
    }
    // Publish the Promise before the first progress callback can run.
    this.running = Promise.resolve().then(() => this.runUpgrade(claimed.status)).finally(() => { this.running = null; });
    this.running.catch((error) => this.options.onError?.(error));
    return this.running;
  }

  requestRetry(): DerivedDataUpgradeStatus {
    return this.options.db.transaction(() => {
      const status = this.getStatus();
      if (status.state !== "failed") {
        return status;
      }
      const pending: DerivedDataUpgradeStatus = {
        ...status, owner: undefined, state: "pending", step: "detecting", error: null, finishedAt: null
      };
      this.writeStatus(pending);
      return pending;
    }).immediate();
  }

  retry(): Promise<DerivedDataUpgradeStatus> {
    this.requestRetry();
    return this.startIfRequired();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.running?.catch(() => undefined);
  }

  private async runUpgrade(initial: DerivedDataUpgradeStatus): Promise<DerivedDataUpgradeStatus> {
    const heartbeat = setInterval(() => {
      try { this.updateOwned((status) => status); } catch (error) { this.options.onError?.(error); }
    }, OWNER_LEASE_MS / 3);
    heartbeat.unref?.();
    try {
      const result = await this.options.profileRebuild.rebuildActiveIndexProfileAsync({
        chunkSize: 50, recalculateRanking: false,
        onProgress: (progress) => this.recordProgress(progress)
      });
      result.rebuilt.rankingRows = await this.options.profileRebuild.rebuildAllRankingsAsync(
        (progress) => this.recordProgress(progress)
      );
      // Cleanup and completion commit together, after all eligible rankings
      // have been verified. Failure preserves old contexts for the retry.
      return this.updateOwned((status) => {
        if (!this.sameContract(initial, this.expectedStatus())) {
          throw new Error("Recommendation contract changed during upgrade");
        }
        this.cleanupSupersededContexts(initial.rankContext);
        return {
          ...status, owner: undefined, state: "completed", blocking: false, step: "completed",
          finishedAt: this.now(), error: null, result,
          progress: { ...status.progress, current: status.progress.total, percent: 1 }
        };
      });
    } catch (error) {
      this.options.db.transaction(() => {
        const status = this.readStoredStatus();
        if (status?.owner?.token === this.token) {
          this.writeStatus({ ...status, owner: undefined, state: "failed", blocking: true, step: "failed",
            finishedAt: this.now(), error: error instanceof Error ? error.message : String(error) });
        }
      }).immediate();
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private updateOwned(update: (status: DerivedDataUpgradeStatus) => DerivedDataUpgradeStatus): DerivedDataUpgradeStatus {
    return this.options.db.transaction(() => {
      const status = this.readStoredStatus();
      if (this.stopping || status?.owner?.token !== this.token || status.state !== "running") {
        throw new Error("Derived-data upgrade ownership lost or shutting down");
      }
      const next = update({ ...status, owner: { ...status.owner, heartbeatAt: this.now() } });
      this.writeStatus(next);
      return next;
    }).immediate();
  }

  private recordProgress(progress: ProfileRebuildProgress): void {
    const total = Math.max(0, progress.workUnitCount ?? progress.articleCount);
    const current = Math.min(total, Math.max(0, progress.workUnitsProcessed ?? progress.articleIdsProcessed));
    this.updateOwned((status) => ({ ...status, step: progress.step,
      progress: { current, total, chunksProcessed: progress.chunksProcessed, percent: total > 0 ? current / total : 0 } }));
  }

  private expectedStatus(): DerivedDataUpgradeStatus {
    const active = this.options.db.prepare("select id from embedding_indexes where status = 'active' order by updated_at desc limit 1").get() as { id: string } | undefined;
    const hasArticles = Boolean(this.options.db.prepare("select 1 from articles where deleted_at is null and status != 'deleted' limit 1").get());
    return {
      id: DERIVED_DATA_UPGRADE_ID, targetVersion: this.options.targetVersion ?? DERIVED_DATA_UPGRADE_TARGET_VERSION,
      ...this.options.profileRebuild.getRankContract(), activeIndexId: active?.id ?? null,
      state: hasArticles ? "pending" : "not_required", blocking: hasArticles,
      step: hasArticles ? "detecting" : "skipped", reason: hasArticles ? "recommendation_contract_upgrade" : "no_articles",
      progress: { current: 0, total: 0, chunksProcessed: 0, percent: hasArticles ? 0 : 1 },
      startedAt: null, finishedAt: hasArticles ? null : this.now(), error: null, result: null
    };
  }

  private sameContract(left: DerivedDataUpgradeStatus, right: DerivedDataUpgradeStatus): boolean {
    // Release numbers, tuning parameters and user-initiated provider/index
    // changes use their existing workflows, not a software data upgrade.
    return left.algorithmVersion === right.algorithmVersion && left.featureSchemaVersion === right.featureSchemaVersion;
  }

  private cleanupSupersededContexts(rankContext: string): void {
    for (const table of ["article_rank_explanations", "article_rank_scores", "recommendation_sessions"]) {
      this.options.db.prepare(`delete from ${table} where rank_context not in (?, 'base')`).run(rankContext);
    }
    this.options.db.prepare("delete from rank_contexts where id not in (?, 'base')").run(rankContext);
    this.options.db.prepare("delete from user_representation_snapshots").run();
  }

  private ownerAlive(owner: UpgradeOwner): boolean {
    if (this.options.isOwnerAlive) {
      return this.options.isOwnerAlive(owner);
    }
    if (owner.host !== hostname()) {
      return this.now() - owner.heartbeatAt < OWNER_LEASE_MS;
    }
    try {
      process.kill(owner.pid, 0);
      const startTicks = processStartTicks(owner.pid);
      return !owner.startTicks || !startTicks || owner.startTicks === startTicks;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private readStoredStatus(): DerivedDataUpgradeStatus | null {
    const value = this.options.settings.getJson<DerivedDataUpgradeStatus>(DERIVED_DATA_UPGRADE_SETTING_KEY);
    return value?.id === DERIVED_DATA_UPGRADE_ID ? value : null;
  }

  private writeStatus(status: DerivedDataUpgradeStatus): void {
    this.options.settings.setJson(DERIVED_DATA_UPGRADE_SETTING_KEY, status, this.now());
  }
}

function processStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}
