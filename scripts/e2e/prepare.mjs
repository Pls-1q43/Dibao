import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase, SqliteAppSettingsRepository, SqliteEmbeddingRepository, SqliteProfileRepository, SqliteRankingRepository } from "../../packages/db/dist/index.js";
import { DerivedDataUpgradeService } from "../../apps/server/dist/derived-data-upgrade-service.js";
import { ProfileRebuildService } from "../../apps/server/dist/profile-rebuild-service.js";
import { ProfileService } from "../../apps/server/dist/profile-service.js";
import { RecommendationRankingService } from "../../apps/server/dist/ranking-service.js";

const databasePath = resolve(".tmp/e2e/dibao.sqlite");

rmSync(databasePath, { force: true });
rmSync(`${databasePath}-shm`, { force: true });
rmSync(`${databasePath}-wal`, { force: true });
mkdirSync(dirname(databasePath), { recursive: true });

// Record a real empty-installation contract, not the retired v0.1.1 marker.
// The standalone HTTP upgrade runner handles later provider/index changes even
// though Playwright deliberately disables ordinary background jobs.
const db = openDatabase(databasePath, { migrate: true });
try {
  const embeddings = new SqliteEmbeddingRepository(db);
  const profiles = new SqliteProfileRepository(db);
  const upgrade = new DerivedDataUpgradeService({
    db,
    settings: new SqliteAppSettingsRepository(db),
    profileRebuild: new ProfileRebuildService({
      db,
      profile: new ProfileService({ embeddings, profiles }),
      ranking: new RecommendationRankingService({ db, embeddings, profiles, rankings: new SqliteRankingRepository(db) })
    })
  });
  await upgrade.startIfRequired();
  await upgrade.stop();
} finally {
  db.close();
}
