import assert from "node:assert/strict";
import { _electron } from "@playwright/test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, SqliteArticleRepository, SqliteFeedRepository, SqliteAppSettingsRepository } from "../../packages/db/dist/index.js";
import { repoRoot, run } from "./prepare-resources.mjs";
import { closeTestApplication } from "./test-utils.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Installed release tests require a disposable native CI runner");
const semver = createRequire(import.meta.url)("semver");
const version = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).version;
const releases = JSON.parse(execFileSync("gh", ["api", "repos/Pls-1q43/Dibao/releases?per_page=100"], { encoding: "utf8" }));
const previous = releases.filter(release => !release.draft && !release.prerelease && semver.valid(release.tag_name) && semver.lt(release.tag_name, version))
  .sort((a, b) => semver.rcompare(a.tag_name, b.tag_name))[0];
assert(previous, "Missing previous public release");
const suffix = process.platform === "win32" ? "win-x64.exe" : `mac-${process.arch}.dmg`;
const name = `Dibao-${semver.clean(previous.tag_name)}-${suffix}`;
const published = previous.assets.find(asset => asset.name === name);
assert(published?.digest?.startsWith("sha256:"), "Previous installer or checksum is missing");
const temporary = await mkdtemp(join(tmpdir(), "dibao-published-upgrade-"));
const data = join(temporary, "data-root");
const installation = join(temporary, "installation");
await mkdir(installation);
const oldInstaller = join(temporary, name);
await run("gh", ["release", "download", previous.tag_name, "--repo", "Pls-1q43/Dibao", "--pattern", name, "--dir", temporary]);
const hash = createHash("sha256");
for await (const chunk of createReadStream(oldInstaller)) hash.update(chunk);
assert.equal(`sha256:${hash.digest("hex")}`, published.digest, "Previous installer differs from the published checksum");
const env = { ...process.env, DIBAO_DESKTOP_DATA_DIR: data };
delete env.DIBAO_DESKTOP_RESOURCES;
const executable = process.platform === "win32" ? join(installation, "Dibao.exe") : join(installation, "Dibao.app", "Contents", "MacOS", "Dibao");
let electron;
async function install(installer) {
  if (process.platform === "win32") await run(installer, ["/S", `/D=${installation}`], { env });
  else {
    const mount = join(temporary, "volume");
    await run("hdiutil", ["attach", installer, "-readonly", "-nobrowse", "-mountpoint", mount]);
    try {
      await rm(join(installation, "Dibao.app"), { recursive: true, force: true });
      await cp(join(mount, "Dibao.app"), join(installation, "Dibao.app"), { recursive: true, verbatimSymlinks: true });
    } finally { await run("hdiutil", ["detach", mount]); }
  }
}
async function launch() {
  electron = await _electron.launch({ executablePath: executable, env, timeout: 90_000 });
  const page = await electron.firstWindow({ timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.dibaoDesktop));
  return page;
}
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: (await response.json()).data };
  }, { path, body });
}
function snapshot() {
  const db = openDatabase(join(data, "data", "dibao.sqlite"));
  try {
    return JSON.stringify({
      article: db.prepare("select * from articles where id='published-upgrade-article'").get(),
      content: db.prepare("select * from article_contents where article_id='published-upgrade-article'").get(),
      state: db.prepare("select * from article_states where article_id='published-upgrade-article'").get(),
      vector: db.prepare("select embedding from desktop_upgrade_vector where rowid=1").get(),
      setting: db.prepare("select value_json from app_settings where key='desktop.previous-release-test'").get()
    });
  } finally { db.close(); }
}
try {
  await install(oldInstaller);
  let page = await launch();
  assert.equal(await page.evaluate(() => window.dibaoDesktop.getRuntime().then(runtime => runtime.version)), semver.clean(previous.tag_name));
  assert.equal((await api(page, "/api/auth/setup", { username: "PublishedUpgrade", password: "Published-upgrade-test-2026", telemetryEnabled: false })).status, 200);
  await api(page, "/api/setup/status");
  await api(page, "/api/articles?view=latest&limit=1");
  await page.evaluate(() => localStorage.setItem("published-upgrade-client-state", "preserved"));
  await closeTestApplication(electron); electron = null;
  const db = openDatabase(join(data, "data", "dibao.sqlite"));
  const now = Date.now();
  new SqliteFeedRepository(db).upsert({ id: "published-upgrade-feed", title: "Previous release", feedUrl: "https://example.invalid/feed.xml", now });
  const articles = new SqliteArticleRepository(db);
  articles.upsert({ id: "published-upgrade-article", feedId: "published-upgrade-feed", title: "Previous release article", url: "https://example.invalid/article", discoveredAt: now, dedupeKey: "published-upgrade", now });
  articles.upsertContent({ articleId: "published-upgrade-article", contentText: "Previous release body", contentHtml: "<p>Previous release body</p>", extractionStatus: "feed_only", extractedAt: now, now });
  db.prepare("insert into article_states(article_id,favorited_at,updated_at) values(?,?,?) on conflict(article_id) do update set favorited_at=excluded.favorited_at")
    .run("published-upgrade-article", now, now);
  const settings = new SqliteAppSettingsRepository(db);
  for (const id of ["app.dibao.daily-brief", "app.dibao.webhook"]) settings.setJson(`setup.optionalPlugin.${id}`, "skipped", now);
  settings.setJson("desktop.previous-release-test", { retained: true }, now);
  db.exec("create virtual table desktop_upgrade_vector using vec0(embedding float[4])");
  db.prepare("insert into desktop_upgrade_vector(rowid,embedding) values(?,?)").run(1n, new Float32Array([0.2, 0.4, 0.6, 0.8]));
  db.close();
  const before = snapshot();
  const secretPath = join(data, "data", "plugins", "secrets", "plugin-secret.key");
  const secretBefore = createHash("sha256").update(await readFile(secretPath)).digest("hex");
  const current = join(repoRoot, "dist", "desktop", `Dibao-${version}-${suffix}`);
  await install(current);
  page = await launch();
  await page.locator('[data-testid="article-list-scroll-container"]').waitFor({ timeout: 90_000 });
  assert.equal(await page.evaluate(() => window.dibaoDesktop.getRuntime().then(runtime => runtime.version)), version);
  assert.equal((await api(page, "/api/auth/session")).data.authenticated, true, "Published upgrade lost login");
  assert.equal(await page.evaluate(() => localStorage.getItem("published-upgrade-client-state")), "preserved");
  assert.equal((await api(page, "/api/articles/published-upgrade-article")).status, 200);
  assert.equal(snapshot(), before, "Published upgrade changed article, state, vector or settings");
  assert.equal(createHash("sha256").update(await readFile(secretPath)).digest("hex"), secretBefore, "Published upgrade changed plugin keys");
  await closeTestApplication(electron); electron = null;
  const state = JSON.parse(await readFile(join(data, "desktop-state.json"), "utf8"));
  assert.equal(state.pending, null);
  assert((await readdir(join(data, "backups"))).length > 0, "Published upgrade skipped backup");
  const output = join(repoRoot, "test-results", `desktop-${process.platform}-${process.arch}`);
  await writeFile(join(output, "previous-release.json"), JSON.stringify({ passed: true, from: semver.clean(previous.tag_name), to: version,
    checks: ["published-installer-checksum", "previous-native-install", "current-native-install", "account-retained", "client-state-retained", "article-state-vector-settings-retained", "plugin-key-retained", "pre-upgrade-backup"] }, null, 2));
} finally {
  if (electron) await closeTestApplication(electron);
}
