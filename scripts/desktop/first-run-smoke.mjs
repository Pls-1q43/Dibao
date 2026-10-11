import { _electron } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRoot } from "./prepare-resources.mjs";
import { closeTestApplication } from "./test-utils.mjs";

const require = createRequire(import.meta.url);
const output = process.env.DIBAO_DESKTOP_FIRST_RUN_OUTPUT ?? join(repoRoot, "test-results", `desktop-${process.platform}-${process.arch}`, "first-run");
await mkdir(output, { recursive: true });
const copy = {
  "zh-CN": { start: "开始设置", sources: "添加订阅源", skip: "稍后添加", plugin: "每日简报", enable: "启用", decline: "暂不启用", provider: "推荐能力", continue: "跳过，使用基础排序" },
  "en-US": { start: "Start setup", sources: "Add feeds", skip: "Add later", plugin: "Daily Brief", enable: "Enable", decline: "Not now", provider: "Personalization", continue: "Skip and use baseline ranking" },
  "ja-JP": { start: "設定を始める", sources: "フィードを追加", skip: "あとで追加", plugin: "デイリーブリーフ", enable: "有効にする", decline: "今は有効にしない", provider: "おすすめ機能", continue: "スキップして基本の並び替えを使う" }
};
const cases = [["zh-CN", true], ["en-US", false], ["ja-JP", true]];
const results = [];
function assert(value, message) { if (!value) throw new Error(message); }

for (const [locale, enabled] of cases) {
  const labels = copy[locale];
  const data = await mkdtemp(join(tmpdir(), `dibao-first-run-${locale}-`));
  const env = { ...process.env, DIBAO_DESKTOP_DATA_DIR: data };
  if (!process.env.DIBAO_DESKTOP_EXECUTABLE) env.DIBAO_DESKTOP_RESOURCES = process.env.DIBAO_DESKTOP_RESOURCES ?? join(repoRoot, ".tmp", `desktop-${process.platform}-${process.arch}`, "payload");
  const options = { executablePath: process.env.DIBAO_DESKTOP_EXECUTABLE ?? require("electron"), args: process.env.DIBAO_DESKTOP_EXECUTABLE ? [] : [join(repoRoot, "apps", "desktop")], env, timeout: 90_000 };
  let electron;
  let stderr = "";
  const errors = [];
  const shutdownErrors = [];
  const failedRequests = [];
  let closing = false;
  const failedStyles = [];
  try {
    electron = await _electron.launch(options);
    electron.process().stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
    let page = await electron.firstWindow({ timeout: 90_000 });
    const tray = await electron.evaluate(({ app, nativeImage }) => {
      const require = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`);
      const { createDesktopTrayIcon } = require("./dist/tray-icon.js");
      const resources = process.env.DIBAO_DESKTOP_RESOURCES ?? `${process.resourcesPath}/dibao`;
      const icon = createDesktopTrayIcon(nativeImage.createFromPath(`${resources}/desktop-assets/tray.png`), process.platform);
      return { size: icon.getSize(), template: icon.isTemplateImage(), platform: process.platform };
    });
    const traySize = tray.platform === "darwin" ? 18 : 16;
    assert(tray.size.width === traySize && tray.size.height === traySize && tray.template === (tray.platform === "darwin"), `Native tray sizing failed: ${JSON.stringify(tray)}`);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") (closing ? shutdownErrors : errors).push(message.text()); });
    page.on("response", response => {
      if (response.url().includes("/api/plugins/ui.css") && !response.ok()) failedStyles.push(response.status());
      if (response.url().startsWith("https://dibao.localhost/") && !response.ok()) failedRequests.push({ phase: closing ? "shutdown" : "reading", path: new URL(response.url()).pathname, status: response.status() });
    });
    await page.locator("#setup-language").waitFor({ timeout: 90_000 });
    await page.locator("#setup-language").selectOption(locale);
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    assert(page.url().startsWith("https://dibao.localhost/"), "First-run page left the private application origin");
    assert(await page.title() === ({ "zh-CN": "邸报", "en-US": "Dibao", "ja-JP": "邸報" })[locale], "Page title did not follow the chosen language");
    await page.screenshot({ path: join(output, `${locale}-language.png`) });
    await page.getByRole("button", { name: labels.start, exact: true }).click();
    await page.locator("#auth-username").fill("FirstRunTest");
    await page.locator("#auth-password").fill("First-run-test-password-2026");
    await page.locator("#auth-telemetry-enabled").uncheck();
    await page.locator('form button[type="submit"]').click();
    await page.getByRole("heading", { name: labels.sources, exact: true }).waitFor();
    assert(await page.locator("html").getAttribute("lang") === locale, "Account setup reset the chosen language");
    await page.getByRole("button", { name: labels.skip, exact: true }).click();
    await page.getByRole("heading", { name: labels.plugin, exact: true }).waitFor();
    await page.getByRole("button", { name: labels.enable, exact: true }).waitFor();
    await page.getByRole("button", { name: labels.decline, exact: true }).waitFor();
    await page.screenshot({ path: join(output, `${locale}-plugin.png`) });
    await page.getByRole("button", { name: enabled ? labels.enable : labels.decline, exact: true }).click();
    await page.getByRole("heading", { name: labels.provider, exact: true }).waitFor();
    await page.getByRole("button", { name: labels.continue, exact: true }).click();
    await page.locator('[data-testid="article-list-scroll-container"]').waitFor();
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    const persisted = await page.evaluate(async () => ({ settings: (await (await fetch("/api/settings")).json()).data, status: (await (await fetch("/api/setup/status")).json()).data }));
    assert(persisted.settings.ui.locale === locale, "Chosen language was not persisted on the server");
    assert(persisted.status.sourcesCompleted && !persisted.status.hasFeeds, "Skipping feeds did not persist");
    if (enabled) {
      await page.getByRole("link", { name: labels.plugin, exact: true }).click();
      const frame = page.frameLocator("iframe");
      await frame.locator("#empty").waitFor();
      const metrics = await frame.locator("body").evaluate(body => ({ background: getComputedStyle(body).backgroundColor, hiddenDialog: getComputedStyle(document.querySelector("#explanation-backdrop")).display, lang: document.documentElement.lang }));
      assert(metrics.background === "rgb(247, 244, 237)" && metrics.hiddenDialog === "none", `Plugin stylesheet / hidden dialog failed: ${JSON.stringify(metrics)}`);
      assert(metrics.lang === locale, "Daily Brief did not follow the chosen language");
      await page.screenshot({ path: join(output, `${locale}-brief.png`) });
      await frame.locator("#tab-settings").click();
      await frame.locator("#save").waitFor();
      await frame.locator("#tab-brief").click();
      assert(!await frame.locator("#explanation-backdrop").isVisible(), "Explanation backdrop is visible without user action");
      assert(failedStyles.length === 0, `Stylesheet requests failed: ${failedStyles}`);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.screenshot({ path: join(output, `${locale}-brief-mobile.png`) });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "Mobile shell overflows horizontally");
      await cdp.send("Emulation.clearDeviceMetricsOverride");
    }
    assert(errors.length === 0, `First-run renderer errors: ${errors.join("; ")}`);
    closing = true;
    await closeTestApplication(electron);
    electron = await _electron.launch(options);
    page = await electron.firstWindow({ timeout: 90_000 });
    await page.locator('[data-testid="article-list-scroll-container"]').waitFor({ timeout: 90_000 });
    assert(await page.locator("html").getAttribute("lang") === locale, "Restart reset the chosen language");
    assert(!await page.locator("#setup-feed-url").isVisible(), "Restart required a feed after the step was skipped");
    assert(await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).data.authenticated), "Restart lost the account session");
    results.push({ locale, enabled, passed: true, tray, consoleErrors: errors, shutdownErrors, failedRequests });
  } catch (error) {
    const serverLog = await readFile(join(data, "logs", "server.log"), "utf8").catch(() => "No local service log");
    const state = await electron?.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), version: app.getVersion(), windows: BrowserWindow.getAllWindows().map(window => ({ url: window.webContents.getURL(), visible: window.isVisible() })) })).catch(() => null);
    const diagnostic = JSON.stringify({ locale, state, error: String(error), stderr, serverLog: serverLog.slice(-24000) }, null, 2).replace(/[a-f0-9]{64}/gi, "[redacted]");
    await writeFile(join(output, `${locale}-failure.json`), diagnostic);
    console.error(diagnostic);
    throw error;
  } finally {
    if (electron) await closeTestApplication(electron);
  }
}
await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, results }, null, 2));
console.log(JSON.stringify({ firstRun: results }));
