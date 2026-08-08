import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAppliedMigrations, openDatabase, runMigrations, type DibaoDatabase } from "@dibao/db";

const dbPath = process.env.DIBAO_DATABASE_PATH;

if (!dbPath) {
  fail("DIBAO_DATABASE_PATH is required.");
}

if (process.env.DIBAO_ALLOW_BLOCKING_MIGRATION !== "1") {
  fail("Refusing core migration without DIBAO_ALLOW_BLOCKING_MIGRATION=1.");
}

if (process.env.DIBAO_DB_BACKUP_CONFIRMED !== "1") {
  fail("Refusing core migration without DIBAO_DB_BACKUP_CONFIRMED=1.");
}

const resolvedDbPath = resolve(dbPath);
const existedBefore = existsSync(resolvedDbPath);
mkdirSync(dirname(resolvedDbPath), { recursive: true });

const backupPath =
  process.env.DIBAO_BACKUP_PATH ??
  `${resolvedDbPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const db = openDatabase(resolvedDbPath, { migrate: false });

try {
  const before = snapshot(db);
  let backup:
    | { created: true; path: string; size: number; sha256: string }
    | { created: false; reason: string };

  if (existedBefore) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(resolvedDbPath, backupPath);
    backup = {
      created: true,
      path: backupPath,
      size: statSync(backupPath).size,
      sha256: await sha256File(backupPath)
    };
  } else {
    backup = { created: false, reason: "database_did_not_exist" };
  }

  const appliedNow = runMigrations(db);
  const after = snapshot(db);

  console.log(
    JSON.stringify(
      {
        ok: true,
        blockingMigration: true,
        databasePath: resolvedDbPath,
        gitSha: process.env.DIBAO_GIT_SHA ?? null,
        image: process.env.DIBAO_IMAGE_TAG ?? null,
        backup,
        appliedNow,
        before,
        after
      },
      null,
      2
    )
  );
} finally {
  db.close();
}

function snapshot(database: DibaoDatabase) {
  return {
    counts: {
      feeds: countRelation(database, "feeds"),
      articles: countRelation(database, "articles"),
      behaviorEvents: countRelation(database, "behavior_events"),
      articleEmbeddings: countRelation(database, "article_embeddings"),
      jobs: countRelation(database, "jobs"),
      pluginInstalls: countRelation(database, "plugin_installs"),
      pluginSettings: countRelation(database, "plugin_settings"),
      pluginSchedules: countRelation(database, "plugin_schedules"),
      interestFamilies: countRelation(database, "interest_families"),
      interestFamilyLabels: countRelation(database, "interest_family_labels")
    },
    activeEmbeddingIndex: activeEmbeddingIndex(database),
    migrations: hasRelation(database, "schema_migrations") ? getAppliedMigrations(database) : []
  };
}

function activeEmbeddingIndex(database: DibaoDatabase) {
  if (!hasRelation(database, "embedding_indexes")) {
    return null;
  }
  return (
    database
      .prepare(
        `
          select id, provider_id as providerId, model, dimension, status, updated_at as updatedAt
          from embedding_indexes
          where status = 'active'
          order by updated_at desc, id
          limit 1
        `
      )
      .get() ?? null
  );
}

function countRelation(database: DibaoDatabase, name: string): number | null {
  if (!hasRelation(database, name)) {
    return null;
  }
  return (database.prepare(`select count(*) as count from ${name}`).get() as { count: number }).count;
}

function hasRelation(database: DibaoDatabase, name: string): boolean {
  const row = database
    .prepare("select 1 as ok from sqlite_master where type in ('table', 'view') and name = ?")
    .get(name) as { ok: number } | undefined;
  return row !== undefined;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
