import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteArticleFtsIndex,
  SqliteArticleActionRepository,
  SqliteArticleRepository,
  SqliteAppSettingsRepository,
  SqliteAuthCredentialRepository,
  SqliteEmbeddingRepository,
  SqliteFeedFolderRepository,
  SqliteFeedRepository,
  SqliteJobRepository,
  SqlitePluginRepository,
  SqliteProfileRepository,
  SqliteRankingRepository,
  SqliteReaderCommandEventRepository,
  SqliteSessionRepository,
  SqliteVecVectorStore,
  checksumSql,
  float32VectorToBuffer,
  fromVectorBlob,
  getAppliedMigrations,
  getSqliteVecVersion,
  loadDefaultMigrations,
  openDatabase,
  runMigrations,
  vectorToJson
} from "./index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("db package", () => {
  it("loads sqlite-vec and exposes vec_version", () => {
    const db = openDatabase();
    try {
      const result = getSqliteVecVersion(db);
      expect(result.version).toMatch(/^v\d+\./);
    } finally {
      db.close();
    }
  });

  it("serializes vectors for blob and sqlite-vec json inputs", () => {
    expect(float32VectorToBuffer([1, 0, 0, 0])).toBeInstanceOf(Buffer);
    expect(vectorToJson([1, 0, 0, 0])).toBe("[1,0,0,0]");
  });

  it("runs migrations once and records checksums", () => {
    const db = openDatabase(":memory:", { loadSqliteVec: false });
    try {
      const migrations = [
        {
          version: "001",
          name: "test",
          sql: "create table example (id text primary key);"
        }
      ];

      expect(runMigrations(db, migrations, () => 1000)).toHaveLength(1);
      expect(runMigrations(db, migrations, () => 2000)).toHaveLength(0);
      expect(getAppliedMigrations(db)).toEqual([
        {
          version: "001",
          name: "test",
          appliedAt: 1000,
          checksum: checksumSql(migrations[0].sql)
        }
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects changed migrations after they have been applied", () => {
    const db = openDatabase(":memory:", { loadSqliteVec: false });
    try {
      runMigrations(db, [
        {
          version: "001",
          name: "test",
          sql: "create table example (id text primary key);"
        }
      ]);

      expect(() =>
        runMigrations(db, [
          {
            version: "001",
            name: "test",
            sql: "create table example_changed (id text primary key);"
          }
        ])
      ).toThrow("Migration 001 has changed");
    } finally {
      db.close();
    }
  });

  it("applies the default schema to an empty database idempotently", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      expect(runMigrations(db)).toHaveLength(0);

      expect(getSqliteVecVersion(db).version).toMatch(/^v\d+\./);
      expect(
        db.prepare("select sqlite_compileoption_used('ENABLE_FTS5') as enabled").get()
      ).toEqual({ enabled: 1 });

      for (const name of [
        "schema_migrations",
        "app_settings",
        "auth_credentials",
        "sessions",
        "feed_folders",
        "feeds",
        "articles",
        "article_contents",
        "article_states",
        "behavior_events",
        "embedding_providers",
        "embedding_indexes",
        "article_embeddings",
        "article_vector_rows",
        "interest_clusters",
        "interest_cluster_labels",
        "feed_stats",
        "article_rank_scores",
        "article_rank_explanations",
        "rank_contexts",
        "interest_cluster_evidence",
        "profile_terms",
        "recent_intent_profiles",
        "article_fingerprints",
        "duplicate_groups",
        "duplicate_group_members",
        "rank_model_versions",
        "rank_model_weights",
        "rank_training_examples",
        "exploration_buckets",
        "ranking_eval_runs",
        "ranking_eval_items",
        "recommendation_backfill_state",
        "recommendation_maintenance_schedule_state",
        "embedding_usage_events",
        "interest_cluster_merge_candidates",
        "interest_families",
        "interest_family_labels",
        "interest_cluster_family_members",
        "interest_cluster_calibrations",
        "reader_command_events",
        "plugin_installs",
        "plugin_capability_grants",
        "plugin_settings",
        "plugin_kv",
        "plugin_migrations",
        "plugin_update_checks",
        "plugin_secrets",
        "plugin_deliveries",
        "plugin_delivery_attempts",
        "behavior_projection_cursors",
        "user_representation_snapshots",
        "recommendation_exposures",
        "exploration_attempts",
        "jobs"
      ]) {
        expect(hasTableOrView(db, name), name).toBe(true);
      }

      expect(hasFtsTable(db, "article_fts")).toBe(true);
      expect(hasColumn(db, "article_states", "liked_at")).toBe(true);
      expect(hasIndex(db, "idx_article_states_liked_at")).toBe(true);
      expect(hasColumn(db, "rank_model_weights", "z")).toBe(true);
      expect(hasColumn(db, "rank_model_weights", "n")).toBe(true);
      expect(hasColumn(db, "jobs", "priority")).toBe(true);
      expect(hasColumn(db, "article_states", "last_action_at")).toBe(true);
      expect(hasColumn(db, "article_states", "last_ignored_at")).toBe(true);
      expect(hasColumn(db, "feed_stats", "clear_positive")).toBe(true);
      expect(hasColumn(db, "feed_stats", "source_confidence")).toBe(true);
      expect(hasColumn(db, "interest_cluster_evidence", "article_title_snapshot")).toBe(true);
      expect(hasColumn(db, "interest_cluster_evidence", "vector_blob_snapshot")).toBe(true);
      expect(hasColumn(db, "interest_cluster_labels", "manual_label")).toBe(true);
      expect(hasColumn(db, "interest_cluster_labels", "label_diagnostics_json")).toBe(true);
      expect(hasIndex(db, "idx_interest_cluster_labels_source")).toBe(true);
      expect(hasIndex(db, "idx_interest_cluster_merge_candidates_status")).toBe(true);
      expect(hasIndex(db, "idx_interest_families_index_polarity_weight")).toBe(true);
      expect(hasIndex(db, "idx_interest_cluster_family_members_family")).toBe(true);
      expect(hasIndex(db, "idx_interest_cluster_calibrations_algorithm")).toBe(true);
      expect(hasIndex(db, "idx_reader_command_events_created_at")).toBe(true);
      expect(hasIndex(db, "idx_profile_terms_polarity_scope_weight")).toBe(true);
      expect(hasIndex(db, "idx_plugin_deliveries_plugin_status")).toBe(true);
      expect(hasIndex(db, "idx_plugin_delivery_attempts_delivery")).toBe(true);
      expect(hasIndex(db, "idx_behavior_events_projection_order")).toBe(true);
      expect(hasIndex(db, "idx_jobs_status_priority_run_after")).toBe(true);
      expect(hasIndex(db, "idx_article_states_last_action_at")).toBe(true);
      expect(hasIndex(db, "idx_article_states_last_ignored_at")).toBe(true);
      expect(hasIndex(db, "idx_article_rank_scores_context_recommended_order")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("applies later migrations to old databases and permits new action and job types", () => {
    const db = openDatabase(":memory:", { loadSqliteVec: false });
    try {
      const initialMigration = loadDefaultMigrations().slice(0, 1);
      expect(runMigrations(db, initialMigration, () => 1000).map((migration) => migration.version)).toEqual([
        "001"
      ]);
      expect(hasColumn(db, "article_states", "liked_at")).toBe(false);
      db.prepare(
        `
          insert into auth_credentials (id, password_hash, password_algo, created_at, updated_at)
          values ('single_user', 'scrypt:v1:old', 'scrypt:v1', 1000, 1000)
        `
      ).run();

      expect(runMigrations(db, loadDefaultMigrations(), () => 2000).map((migration) => migration.version)).toEqual([
        "002",
        "003",
        "004",
        "005",
        "006",
        "007",
        "008",
        "009",
        "011",
        "012",
        "013",
        "014",
        "015",
        "016",
        "017",
        "018",
        "019",
        "020",
        "021",
        "022",
        "023",
        "024",
        "025",
        "026"
      ]);
      expect(hasColumn(db, "article_states", "liked_at")).toBe(true);
      expect(hasColumn(db, "article_states", "last_action_at")).toBe(true);
      expect(hasColumn(db, "article_states", "last_ignored_at")).toBe(true);
      expect(hasColumn(db, "auth_credentials", "username")).toBe(true);
      expect(db.prepare("select username from auth_credentials where id = ?").get("single_user")).toEqual({
        username: null
      });
      expect(hasColumn(db, "feeds", "full_content_mode")).toBe(true);
      expect(hasIndex(db, "idx_article_states_liked_at")).toBe(true);
      expect(hasColumn(db, "rank_model_weights", "z")).toBe(true);
      expect(hasColumn(db, "feed_stats", "clear_signal_count")).toBe(true);
      expect(hasTableOrView(db, "recommendation_maintenance_schedule_state")).toBe(true);
      expect(hasTableOrView(db, "embedding_usage_events")).toBe(true);
      expect(hasColumn(db, "interest_cluster_evidence", "feed_title_snapshot")).toBe(true);
      expect(hasTableOrView(db, "interest_cluster_labels")).toBe(true);
      expect(hasTableOrView(db, "interest_cluster_merge_candidates")).toBe(true);
      expect(hasTableOrView(db, "interest_families")).toBe(true);
      expect(hasTableOrView(db, "interest_family_labels")).toBe(true);
      expect(hasTableOrView(db, "interest_cluster_family_members")).toBe(true);
      expect(hasColumn(db, "embedding_providers", "text_max_chars")).toBe(true);
      expect(hasColumn(db, "embedding_providers", "requests_per_minute")).toBe(true);
      expect(hasColumn(db, "embedding_providers", "requests_per_day")).toBe(true);
      expect(hasColumn(db, "embedding_indexes", "text_max_chars")).toBe(true);
      expect(hasTableOrView(db, "reader_command_events")).toBe(true);
      expect(hasTableOrView(db, "plugin_secrets")).toBe(true);
      expect(hasTableOrView(db, "plugin_deliveries")).toBe(true);
      expect(hasTableOrView(db, "plugin_delivery_attempts")).toBe(true);
      expect(hasTableOrView(db, "behavior_projection_cursors")).toBe(true);
      expect(hasTableOrView(db, "user_representation_snapshots")).toBe(true);
      expect(hasTableOrView(db, "recommendation_exposures")).toBe(true);
      expect(hasTableOrView(db, "exploration_attempts")).toBe(true);
      expect(hasColumn(db, "jobs", "priority")).toBe(true);

      db.prepare(
        `
          insert into feeds (id, title, feed_url, created_at, updated_at)
          values ('feed_migrate', 'Migration Feed', 'https://example.com/migrate.xml', 2000, 2000)
        `
      ).run();
      db.prepare(
        `
          insert into articles (
            id,
            feed_id,
            url,
            title,
            discovered_at,
            dedupe_key,
            created_at,
            updated_at
          )
          values (
            'article_migrate',
            'feed_migrate',
            'https://example.com/migrate',
            'Migration Article',
            2000,
            'article_migrate',
            2000,
            2000
          )
        `
      ).run();
      db.prepare(
        `
          insert into behavior_events (
            id,
            article_id,
            event_type,
            event_weight,
            created_at
          )
          values ('event_like', 'article_migrate', 'like', 1.1, 2000)
        `
      ).run();

      expect(
        db.prepare("select event_type as eventType from behavior_events").get()
      ).toEqual({ eventType: "like" });
      db.prepare(
        `
          insert into jobs (
            id,
            type,
            status,
            attempts,
            max_attempts,
            run_after,
            created_at,
            updated_at
          )
          values ('job_profile_event', 'profile_event_process', 'queued', 0, 2, 2000, 2000, 2000)
        `
      ).run();
      expect(db.prepare("select type from jobs where id = 'job_profile_event'").get()).toEqual({
        type: "profile_event_process"
      });
      db.prepare(
        `
          insert into jobs (
            id,
            type,
            status,
            attempts,
            max_attempts,
            run_after,
            created_at,
            updated_at
          )
          values ('job_duplicate_rebuild', 'duplicate_group_rebuild', 'queued', 0, 1, 2000, 2000, 2000)
        `
      ).run();
      expect(
        db.prepare("select type from jobs where id = 'job_duplicate_rebuild'").get()
      ).toEqual({
        type: "duplicate_group_rebuild"
      });
      db.prepare(
        `
          insert into jobs (
            id,
            type,
            status,
            attempts,
            max_attempts,
            run_after,
            created_at,
            updated_at
          )
          values ('job_cluster_labels', 'interest_cluster_label_rebuild', 'queued', 0, 1, 2000, 2000, 2000)
        `
      ).run();
      expect(
        db.prepare("select type from jobs where id = 'job_cluster_labels'").get()
      ).toEqual({
        type: "interest_cluster_label_rebuild"
      });
      db.prepare(
        `
          insert into jobs (
            id,
            type,
            status,
            attempts,
            max_attempts,
            run_after,
            created_at,
            updated_at
          )
          values ('job_cluster_merge_diagnostics', 'interest_cluster_merge_diagnostics', 'queued', 0, 1, 2000, 2000, 2000)
        `
      ).run();
      db.prepare(
        `
          insert into jobs (
            id,
            type,
            status,
            attempts,
            max_attempts,
            run_after,
            created_at,
            updated_at
          )
          values ('job_cluster_auto_merge', 'interest_cluster_auto_merge', 'queued', 0, 1, 2000, 2000, 2000)
        `
      ).run();
      db.prepare(
        `
          insert into jobs (
            id,
            type,
            status,
            attempts,
            max_attempts,
            run_after,
            created_at,
            updated_at
          )
          values ('job_interest_family_rebuild', 'interest_family_rebuild', 'queued', 0, 1, 2000, 2000, 2000)
        `
      ).run();
      expect(
        db.prepare("select count(*) as count from jobs where type like 'interest_cluster_%'").get()
      ).toEqual({ count: 3 });
      expect(
        db.prepare("select type from jobs where id = 'job_interest_family_rebuild'").get()
      ).toEqual({ type: "interest_family_rebuild" });
    } finally {
      db.close();
    }
  });

  it("converts legacy high-volume profile jobs into behavior projection cursor state", () => {
    const db = openDatabase(":memory:", { loadSqliteVec: false });
    try {
      const migrationsThrough022 = loadDefaultMigrations().filter(
        (migration) => Number.parseInt(migration.version, 10) <= 22
      );
      expect(
        runMigrations(db, migrationsThrough022, () => 1000).at(-1)?.version
      ).toBe("022");

      db.prepare(
        `
          insert into feeds (id, title, feed_url, created_at, updated_at)
          values ('feed_023', '023 Feed', 'https://example.com/023.xml', 1000, 1000)
        `
      ).run();
      db.prepare(
        `
          insert into articles (
            id,
            feed_id,
            url,
            title,
            discovered_at,
            dedupe_key,
            created_at,
            updated_at
          )
          values ('article_023', 'feed_023', 'https://example.com/023', '023 Article', 1000, 'article_023', 1000, 1000)
        `
      ).run();
      db.prepare(
        `
          insert into behavior_events (
            id,
            article_id,
            event_type,
            event_weight,
            created_at
          )
          values
            ('event_open_023', 'article_023', 'open', 0.1, 2000),
            ('event_favorite_023', 'article_023', 'favorite', 1.5, 3000)
        `
      ).run();
      db.prepare(
        `
          insert into jobs (
            id,
            type,
            status,
            payload_json,
            attempts,
            max_attempts,
            run_after,
            created_at,
            updated_at
          )
          values
            (
              'job_open_023',
              'profile_event_process',
              'queued',
              '{"eventId":"event_open_023","articleId":"article_023","actionType":"open"}',
              0,
              2,
              2000,
              2000,
              2000
            ),
            (
              'job_favorite_023',
              'profile_event_process',
              'queued',
              '{"eventId":"event_favorite_023","articleId":"article_023","actionType":"favorite"}',
              0,
              2,
              3000,
              3000,
              3000
            )
        `
      ).run();

      const migration023 = loadDefaultMigrations().find((migration) => migration.version === "023");
      expect(migration023).toBeDefined();
      expect(runMigrations(db, [migration023!], () => 4000).map((migration) => migration.version)).toEqual([
        "023"
      ]);

      expect(
        db
          .prepare("select status, priority from jobs where id = 'job_open_023'")
          .get()
      ).toEqual({
        status: "cancelled",
        priority: 40
      });
      expect(
        db
          .prepare("select status, priority from jobs where id = 'job_favorite_023'")
          .get()
      ).toEqual({
        status: "queued",
        priority: 40
      });
      expect(
        db
          .prepare(
            `
              select
                last_created_at as lastCreatedAt,
                last_event_id as lastEventId
              from behavior_projection_cursors
              where projector_id = 'profile'
            `
          )
          .get()
      ).toEqual({
        lastCreatedAt: 1999,
        lastEventId: ""
      });
    } finally {
      db.close();
    }
  });

  it("removes legacy corpus topic snapshot artifacts from databases that had the retired migration applied", () => {
    const db = openDatabase(":memory:", { loadSqliteVec: false });
    try {
      const migrationsBeforeCleanup = loadDefaultMigrations().filter((migration) => migration.version !== "011");
      runMigrations(db, migrationsBeforeCleanup, () => 1000);

      db.exec(`
        create table corpus_topic_runs (id text primary key);
        create table corpus_topics (id text primary key);
        create table corpus_topic_articles (id text primary key);

        drop table jobs;
        create table jobs (
          id text primary key,
          type text not null check (
            type in (
              'feed_refresh',
              'content_extract',
              'embedding_generate',
              'profile_event_process',
              'ranking_recalculate',
              'profile_decay',
              'retention_cleanup',
              'vector_index_rebuild',
              'article_fingerprint_backfill',
              'duplicate_group_rebuild',
              'keyword_profile_rebuild',
              'recent_intent_rebuild',
              'ftrl_train',
              'ranking_eval_run',
              'recommendation_backfill',
              'interest_cluster_label_rebuild',
              'interest_cluster_merge_diagnostics',
              'interest_cluster_auto_merge',
              'topic_snapshot_rebuild'
            )
          ),
          status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          payload_json text,
          error text,
          attempts integer not null default 0,
          max_attempts integer not null default 3,
          run_after integer not null,
          started_at integer,
          finished_at integer,
          created_at integer not null,
          updated_at integer not null
        );

        drop table interest_cluster_labels;
        create table interest_cluster_labels (
          cluster_id text primary key references interest_clusters(id) on delete cascade,
          auto_label text,
          manual_label text,
          label_source text not null default 'fallback' check (
            label_source in ('manual', 'keywords', 'representative_titles', 'feeds', 'corpus_topic', 'fallback')
          ),
          label_terms_json text,
          representative_articles_json text,
          feed_titles_json text,
          label_diagnostics_json text,
          confidence real not null default 0,
          generated_at integer,
          updated_at integer not null
        );
      `);

      db.prepare(
        `
          insert into embedding_providers (
            id,
            type,
            name,
            base_url,
            model,
            dimension,
            enabled,
            created_at,
            updated_at
          )
          values ('provider_cleanup', 'openai_compatible', 'Provider', 'https://api.example.com/v1', 'fixture', 3, 1, 1000, 1000)
        `
      ).run();
      db.prepare(
        `
          insert into embedding_indexes (
            id,
            provider_id,
            model,
            dimension,
            distance_metric,
            table_name,
            status,
            created_at,
            updated_at
          )
          values ('index_cleanup', 'provider_cleanup', 'fixture', 3, 'cosine', 'vec_cleanup', 'active', 1000, 1000)
        `
      ).run();
      db.prepare(
        `
          insert into interest_clusters (
            id,
            embedding_index_id,
            polarity,
            centroid_vector_blob,
            weight,
            sample_count,
            created_at,
            updated_at
          )
          values ('cluster_cleanup', 'index_cleanup', 'positive', ?, 1, 1, 1000, 1000)
        `
      ).run(float32VectorToBuffer([1, 0, 0]));
      db.prepare(
        `
          insert into interest_cluster_labels (
            cluster_id,
            auto_label,
            label_source,
            updated_at
          )
          values ('cluster_cleanup', 'Legacy Topic', 'corpus_topic', 1000)
        `
      ).run();
      db.prepare(
        `
          insert into jobs (
            id,
            type,
            status,
            attempts,
            max_attempts,
            run_after,
            created_at,
            updated_at
          )
          values ('job_topic_cleanup', 'topic_snapshot_rebuild', 'queued', 0, 1, 1000, 1000, 1000)
        `
      ).run();

      const cleanupMigration = loadDefaultMigrations().find((migration) => migration.version === "011");
      expect(cleanupMigration).toBeDefined();
      expect(runMigrations(db, [cleanupMigration!], () => 2000).map((migration) => migration.version)).toEqual([
        "011"
      ]);

      expect(hasTableOrView(db, "corpus_topic_runs")).toBe(false);
      expect(hasTableOrView(db, "corpus_topics")).toBe(false);
      expect(hasTableOrView(db, "corpus_topic_articles")).toBe(false);
      expect(
        db.prepare("select count(*) as count from jobs where type = 'topic_snapshot_rebuild'").get()
      ).toEqual({ count: 0 });
      expect(db.prepare("select label_source as labelSource from interest_cluster_labels").get()).toEqual({
        labelSource: "fallback"
      });
      expect(() =>
        db.prepare(
          `
            insert into jobs (
              id,
              type,
              status,
              attempts,
              max_attempts,
              run_after,
              created_at,
              updated_at
            )
            values ('job_topic_rejected', 'topic_snapshot_rebuild', 'queued', 0, 1, 1000, 1000, 1000)
          `
        ).run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("applies recommendation completion migration after an already-applied 004 database without changing core counts", () => {
    const db = openDatabase(":memory:", { loadSqliteVec: false });
    try {
      const through004 = loadDefaultMigrations().slice(0, 4);
      expect(runMigrations(db, through004, () => 1000).map((migration) => migration.version)).toEqual([
        "001",
        "002",
        "003",
        "004"
      ]);

      db.prepare(
        `
          insert into feeds (id, title, feed_url, created_at, updated_at)
          values ('feed_005', '005 Feed', 'https://example.com/005.xml', 1000, 1000)
        `
      ).run();
      db.prepare(
        `
          insert into articles (
            id,
            feed_id,
            url,
            title,
            discovered_at,
            dedupe_key,
            created_at,
            updated_at
          )
          values ('article_005', 'feed_005', 'https://example.com/005', '005 Article', 1000, 'article_005', 1000, 1000)
        `
      ).run();
      db.prepare(
        `
          insert into behavior_events (
            id,
            article_id,
            event_type,
            event_weight,
            created_at
          )
          values ('event_005', 'article_005', 'open', 0.1, 1000)
        `
      ).run();

      const before = {
        feeds: countTable(db, "feeds"),
        articles: countTable(db, "articles"),
        behaviorEvents: countTable(db, "behavior_events")
      };
      const checksum004 = getAppliedMigrations(db).find((migration) => migration.version === "004")?.checksum;

      expect(runMigrations(db, loadDefaultMigrations(), () => 2000).map((migration) => migration.version)).toEqual([
        "005",
        "006",
        "007",
        "008",
        "009",
        "011",
        "012",
        "013",
        "014",
        "015",
        "016",
        "017",
        "018",
        "019",
        "020",
        "021",
        "022",
        "023",
        "024",
        "025",
        "026"
      ]);

      expect(getAppliedMigrations(db).find((migration) => migration.version === "004")?.checksum).toBe(checksum004);
      expect({
        feeds: countTable(db, "feeds"),
        articles: countTable(db, "articles"),
        behaviorEvents: countTable(db, "behavior_events")
      }).toEqual(before);
      expect(hasColumn(db, "rank_model_weights", "z")).toBe(true);
      expect(hasColumn(db, "feed_stats", "smoothed_positive_rate")).toBe(true);
      expect(hasIndex(db, "idx_duplicate_group_members_article_reason")).toBe(true);
      expect(hasTableOrView(db, "recommendation_maintenance_schedule_state")).toBe(true);
      expect(hasTableOrView(db, "embedding_usage_events")).toBe(true);
      expect(hasTableOrView(db, "interest_cluster_labels")).toBe(true);
      expect(hasTableOrView(db, "interest_cluster_merge_candidates")).toBe(true);
      expect(hasTableOrView(db, "interest_cluster_calibrations")).toBe(true);
      expect(hasTableOrView(db, "reader_command_events")).toBe(true);
      expect(hasColumn(db, "auth_credentials", "username")).toBe(true);
      expect(hasTableOrView(db, "behavior_projection_cursors")).toBe(true);
      expect(hasTableOrView(db, "user_representation_snapshots")).toBe(true);
      expect(hasColumn(db, "jobs", "priority")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("claims jobs with attempts and moves failures through retry boundaries", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const jobs = new SqliteJobRepository(db);
      const job = jobs.enqueue({
        id: "job_feed_refresh",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: "feed_1" }),
        maxAttempts: 2,
        runAfter: 1000,
        now: 900
      });

      expect(job.status).toBe("queued");
      expect(job.attempts).toBe(0);
      expect(jobs.claimNextDue(999)).toBeNull();
      expect(jobs.claimById("job_feed_refresh", 999)).toBeNull();

      const firstClaim = jobs.claimById("job_feed_refresh", 1000);
      expect(firstClaim).toMatchObject({
        id: "job_feed_refresh",
        status: "running",
        attempts: 1,
        startedAt: 1000
      });
      expect(jobs.claimById("job_feed_refresh", 1000)).toBeNull();

      const retry = jobs.markFailedOrRetry("job_feed_refresh", "temporary", 1100, 5000);
      expect(retry).toMatchObject({
        status: "queued",
        attempts: 1,
        error: "temporary",
        runAfter: 6100,
        startedAt: null,
        finishedAt: null
      });
      expect(jobs.claimNextDue(6099)).toBeNull();

      expect(jobs.claimNextDue(6100)).toMatchObject({
        attempts: 2,
        status: "running"
      });
      const failed = jobs.markFailedOrRetry("job_feed_refresh", "permanent", 6200, 5000);
      expect(failed).toMatchObject({
        status: "failed",
        attempts: 2,
        error: "permanent",
        finishedAt: 6200
      });
    } finally {
      db.close();
    }
  });

  it("claims due jobs by priority before older lower-priority work", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const jobs = new SqliteJobRepository(db);
      jobs.enqueue({
        id: "job_low",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: "feed_low" }),
        maxAttempts: 1,
        priority: 0,
        runAfter: 900,
        now: 900
      });
      jobs.enqueue({
        id: "job_projection",
        type: "behavior_event_project",
        payloadJson: JSON.stringify({}),
        maxAttempts: 1,
        priority: 60,
        runAfter: 1000,
        now: 1000
      });

      expect(jobs.findById("job_projection")).toMatchObject({
        priority: 60
      });
      expect(jobs.claimNextDue(1000)).toMatchObject({
        id: "job_projection",
        type: "behavior_event_project",
        priority: 60
      });
      expect(jobs.claimNextDue(1000)).toMatchObject({
        id: "job_low",
        type: "feed_refresh",
        priority: 0
      });
    } finally {
      db.close();
    }
  });

  it("stores plugin installs, grants, settings, kv, and plugin job cancellation", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const plugins = new SqlitePluginRepository(db);
      const jobs = new SqliteJobRepository(db);
      const manifest = {
        manifestVersion: 1,
        id: "com.example.test",
        name: "Test Plugin",
        version: "1.0.0",
        publisher: "Example",
        dibao: { minVersion: "0.1.0", maxVersion: "<1.0.0" },
        capabilities: ["articles:read"],
        contributes: { hooks: ["settings.afterUpdated"] }
      };

      plugins.upsertInstall({
        id: manifest.id,
        version: manifest.version,
        sourceType: "local_file",
        packagePath: "/tmp/plugin",
        dataPath: "/tmp/plugin-data",
        manifestJson: JSON.stringify(manifest),
        status: "installed",
        official: false,
        bundled: false,
        trustLevel: "untrusted",
        now: 1000
      });
      plugins.grantCapabilities(manifest.id, manifest.capabilities, 1100);
      plugins.setSetting(manifest.id, "enabledFlag", true, 1200);
      plugins.setKv(manifest.id, "hook:settings.afterUpdated:last", { ok: true }, 1300);
      plugins.upsertSecret({
        pluginId: manifest.id,
        key: "webhook.token",
        ciphertext: "ciphertext",
        hint: "tok...",
        now: 1350
      });
      const delivery = plugins.upsertDelivery({
        id: "delivery_test",
        pluginId: manifest.id,
        status: "queued",
        method: "POST",
        url: "https://example.com/hook",
        requestJson: JSON.stringify({ method: "POST" }),
        idempotencyKey: "once",
        now: 1360
      });
      plugins.insertDeliveryAttempt({
        id: "attempt_test",
        deliveryId: delivery.id,
        attempt: 1,
        status: "failed",
        statusCode: 500,
        durationMs: 12,
        requestJson: "{}",
        responseJson: "{}",
        error: "HTTP 500",
        now: 1370
      });
      const updateCheck = plugins.upsertUpdateCheck({
        pluginId: manifest.id,
        latestVersion: "1.1.0",
        updateUrl: "https://example.com/plugin.json",
        checksum: "abc",
        now: 1400
      });

      expect(plugins.findInstall(manifest.id)).toMatchObject({
        id: manifest.id,
        status: "installed",
        trustLevel: "untrusted"
      });
      expect(plugins.listCapabilityGrants(manifest.id)).toEqual(["articles:read"]);
      expect(plugins.listSettings(manifest.id)).toEqual({ enabledFlag: true });
      expect(plugins.getKv(manifest.id, "hook:settings.afterUpdated:last")).toEqual({ ok: true });
      expect(plugins.listSecrets(manifest.id)).toEqual([
        expect.objectContaining({
          key: "webhook.token",
          hasValue: true,
          hint: "tok..."
        })
      ]);
      expect(plugins.getSecret(manifest.id, "webhook.token")?.ciphertext).toBe("ciphertext");
      expect(plugins.findDeliveryByIdempotencyKey(manifest.id, "once")).toMatchObject({
        id: "delivery_test",
        status: "queued"
      });
      expect(plugins.listDeliveryAttempts("delivery_test")).toEqual([
        expect.objectContaining({
          id: "attempt_test",
          status: "failed",
          statusCode: 500
        })
      ]);
      expect(plugins.updateDeliveryStatus("delivery_test", {
        status: "failed",
        error: "done",
        finishedAt: 1380,
        now: 1380
      })).toMatchObject({
        status: "failed",
        error: "done",
        finishedAt: 1380
      });
      expect(updateCheck).toMatchObject({
        pluginId: manifest.id,
        latestVersion: "1.1.0",
        checksum: "abc"
      });

      const pluginJob = jobs.enqueue({
        id: "job_plugin",
        type: "plugin:com.example.test:manual",
        now: 1500
      });
      expect(pluginJob.type).toBe("plugin:com.example.test:manual");
      expect(jobs.cancel(pluginJob.id, "Cancelled by test", 1600)).toMatchObject({
        status: "cancelled",
        error: "Cancelled by test",
        finishedAt: 1600
      });
    } finally {
      db.close();
    }
  });

  it("derives feed next refresh times from recent article frequency", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const hour = 60 * 60 * 1000;

      feeds.upsert({
        id: "feed_hourly",
        title: "Hourly Feed",
        feedUrl: "https://example.com/hourly.xml",
        now: 1000
      });
      feeds.upsert({
        id: "feed_slow",
        title: "Slow Feed",
        feedUrl: "https://example.com/slow.xml",
        now: 1000
      });

      for (const [feedId, timestamps] of [
        ["feed_hourly", [10 * hour, 8 * hour, 6 * hour]],
        ["feed_slow", [10 * hour, 10 * hour - 48 * hour]]
      ] as const) {
        for (const timestamp of timestamps) {
          articles.upsert({
            id: `${feedId}_${timestamp}`,
            feedId,
            url: `https://example.com/${feedId}/${timestamp}`,
            title: `${feedId} ${timestamp}`,
            publishedAt: timestamp,
            discoveredAt: timestamp,
            dedupeKey: `${feedId}_${timestamp}`,
            now: timestamp
          });
        }
      }

      feeds.recordFetchSuccess("feed_hourly", 20 * hour);
      feeds.recordFetchSuccess("feed_slow", 20 * hour);

      expect(feeds.findById("feed_hourly")).toMatchObject({
        nextRefreshAt: 22 * hour
      });
      expect(feeds.findById("feed_slow")).toMatchObject({
        nextRefreshAt: 44 * hour
      });
      expect(feeds.listActiveDue(22 * hour - 1).map((feed) => feed.id)).toEqual([]);
      expect(feeds.listActiveDue(22 * hour).map((feed) => feed.id)).toEqual(["feed_hourly"]);
      expect(feeds.listActiveDue(44 * hour).map((feed) => feed.id)).toEqual([
        "feed_hourly",
        "feed_slow"
      ]);
    } finally {
      db.close();
    }
  });

  it("persists feed full content mode and updates article hashes with effective content", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);

      feeds.upsert({
        id: "feed_full_content",
        title: "Full Content Feed",
        feedUrl: "https://example.com/full.xml",
        now: 1000
      });
      expect(feeds.findById("feed_full_content")?.fullContentMode).toBe("feed_only");
      expect(
        feeds.update({
          id: "feed_full_content",
          fullContentMode: "fetch_full_content",
          now: 2000
        })?.fullContentMode
      ).toBe("fetch_full_content");

      articles.upsert({
        id: "article_effective_content",
        feedId: "feed_full_content",
        url: "https://example.com/article",
        title: "Original title",
        summary: "Feed summary",
        contentHash: "feed-hash",
        dedupeKey: "article_effective_content",
        now: 3000
      });
      const result = articles.upsertContent({
        articleId: "article_effective_content",
        contentText: "Expanded full text with searchablehashmarker",
        extractionStatus: "success",
        contentHash: "full-content-hash",
        extractedAt: 4000,
        now: 4000
      });

      expect(result.contentHashChanged).toBe(true);
      expect(articles.findById("article_effective_content")?.contentHash).toBe(
        "full-content-hash"
      );
      expect(articles.search({ query: "searchablehashmarker" }).items.map((item) => item.id)).toEqual([
        "article_effective_content"
      ]);
    } finally {
      db.close();
    }
  });

  it("resets stale running jobs on runner startup", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const jobs = new SqliteJobRepository(db);
      jobs.enqueue({
        id: "job_retryable",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: "feed_1" }),
        maxAttempts: 2,
        runAfter: 1000,
        now: 1000
      });
      jobs.enqueue({
        id: "job_exhausted",
        type: "feed_refresh",
        payloadJson: JSON.stringify({ feedId: "feed_2" }),
        maxAttempts: 1,
        runAfter: 1000,
        now: 1000
      });

      jobs.claimNextDue(1100);
      jobs.claimNextDue(1200);

      expect(jobs.resetStaleRunning(2000)).toBe(2);
      expect(jobs.findById("job_retryable")).toMatchObject({
        status: "queued",
        attempts: 1,
        runAfter: 2000,
        startedAt: null,
        finishedAt: null
      });
      expect(jobs.findById("job_exhausted")).toMatchObject({
        status: "failed",
        attempts: 1,
        finishedAt: 2000
      });
    } finally {
      db.close();
    }
  });

  it("cleans retention candidates without losing behavior state or saved articles", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const actions = new SqliteArticleActionRepository(db);
      const embeddings = new SqliteEmbeddingRepository(db);
      const vectorStore = new SqliteVecVectorStore(db);
      const fts = new SqliteArticleFtsIndex(db);
      const now = Date.parse("2026-05-15T00:00:00.000Z");
      const cutoff = now - 60 * 24 * 60 * 60 * 1000;

      feeds.upsert({
        id: "feed_retention",
        title: "Retention Feed",
        feedUrl: "https://example.com/retention.xml",
        now
      });
      for (const article of [
        {
          id: "article_old_published",
          publishedAt: cutoff - 1000,
          discoveredAt: cutoff + 1000,
          title: "Old published cleanupvanish"
        },
        {
          id: "article_old_discovered",
          publishedAt: null,
          discoveredAt: cutoff - 2000,
          title: "Old discovered cleanupvanish"
        },
        {
          id: "article_favorite_old",
          publishedAt: cutoff - 3000,
          discoveredAt: cutoff - 3000,
          title: "Old favorite protected"
        },
        {
          id: "article_read_later_old",
          publishedAt: cutoff - 4000,
          discoveredAt: cutoff - 4000,
          title: "Old later protected"
        },
        {
          id: "article_recent",
          publishedAt: cutoff + 1000,
          discoveredAt: cutoff + 1000,
          title: "Recent active"
        }
      ]) {
        articles.upsert({
          id: article.id,
          feedId: "feed_retention",
          url: `https://example.com/${article.id}`,
          canonicalUrl: `https://example.com/${article.id}`,
          title: article.title,
          summary: "Retention fixture.",
          publishedAt: article.publishedAt,
          discoveredAt: article.discoveredAt,
          dedupeKey: article.id,
          now: article.discoveredAt
        });
        articles.upsertContent({
          articleId: article.id,
          contentText: `${article.title} body`,
          extractionStatus: "success",
          extractedAt: article.discoveredAt,
          now: article.discoveredAt
        });
      }

      expect(
        actions.record({
          articleId: "article_old_published",
          type: "open",
          eventId: "event_old_open",
          now
        })
      ).not.toBeNull();
      expect(
        actions.record({
          articleId: "article_favorite_old",
          type: "favorite",
          eventId: "event_favorite",
          now
        })
      ).not.toBeNull();
      expect(
        actions.record({
          articleId: "article_read_later_old",
          type: "read_later",
          eventId: "event_later",
          now
        })
      ).not.toBeNull();

      insertRank(db, "article_old_published", 0.5, now);
      embeddings.upsertProvider({
        id: "provider_retention",
        type: "embedded_local",
        name: "Retention Fixture",
        model: "fixture-4d",
        dimension: 4,
        enabled: true,
        now
      });
      for (const index of ["index_retention_one", "index_retention_two"]) {
        embeddings.createIndex({
          id: index,
          providerId: "provider_retention",
          model: "fixture-4d",
          dimension: 4,
          now
        });
        vectorStore.upsertArticleVector({
          articleId: "article_old_published",
          embeddingIndexId: index,
          vector: [0.9, 0.1, 0.05, 0.02],
          contentHash: `hash_${index}`,
          now
        });
      }

      const candidates = articles.listRetentionCandidates({ cutoff, limit: 10 });
      expect(candidates.map((candidate) => candidate.articleId)).toEqual([
        "article_old_discovered",
        "article_old_published"
      ]);

      const vectorRowsDeleted = candidates.reduce(
        (count, candidate) => count + vectorStore.deleteArticleVectors(candidate.articleId),
        0
      );
      const cleanup = articles.cleanupForRetention(
        candidates.map((candidate) => candidate.articleId),
        now
      );

      expect(vectorRowsDeleted).toBe(2);
      expect(cleanup).toMatchObject({
        articlesSoftDeleted: 2,
        contentsDeleted: 2,
        ftsRowsDeleted: 2,
        rankScoresDeleted: 1
      });
      expect(articles.findById("article_old_published")).toMatchObject({
        status: "deleted",
        deletedAt: now
      });
      expect(articles.list({ feedId: "feed_retention" }).items.map((article) => article.id)).toEqual([
        "article_recent",
        "article_favorite_old",
        "article_read_later_old"
      ]);
      expect(articles.findDetailById("article_old_published")).toBeNull();
      expect(fts.search("cleanupvanish", 10)).toHaveLength(0);
      expect(
        db.prepare("select count(*) as count from article_contents where article_id = ?").get(
          "article_old_published"
        )
      ).toEqual({ count: 0 });
      expect(
        db.prepare("select count(*) as count from article_embeddings where article_id = ?").get(
          "article_old_published"
        )
      ).toEqual({ count: 0 });
      expect(
        db.prepare("select count(*) as count from article_vector_rows where article_id = ?").get(
          "article_old_published"
        )
      ).toEqual({ count: 0 });
      expect(
        db.prepare("select count(*) as count from behavior_events where article_id = ?").get(
          "article_old_published"
        )
      ).toEqual({ count: 1 });
      expect(
        db.prepare("select count(*) as count from article_states where article_id = ?").get(
          "article_old_published"
        )
      ).toEqual({ count: 1 });

      const upserted = articles.upsert({
        id: "article_old_published",
        feedId: "feed_retention",
        url: "https://example.com/article_old_published",
        canonicalUrl: "https://example.com/article_old_published",
        title: "Old published returned",
        summary: "Returned by feed.",
        publishedAt: now,
        discoveredAt: now,
        dedupeKey: "article_old_published",
        status: "active",
        now: now + 1000
      });
      expect(upserted).toMatchObject({
        status: "deleted",
        deletedAt: now
      });
    } finally {
      db.close();
    }
  });

  it("initializes schema, repositories, FTS5, and sqlite-vec vector rebuild flow", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const settings = new SqliteAppSettingsRepository(db);
      settings.setJson("setup.completed", false, 1000);
      expect(settings.getJson("setup.completed")).toBe(false);

      const feeds = new SqliteFeedRepository(db);
      feeds.upsert({
        id: "feed_1",
        title: "Dibao Lab",
        feedUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        now: 1000
      });

      const articles = new SqliteArticleRepository(db);
      articles.upsert({
        id: "article_ai_local",
        feedId: "feed_1",
        url: "https://example.com/local-embedding",
        canonicalUrl: "https://example.com/local-embedding",
        title: "Local embedding for personal RSS ranking",
        summary: "Using local vectors for a private recommender.",
        dedupeKey: "local-embedding",
        now: 1000
      });
      articles.upsertContent({
        articleId: "article_ai_local",
        contentText: "RSS personalization with local embeddings and transparent ranking.",
        extractionStatus: "success",
        extractedAt: 1000,
        now: 1000
      });

      articles.upsert({
        id: "article_design",
        feedId: "feed_1",
        url: "https://example.com/design",
        canonicalUrl: "https://example.com/design",
        title: "Japanese editorial layout systems",
        summary: "Typography and quiet interface density.",
        dedupeKey: "design",
        now: 1000
      });
      articles.upsertContent({
        articleId: "article_design",
        contentText: "Editorial design, spacing, type and reading rhythm.",
        extractionStatus: "success",
        extractedAt: 1000,
        now: 1000
      });

      const fts = new SqliteArticleFtsIndex(db);
      expect(fts.search("embedding", 5)[0]?.articleId).toBe("article_ai_local");

      const embeddings = new SqliteEmbeddingRepository(db);
      embeddings.upsertProvider({
        id: "provider_fixture",
        type: "embedded_local",
        name: "Fixture",
        model: "deterministic-fixture-4d",
        dimension: 4,
        enabled: true,
        now: 1000
      });
      embeddings.createIndex({
        id: "index_fixture",
        providerId: "provider_fixture",
        model: "deterministic-fixture-4d",
        dimension: 4,
        now: 1000
      });

      const vectorStore = new SqliteVecVectorStore(db);
      vectorStore.upsertArticleVector({
        articleId: "article_ai_local",
        embeddingIndexId: "index_fixture",
        vector: [0.96, 0.12, 0.05, 0.02],
        contentHash: "hash_article_ai_local",
        now: 1000
      });
      vectorStore.upsertArticleVector({
        articleId: "article_design",
        embeddingIndexId: "index_fixture",
        vector: [0.05, 0.08, 0.92, 0.2],
        contentHash: "hash_article_design",
        now: 1000
      });

      const initial = vectorStore.searchSimilarArticles({
        embeddingIndexId: "index_fixture",
        vector: [0.94, 0.14, 0.04, 0.03],
        limit: 2
      });
      expect(initial[0]?.articleId).toBe("article_ai_local");

      db.exec(`
        delete from vec_articles_index_fixture;
        delete from article_vector_rows;
      `);
      expect(
        vectorStore.searchSimilarArticles({
          embeddingIndexId: "index_fixture",
          vector: [0.94, 0.14, 0.04, 0.03],
          limit: 2
        })
      ).toHaveLength(0);

      vectorStore.rebuildIndex("index_fixture");
      const rebuilt = vectorStore.searchSimilarArticles({
        embeddingIndexId: "index_fixture",
        vector: [0.94, 0.14, 0.04, 0.03],
        limit: 2
      });
      expect(rebuilt[0]?.articleId).toBe("article_ai_local");
    } finally {
      db.close();
    }
  });

  it("searches local articles with filters, pagination, CJK fallback, and recommendation-aware ordering", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const folders = new SqliteFeedFolderRepository(db);
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const actions = new SqliteArticleActionRepository(db);
      const rankings = new SqliteRankingRepository(db);

      folders.upsert({
        id: "folder_search",
        title: "Search Folder",
        now: 1000
      });
      feeds.upsert({
        id: "feed_search",
        folderId: "folder_search",
        title: "Search Feed",
        feedUrl: "https://example.com/search.xml",
        now: 1000
      });
      feeds.upsert({
        id: "feed_other",
        title: "Other Feed",
        feedUrl: "https://example.com/other.xml",
        now: 1000
      });

      const fixtures = [
        {
          id: "article_title",
          feedId: "feed_search",
          title: "Alpha launch report",
          summary: "Title match",
          content: "A short note.",
          publishedAt: 1000
        },
        {
          id: "article_content",
          feedId: "feed_search",
          title: "Release notes",
          summary: "Content match",
          content: "This article discusses alpha launch experiments in detail.",
          publishedAt: 2000
        },
        {
          id: "article_cjk",
          feedId: "feed_search",
          title: "腾讯研究院发布报告",
          summary: "中文搜索 fixture",
          content: "报告关注本地推荐系统。",
          publishedAt: 3000
        },
        {
          id: "article_favorite",
          feedId: "feed_search",
          title: "Alpha favorite",
          summary: "Favorite state",
          content: "Favorite alpha item.",
          publishedAt: 4000
        },
        {
          id: "article_later",
          feedId: "feed_search",
          title: "Alpha read later",
          summary: "Read later state",
          content: "Read later alpha item.",
          publishedAt: 5000
        },
        {
          id: "article_read",
          feedId: "feed_search",
          title: "Alpha read",
          summary: "Read state",
          content: "Read alpha item.",
          publishedAt: 6000
        },
        {
          id: "article_other_feed",
          feedId: "feed_other",
          title: "Alpha other feed",
          summary: "Other feed",
          content: "Other feed alpha item.",
          publishedAt: 7000
        },
        {
          id: "article_hidden",
          feedId: "feed_search",
          title: "Alpha hidden",
          summary: "Hidden state",
          content: "Hidden alpha item.",
          publishedAt: 8000
        },
        {
          id: "article_not_interested",
          feedId: "feed_search",
          title: "Alpha not interested",
          summary: "Not interested state",
          content: "Not interested alpha item.",
          publishedAt: 9000
        }
      ];

      for (const fixture of fixtures) {
        articles.upsert({
          id: fixture.id,
          feedId: fixture.feedId,
          url: `https://example.com/${fixture.id}`,
          title: fixture.title,
          summary: fixture.summary,
          publishedAt: fixture.publishedAt,
          discoveredAt: fixture.publishedAt,
          dedupeKey: fixture.id,
          now: fixture.publishedAt
        });
        articles.upsertContent({
          articleId: fixture.id,
          contentText: fixture.content,
          extractionStatus: "success",
          extractedAt: fixture.publishedAt,
          now: fixture.publishedAt
        });
      }

      actions.record({ articleId: "article_favorite", type: "favorite", now: 10_000 });
      actions.record({ articleId: "article_later", type: "read_later", now: 10_100 });
      actions.record({
        articleId: "article_read",
        type: "read_progress",
        progress: 0.95,
        now: 10_200
      });
      actions.record({ articleId: "article_hidden", type: "hide", now: 10_300 });
      actions.record({
        articleId: "article_not_interested",
        type: "not_interested",
        now: 10_400
      });

      rankings.upsertScore({
        articleId: "article_content",
        rankContext: "ctx_search",
        score: 0.95,
        baseScore: 0.95,
        interestScore: 0,
        sourceScore: 0,
        freshnessScore: 0,
        stateScore: 0,
        diversityScore: 0,
        penaltyScore: 0,
        rerankPosition: 1,
        calculatedAt: 11_000
      });
      rankings.upsertScore({
        articleId: "article_title",
        rankContext: "ctx_search",
        score: 0.1,
        baseScore: 0.1,
        interestScore: 0,
        sourceScore: 0,
        freshnessScore: 0,
        stateScore: 0,
        diversityScore: 0,
        penaltyScore: 0,
        rerankPosition: 2,
        calculatedAt: 11_000
      });

      expect(articles.search({ query: "report" }).items.map((article) => article.id)).toEqual([
        "article_title"
      ]);
      expect(articles.search({ query: "experiments" }).items.map((article) => article.id)).toEqual([
        "article_content"
      ]);
      expect(articles.search({ query: "腾讯" }).items.map((article) => article.id)).toEqual([
        "article_cjk"
      ]);
      expect(articles.search({ query: "研究院" }).items.map((article) => article.id)).toEqual([
        "article_cjk"
      ]);

      const visibleAlpha = articles.search({ query: "alpha", limit: 20 }).items.map((article) => article.id);
      expect(visibleAlpha).toContain("article_title");
      expect(visibleAlpha).not.toContain("article_hidden");
      expect(visibleAlpha).not.toContain("article_not_interested");

      expect(
        articles.search({ query: "alpha", feedId: "feed_other" }).items.map((article) => article.id)
      ).toEqual(["article_other_feed"]);
      expect(
        articles.search({ query: "alpha", folderId: "folder_search", limit: 20 }).items.map((article) => article.id)
      ).not.toContain("article_other_feed");
      expect(
        articles.search({ query: "alpha", state: "favorites" }).items.map((article) => article.id)
      ).toEqual(["article_favorite"]);
      expect(
        articles.search({ query: "alpha", state: "read_later" }).items.map((article) => article.id)
      ).toEqual(["article_later"]);
      expect(
        articles.search({ query: "alpha", state: "read" }).items.map((article) => article.id)
      ).toEqual(["article_read"]);
      expect(
        articles.search({ query: "alpha", state: "unread", limit: 20 }).items.map((article) => article.id)
      ).toEqual(["article_other_feed", "article_title", "article_content"]);
      expect(
        articles.search({ query: "alpha", from: 1500, to: 4500, limit: 20 }).items.map((article) => article.id)
      ).toEqual(["article_favorite", "article_content"]);

      const firstPage = articles.search({ query: "alpha", limit: 1 });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextOffset).toBe(1);

      expect(
        articles.search({ query: "launch", sort: "relevance", limit: 2 }).items.map((article) => article.id)
      ).toEqual(["article_title", "article_content"]);
      expect(
        articles.search({ query: "alpha", sort: "latest", limit: 2 }).items.map((article) => article.id)
      ).toEqual(["article_other_feed", "article_read"]);
      expect(
        articles.search({
          query: "alpha",
          sort: "recommended",
          rankContext: "ctx_search",
          limit: 2
        }).items.map((article) => article.id)
      ).toEqual(["article_content", "article_title"]);
      expect(
        articles.search({
          query: "alpha",
          sort: "recommended",
          rankContext: "ctx_missing",
          limit: 2
        }).items.map((article) => article.id)
      ).toEqual(["article_read", "article_favorite"]);
      expect(articles.search({ query: "alpha" }).unreadCount).toBe(3);
      expect(articles.search({ query: "   " })).toEqual({
        items: [],
        nextOffset: null,
        unreadCount: 0
      });
    } finally {
      db.close();
    }
  });

  it("paginates non-recommended article lists with keyset cursors", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const actions = new SqliteArticleActionRepository(db);

      feeds.upsert({
        id: "feed_keyset",
        title: "Keyset Feed",
        feedUrl: "https://example.com/keyset.xml",
        now: 1000
      });

      for (const timestamp of [1000, 2000, 3000, 4000, 5000]) {
        articles.upsert({
          id: `article_keyset_${timestamp}`,
          feedId: "feed_keyset",
          url: `https://example.com/keyset/${timestamp}`,
          title: `Keyset ${timestamp}`,
          publishedAt: timestamp,
          discoveredAt: timestamp,
          dedupeKey: `article_keyset_${timestamp}`,
          now: timestamp
        });
      }

      actions.record({ articleId: "article_keyset_1000", type: "favorite", now: 11_000 });
      actions.record({ articleId: "article_keyset_2000", type: "favorite", now: 12_000 });
      actions.record({ articleId: "article_keyset_3000", type: "favorite", now: 13_000 });
      actions.record({ articleId: "article_keyset_3000", type: "read_later", now: 21_000 });
      actions.record({ articleId: "article_keyset_4000", type: "read_later", now: 22_000 });
      actions.record({ articleId: "article_keyset_5000", type: "read_later", now: 23_000 });

      const latestFirst = articles.list({ view: "latest", limit: 2 });
      expect(latestFirst.items.map((article) => article.id)).toEqual([
        "article_keyset_5000",
        "article_keyset_4000"
      ]);
      expect(latestFirst.nextCursor).toMatchObject({ type: "latest" });
      expect(
        articles.list({ view: "latest", limit: 2, cursor: latestFirst.nextCursor ?? undefined }).items.map((article) => article.id)
      ).toEqual(["article_keyset_3000", "article_keyset_2000"]);

      const favoritesFirst = articles.list({ view: "favorites", sort: "favorited_desc", limit: 2 });
      expect(favoritesFirst.items.map((article) => article.id)).toEqual([
        "article_keyset_3000",
        "article_keyset_2000"
      ]);
      expect(favoritesFirst.nextCursor).toMatchObject({ type: "favorites" });
      expect(
        articles.list({
          view: "favorites",
          sort: "favorited_desc",
          limit: 2,
          cursor: favoritesFirst.nextCursor ?? undefined
        }).items.map((article) => article.id)
      ).toEqual(["article_keyset_1000"]);

      const readLaterFirst = articles.list({
        view: "read_later",
        sort: "read_later_desc",
        limit: 2
      });
      expect(readLaterFirst.items.map((article) => article.id)).toEqual([
        "article_keyset_5000",
        "article_keyset_4000"
      ]);
      expect(readLaterFirst.nextCursor).toMatchObject({ type: "read_later" });
      expect(
        articles.list({
          view: "read_later",
          sort: "read_later_desc",
          limit: 2,
          cursor: readLaterFirst.nextCursor ?? undefined
        }).items.map((article) => article.id)
      ).toEqual(["article_keyset_3000"]);
    } finally {
      db.close();
    }
  });

  it("resolves unread article scopes and marks ids read without behavior events", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const folders = new SqliteFeedFolderRepository(db);
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const actions = new SqliteArticleActionRepository(db);
      const commandEvents = new SqliteReaderCommandEventRepository(db);

      folders.upsert({ id: "folder_scope", title: "Scope Folder", now: 1000 });
      feeds.upsert({
        id: "feed_scope",
        folderId: "folder_scope",
        title: "Scope Feed",
        feedUrl: "https://example.com/scope.xml",
        now: 1000
      });
      feeds.upsert({
        id: "feed_other_scope",
        title: "Other Scope Feed",
        feedUrl: "https://example.com/other-scope.xml",
        now: 1000
      });

      for (const fixture of [
        ["article_scope_recent", "feed_scope", "Scope recent alpha", 9_000],
        ["article_scope_old", "feed_scope", "Scope old alpha", 1_000],
        ["article_scope_other_feed", "feed_other_scope", "Scope other alpha", 9_100],
        ["article_scope_favorite", "feed_scope", "Scope favorite alpha", 9_200],
        ["article_scope_later", "feed_scope", "Scope later alpha", 9_300],
        ["article_scope_hidden", "feed_scope", "Scope hidden alpha", 9_400],
        ["article_scope_not_interested", "feed_scope", "Scope not interested alpha", 9_500]
      ] as const) {
        articles.upsert({
          id: fixture[0],
          feedId: fixture[1],
          url: `https://example.com/${fixture[0]}`,
          title: fixture[2],
          summary: "Scope fixture",
          publishedAt: fixture[3],
          discoveredAt: fixture[3],
          dedupeKey: fixture[0],
          now: fixture[3]
        });
        articles.upsertContent({
          articleId: fixture[0],
          contentText: `${fixture[2]} body`,
          extractionStatus: "success",
          extractedAt: fixture[3],
          now: fixture[3]
        });
      }

      actions.record({ articleId: "article_scope_favorite", type: "favorite", now: 10_000 });
      actions.record({ articleId: "article_scope_later", type: "read_later", now: 10_100 });
      actions.record({ articleId: "article_scope_hidden", type: "hide", now: 10_200 });
      actions.record({
        articleId: "article_scope_not_interested",
        type: "not_interested",
        now: 10_300
      });

      const articleListScope = {
        type: "article_list",
        view: "latest",
        folderId: "folder_scope",
        clearWindow: "24h",
        beforeAt: 8_000
      } as const;
      const searchScope = {
        type: "search",
        query: "alpha",
        feedId: "feed_scope",
        from: 8_000,
        to: 11_000,
        state: "all"
      } as const;

      expect(articles.countUnreadForScope(articleListScope)).toBe(1);
      expect(articles.listUnreadArticleIdsForScope(articleListScope)).toEqual([
        "article_scope_old"
      ]);
      expect(articles.countUnreadForScope(searchScope)).toBe(1);
      expect(articles.countUnreadForScope({ ...searchScope, state: "read" })).toBe(0);

      const behaviorCountBefore = countTable(db, "behavior_events");
      const markedReadCount = commandEvents.transaction(() => {
        const result = articles.markScopeRead(searchScope, 12_000);
        commandEvents.record({
          id: "cmd_scope_read",
          commandType: "mark_scope_read",
          scope: searchScope,
          result,
          createdAt: 12_000
        });
        return result.markedReadCount;
      });

      expect(markedReadCount).toBe(1);
      expect(articles.countUnreadForScope(searchScope)).toBe(0);
      expect(countTable(db, "behavior_events")).toBe(behaviorCountBefore);
      expect(db.prepare("select command_type as commandType from reader_command_events").get()).toEqual({
        commandType: "mark_scope_read"
      });
      expect(
        db
          .prepare(
            "select read_later_at as readLaterAt from article_states where article_id = 'article_scope_later'"
          )
          .get()
      ).toEqual({ readLaterAt: 10_100 });
      expect(
        db
          .prepare(
            "select favorited_at as favoritedAt from article_states where article_id = 'article_scope_favorite'"
          )
          .get()
      ).toEqual({ favoritedAt: 10_000 });
    } finally {
      db.close();
    }
  });

  it("reads ranking candidates and writes base rank scores", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const feeds = new SqliteFeedRepository(db);
      feeds.upsert({
        id: "feed_rank",
        title: "Ranking Feed",
        feedUrl: "https://example.com/ranking.xml",
        sourceWeight: 0.5,
        now: 1000
      });

      const articles = new SqliteArticleRepository(db);
      articles.upsert({
        id: "article_rank",
        feedId: "feed_rank",
        url: "https://example.com/rank",
        title: "Rank candidate",
        publishedAt: 1000,
        discoveredAt: 1000,
        dedupeKey: "rank",
        now: 1000
      });

      const actions = new SqliteArticleActionRepository(db);
      actions.record({
        articleId: "article_rank",
        type: "favorite",
        now: 2000
      });

      const rankings = new SqliteRankingRepository(db);
      const candidate = rankings.listBaseCandidates({ articleIds: ["article_rank"] })[0];

      expect(candidate).toMatchObject({
        articleId: "article_rank",
        feedId: "feed_rank",
        sourceWeight: 0.5,
        state: {
          favorited: true
        },
        behaviorProjectionScore: 0.12,
        behaviorEventCount: 1
      });

      articles.upsert({
        id: "article_like_rank",
        feedId: "feed_rank",
        url: "https://example.com/like-rank",
        title: "Like rank candidate",
        publishedAt: 1000,
        discoveredAt: 1000,
        dedupeKey: "like-rank",
        now: 1000
      });
      actions.record({
        articleId: "article_like_rank",
        type: "like",
        now: 2000
      });
      const likeCandidate = rankings.listBaseCandidates({ articleIds: ["article_like_rank"] })[0];
      expect(likeCandidate).toMatchObject({
        state: {
          liked: true
        },
        behaviorProjectionScore: 0.16,
        behaviorEventCount: 1
      });
      expect(likeCandidate?.behaviorProjectionScore).toBeGreaterThan(
        candidate?.behaviorProjectionScore ?? 0
      );

      const pagedCandidate = rankings.listCandidates({
        afterArticleId: "article_like_rank",
        limit: 1
      })[0];
      expect(pagedCandidate).toMatchObject({
        articleId: "article_rank",
        behaviorProjectionScore: 0.12,
        behaviorEventCount: 1
      });

      rankings.upsertBaseScore({
        articleId: "article_rank",
        score: 0.75,
        interestScore: 0.1,
        sourceScore: 0.2,
        freshnessScore: 0.3,
        stateScore: 0.15,
        diversityScore: 0,
        penaltyScore: 0,
        calculatedAt: 3000
      });

      expect(articles.list({ view: "recommended" }).items[0]?.rank).toEqual({
        score: 0.75,
        calculatedAt: 3000
      });
    } finally {
      db.close();
    }
  });

  it("reads active ranking candidates, profile snapshots, and active rank fallback", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const embeddings = new SqliteEmbeddingRepository(db);
      const vectorStore = new SqliteVecVectorStore(db);
      const rankings = new SqliteRankingRepository(db);
      const profiles = new SqliteProfileRepository(db);

      feeds.upsert({
        id: "feed_profile",
        title: "Profile Feed",
        feedUrl: "https://example.com/profile.xml",
        now: 1000
      });
      articles.upsert({
        id: "article_profile",
        feedId: "feed_profile",
        url: "https://example.com/profile",
        title: "Profile candidate",
        publishedAt: 1000,
        discoveredAt: 1000,
        contentHash: "hash_profile",
        dedupeKey: "profile",
        now: 1000
      });
      embeddings.upsertProvider({
        id: "provider_profile",
        type: "openai_compatible",
        name: "Provider",
        model: "fixture",
        dimension: 3,
        enabled: true,
        now: 1000
      });
      embeddings.createIndex({
        id: "index_profile",
        providerId: "provider_profile",
        model: "fixture",
        dimension: 3,
        now: 1000
      });
      vectorStore.upsertArticleVector({
        articleId: "article_profile",
        embeddingIndexId: "index_profile",
        vector: [1, 0, 0],
        contentHash: "hash_profile",
        now: 1000
      });

      const candidate = rankings.listCandidates({
        embeddingIndexId: "index_profile",
        articleIds: ["article_profile"]
      })[0];
      expect(candidate?.embeddingContentHash).toBe("hash_profile");
      expect(candidate?.vectorBlob ? fromVectorBlob(candidate.vectorBlob) : null).toEqual([
        1, 0, 0
      ]);

      profiles.upsertTopicSnapshot({
        articleId: "article_profile",
        feedId: "feed_profile",
        topicSnapshotJson: JSON.stringify({
          profileV0: {
            index_profile: {
              hash_profile: {
                processedEventIds: ["event_1"]
              }
            }
          }
        }),
        now: 2000
      });
      expect(profiles.getTopicSnapshot("article_profile")).toContain("event_1");

      rankings.upsertBaseScore({
        articleId: "article_profile",
        score: 0.42,
        interestScore: 0,
        sourceScore: 0,
        freshnessScore: 0.42,
        stateScore: 0,
        diversityScore: 0,
        penaltyScore: 0,
        calculatedAt: 2000
      });
      expect(
        articles.list({ view: "recommended", rankContext: "index_profile" }).items[0]?.rank
      ).toEqual({
        score: 0.42,
        calculatedAt: 2000
      });
    } finally {
      db.close();
    }
  });

  it("orders recommended article lists from rank scores while preserving active and base fallback", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      feeds.upsert({
        id: "feed_ranked_list",
        title: "Ranked List Feed",
        feedUrl: "https://example.com/ranked-list.xml",
        now: 1000
      });

      for (const id of ["base_only", "active_high", "active_low", "unranked"]) {
        articles.upsert({
          id: `article_${id}`,
          feedId: "feed_ranked_list",
          url: `https://example.com/${id}`,
          title: id,
          publishedAt: 1000,
          discoveredAt: 1000,
          dedupeKey: id,
          now: 1000
        });
      }

      insertRank(db, "article_base_only", 0.95, 2000);
      insertRank(db, "article_active_high", 0.1, 2000);
      insertRank(db, "article_active_high", 0.9, 3000, "active");
      insertRank(db, "article_active_low", 0.7, 3000, "active");

      const firstPage = articles.list({ view: "recommended", rankContext: "active", limit: 2 });
      expect(firstPage.items.map((item) => item.id)).toEqual([
        "article_base_only",
        "article_active_high"
      ]);
      expect(firstPage.nextCursor).toMatchObject({ type: "recommended" });
      expect(firstPage.timing).toMatchObject({
        unreadCountMs: expect.any(Number),
        rankCandidateMs: expect.any(Number),
        hydrateMs: expect.any(Number)
      });
      expect(
        articles
          .list({ view: "recommended", rankContext: "active", limit: 3, offset: 2 })
          .items.map((item) => item.id)
      ).toEqual(["article_active_low", "article_unranked"]);
      expect(
        articles
          .list({
            view: "recommended",
            rankContext: "active",
            limit: 3,
            cursor: firstPage.nextCursor ?? undefined
          })
          .items.map((item) => item.id)
      ).toEqual(["article_active_low", "article_unranked"]);
      const withoutCount = articles.list({
        view: "recommended",
        rankContext: "active",
        includeUnreadCount: false,
        limit: 2
      });
      expect(withoutCount.unreadCount).toBeNull();
      expect(withoutCount.timing?.unreadCountMs).toBe(0);
    } finally {
      db.close();
    }
  });

  it("stores auth credentials and hashed sessions", () => {
    const db = openDatabase(tempDatabasePath(), { migrate: true });
    try {
      const credentials = new SqliteAuthCredentialRepository(db);
      const sessions = new SqliteSessionRepository(db);

      expect(credentials.hasCredential()).toBe(false);
      credentials.createCredential({
        id: "single_user",
        username: "Pls",
        passwordHash: "scrypt:v1:hash",
        passwordAlgo: "scrypt:v1",
        now: 1000
      });
      expect(credentials.hasCredential()).toBe(true);
      expect(credentials.findCredential()).toMatchObject({
        id: "single_user",
        username: "Pls",
        passwordHash: "scrypt:v1:hash",
        passwordAlgo: "scrypt:v1",
        createdAt: 1000,
        updatedAt: 1000
      });

      const createdSession = sessions.createSession({
        id: "session_1",
        sessionHash: "hash_1",
        createdAt: 2000,
        expiresAt: 3000,
        userAgent: "vitest",
        ipHash: "ip_hash"
      });
      expect(createdSession).toMatchObject({
        id: "session_1",
        sessionHash: "hash_1",
        createdAt: 2000,
        expiresAt: 3000,
        lastSeenAt: 2000,
        userAgent: "vitest",
        ipHash: "ip_hash"
      });
      expect(sessions.findByHash("hash_1")).toMatchObject({
        id: "session_1",
        sessionHash: "hash_1",
        lastSeenAt: 2000
      });

      sessions.touchSession("session_1", 2500);
      expect(sessions.findByHash("hash_1")).toMatchObject({
        lastSeenAt: 2500
      });

      sessions.deleteExpired(3000);
      expect(sessions.findByHash("hash_1")).toBeNull();
    } finally {
      db.close();
    }
  });
});

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dibao-db-"));
  tempDirs.push(dir);
  return join(dir, "dibao.sqlite");
}

function insertRank(
  db: ReturnType<typeof openDatabase>,
  articleId: string,
  score: number,
  calculatedAt: number,
  rankContext = "base"
): void {
  db.prepare(
    `
      insert into article_rank_scores (
        article_id,
        rank_context,
        embedding_index_id,
        score,
        interest_score,
        source_score,
        freshness_score,
        state_score,
        diversity_score,
        penalty_score,
        calculated_at
      )
      values (?, ?, null, ?, 0, 0, 0, 0, 0, 0, ?)
    `
  ).run(articleId, rankContext, score, calculatedAt);
}

function hasTableOrView(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return Boolean(
    db
      .prepare(
        `
          select 1
          from sqlite_schema
          where name = ?
            and type in ('table', 'view')
        `
      )
      .get(name)
  );
}

function hasFtsTable(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return Boolean(
    db
      .prepare(
        `
          select 1
          from sqlite_schema
          where name = ?
            and type = 'table'
            and sql like '%using fts5%'
        `
      )
      .get(name)
  );
}

function hasColumn(
  db: ReturnType<typeof openDatabase>,
  tableName: string,
  columnName: string
): boolean {
  return db
    .prepare(`pragma table_info(${tableName})`)
    .all()
    .some((row) => (row as { name: string }).name === columnName);
}

function hasIndex(db: ReturnType<typeof openDatabase>, indexName: string): boolean {
  return Boolean(
    db
      .prepare(
        `
          select 1
          from sqlite_schema
          where name = ?
            and type = 'index'
        `
      )
      .get(indexName)
  );
}

function countTable(db: ReturnType<typeof openDatabase>, tableName: string): number {
  const row = db.prepare(`select count(*) as count from ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}
