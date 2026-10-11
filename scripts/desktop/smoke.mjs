import { _electron } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopDataProtection } from "../../apps/desktop/dist/data-protection.js";
import { openDatabase, SqliteFeedRepository, SqliteArticleRepository, SqliteAppSettingsRepository } from "../../packages/db/dist/index.js";
import { repoRoot } from "./prepare-resources.mjs";
import { closeTestApplication } from "./test-utils.mjs";

const require = createRequire(import.meta.url);
const data = process.env.DIBAO_DESKTOP_SMOKE_DATA ?? await mkdtemp(join(tmpdir(), "dibao-desktop-smoke-"));
const output = join(repoRoot, "test-results", `desktop-${process.platform}-${process.arch}`);
await mkdir(join(data, "data"), { recursive: true }); await mkdir(output, { recursive: true });
const articleHtml = "<p>Persisted local article body.</p>" + Array.from({ length: 150 }, (_, i) => `<p>Local reading paragraph ${i}. This content remains available without an internet connection.</p>`).join("");
const rss = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/rss+xml" });
  response.end('<rss version="2.0"><channel><title>Desktop test</title><link>https://example.com</link><description>Test</description></channel></rss>');
});
await new Promise(resolve => rss.listen(0, "127.0.0.1", resolve));
const feedUrl = `http://127.0.0.1:${rss.address().port}/feed.xml`;
const db = openDatabase(join(data, "data", "dibao.sqlite"), { migrate: true });
const now = Date.now();
new SqliteFeedRepository(db).upsert({ id: "desktop-smoke-feed", title: "Desktop test", feedUrl, now });
const articles = new SqliteArticleRepository(db);
articles.upsert({ id: "desktop-smoke-article", feedId: "desktop-smoke-feed", title: "Desktop offline article", url: "https://example.com/desktop-offline", discoveredAt: now, publishedAt: now, dedupeKey: "desktop-smoke", now });
articles.upsertContent({ articleId: "desktop-smoke-article", contentText: articleHtml.replace(/<[^>]+>/g, "\n"), contentHtml: articleHtml, extractionStatus: "feed_only", extractedAt: now, now });
const settings = new SqliteAppSettingsRepository(db);
for (const id of ["app.dibao.daily-brief", "app.dibao.webhook"]) settings.setJson(`setup.optionalPlugin.${id}`, "skipped", now);
settings.setJson("telemetry.settings", { enabled: false }, now);
db.close();

const env = { ...process.env, DIBAO_DESKTOP_DATA_DIR: data, DIBAO_FOREGROUND_QUIET_WINDOW_MS: "0", DIBAO_BACKGROUND_STARTUP_DELAY_MS: "0" };
if (!process.env.DIBAO_DESKTOP_EXECUTABLE) env.DIBAO_DESKTOP_RESOURCES = process.env.DIBAO_DESKTOP_RESOURCES ?? join(repoRoot, ".tmp", `desktop-${process.platform}-${process.arch}`, "payload");
const executablePath = process.env.DIBAO_DESKTOP_EXECUTABLE ?? require("electron");
const args = process.env.DIBAO_DESKTOP_EXECUTABLE ? [] : [join(repoRoot, "apps", "desktop")];
let electron;
const errors = [];
async function launch() {
  electron = await _electron.launch({ executablePath, args, env, timeout: 90_000 });
  const page = await electron.firstWindow({ timeout: 90_000 });
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForURL("https://dibao.localhost/**");
  await page.waitForFunction(() => Boolean(window.dibaoDesktop));
  return page;
}
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, payload: await response.json() };
  }, { path, body });
}
function assert(value, message) { if (!value) throw new Error(message); }
try {
  let page = await launch();
  const listening = (await readFile(join(data, "logs", "server.log"), "utf8")).split("\n")
    .filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(line => line?.msg?.startsWith("Server listening at "));
  assert(Boolean(listening), "Private local service did not announce its listener");
  const internalUrl = new URL(listening.msg.slice("Server listening at ".length));
  assert(internalUrl.hostname === "127.0.0.1", "Desktop service is exposed beyond loopback");
  assert((await fetch(`${internalUrl.origin}/api/system/health`)).status === 403, "Local service accepted a request without the private capability");
  const setup = await api(page, "/api/auth/setup", { username: "DesktopTest", password: "Desktop-test-password-2026" });
  assert(setup.status === 200, `Account creation failed: ${JSON.stringify(setup)}`);
  assert((await api(page, "/api/auth/session")).payload.data.authenticated, "Desktop cookie was not persisted");
  await page.reload();
  await page.getByText("Desktop offline article", { exact: true }).first().waitFor({ timeout: 90_000 });
  const online = await api(page, "/api/articles?view=latest&limit=10");
  assert(online.status === 200, "Article list did not load");
  await page.getByText("Desktop offline article", { exact: true }).first().click();
  await page.getByText("Persisted local article body.", { exact: true }).first().waitFor();
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  await network.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.waitForFunction(() => !navigator.onLine);
  assert((await api(page, "/api/articles/desktop-smoke-article")).status === 200, "Internet outage blocked local reading");
  await page.reload();
  await page.getByText("Desktop offline article", { exact: true }).first().waitFor({ timeout: 30_000 });
  assert(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length) === 0, "Desktop registered a PWA service worker");
  await page.screenshot({ path: join(output, "reader.png"), fullPage: true });
  await network.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.goto("https://dibao.localhost/?page=settings");
  await page.getByText("打开数据目录", { exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const about = document.querySelector(".about-settings-card");
    if (!about) return false;
    about.scrollIntoView({ behavior: "instant", block: "end" });
    return true;
  });
  await page.screenshot({ path: join(output, "settings.png"), fullPage: true });
  assert(!await page.locator("#settings-offline-enabled").isVisible(), "Desktop exposed the limited PWA cache controls");
  const cookie = await electron.evaluate(async ({ session }) => session.fromPartition("persist:dibao").cookies.get({ url: "https://dibao.localhost" }));
  assert(cookie.some(c => c.name === "dibao_session"), "Login cookie is missing");
  await page.evaluate(() => new Promise((resolve, reject) => {
    const stream = new EventSource("/api/recommendation/inventory/events");
    stream.onopen = () => { stream.close(); resolve(true); };
    stream.onerror = () => { stream.close(); reject(new Error("SSE failed")); };
  }));
  assert(await electron.evaluate(async ({ BrowserWindow }) => {
    const primary = BrowserWindow.getAllWindows()[0];
    const preload = primary.webContents.getLastWebPreferences().preload;
    const evil = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await evil.loadURL("data:text/html,<h1>Untrusted page</h1>");
      return await evil.webContents.executeJavaScript("window.dibaoDesktop ? window.dibaoDesktop.getRuntime().then(() => false, () => true) : true");
    } finally { evil.destroy(); }
  }), "An untrusted page accessed desktop permissions");
  assert(await page.evaluate(() => typeof window.require === "undefined" && typeof window.process === "undefined"), "Node privileges leaked to the renderer");
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert(await electron.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()), "Closing the window did not keep the tray application alive");
  assert((await api(page, "/api/articles?view=latest&limit=1")).status === 200, "Tray mode stopped the local service");
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await new Promise((resolve, reject) => {
    const second = spawn(executablePath, args, { env, stdio: "ignore" });
    const timer = setTimeout(() => { second.kill(); reject(new Error("Second instance did not exit")); }, 15_000);
    second.once("error", reject);
    second.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Second instance exited with ${code}`)); });
  });
  assert((await api(page, "/api/auth/session")).payload.data.authenticated, "Repeated launch broke the original instance");
  await electron.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
  assert((await api(page, "/api/articles?view=latest&limit=1")).status === 200, "Resume interrupted local reading");
  for (const role of ["http", "worker"]) {
    const owner = JSON.parse(await readFile(join(data, "runtime", `${role}.owner`), "utf8"));
    assert(Number.isSafeInteger(owner.pid), "Local writer ownership is missing");
  }
  await page.goto("https://dibao.localhost/?view=latest&article=desktop-smoke-article");
  const reader = page.getByTestId("reader-scroll-container");
  await reader.waitFor();
  await page.getByText("Local reading paragraph 149. This content remains available without an internet connection.", { exact: true }).waitFor();
  // DOM content can appear before React installs the reader's passive scroll listener.
  await page.waitForFunction(async () => {
    const container = document.querySelector('[data-testid="reader-scroll-container"]');
    if (!container) return false;
    container.scrollTop = container.scrollHeight * 0.3;
    container.dispatchEvent(new Event("scroll"));
    const response = await fetch("/api/articles/desktop-smoke-article");
    return (await response.json()).data.state.readingProgress >= 0.25;
  }, undefined, { timeout: 30_000, polling: 100 });
  await reader.evaluate(container => { container.scrollTop = container.scrollHeight * 0.8; container.dispatchEvent(new Event("scroll")); });
  await page.evaluate(() => window.dibaoDesktop.prepareToQuit());
  const progress = await api(page, "/api/articles/desktop-smoke-article");
  assert(progress.payload.data.state.readingProgress >= 0.75, "Pending reading progress was not flushed before exit");
  await closeTestApplication(electron); electron = null;
  const state = JSON.parse(await readFile(join(data, "desktop-state.json"), "utf8"));
  assert(state.pending === null, "Successful article loading did not finish the upgrade marker");
  page = await launch();
  assert((await api(page, "/api/auth/session")).payload.data.authenticated, "Login did not survive restart / internal port change");
  await closeTestApplication(electron); electron = null;
  const protection = new DesktopDataProtection(data);
  const oldVersion = state.highestVersion;
  const next = oldVersion.replace(/beta\.(\d+)$/, (_, n) => `beta.${Number(n) + 1}`);
  if (next !== oldVersion) {
    const prepared = await protection.prepare(next);
    assert(Boolean(prepared.pending?.backupId), "Version upgrade did not create a complete backup");
    await protection.restore(prepared.pending.backupId);
  }
  assert(errors.length === 0, `Renderer errors: ${errors.join("; ")}`);
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, data, checks: ["private-loopback", "account", "cookies", "article-body", "chromium-offline", "reload", "no-service-worker", "sse", "restart", "backup-restore", "untrusted-ipc", "sandbox", "tray", "singleton", "resume", "pending-progress-flush", "writer-ownership"] }, null, 2));
  console.log(JSON.stringify({ passed: true, data, output }));
} catch (error) {
  if (electron) {
    for (const page of electron.windows()) {
      await page.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
      console.error((await page.locator("body").innerText().catch(() => "")).slice(-5000));
    }
  }
  throw error;
} finally {
  if (electron) await closeTestApplication(electron).catch(() => undefined);
  await new Promise(resolve => rss.close(resolve));
}
