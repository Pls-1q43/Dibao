import { randomUUID } from "node:crypto";
import type {
  ArticleActionType,
  ArticleInteractionStatus,
  ArticleStateSnapshot,
  DibaoDatabase,
  RecordArticleActionInput,
  RecordArticleActionResult
} from "../types.js";

export const ARTICLE_ACTION_EVENT_WEIGHTS = {
  impression: -0.15,
  open: 0.2,
  mark_read: 0.7,
  mark_unread: -0.1,
  favorite: 1,
  unfavorite: -0.4,
  like: 1.1,
  unlike: -0.25,
  read_later: 0.4,
  remove_read_later: -0.2,
  hide: -0.8,
  not_interested: -1,
  read_progress: 0.1
} as const satisfies Record<ArticleActionType, number>;

type ArticleStateDbRow = {
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
  notInterestedAt: number | null;
};

type PreparedRecordArticleActionInput =
  Required<Omit<RecordArticleActionInput, "progress" | "metadata">> &
    Pick<RecordArticleActionInput, "progress" | "metadata">;

export interface ArticleActionRepository {
  clearReadLater(articleId: string, now: number): ArticleStateSnapshot | null;
  record(input: RecordArticleActionInput): RecordArticleActionResult | null;
  recordMany?(inputs: RecordArticleActionInput[]): Array<RecordArticleActionResult | null>;
}

export class SqliteArticleActionRepository implements ArticleActionRepository {
  private readonly recordTransaction: (
    input: PreparedRecordArticleActionInput
  ) => RecordArticleActionResult | null;
  private readonly recordManyTransaction: (
    inputs: PreparedRecordArticleActionInput[]
  ) => Array<RecordArticleActionResult | null>;

  constructor(private readonly db: DibaoDatabase) {
    this.recordTransaction = this.db.transaction((input) => {
      if (!this.articleExists(input.articleId)) {
        return null;
      }

      const existingEvent = this.findExistingEvent(input.eventId);
      if (existingEvent) {
        if (
          existingEvent.articleId !== input.articleId ||
          existingEvent.eventType !== input.type
        ) {
          throw new Error(`Article action event id ${input.eventId} is already in use`);
        }
        return {
          state: this.getState(input.articleId),
          eventId: input.eventId,
          deduplicated: true
        };
      }

      this.ensureStateRow(input.articleId, input.now);
      const eventWeight = this.eventWeightFor(input);
      this.insertBehaviorEvent(input, eventWeight);
      this.updateInteractionProjection(input, eventWeight);
      this.applyStateChange(input);

      return {
        state: this.getState(input.articleId),
        eventId: input.eventId
      };
    });
    this.recordManyTransaction = this.db.transaction((inputs: PreparedRecordArticleActionInput[]) =>
      inputs.map((input) => this.recordTransaction(input))
    );
  }

  record(input: RecordArticleActionInput): RecordArticleActionResult | null {
    return this.recordTransaction({
      ...input,
      now: input.now ?? Date.now(),
      eventId: input.eventId ?? randomUUID()
    });
  }

  recordMany(inputs: RecordArticleActionInput[]): Array<RecordArticleActionResult | null> {
    return this.recordManyTransaction(
      inputs.map((input) => ({
        ...input,
        now: input.now ?? Date.now(),
        eventId: input.eventId ?? randomUUID()
      }))
    );
  }

  clearReadLater(articleId: string, now: number): ArticleStateSnapshot | null {
    if (!this.articleExists(articleId)) {
      return null;
    }

    this.ensureStateRow(articleId, now);
    this.db
      .prepare(
        `
          update article_states
          set read_later_at = null, updated_at = ?
          where article_id = ?
        `
      )
      .run(now, articleId);

    return this.getState(articleId);
  }

  private articleExists(articleId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `
            select 1
            from articles
            where id = ?
              and deleted_at is null
              and status != 'deleted'
          `
        )
        .get(articleId)
    );
  }

  private findExistingEvent(
    eventId: string
  ): { articleId: string; eventType: ArticleActionType } | null {
    const row = this.db
      .prepare(
        `
          select article_id as articleId, event_type as eventType
          from behavior_events
          where id = ?
        `
      )
      .get(eventId) as { articleId: string; eventType: ArticleActionType } | undefined;
    return row ?? null;
  }

  private ensureStateRow(articleId: string, now: number): void {
    this.db
      .prepare(
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
      )
      .run(articleId, now);
  }

  private insertBehaviorEvent(
    input: Required<Omit<RecordArticleActionInput, "progress" | "metadata">> &
      Pick<RecordArticleActionInput, "progress" | "metadata">,
    eventWeight: number
  ): void {
    this.db
      .prepare(
        `
          insert into behavior_events (
            id,
            article_id,
            event_type,
            event_weight,
            metadata_json,
            created_at
          )
          values (?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.eventId,
        input.articleId,
        input.type,
        eventWeight,
        serializeMetadata(input),
        input.now
      );
  }

  private eventWeightFor(
    input: Required<Omit<RecordArticleActionInput, "progress" | "metadata">> &
      Pick<RecordArticleActionInput, "progress" | "metadata">
  ): number {
    if (input.type !== "impression") {
      return ARTICLE_ACTION_EVENT_WEIGHTS[input.type];
    }

    return this.canRecordIgnoredImpression(input.articleId)
      ? ARTICLE_ACTION_EVENT_WEIGHTS.impression
      : 0;
  }

  private updateInteractionProjection(
    input: Required<Omit<RecordArticleActionInput, "progress" | "metadata">> &
      Pick<RecordArticleActionInput, "progress" | "metadata">,
    eventWeight: number
  ): void {
    this.db
      .prepare(
        `
          update article_states
          set
            last_action_at = max(coalesce(last_action_at, 0), ?),
            last_ignored_at = case
              when ? = 'impression' and ? < 0
                then max(coalesce(last_ignored_at, 0), ?)
              else last_ignored_at
            end,
            updated_at = max(updated_at, ?)
          where article_id = ?
        `
      )
      .run(input.now, input.type, eventWeight, input.now, input.now, input.articleId);
  }

  private canRecordIgnoredImpression(articleId: string): boolean {
    const row = this.db
      .prepare(
        `
          select
            case when s.read_at is not null then 1 else 0 end as read,
            case when s.favorited_at is not null then 1 else 0 end as favorited,
            case when s.liked_at is not null then 1 else 0 end as liked,
            case when s.read_later_at is not null then 1 else 0 end as readLater,
            case when s.hidden_at is not null then 1 else 0 end as hidden,
            case when s.not_interested_at is not null then 1 else 0 end as notInterested,
            coalesce(s.reading_progress, 0) as readingProgress,
            s.last_opened_at as lastOpenedAt,
            case when s.last_action_at is not null then 1 else 0 end as hasBehavior
          from article_states s
          where s.article_id = ?
        `
      )
      .get(articleId) as
      | {
          read: 0 | 1;
          favorited: 0 | 1;
          liked: 0 | 1;
          readLater: 0 | 1;
          hidden: 0 | 1;
          notInterested: 0 | 1;
          readingProgress: number;
          lastOpenedAt: number | null;
          hasBehavior: 0 | 1;
        }
      | undefined;

    return Boolean(
      row &&
        row.read === 0 &&
        row.favorited === 0 &&
        row.liked === 0 &&
        row.readLater === 0 &&
        row.hidden === 0 &&
        row.notInterested === 0 &&
        row.readingProgress <= 0 &&
        row.lastOpenedAt === null &&
        row.hasBehavior === 0
    );
  }

  private applyStateChange(
    input: Required<Omit<RecordArticleActionInput, "progress" | "metadata">> &
      Pick<RecordArticleActionInput, "progress" | "metadata">
  ): void {
    const update = this.stateUpdateFor(input);
    this.db.prepare(update.sql).run(...update.params);
  }

  private stateUpdateFor(
    input: Required<Omit<RecordArticleActionInput, "progress" | "metadata">> &
      Pick<RecordArticleActionInput, "progress" | "metadata">
  ): { sql: string; params: unknown[] } {
    switch (input.type) {
      case "impression":
        return {
          sql: "update article_states set updated_at = ? where article_id = ?",
          params: [input.now, input.articleId]
        };
      case "open":
        return {
          sql: "update article_states set last_opened_at = ?, updated_at = ? where article_id = ?",
          params: [input.now, input.now, input.articleId]
        };
      case "mark_read":
        return {
          sql:
            "update article_states set read_at = ?, reading_progress = 1, updated_at = ? where article_id = ?",
          params: [input.now, input.now, input.articleId]
        };
      case "mark_unread":
        return {
          sql:
            "update article_states set read_at = null, reading_progress = 0, updated_at = ? where article_id = ?",
          params: [input.now, input.articleId]
        };
      case "favorite":
        return {
          sql: "update article_states set favorited_at = ?, updated_at = ? where article_id = ?",
          params: [input.now, input.now, input.articleId]
        };
      case "unfavorite":
        return {
          sql:
            "update article_states set favorited_at = null, updated_at = ? where article_id = ?",
          params: [input.now, input.articleId]
        };
      case "like":
        return {
          sql: "update article_states set liked_at = ?, updated_at = ? where article_id = ?",
          params: [input.now, input.now, input.articleId]
        };
      case "unlike":
        return {
          sql: "update article_states set liked_at = null, updated_at = ? where article_id = ?",
          params: [input.now, input.articleId]
        };
      case "read_later":
        return {
          sql: "update article_states set read_later_at = ?, updated_at = ? where article_id = ?",
          params: [input.now, input.now, input.articleId]
        };
      case "remove_read_later":
        return {
          sql:
            "update article_states set read_later_at = null, updated_at = ? where article_id = ?",
          params: [input.now, input.articleId]
        };
      case "hide":
        return {
          sql: "update article_states set hidden_at = ?, updated_at = ? where article_id = ?",
          params: [input.now, input.now, input.articleId]
        };
      case "not_interested":
        return {
          sql:
            `update article_states
             set
               read_at = null,
               favorited_at = null,
               liked_at = null,
               read_later_at = null,
               hidden_at = null,
               not_interested_at = ?,
               reading_progress = 0,
               updated_at = ?
             where article_id = ?`,
          params: [input.now, input.now, input.articleId]
        };
      case "read_progress":
        return {
          sql: `
            update article_states
            set
              reading_progress = max(reading_progress, ?),
              last_opened_at = coalesce(last_opened_at, ?),
              read_at = case
                when ? >= 1 and read_at is null then ?
                else read_at
              end,
              updated_at = ?
            where article_id = ?
          `,
          params: [
            input.progress,
            input.now,
            input.progress,
            input.now,
            input.now,
            input.articleId
          ]
        };
    }
  }

  private getState(articleId: string): ArticleStateSnapshot {
    const row = this.db
      .prepare(
        `
          select
            case when read_at is not null then 1 else 0 end as read,
            case when favorited_at is not null then 1 else 0 end as favorited,
            case when liked_at is not null then 1 else 0 end as liked,
            case when read_later_at is not null then 1 else 0 end as readLater,
            case when hidden_at is not null then 1 else 0 end as hidden,
            case when not_interested_at is not null then 1 else 0 end as notInterested,
            reading_progress as readingProgress,
            last_opened_at as lastOpenedAt,
            (
              select max(be.created_at)
              from behavior_events be
              where be.article_id = article_states.article_id
                and be.event_type = 'impression'
                and be.event_weight < 0
            ) as lastIgnoredAt,
            (
              select max(be.created_at)
              from behavior_events be
              where be.article_id = article_states.article_id
            ) as lastActionAt,
            not_interested_at as notInterestedAt
          from article_states
          where article_id = ?
        `
      )
      .get(articleId) as ArticleStateDbRow | undefined;

    if (!row) {
      throw new Error(`Article state was not created for ${articleId}`);
    }

    return {
      read: row.read === 1,
      favorited: row.favorited === 1,
      liked: row.liked === 1,
      readLater: row.readLater === 1,
      hidden: row.hidden === 1,
      notInterested: row.notInterested === 1,
      readingProgress: row.readingProgress,
      interactionStatus: interactionStatusForState(row),
      openedAt: row.lastOpenedAt,
      ignoredAt: ignoredAtForState(row)
    };
  }
}

function interactionStatusForState(row: ArticleStateDbRow): ArticleInteractionStatus {
  if (row.notInterested === 1) {
    return "ignored";
  }
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

function ignoredAtForState(row: ArticleStateDbRow): number | null {
  if (row.notInterestedAt !== null) {
    return row.notInterestedAt;
  }

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

  return row.lastIgnoredAt !== null &&
    (row.lastOpenedAt === null || row.lastIgnoredAt > row.lastOpenedAt)
    ? row.lastIgnoredAt
    : null;
}

function serializeMetadata(input: RecordArticleActionInput): string | null {
  const metadata = input.metadata ? { ...input.metadata } : {};

  if (input.type === "read_progress") {
    metadata.progress = input.progress;
  }

  return Object.keys(metadata).length === 0 ? null : JSON.stringify(metadata);
}
