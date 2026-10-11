import { _electron, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, SqliteFeedRepository, SqliteAppSettingsRepository } from "../../packages/db/dist/index.js";
import { repoRoot } from "./prepare-resources.mjs";
import { closeTestApplication } from "./test-utils.mjs";

const require = createRequire(import.meta.url);
const data = await mkdtemp(join(tmpdir(), "dibao-startup-ui-"));
const output = process.env.DIBAO_DESKTOP_STARTUP_OUTPUT ?? await mkdtemp(join(tmpdir(), "dibao-startup-evidence-"));
await mkdir(output, { recursive: true }); await mkdir(join(data, "data"));
let rssRequests = 0;
const rss = createServer((_request, response) => {
  rssRequests++;
  response.writeHead(200, { "content-type": "application/rss+xml" });
  response.end('<rss version="2.0"><channel><title>Background test</title><link>https://example.com</link><description>Test</description><item><guid>background-test-article</guid><title>Background fetched article</title><link>https://example.com/background-test</link><description>Fetched without opening a window.</description></item></channel></rss>');
});
await new Promise(resolve => rss.listen(0, "127.0.0.1", resolve));
const db = openDatabase(join(data, "data", "dibao.sqlite"), { migrate: true });
const now = Date.now();
new SqliteFeedRepository(db).upsert({ id: "background-test", title: "Background test", feedUrl: `http://127.0.0.1:${rss.address().port}/feed.xml`, now });
const settings = new SqliteAppSettingsRepository(db);
for (const id of ["app.dibao.daily-brief", "app.dibao.webhook"]) settings.setJson(`setup.optionalPlugin.${id}`, "skipped", now);
settings.setJson("telemetry.settings", { enabled: false }, now);
db.close();
const env = { ...process.env, DIBAO_DESKTOP_DATA_DIR: data, DIBAO_BACKGROUND_STARTUP_DELAY_MS: "0", DIBAO_FOREGROUND_QUIET_WINDOW_MS: "0" };
if (!process.env.DIBAO_DESKTOP_EXECUTABLE) env.DIBAO_DESKTOP_RESOURCES = process.env.DIBAO_DESKTOP_RESOURCES ?? join(repoRoot, ".tmp", `desktop-${process.platform}-${process.arch}`, "payload");
const executablePath = process.env.DIBAO_DESKTOP_EXECUTABLE ?? require("electron");
const baseArgs = process.env.DIBAO_DESKTOP_EXECUTABLE ? [] : [join(repoRoot, "apps", "desktop")];
let electron;
let closing = false;
const errors = [];
function assert(value, message) { if (!value) throw new Error(message); }
async function launch(args) {
  closing = false;
  electron = await _electron.launch({ executablePath, args: [...baseArgs, ...args], env, timeout: 90_000 });
  await electron.evaluate(({ app, BrowserWindow, Menu }) => {
    globalThis.__dibaoShown = false;
    const watch = window => { if (window.isVisible()) globalThis.__dibaoShown = true; window.on("show", () => { globalThis.__dibaoShown = true; }); };
    BrowserWindow.getAllWindows().forEach(watch);
    app.on("browser-window-created", (_event, window) => watch(window));
    const buildMenu = Menu.buildFromTemplate;
    Menu.buildFromTemplate = template => {
      const open = template.find(item => item.label === "Open Dibao");
      if (open) globalThis.__dibaoOpenFromTray = open.click;
      return buildMenu.call(Menu, template);
    };
  });
  const page = await electron.firstWindow({ timeout: 90_000 });
  page.on("pageerror", error => { if (!closing) errors.push(error.message); });
  await page.waitForFunction(() => Boolean(window.dibaoDesktop));
  return page;
}
async function visible() { return electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())); }
async function secondLaunch(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executablePath, [...baseArgs, ...args], { env, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Second instance did not exit")); }, 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Second instance exited ${code}`)); });
  });
}
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return (await response.json()).data;
  }, { path, body });
}

try {
  let page = await launch(["--dibao-background"]);
  await page.waitForLoadState("domcontentloaded");
  assert(!await visible(), "Background startup showed the main window");
  await api(page, "/api/auth/setup", { username: "StartupTest", password: "Startup-test-password-2026", telemetryEnabled: false, locale: "zh-CN" });
  await page.reload();
  await page.locator('[data-testid="article-list-scroll-container"]').waitFor({ timeout: 90_000 });
  await api(page, "/api/feeds/refresh", {});
  await expect.poll(async () => (await api(page, "/api/articles?view=latest&limit=10"))
    .some(article => article.title === "Background fetched article"), { timeout: 60_000 }).toBe(true);
  assert(rssRequests > 0 && !await visible(), "Background fetching did not run silently");
  assert(!await electron.evaluate(() => globalThis.__dibaoShown), "Startup flashed a visible window");
  for (const role of ["http", "worker"]) {
    const owner = JSON.parse(await readFile(join(data, "runtime", `${role}.owner`), "utf8"));
    assert(Number.isSafeInteger(owner.pid), `Background ${role} is missing`);
  }
  await secondLaunch(["--dibao-background"]);
  assert(!await visible(), "A repeated background launch raised the window");
  await secondLaunch([]);
  await page.waitForFunction(() => document.hasFocus());
  assert(await visible(), "Manual launch did not open the existing background instance");
  await page.screenshot({ path: join(output, "opened.png") });
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert(!await visible(), "Closing the window did not return to background mode");
  await electron.evaluate(() => { if (!globalThis.__dibaoOpenFromTray) throw new Error("Tray Open action is missing"); globalThis.__dibaoOpenFromTray(); });
  assert(await visible(), "Tray Open did not reopen the hidden window");
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await electron.evaluate(({ app }) => app.emit("activate", {}, false));
  assert(await visible(), "Explicit activation did not reopen the hidden window");

  await page.goto("https://dibao.localhost/?page=settings");
  const startup = page.getByLabel("登录系统时在后台启动", { exact: true });
  await startup.waitFor();
  // Test the real settings IPC without modifying the developer machine's login items.
  await electron.evaluate(({ app }) => {
    let enabled = false;
    globalThis.__loginRegistrations = [];
    app.setLoginItemSettings = settings => { globalThis.__loginRegistrations.push(settings); enabled = settings.openAtLogin; };
    app.getLoginItemSettings = () => ({ openAtLogin: enabled, wasOpenedAtLogin: false, status: enabled ? "enabled" : "not-registered", executableWillLaunchAtLogin: enabled, launchItems: [] });
  });
  await startup.check(); await expect(startup).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.dibaoDesktop.getRuntime().then(info => info.autoLaunch))).toBe(true);
  await expect(startup).toBeEnabled();
  await startup.uncheck(); await expect(startup).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => window.dibaoDesktop.getRuntime().then(info => info.autoLaunch))).toBe(false);
  await expect(startup).toBeEnabled();
  const registrations = await electron.evaluate(() => globalThis.__loginRegistrations);
  assert(registrations.length === 2 && registrations[0].openAtLogin && !registrations[1].openAtLogin, "Login toggle did not register/remove the login item");
  if (process.platform === "win32") assert(registrations.every(item => item.args?.includes("--dibao-background")), "Windows registration omitted the background argument");
  await startup.locator("xpath=..").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "settings.png") });
  await electron.evaluate(({ app }) => { app.setLoginItemSettings = () => { throw new Error("Simulated denied login registration"); }; });
  await startup.check();
  await expect(page.getByRole("alert").filter({ hasText: "启动设置未能保存" })).toBeVisible();
  await expect(startup).not.toBeChecked(); await expect(startup).toBeEnabled();
  await page.screenshot({ path: join(output, "startup-error.png") });
  closing = true; await closeTestApplication(electron); electron = null;

  page = await launch([]);
  await page.locator('[data-testid="article-list-scroll-container"]').waitFor({ timeout: 90_000 });
  await expect.poll(visible).toBe(true);
  closing = true; await closeTestApplication(electron); electron = null;
  page = await launch(["--dibao-background", "--dibao-backups"]);
  await page.getByRole("region", { name: "数据备份与恢复" }).waitFor({ timeout: 90_000 });
  await expect.poll(visible).toBe(true);
  assert(errors.length === 0, `Renderer errors: ${errors.join("; ")}`);
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, data, rssRequests, checks: ["hidden-startup", "no-window-flash", "http-and-worker", "background-fetch", "background-second-instance", "manual-second-instance", "tray-open", "activation", "settings-ipc", "settings-error-feedback", "normal-launch", "visible-backup-restart"], errors }, null, 2));
  console.log(JSON.stringify({ startup: true, data, output }));
} catch (error) {
  if (electron) for (const page of electron.windows()) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
    console.error((await page.locator("body").innerText().catch(() => "")).slice(-4000));
  }
  throw error;
} finally {
  if (electron) { closing = true; await closeTestApplication(electron); }
  await new Promise(resolve => rss.close(resolve));
}
