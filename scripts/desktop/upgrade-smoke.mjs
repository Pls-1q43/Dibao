import { _electron } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { openDatabase } from "../../packages/db/dist/index.js";
import { repoRoot, run } from "./prepare-resources.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const output = join(repoRoot, "test-results", `desktop-${process.platform}-${process.arch}`);
const evidence = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
if (!evidence.passed) throw new Error("Run the packaged application smoke test first");
const data = evidence.data;
const originalVersion = JSON.parse(await readFile(join(data, "desktop-state.json"), "utf8")).highestVersion;
const nextVersion = originalVersion.replace(/beta\.(\d+)$/, (_, n) => `beta.${Number(n) + 1}`);
if (nextVersion === originalVersion) throw new Error("Upgrade validation requires a beta version");
const installation = await mkdtemp(join(tmpdir(), "dibao-installed-"));
const builds = join(repoRoot, "dist", "desktop");
const replacement = join(builds, "upgrade-test");
const macFolder = process.arch === "arm64" ? "mac-arm64" : "mac";
const installedApp = join(installation, "Dibao.app");
const executable = process.platform === "win32" ? join(installation, "Dibao.exe") : join(installedApp, "Contents", "MacOS", "Dibao");
const env = { ...process.env, DIBAO_DESKTOP_DATA_DIR: data, DIBAO_FOREGROUND_QUIET_WINDOW_MS: "0", DIBAO_BACKGROUND_STARTUP_DELAY_MS: "0" };
delete env.DIBAO_DESKTOP_RESOURCES;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let n = 0; n < 180; n++) { if (await check()) return; await delay(500); }
  throw new Error(`Timed out: ${label}`);
}
async function installerIn(dir) { return join(dir, (await readdir(dir)).find(file => file.endsWith(".exe")) ?? "missing-installer"); }
function snapshot() {
  const db = openDatabase(join(data, "data", "dibao.sqlite"));
  try {
    return {
      article: db.prepare("select a.id,a.title,ac.content_text from articles a left join article_contents ac on ac.article_id=a.id where a.id=?").get("desktop-smoke-article"),
      articleState: db.prepare("select read_at,favorited_at,read_later_at,reading_progress from article_states where article_id=?").get("desktop-smoke-article"),
      feed: db.prepare("select id,title,feed_url from feeds where id=?").get("desktop-smoke-feed"),
      vector: db.prepare("select embedding from desktop_upgrade_vector where rowid=1").get(),
      settings: db.prepare("select * from app_settings where key='desktop.upgrade-test' ").all()
    };
  } finally { db.close(); }
}

const db = openDatabase(join(data, "data", "dibao.sqlite"));
db.exec("create virtual table if not exists desktop_upgrade_vector using vec0(embedding float[4])");
db.exec("delete from desktop_upgrade_vector where rowid=1");
db.prepare("insert into desktop_upgrade_vector(rowid,embedding) values(?,?)").run(1n, new Float32Array([0.2, 0.4, 0.6, 0.8]));
db.prepare("insert or replace into app_settings(key,value_json,updated_at) values(?,?,?)").run("desktop.upgrade-test", JSON.stringify({ retained: true }), Date.now());
db.close();
const before = JSON.stringify(snapshot());
const secretPath = join(data, "data", "plugins", "secrets", "plugin-secret.key");
const secretBefore = createHash("sha256").update(await readFile(secretPath)).digest("hex");
let electron;
let fixture;
let installerLaunchedPid;
async function launch() {
  electron = await _electron.launch({ executablePath: executable, env, timeout: 90_000 });
  const page = await electron.firstWindow({ timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.dibaoDesktop));
  await page.goto("https://dibao.localhost/?view=latest");
  await page.getByText("Desktop offline article", { exact: true }).first().waitFor({ timeout: 90_000 });
  assert(await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).data.authenticated), "Installed application lost login");
  return page;
}

try {
  if (process.platform === "win32") await run(await installerIn(builds), ["/S", `/D=${installation}`], { env });
  else await cp(join(builds, macFolder, "Dibao.app"), installedApp, { recursive: true, verbatimSymlinks: true });
  let page = await launch();
  assert(await page.evaluate(() => window.dibaoDesktop.getRuntime().then(runtime => runtime.version)) === originalVersion, "First installer version mismatch");
  await page.evaluate(() => localStorage.setItem("desktop-upgrade-pending-action", "preserve-client-operation"));
  await electron.close(); electron = null;

  await run(process.execPath, [join(repoRoot, "scripts", "desktop", "package.mjs"),
    `--config.extraMetadata.version=${nextVersion}`, "--config.directories.output=../../dist/desktop/upgrade-test",
    ...(process.platform === "darwin" ? ["--dir"] : [])]);

  if (process.platform === "darwin") {
    await rm(installedApp, { recursive: true });
    await cp(join(replacement, macFolder, "Dibao.app"), installedApp, { recursive: true, verbatimSymlinks: true });
    page = await launch();
  } else {
    let mode = "interrupt";
    fixture = createServer(async (request, response) => {
      const name = basename(new URL(request.url, "http://localhost").pathname);
      const path = join(replacement, name);
      try {
        const info = await stat(path);
        if (name.endsWith(".yml")) {
          const metadata = yaml.load(await readFile(path, "utf8"));
          if (mode === "corrupt") {
            metadata.sha512 = Buffer.alloc(64).toString("base64");
            for (const file of metadata.files ?? []) file.sha512 = metadata.sha512;
          }
          response.writeHead(200, { "content-type": "text/yaml" }); response.end(yaml.dump(metadata)); return;
        }
        const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Number(match[2]) : info.size - 1;
        response.writeHead(match ? 206 : 200, { "content-length": end - start + 1, "accept-ranges": "bytes", ...(match ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}) });
        if (mode === "interrupt" && name.endsWith(".exe")) {
          const stream = createReadStream(path, { start, end: Math.min(end, start + 4095) });
          stream.pipe(response, { end: false }); stream.on("end", () => response.destroy());
        } else createReadStream(path, { start, end }).pipe(response);
      } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
    page = await launch();
    await electron.evaluate(async ({ app, dialog }, url) => {
      const { createRequire } = await import("node:module");
      const updater = createRequire(`${app.getAppPath()}/package.json`)("electron-updater").autoUpdater;
      updater.setFeedURL({ provider: "generic", url, channel: "beta" });
      updater.disableDifferentialDownload = true;
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, `http://127.0.0.1:${fixture.address().port}`);
    await page.evaluate(() => window.dibaoDesktop.checkForUpdates());
    for (const scenario of ["interrupt", "corrupt", "valid"]) {
      mode = scenario;
      if (scenario !== "interrupt") await page.evaluate(() => window.dibaoDesktop.checkForUpdates());
      const downloaded = await page.evaluate(() => window.dibaoDesktop.downloadUpdate().then(() => true, () => false));
      assert(downloaded === (scenario === "valid"), `${scenario} download did not respect updater verification`);
      assert(await page.evaluate(async () => (await fetch("/api/articles?view=latest&limit=1")).ok), "Failed download stopped local reading");
    }
    const processHandle = electron.process();
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Updater did not exit for installation")), 90_000);
      processHandle.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await page.evaluate(() => window.dibaoDesktop.installUpdate()).catch(() => undefined);
    await exit; electron = null;
    await until(async () => {
      try {
        const state = JSON.parse(await readFile(join(data, "desktop-state.json"), "utf8"));
        return state.highestVersion === nextVersion && state.pending === null;
      } catch { return false; }
    }, "NSIS update restart and migration completion");
    installerLaunchedPid = JSON.parse(await readFile(join(data, "data.lock"), "utf8")).pid;
    process.kill(installerLaunchedPid, "SIGKILL"); installerLaunchedPid = null;
    await delay(3000);
    page = await launch();
  }

  assert(await page.evaluate(() => window.dibaoDesktop.getRuntime().then(runtime => runtime.version)) === nextVersion, "Replacement application version mismatch");
  assert(await page.evaluate(() => localStorage.getItem("desktop-upgrade-pending-action")) === "preserve-client-operation", "Upgrade lost client state");
  if (process.platform === "darwin") {
    await electron.evaluate(async ({ session }) => {
      await session.fromPartition("persist:dibao").cookies.flushStore();
      await session.fromPartition("persist:dibao").flushStorageData();
    });
    const child = electron.process();
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited; electron = null;
    page = await launch();
    assert(await page.evaluate(() => localStorage.getItem("desktop-upgrade-pending-action")) === "preserve-client-operation", "Forced exit lost persisted client state");
  }
  await electron.close(); electron = null;
  assert(JSON.stringify(snapshot()) === before, "Upgrade changed article, vector or settings data");
  assert(createHash("sha256").update(await readFile(secretPath)).digest("hex") === secretBefore, "Upgrade replaced plugin encryption key");
  const backups = await readdir(join(data, "backups"));
  assert(backups.length > 0, "Installer update skipped pre-upgrade backups");
  await writeFile(join(output, "upgrade.json"), JSON.stringify({ passed: true, from: originalVersion, to: nextVersion, installation, data,
    checks: process.platform === "win32" ? ["nsis-install", "download-interruption", "checksum-failure", "electron-updater-install", "force-exit-recovery", "data-regression"] : ["application-copy", "manual-replacement", "force-exit-recovery", "data-regression"] }, null, 2));
  console.log(JSON.stringify({ passed: true, from: originalVersion, to: nextVersion, output }));
} finally {
  if (electron) await electron.close().catch(() => undefined);
  if (installerLaunchedPid) { try { process.kill(installerLaunchedPid, "SIGKILL"); } catch {} }
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
}
