import type {
  DibaoDatabase,
  FeedFullContentMode,
  FeedListInput,
  FeedRow,
  UpdateFeedInput,
  UpsertFeedInput
} from "../types.js";

type FeedDbRow = {
  id: string;
  folderId: string | null;
  title: string;
  siteUrl: string | null;
  feedUrl: string;
  description: string | null;
  enabled: 0 | 1;
  fullContentMode: FeedFullContentMode;
  sourceWeight: number;
  lastFetchedAt: number | null;
  lastSuccessAt: number | null;
  fetchIntervalMinutes: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_FEED_REFRESH_TTL_MINUTES = 60;
export const DEFAULT_FEED_REFRESH_TTL_MS = DEFAULT_FEED_REFRESH_TTL_MINUTES * 60 * 1000;
export const MAX_FEED_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const AUTO_TTL_SAMPLE_SIZE = 20;

export interface FeedRepository {
  clearFolder(folderId: string, now: number): void;
  findById(id: string): FeedRow | null;
  findByFeedUrl(feedUrl: string): FeedRow | null;
  list(input?: FeedListInput): FeedRow[];
  listActive(): FeedRow[];
  listActiveDue(now: number): FeedRow[];
  recordFetchFailure(id: string, error: string, fetchedAt: number): void;
  recordFetchSuccess(id: string, fetchedAt: number): void;
  softDelete(id: string, now: number): boolean;
  update(input: UpdateFeedInput): FeedRow | null;
  upsert(input: UpsertFeedInput): FeedRow;
}

export class SqliteFeedRepository implements FeedRepository {
  constructor(private readonly db: DibaoDatabase) {}

  clearFolder(folderId: string, now: number): void {
    this.db
      .prepare(
        `
          update feeds
          set
            folder_id = null,
            updated_at = ?
          where folder_id = ? and deleted_at is null
        `
      )
      .run(now, folderId);
  }

  findById(id: string): FeedRow | null {
    const row = this.selectBase().get(id) as FeedDbRow | undefined;
    return row ? this.mapFeed(row) : null;
  }

  findByFeedUrl(feedUrl: string): FeedRow | null {
    const row = this.db
      .prepare(`${baseFeedSelect()} where feed_url = ? and deleted_at is null`)
      .get(feedUrl) as FeedDbRow | undefined;
    return row ? this.mapFeed(row) : null;
  }

  list(input: FeedListInput = {}): FeedRow[] {
    const conditions = ["deleted_at is null"];
    const params: unknown[] = [];

    if (input.folderId !== undefined) {
      if (input.folderId === null) {
        conditions.push("folder_id is null");
      } else {
        conditions.push("folder_id = ?");
        params.push(input.folderId);
      }
    }

    if (input.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(input.enabled ? 1 : 0);
    }

    const rows = this.db
      .prepare(
        `
          ${baseFeedSelect()}
          where ${conditions.join(" and ")}
          order by title collate nocase, id
        `
      )
      .all(...params) as FeedDbRow[];
    const refreshIntervals = this.refreshIntervalsForFeeds(rows);
    return rows.map((row) => this.mapFeed(row, refreshIntervals.get(row.id)));
  }

  listActive(): FeedRow[] {
    return this.list({ enabled: true });
  }

  listActiveDue(now: number): FeedRow[] {
    return this.listActive().filter(
      (feed) => feed.nextRefreshAt === null || feed.nextRefreshAt <= now
    );
  }

  recordFetchFailure(id: string, error: string, fetchedAt: number): void {
    this.db
      .prepare(
        `
          update feeds
          set
            last_fetched_at = ?,
            last_error = ?,
            updated_at = ?
          where id = ? and deleted_at is null
        `
      )
      .run(fetchedAt, error, fetchedAt, id);
  }

  recordFetchSuccess(id: string, fetchedAt: number): void {
    this.db
      .prepare(
        `
          update feeds
          set
            last_fetched_at = ?,
            last_success_at = ?,
            last_error = null,
            updated_at = ?
          where id = ? and deleted_at is null
        `
      )
      .run(fetchedAt, fetchedAt, fetchedAt, id);
  }

  softDelete(id: string, now: number): boolean {
    const result = this.db
      .prepare(
        `
          update feeds
          set
            deleted_at = ?,
            updated_at = ?
          where id = ? and deleted_at is null
        `
      )
      .run(now, now, id);

    return result.changes > 0;
  }

  update(input: UpdateFeedInput): FeedRow | null {
    const existing = this.findById(input.id);
    if (!existing) {
      return null;
    }

    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `
          update feeds
          set
            title = ?,
            folder_id = ?,
            feed_url = ?,
            enabled = ?,
            full_content_mode = ?,
            source_weight = ?,
            updated_at = ?
          where id = ? and deleted_at is null
        `
      )
      .run(
        input.title ?? existing.title,
        input.folderId === undefined ? existing.folderId : input.folderId,
        input.feedUrl ?? existing.feedUrl,
        input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0,
        input.fullContentMode ?? existing.fullContentMode,
        input.sourceWeight ?? existing.sourceWeight,
        now,
        input.id
      );

    return this.findById(input.id);
  }

  upsert(input: UpsertFeedInput): FeedRow {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `
          insert into feeds (
            id,
            folder_id,
            title,
            site_url,
            feed_url,
            description,
            enabled,
            full_content_mode,
            source_weight,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(feed_url) do update set
            folder_id = excluded.folder_id,
            title = excluded.title,
            site_url = excluded.site_url,
            description = excluded.description,
            enabled = excluded.enabled,
            full_content_mode = excluded.full_content_mode,
            source_weight = excluded.source_weight,
            updated_at = excluded.updated_at,
            deleted_at = null
        `
      )
      .run(
        input.id,
        input.folderId ?? null,
        input.title,
        input.siteUrl ?? null,
        input.feedUrl,
        input.description ?? null,
        input.enabled === false ? 0 : 1,
        input.fullContentMode ?? "feed_only",
        input.sourceWeight ?? 0,
        now,
        now
      );

    const row = this.findByFeedUrl(input.feedUrl);
    if (!row) {
      throw new Error(`Failed to upsert feed: ${input.feedUrl}`);
    }
    return row;
  }

  private selectBase() {
    return this.db.prepare(`${baseFeedSelect()} where id = ? and deleted_at is null`);
  }

  private mapFeed(row: FeedDbRow, refreshIntervalMs?: number): FeedRow {
    return {
      id: row.id,
      folderId: row.folderId,
      title: row.title,
      siteUrl: row.siteUrl,
      feedUrl: row.feedUrl,
      description: row.description,
      enabled: row.enabled === 1,
      fullContentMode: row.fullContentMode,
      sourceWeight: row.sourceWeight,
      lastFetchedAt: row.lastFetchedAt,
      lastSuccessAt: row.lastSuccessAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      nextRefreshAt: this.nextRefreshAtForFeed(row, refreshIntervalMs)
    };
  }

  private nextRefreshAtForFeed(feed: FeedDbRow, refreshIntervalMs?: number): number | null {
    const baseline = feed.lastFetchedAt ?? feed.lastSuccessAt;
    if (baseline === null) {
      return null;
    }
    const intervalMs = refreshIntervalMs ?? this.refreshIntervalForFeed(feed);
    if (feed.lastError === null) {
      return baseline + intervalMs;
    }

    // Failures must not keep an unhealthy source due on every scheduler tick.
    // Derive a bounded exponential delay from its uninterrupted failure span;
    // a successful fetch clears last_error and immediately resets this policy.
    const failureStartedAt = feed.lastSuccessAt ?? feed.createdAt;
    const failedForMs = Math.max(intervalMs, baseline - failureStartedAt);
    const exponent = Math.min(7, Math.floor(Math.log2(failedForMs / intervalMs)) + 1);
    const retryDelayMs = Math.min(24 * 60 * 60 * 1000, intervalMs * 2 ** exponent);
    return baseline + retryDelayMs;
  }

  private configuredRefreshIntervalForFeed(feed: FeedDbRow): number | null {
    if (feed.fetchIntervalMinutes !== DEFAULT_FEED_REFRESH_TTL_MINUTES) {
      return Math.max(1, Math.trunc(feed.fetchIntervalMinutes)) * 60 * 1000;
    }
    return null;
  }

  private refreshIntervalForFeed(feed: FeedDbRow): number {
    const configured = this.configuredRefreshIntervalForFeed(feed);
    if (configured !== null) {
      return configured;
    }

    const rows = this.db
      .prepare(
        `
          select coalesce(published_at, discovered_at) as timestamp
          from articles
          where feed_id = ?
            and deleted_at is null
            and status != 'deleted'
          order by timestamp desc
          limit ?
        `
      )
      .all(feed.id, AUTO_TTL_SAMPLE_SIZE) as Array<{ timestamp: number | null }>;
    const timestamps = rows
      .map((row) => row.timestamp)
      .filter((timestamp): timestamp is number => typeof timestamp === "number");

    if (timestamps.length < 2) {
      return DEFAULT_FEED_REFRESH_TTL_MS;
    }

    let totalInterval = 0;
    let intervalCount = 0;
    for (let index = 0; index < timestamps.length - 1; index += 1) {
      const interval = timestamps[index] - timestamps[index + 1];
      if (interval > 0) {
        totalInterval += interval;
        intervalCount += 1;
      }
    }

    if (intervalCount === 0) {
      return DEFAULT_FEED_REFRESH_TTL_MS;
    }

    const averageInterval = totalInterval / intervalCount;
    return Math.min(
      Math.max(Math.round(averageInterval), DEFAULT_FEED_REFRESH_TTL_MS),
      MAX_FEED_REFRESH_TTL_MS
    );
  }

  private refreshIntervalsForFeeds(feeds: FeedDbRow[]): Map<string, number> {
    const intervals = new Map<string, number>();
    const defaultIntervalFeeds: FeedDbRow[] = [];

    for (const feed of feeds) {
      const configured = this.configuredRefreshIntervalForFeed(feed);
      if (configured !== null) {
        intervals.set(feed.id, configured);
      } else {
        defaultIntervalFeeds.push(feed);
      }
    }

    if (defaultIntervalFeeds.length === 0) {
      return intervals;
    }

    const placeholders = defaultIntervalFeeds.map(() => "(?)").join(", ");
    const rows = this.db
      .prepare(
        `
          with feed_ids(id) as (
            values ${placeholders}
          ),
          ranked_articles as (
            select
              a.feed_id as feedId,
              coalesce(a.published_at, a.discovered_at) as timestamp,
              row_number() over (
                partition by a.feed_id
                order by coalesce(a.published_at, a.discovered_at) desc
              ) as rn
            from articles a
            join feed_ids fi on fi.id = a.feed_id
            where a.deleted_at is null
              and a.status != 'deleted'
              and coalesce(a.published_at, a.discovered_at) is not null
          )
          select feedId, timestamp
          from ranked_articles
          where rn <= ?
          order by feedId, rn
        `
      )
      .all(...defaultIntervalFeeds.map((feed) => feed.id), AUTO_TTL_SAMPLE_SIZE) as Array<{
        feedId: string;
        timestamp: number | null;
      }>;

    const timestampsByFeed = new Map<string, number[]>();
    for (const row of rows) {
      if (typeof row.timestamp !== "number") {
        continue;
      }
      const timestamps = timestampsByFeed.get(row.feedId) ?? [];
      timestamps.push(row.timestamp);
      timestampsByFeed.set(row.feedId, timestamps);
    }

    for (const feed of defaultIntervalFeeds) {
      intervals.set(feed.id, refreshIntervalForTimestamps(timestampsByFeed.get(feed.id) ?? []));
    }

    return intervals;
  }
}

function refreshIntervalForTimestamps(timestamps: number[]): number {
  if (timestamps.length < 2) {
    return DEFAULT_FEED_REFRESH_TTL_MS;
  }

  let totalInterval = 0;
  let intervalCount = 0;
  for (let index = 0; index < timestamps.length - 1; index += 1) {
    const interval = timestamps[index] - timestamps[index + 1];
    if (interval > 0) {
      totalInterval += interval;
      intervalCount += 1;
    }
  }

  if (intervalCount === 0) {
    return DEFAULT_FEED_REFRESH_TTL_MS;
  }

  const averageInterval = totalInterval / intervalCount;
  return Math.min(
    Math.max(Math.round(averageInterval), DEFAULT_FEED_REFRESH_TTL_MS),
    MAX_FEED_REFRESH_TTL_MS
  );
}

function baseFeedSelect(): string {
  return `
    select
      id,
      folder_id as folderId,
      title,
      site_url as siteUrl,
      feed_url as feedUrl,
      description,
      enabled,
      full_content_mode as fullContentMode,
      source_weight as sourceWeight,
      last_fetched_at as lastFetchedAt,
      last_success_at as lastSuccessAt,
      fetch_interval_minutes as fetchIntervalMinutes,
      last_error as lastError,
      created_at as createdAt,
      updated_at as updatedAt
    from feeds
  `;
}
