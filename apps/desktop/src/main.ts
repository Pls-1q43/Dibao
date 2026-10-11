import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, session, shell, Tray } from "electron";
import electronUpdater from "electron-updater";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_ORIGIN, type DesktopRuntimeInfo } from "@dibao/shared";
import { DesktopDataProtection } from "./data-protection.js";
import { desktopDataRoot } from "./paths.js";
import { DesktopRuntime } from "./runtime.js";
import { DesktopUpdateController } from "./update-controller.js";
import { desktopCookieHeader, storeDesktopCookies } from "./cookie-bridge.js";

const root = desktopDataRoot();
const protection = new DesktopDataProtection(root);
// The singleton's files stay outside the browser profile that upgrades back up.
app.setPath("userData", join(root, "runtime"));
app.setPath("sessionData", join(root, "profile"));
app.setName("Dibao");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: DesktopRuntime | null = null;
let updates: DesktopUpdateController | null = null;
let quitting = false;
let stopped = false;
let failureOpen = false;
let upgradeReady = false;
let articlesReady = false;
let completionStarted = false;
let lockOwned = false;
let hasUnsavedChanges = false;
let serviceStopping = false;
let browserSession: Electron.Session | null = null;
const version = app.getVersion();
const channel = version.includes("-") ? "beta" : "latest";
const here = dirname(fileURLToPath(import.meta.url));
const resourceRoot = process.env.DIBAO_DESKTOP_RESOURCES ?? (app.isPackaged ? join(process.resourcesPath, "dibao") : resolve(here, "../../.."));

app.on("second-instance", () => showWindow());
app.on("activate", () => showWindow());
app.on("window-all-closed", () => undefined);
app.on("before-quit", event => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    if (hasUnsavedChanges) {
      const answer = await dialog.showMessageBox({ type: "warning", message: "There are unsaved changes. Save them before quitting.", buttons: ["Return", "Quit without saving"], defaultId: 0, cancelId: 0 });
      if (answer.response === 0) { quitting = false; showWindow(); return; }
    }
    await stopServices();
    app.quit();
  })().catch(error => {
    quitting = false;
    void dialog.showMessageBox({ type: "error", message: String(error), buttons: ["OK"] });
  });
});

async function acquireDataLock() {
  try {
    const file = await open(protection.paths.lock, "wx", 0o600);
    await file.writeFile(JSON.stringify({ pid: process.pid }));
    await file.close();
    lockOwned = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = JSON.parse(await readFile(protection.paths.lock, "utf8")) as { pid: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid data directory lock");
    try { process.kill(owner.pid, 0); throw new Error("Another application is using this data directory"); }
    catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError; }
    await rm(protection.paths.lock);
    await acquireDataLock();
  }
}

async function boot(retry = false) {
  if (!lockOwned) await acquireDataLock();
  await protection.initialize();
  await protection.restoreRequested();
  await protection.prepare(version, retry);
  stopped = false;
  upgradeReady = false;
  articlesReady = false;
  completionStarted = false;
  serviceStopping = false;
  runtime = new DesktopRuntime(resourceRoot, protection.paths.data, join(protection.paths.logs, "server.log"), message => void showFailure(new Error(message)));
  await runtime.start();
  browserSession = session.fromPartition("persist:dibao");
  const activeSession = browserSession;
  if (!activeSession.protocol.isProtocolHandled("https")) {
    activeSession.protocol.handle("https", async request => {
      const url = new URL(request.url);
      if (url.origin !== DESKTOP_ORIGIN) return activeSession.fetch(request, { bypassCustomProtocolHandlers: true });
      const initiator = (request as Request & { initiatorOrigin?: string }).initiatorOrigin;
      if (initiator !== undefined && initiator !== DESKTOP_ORIGIN) return new Response("Untrusted origin", { status: 403 });
      if (!runtime || !runtime.port) return new Response("Local service is unavailable", { status: 503 });
      if (serviceStopping) return new Response("Local service is saving data", { status: 503 });
      const headers = new Headers(request.headers);
      headers.set("cookie", await desktopCookieHeader(activeSession.cookies, request.url));
      headers.set("x-dibao-desktop-token", runtime.token);
      headers.set("x-forwarded-host", "dibao.localhost");
      headers.set("x-forwarded-proto", "https");
      const response = await fetch(`http://127.0.0.1:${runtime.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer()),
        redirect: "manual",
        signal: request.signal
      });
      await storeDesktopCookies(response.headers, activeSession.cookies);
      // Read only bounded status responses; SSE and article bodies remain streamed.
      if (["/api/system/upgrade/status", "/api/setup/status"].includes(url.pathname) && response.ok) {
        const status = await response.clone().json() as { data: { blocking?: boolean; state?: string; coreDatabaseMigration?: { blocking: boolean }; derivedDataUpgrade?: { blocking: boolean } } };
        upgradeReady = url.pathname === "/api/setup/status"
          ? !status.data.coreDatabaseMigration?.blocking && !status.data.derivedDataUpgrade?.blocking
          : status.data.blocking === false;
        if (upgradeReady && !articlesReady) {
          const readable = await fetch(`http://127.0.0.1:${runtime.port}/api/articles?view=latest&limit=1`, { headers, signal: AbortSignal.timeout(10_000) });
          articlesReady = readable.ok;
          await readable.body?.cancel();
        }
        void completeIfReady();
      }
      if (url.pathname === "/api/articles" && response.ok) { articlesReady = true; void completeIfReady(); }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
    });
  }
  createWindow(browserSession);
  createTray();
  configureUpdates();
}

async function completeIfReady() {
  if (completionStarted || !upgradeReady || !articlesReady) return;
  completionStarted = true;
  try { await protection.complete(version); }
  catch (error) { completionStarted = false; void showFailure(error); }
}

function createWindow(browserSession: Electron.Session) {
  window = new BrowserWindow({
    width: 1280, height: 900, minWidth: 720, minHeight: 540, show: false,
    backgroundColor: "#ffffff",
    webPreferences: { session: browserSession, preload: join(here, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  window.once("ready-to-show", () => window?.show());
  window.on("close", event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  protectNavigation(window);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  void window.loadURL(DESKTOP_ORIGIN);
}

function protectNavigation(target: BrowserWindow) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === DESKTOP_ORIGIN) return {
      action: "allow", overrideBrowserWindowOptions: {
        width: 1000, height: 800,
        webPreferences: { session: target.webContents.session, preload: join(here, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false }
      }
    };
    void openExternal(url);
    return { action: "deny" };
  });
  target.webContents.on("did-create-window", child => protectNavigation(child));
  target.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== DESKTOP_ORIGIN) { event.preventDefault(); void openExternal(url); }
  });
}

function showWindow() { if (window) { window.show(); window.focus(); } }

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(join(resourceRoot, "desktop-assets", "tray.png"));
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Dibao");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Dibao", click: showWindow },
    { label: "Check for updates", click: () => void updates?.check().catch(() => undefined) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ]));
  tray.on("double-click", showWindow);
}

async function openExternal(url: string) {
  if (["https:", "http:"].includes(new URL(url).protocol)) await shell.openExternal(url);
}

function configureUpdates() {
  if (updates) return;
  const { autoUpdater } = electronUpdater;
  updates = new DesktopUpdateController(autoUpdater, version, process.platform === "darwin" && process.env.DIBAO_DESKTOP_SIGNED !== "true", state => {
    window?.webContents.send("dibao:update-state", state);
  }, async () => {
    if (hasUnsavedChanges) throw new Error("Save your changes before updating");
    if (!upgradeReady || !articlesReady || (await protection.readState())?.pending) throw new Error("Finish the database upgrade and open the article list before updating");
    await protection.checkBackupSpace(256 * 1024 * 1024);
  }, stopServices, async step => {
    const result = await dialog.showMessageBox({
      type: "question", buttons: ["Cancel", step === "download" ? "Download" : "Restart and update"], defaultId: 0, cancelId: 0,
      message: step === "download" ? "Download the available Dibao update?" : "Save your changes before restarting. Your data will be backed up before the new version opens it."
    });
    return result.response === 1;
  }, async () => { await openExternal("https://github.com/Pls-1q43/Dibao/releases"); });
  const check = () => { if (app.isPackaged) void updates?.check().catch(() => undefined); };
  setTimeout(check, 15_000).unref();
  setInterval(check, 24 * 60 * 60 * 1000).unref();
  powerMonitor.on("resume", check);
}

function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== DESKTOP_ORIGIN) throw new Error("Untrusted desktop request");
}
function handle(channel: string, handler: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => { assertSender(event); return handler(...args); });
}

handle("dibao:runtime", (): DesktopRuntimeInfo => ({ platform: process.platform, version, channel, autoLaunch: app.getLoginItemSettings().openAtLogin }));
handle("dibao:update-state", () => updates?.state);
handle("dibao:update-check", () => updates?.check());
handle("dibao:update-download", () => updates?.download());
handle("dibao:update-install", () => updates?.install());
handle("dibao:open-data", () => shell.openPath(root));
handle("dibao:recover", () => chooseRecovery());
handle("dibao:auto-launch", enabled => {
  if (typeof enabled !== "boolean") throw new Error("Invalid startup setting");
  app.setLoginItemSettings({ openAtLogin: enabled });
});
handle("dibao:pending-changes", pending => {
  if (typeof pending !== "boolean") throw new Error("Invalid pending state");
  hasUnsavedChanges = pending;
});

async function stopServices() {
  if (stopped) return;
  serviceStopping = true;
  try { await runtime?.stop(); }
  catch (error) { serviceStopping = false; throw error; }
  for (const opened of BrowserWindow.getAllWindows()) { opened.webContents.stop(); opened.destroy(); }
  window = null;
  if (browserSession) {
    await browserSession.cookies.flushStore();
    await browserSession.flushStorageData();
  }
  runtime = null;
  if (lockOwned) { await rm(protection.paths.lock, { force: true }); lockOwned = false; }
  stopped = true;
}

async function showFailure(error: unknown) {
  if (failureOpen || quitting) return;
  failureOpen = true;
  try {
    await runtime?.stop();
    runtime = null;
    window?.destroy();
    window = null;
    const result = await dialog.showMessageBox({
      type: "error", title: "Dibao", message: "Dibao could not open your data", detail: error instanceof Error ? error.message : String(error),
      buttons: ["Retry", "Restore backup", "Open data directory", "Quit"], cancelId: 3
    });
    if (result.response === 0) { failureOpen = false; await boot(true); return; }
    if (result.response === 1) {
      if (await chooseRecovery()) return;
      failureOpen = false;
      await showFailure(error);
      return;
    }
    if (result.response === 2) { await shell.openPath(root); failureOpen = false; await showFailure(error); return; }
    app.quit();
  } catch (nextError) { failureOpen = false; await showFailure(nextError); }
}

async function chooseRecovery() {
  if (!lockOwned) throw new Error("Another application is using this data directory");
  if (hasUnsavedChanges) throw new Error("Save your changes before restoring a backup");
  const backups = await protection.listBackups();
  if (!backups.length) throw new Error("No data backup is available");
  const choice = await dialog.showMessageBox({
    type: "warning", message: "Restore a backup? Changes after its date will be rolled back. The current data will be saved separately. Dibao will restart before restoring.",
    buttons: [...backups.map(b => `${b.createdAt} (${b.version})`), "Cancel"], cancelId: backups.length, defaultId: backups.length
  });
  if (choice.response >= backups.length) return false;
  await stopServices();
  await protection.requestRestore(backups[choice.response].id);
  app.relaunch();
  app.quit();
  return true;
}

if (gotLock) {
  void app.whenReady().then(async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await acquireDataLock();
    await boot();
  }).catch(showFailure);
}
