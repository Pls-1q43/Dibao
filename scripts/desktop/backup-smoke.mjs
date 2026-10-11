import { _electron } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteFeedRepository, SqliteArticleRepository } from "../../packages/db/dist/index.js";
import { repoRoot } from "./prepare-resources.mjs";
import { closeTestApplication } from "./test-utils.mjs";

const require = createRequire(import.meta.url);
const data = await mkdtemp(join(tmpdir(), "dibao-backup-ui-"));
const output = process.env.DIBAO_DESKTOP_BACKUP_OUTPUT ?? await mkdtemp(join(tmpdir(), "dibao-backup-evidence-"));
await mkdir(output, { recursive: true });
const env = { ...process.env, DIBAO_DESKTOP_DATA_DIR: data };
if (!process.env.DIBAO_DESKTOP_EXECUTABLE) env.DIBAO_DESKTOP_RESOURCES = process.env.DIBAO_DESKTOP_RESOURCES ?? join(repoRoot, ".tmp", `desktop-${process.platform}-${process.arch}`, "payload");
const executablePath = process.env.DIBAO_DESKTOP_EXECUTABLE ?? require("electron");
const args = process.env.DIBAO_DESKTOP_EXECUTABLE ? [] : [join(repoRoot, "apps", "desktop")];
let electron;
let closing = false;
const errors = [];
const dialogs = join(data, "test-dialogs.jsonl");
function assert(value, message) { if (!value) throw new Error(message); }
async function launch(backups = false) {
  closing = false;
  electron = await _electron.launch({ executablePath, args: backups ? [...args, "--dibao-backups"] : args, env, timeout: 90_000 });
  const page = await electron.firstWindow({ timeout: 90_000 });
  page.on("pageerror", error => { if (!closing) errors.push(error.message); });
  page.on("console", message => { if (!closing && message.type() === "error") errors.push(message.text()); });
  await page.waitForFunction(() => Boolean(window.dibaoDesktop));
  assert(page.url().startsWith("https://dibao.localhost"), "Backup UI left the application origin");
  return page;
}
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`Test request failed: ${path}: ${response.status}`);
    return (await response.json()).data;
  }, { path, body });
}
async function confirmWith(response) {
  await electron.evaluate(({ app, dialog, BrowserWindow }, { response, dialogs, data }) => {
    const fs = process.getBuiltinModule("node:fs");
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      fs.appendFileSync(dialogs, `${JSON.stringify({ parented: args[0] instanceof BrowserWindow, options })}\n`);
      return { response, checkboxChecked: false };
    };
    // Keep relaunch under Playwright ownership, while checking the real restart request.
    app.relaunch = options => fs.writeFileSync(`${data}/test-relaunch.json`, JSON.stringify(options));
  }, { response, dialogs, data });
}
async function restartVia(page, button) {
  await confirmWith(1);
  closing = true;
  const exited = electron.waitForEvent("close", { timeout: 90_000 });
  await page.getByRole("button", { name: button, exact: true }).click();
  await exited; electron = null;
  const relaunch = JSON.parse(await readFile(join(data, "test-relaunch.json"), "utf8"));
  assert(relaunch.args.includes("--dibao-backups"), "Restart did not request visible backup feedback");
  return launch(true);
}

try {
  let page = await launch();
  await page.locator("#setup-language").selectOption("zh-CN");
  await page.getByRole("button", { name: "开始设置", exact: true }).click();
  await page.locator("#auth-username").fill("BackupTest");
  await page.locator("#auth-password").fill("Backup-test-password-2026");
  await page.locator("#auth-telemetry-enabled").uncheck();
  await page.locator('form button[type="submit"]').click();
  await page.getByRole("button", { name: "稍后添加", exact: true }).click();
  await page.getByRole("button", { name: "暂不启用", exact: true }).click();
  await page.getByRole("button", { name: "跳过，使用基础排序", exact: true }).click();
  await page.locator('[data-testid="article-list-scroll-container"]').waitFor();
  await page.goto("https://dibao.localhost/?page=settings");
  const section = page.getByRole("region", { name: "数据备份与恢复" });
  await section.getByText("还没有备份。可先创建一份；之后升级应用前也会自动备份。", { exact: true }).waitFor();
  assert(await section.getByRole("button", { name: "恢复备份", exact: true }).isDisabled(), "Empty restore remained clickable");
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "empty.png") });
  await page.locator("#settings-current-password").fill("unsaved-test-value");
  await section.getByRole("button", { name: "创建备份", exact: true }).click();
  await section.getByRole("alert").filter({ hasText: "设置尚未保存" }).waitFor();
  await page.locator("#settings-current-password").fill("");
  await confirmWith(0);
  await section.getByRole("button", { name: "创建备份", exact: true }).click();
  await section.getByText("已取消，当前数据未改变。", { exact: true }).waitFor();
  await page.evaluate(() => localStorage.setItem("dibao.backup.smoke", "original-client-state"));
  closing = true; await closeTestApplication(electron); electron = null;

  const db = openDatabase(join(data, "data", "dibao.sqlite"), { migrate: true });
  const now = Date.now();
  const feeds = new SqliteFeedRepository(db);
  feeds.upsert({ id: "backup-feed", title: "Backup test", feedUrl: "https://example.com/backup-test.xml", now });
  feeds.update({ id: "backup-feed", enabled: false, now });
  const articles = new SqliteArticleRepository(db);
  articles.upsert({ id: "backup-article", feedId: "backup-feed", title: "Backup test article", url: "https://example.com/backup-article", dedupeKey: "backup-test", discoveredAt: now, publishedAt: now, now });
  articles.upsertContent({ articleId: "backup-article", contentText: "Preserved article body", contentHtml: "<p>Preserved article body</p>", extractionStatus: "feed_only", extractedAt: now, now });
  db.close();
  const secret = join(data, "data", "plugins", "backup-test", "secret.key");
  await mkdir(join(data, "data", "plugins", "backup-test"), { recursive: true });
  await writeFile(secret, "original-plugin-key", { mode: 0o600 });
  page = await launch();
  await page.locator('[data-testid="article-list-scroll-container"]').waitFor({ timeout: 90_000 });
  await api(page, "/api/articles/backup-article/actions", { type: "favorite", value: true });
  await page.goto("https://dibao.localhost/?page=settings");
  await page.getByRole("button", { name: "创建备份", exact: true }).waitFor();
  page = await restartVia(page, "创建备份");
  await page.getByText(/^备份已完成/).waitFor({ timeout: 90_000 });
  const backedUp = await page.evaluate(() => window.dibaoDesktop.getBackupState());
  const manual = backedUp.backups.find(item => item.reason === "manual");
  assert(Boolean(manual), "Manual backup did not appear in the restore point list");
  assert(await page.locator("#desktop-backup-point").inputValue() === manual.id, "Manual restore point was not selected");
  assert(!await page.getByRole("button", { name: "恢复备份", exact: true }).isDisabled(), "Restore remained disabled after backup");
  assert((await api(page, "/api/auth/session")).authenticated, "Backup restart lost login");
  await page.getByRole("region", { name: "数据备份与恢复" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "created.png") });

  await api(page, "/api/articles/backup-article/actions", { type: "favorite", value: false });
  await writeFile(secret, "changed-plugin-key");
  await page.evaluate(() => localStorage.setItem("dibao.backup.smoke", "changed-client-state"));
  await page.locator("#desktop-backup-point").selectOption(manual.id);
  page = await restartVia(page, "恢复备份");
  await page.getByText(/^恢复已完成/).waitFor({ timeout: 90_000 });
  const article = await api(page, "/api/articles/backup-article");
  assert(article.state.favorited, "Restored article state was not the saved favorite state");
  assert(article.contentText === "Preserved article body", "Restored article content changed");
  assert(await readFile(secret, "utf8") === "original-plugin-key", "Plugin key was not restored");
  assert(await page.evaluate(() => localStorage.getItem("dibao.backup.smoke")) === "original-client-state", "Client state was not restored");
  assert((await api(page, "/api/auth/session")).authenticated, "Restore lost login");
  const restored = await page.evaluate(() => window.dibaoDesktop.getBackupState());
  const safety = restored.backups.find(item => item.reason === "recovery");
  assert(Boolean(safety), "Restore did not preserve current data separately");
  assert(await readFile(join(data, "backups", safety.id, "data", "plugins", "backup-test", "secret.key"), "utf8") === "changed-plugin-key", "Safety snapshot did not preserve the changed key");
  await page.getByRole("region", { name: "数据备份与恢复" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "restored.png") });
  assert(await electron.evaluate(async ({ BrowserWindow }) => {
    const primary = BrowserWindow.getAllWindows()[0];
    const evil = new BrowserWindow({ show: false, webPreferences: { preload: primary.webContents.getLastWebPreferences().preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await evil.loadURL("data:text/html,<h1>Untrusted backup request</h1>");
      return await evil.webContents.executeJavaScript(`window.dibaoDesktop ? Promise.all([
        window.dibaoDesktop.getBackupState(), window.dibaoDesktop.createBackup("zh-CN"), window.dibaoDesktop.recoverBackup("invalid", "zh-CN")
      ].map(request => request.then(() => false, error => error.message.includes("Untrusted desktop request")))).then(results => results.every(Boolean)) : true`);
    } finally { evil.destroy(); }
  }), "An untrusted page accessed backup permissions");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 700, deviceScaleFactor: 1, mobile: false });
  await page.getByRole("region", { name: "数据备份与恢复" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "narrow.png") });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "Narrow desktop settings overflow horizontally");
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  await writeFile(join(data, "backups", manual.id, "data", "plugins", "backup-test", "secret.key"), "corrupt");
  await page.locator("#desktop-backup-point").selectOption(manual.id);
  await page.getByRole("button", { name: "恢复备份", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "备份校验失败" }).waitFor();
  assert(await readFile(secret, "utf8") === "original-plugin-key", "Corrupt backup replaced current data");
  const prompts = (await readFile(dialogs, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert(prompts.length === 3 && prompts.every(item => item.parented), "Confirmation was missing, unparented, or shown for invalid data");
  assert(prompts[2].options.detail.includes(manual.version), "Restore confirmation omitted the selected version");
  assert(errors.length === 0, `Renderer errors: ${errors.join("; ")}`);
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, data, checks: ["empty-disabled", "manual-button", "unsaved-feedback", "parented-confirmation", "cancel-feedback", "cold-backup", "restore-selection", "cold-restore", "login", "article-state", "article-content", "plugin-key", "client-state", "safety-snapshot", "corruption-feedback", "untrusted-ipc", "narrow-layout"], errors }, null, 2));
  console.log(JSON.stringify({ backupUi: true, data, output }));
} catch (error) {
  if (electron) for (const page of electron.windows()) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
    console.error((await page.locator("body").innerText().catch(() => "")).slice(-5000));
  }
  throw error;
} finally { if (electron) { closing = true; await closeTestApplication(electron); } }
