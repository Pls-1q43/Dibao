import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkVersion } from "./check-version.mjs";
import { assertImageArchitecture, assertUpgradeStatus, embeddingSnapshot, seedFixture, sentryReport } from "./image-probe.mjs";
import { platformImages, safeProbeFailure } from "./verify-docker-release.mjs";
import { assertImmutableTags, isMissingManifest } from "./promote-image.mjs";
import { openDatabase, runMigrations, SqliteVecVectorStore, SqliteAppSettingsRepository,
  SqliteEmbeddingRepository, SqliteProfileRepository, SqliteRankingRepository } from "../../packages/db/src/index.ts";
import { DerivedDataUpgradeService } from "../../apps/server/src/derived-data-upgrade-service.ts";
import { ProfileRebuildService } from "../../apps/server/src/profile-rebuild-service.ts";
import { ProfileService } from "../../apps/server/src/profile-service.ts";
import { RecommendationRankingService } from "../../apps/server/src/ranking-service.ts";
import { SettingsService } from "../../apps/server/src/settings-service.ts";
import { InterestClusterLabelService } from "../../apps/server/src/interest-cluster-label-service.ts";
import { InterestClusterCalibrationService } from "../../apps/server/src/interest-cluster-calibration-service.ts";
import { InterestFamilyService } from "../../apps/server/src/interest-family-service.ts";

test("release versions cover root, workspaces, internal refs, lock and runtime constant", () => {
  const root = mkdtempSync(resolve(tmpdir(), "dibao-version-gate-"));
  const write = (path, value) => writeFileSync(resolve(root, path), typeof value === "string" ? value : JSON.stringify(value));
  try {
    mkdirSync(resolve(root, "packages/shared/src"), { recursive: true });
    const pkg = { version: "0.4.0", workspaces: ["packages/*"] };
    const shared = { name: "@dibao/shared", version: "0.4.0", dependencies: { "@dibao/shared": "0.4.0" } };
    const lock = { version: "0.4.0", packages: { "": pkg, "packages/shared": shared } };
    write("package.json", pkg); write("package-lock.json", lock); write("packages/shared/package.json", shared);
    write("packages/shared/src/index.ts", 'export const dibaoVersion = "0.4.0";');
    assert.equal(checkVersion(root, { tag: "v0.4.0", moving: true }), "0.4.0");
    for (const tag of ["v0.3.1", "v0.4.0-extra", "stable", "latest", "bad tag"]) assert.throws(() => checkVersion(root, { tag }));
    assert.throws(() => checkVersion(root, { tag: "manual", moving: true }));
    write("packages/shared/package.json", { ...shared, version: "0.3.1" });
    assert.throws(() => checkVersion(root));
    write("packages/shared/package.json", { ...shared, dependencies: { "@dibao/shared": "0.3.1" } });
    assert.throws(() => checkVersion(root));
    write("packages/shared/package.json", shared);
    write("packages/shared/src/index.ts", 'export const dibaoVersion = "0.3.1";');
    assert.throws(() => checkVersion(root));
    write("packages/shared/src/index.ts", 'export const dibaoVersion = "0.4.0";');
    write("package-lock.json", { ...lock, version: "0.3.1" });
    assert.throws(() => checkVersion(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("image gate rejects health-only, pending/failed and vacuous upgrade acceptance", () => {
  assertUpgradeStatus({ state: "completed", blocking: false, error: null }, true);
  assertUpgradeStatus({ state: "not_required", blocking: false, error: null }, false);
  for (const value of [null, { ok: true }, { state: "pending", blocking: true },
    { state: "failed", blocking: false }, { state: "not_required", blocking: false, error: null }]) {
    assert.throws(() => assertUpgradeStatus(value, true));
  }
});

test("Sentry gate requires both bundles and never returns private values", () => {
  const config = { dsn: "private-dsn", org: "private-org", project: "private-project" };
  const bundle = Object.values(config).join(" ") + ';e._sentryDebugIds[t]=`9a07edaf-e266-4e12-bbec-06ecbe501497`;';
  const result = sentryReport(config, bundle);
  assert(Object.values(result).every((value) => value === true));
  assert.throws(() => sentryReport(config, ""));
  assert.throws(() => sentryReport({ ...config, dsn: "" }, bundle));
  assert.throws(() => sentryReport({ ...config, authToken: "private-token" }, bundle));
  assert.throws(() => sentryReport(config, Object.values(config).join(" ")));
  assert.throws(() => sentryReport(config, Object.values(config).join(" ") + ";read(e._sentryDebugIds);"));
  assert.throws(() => sentryReport(config, Object.values(config).join(" ") + ';e._sentryDebugIds[t]="not-a-debug-id";'));
  assert.equal(sentryReport(config, bundle.replaceAll("`", '"')).browser_debug_ids, true);
});

test("image architecture gate maps OCI amd64 to Node x64 without accepting wrong architectures", () => {
  assertImageArchitecture("amd64", "x64");
  assertImageArchitecture("arm64", "arm64");
  assert.throws(() => assertImageArchitecture("amd64", "arm64"));
  assert.throws(() => assertImageArchitecture("arm64", "x64"));
  assert.throws(() => assertImageArchitecture("amd64", "amd64"));
  assert.throws(() => assertImageArchitecture(undefined, "x64"));
});

test("published platform selection is pinned to digest and rejects missing/duplicate platforms", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const image = `ghcr.io/example/dibao@${digest}`;
  const manifest = { digest, manifests: ["amd64", "arm64"].map((arch, i) => ({
    digest: `sha256:${String(i).repeat(64)}`, platform: { os: "linux", architecture: arch }
  })) };
  assert.deepEqual(platformImages(manifest, image).map((m) => m.platform), ["linux/amd64", "linux/arm64"]);
  assert.throws(() => platformImages({ ...manifest, manifests: manifest.manifests.slice(0, 1) }, image));
  assert.throws(() => platformImages({ ...manifest, manifests: [...manifest.manifests, manifest.manifests[0]] }, image));
  assert.throws(() => platformImages({ ...manifest, digest: "wrong" }, image));
});

for (const tag of ["v0.3.1", "v0.1.0", "v0.1.3"]) {
  test(`image fixture runs on actual ${tag} migrations and completes full derived upgrade without embedding changes`, async () => {
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
    const paths = git("ls-tree", "-r", "--name-only", tag, "packages/db/migrations").trim().split("\n");
    const migrations = paths.map((path) => {
      const [, version, name] = /\/(\d+)_(.+)\.sql$/.exec(path);
      return { version, name, sql: git("show", `${tag}:${path}`) };
    });
    const db = openDatabase(":memory:");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Network/provider calls forbidden in release gate tests"); };
    try {
      runMigrations(db, migrations);
      const before = seedFixture(db);
      assert.equal(before.count, 65);
      runMigrations(db);
      const vectors = new SqliteVecVectorStore(db);
      assert.equal(vectors.listCosineUpgradePlans().length, 1);
      vectors.upgradeIndexesToCosine();
      assert.deepEqual(embeddingSnapshot(db), before);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      assert(vectors.searchSimilarArticles({ embeddingIndexId: "release-index", vector: [1, 0], limit: 1 }).length);
      const settings = new SqliteAppSettingsRepository(db);
      const settingsService = new SettingsService({ settings });
      const embeddings = new SqliteEmbeddingRepository(db);
      const profiles = new SqliteProfileRepository(db);
      const calibration = new InterestClusterCalibrationService({ db });
      const profile = new ProfileService({ embeddings, profiles,
        getClusterLimits: () => settingsService.getSettings().ranking,
        getClusterCalibration: (id) => calibration.getOrCreateCalibration(id) });
      const ranking = new RecommendationRankingService({ db, embeddings, profiles,
        rankings: new SqliteRankingRepository(db), getRankingSettings: () => settingsService.getSettings().ranking });
      const upgrade = new DerivedDataUpgradeService({ db, settings, profileRebuild: new ProfileRebuildService({
        db, profile, ranking, calibration, clusterLabels: new InterestClusterLabelService({ db, settings }),
        interestFamilies: new InterestFamilyService({ db, getFamilyLimits: () => settingsService.getSettings().ranking,
          getClusterCalibration: (id) => calibration.getOrCreateCalibration(id) })
      }) });
      const completed = await upgrade.startIfRequired();
      assertUpgradeStatus(completed, true);
      assert.equal(completed.result.rebuilt.rankingRows, 63);
      assert.equal(db.prepare("select count(*) n from article_rank_scores where rank_context='obsolete-release-context'").get().n, 0);
      assert.deepEqual(embeddingSnapshot(db), before);
      db.prepare("update article_embeddings set updated_at=updated_at+1 where article_id='release-article-000'").run();
      assert.notDeepEqual(embeddingSnapshot(db), before, "Gate must detect metadata-only embedding rewrites");
    } finally { globalThis.fetch = originalFetch; db.close(); }
  });
}

test("workflow verifies registry digest before promotion and enables opt-in sourcemaps", () => {
  const workflow = readFileSync(".github/workflows/publish-docker-image.yml", "utf8");
  assert(workflow.indexOf("node scripts/release/verify-docker-release.mjs") < workflow.indexOf("node scripts/release/promote-image.mjs"));
  assert(workflow.includes("flavor: latest=false"));
  assert.equal((workflow.match(/uses: docker\/build-push-action/g) ?? []).length, 1);
  assert(workflow.includes("DIBAO_SENTRY_UPLOAD_SOURCEMAPS=1"));
  assert(workflow.includes("node scripts/e2e/prepare.mjs"));
  assert(workflow.includes("npx playwright test"));
  assert(workflow.indexOf("npm run build") < workflow.indexOf("npm test"));
  assert.equal((workflow.match(/npm run build/g) ?? []).length, 1);
  assert(workflow.indexOf("npm run build") < workflow.indexOf("node --import tsx --test"));
  const dockerfile = readFileSync("Dockerfile", "utf8");
  assert(dockerfile.includes("ARG DIBAO_SENTRY_UPLOAD_SOURCEMAPS=0"));
  assert(dockerfile.includes("DIBAO_SENTRY_UPLOAD_SOURCEMAPS=$DIBAO_SENTRY_UPLOAD_SOURCEMAPS npm run build"));
});

test("formal image tags are immutable unless the dispatch explicitly authorizes repair", () => {
  const tags = ["ghcr.io/example/dibao:v0.4.0", "ghcr.io/example/dibao:stable"];
  assert.throws(() => assertImmutableTags(tags, "new", () => "old"));
  assertImmutableTags(tags, "same", () => "same");
  assertImmutableTags(tags, "new", () => null);
  assertImmutableTags(tags, "new", () => "old", true);
  assert(isMissingManifest("ERROR: ghcr.io/example/dibao:v0.4.0: not found", tags[0]));
  for (const error of ["unauthorized", "timeout", "docker-credential-desktop: executable file not found"]) {
    assert.equal(isMissingManifest(error, tags[0]), false);
  }
});

test("failure diagnostics only expose the probe stage, never SDK stderr", () => {
  assert.equal(safeProbeFailure('private-dsn private-token\n{"releaseProbeFailed":true,"stage":"historical_migrations_and_fixture_seed"}'), "historical_migrations_and_fixture_seed");
  assert.equal(safeProbeFailure("private-dsn private-token private-org"), "probe_process_or_output");
});
