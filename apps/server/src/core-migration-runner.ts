import {
  openDatabase,
  runMigrations,
  SqliteVecVectorStore,
  type AppliedMigration,
  type Migration,
  type VectorIndexUpgradeResult
} from "@dibao/db";

const databasePath = process.env.DIBAO_DATABASE_PATH;

if (!databasePath) {
  emit({
    type: "failed",
    error: "DIBAO_DATABASE_PATH is required"
  });
  process.exit(1);
}

const db = openDatabase(databasePath, { migrate: false });

try {
  const appliedNow = runMigrations(db, undefined, Date.now, {
    onMigrationStart: ({ migration, index, total, appliedAt }) => {
      emit({
        type: "migration_started",
        migration: migrationSummary(migration),
        index,
        total,
        appliedAt
      });
    },
    onMigrationApplied: ({ applied, migration, index, total, appliedAt }) => {
      emit({
        type: "migration_applied",
        migration: migrationSummary(migration),
        index,
        total,
        appliedAt,
        applied
      });
    }
  });
  const vectorStore = new SqliteVecVectorStore(db);
  const vectorIndexesUpgraded: VectorIndexUpgradeResult[] = [];
  for (const plan of vectorStore.listCosineUpgradePlans()) {
    vectorIndexesUpgraded.push(
      ...vectorStore.upgradeIndexesToCosine({
        embeddingIndexIds: [plan.embeddingIndexId],
        onProgress: (progress) => {
          emit({
            type: "vector_index_progress",
            ...progress
          });
        }
      })
    );
  }
  emit({
    type: "completed",
    appliedNow,
    vectorIndexesUpgraded
  });
} catch (error) {
  emit({
    type: "failed",
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
} finally {
  db.close();
}

function migrationSummary(migration: Migration): Pick<Migration, "version" | "name"> {
  return {
    version: migration.version,
    name: migration.name
  };
}

function emit(
  message:
    | {
        type: "migration_started";
        migration: Pick<Migration, "version" | "name">;
        index: number;
        total: number;
        appliedAt: number;
      }
    | {
        type: "migration_applied";
        migration: Pick<Migration, "version" | "name">;
        index: number;
        total: number;
        appliedAt: number;
        applied: AppliedMigration;
      }
    | {
        type: "completed";
        appliedNow: AppliedMigration[];
        vectorIndexesUpgraded: VectorIndexUpgradeResult[];
      }
    | {
        type: "vector_index_progress";
        embeddingIndexId: string;
        current: number;
        total: number;
      }
    | {
        type: "failed";
        error: string;
      }
): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
