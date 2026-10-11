export const BACKGROUND_STARTUP_ARG = "--dibao-background";
export const FOREGROUND_STARTUP_ARG = "--dibao-foreground";

export function isBackgroundStartup(platform: string, args: readonly string[], wasOpenedAtLogin = false) {
  if (args.includes(FOREGROUND_STARTUP_ARG) || args.includes("--dibao-backups")) return false;
  return args.includes(BACKGROUND_STARTUP_ARG) || (platform === "darwin" && wasOpenedAtLogin);
}

export function foregroundRelaunchArgs(args: readonly string[]) {
  return args.filter(arg => arg !== BACKGROUND_STARTUP_ARG && arg !== FOREGROUND_STARTUP_ARG && arg !== "--dibao-retry-upgrade").concat(FOREGROUND_STARTUP_ARG);
}

export function loginItemOptions(platform: string, executable: string): Electron.LoginItemSettingsOptions {
  return platform === "win32" ? { path: executable, args: [BACKGROUND_STARTUP_ARG] } : {};
}

type LoginItemApp = Pick<Electron.App, "getLoginItemSettings" | "setLoginItemSettings">;

export function setDesktopAutoLaunch(app: LoginItemApp, platform: string, executable: string, enabled: boolean) {
  app.setLoginItemSettings({ ...loginItemOptions(platform, executable), openAtLogin: enabled, ...(platform === "win32" ? { enabled } : {}) });
}

export function migrateLegacyLoginItem(app: LoginItemApp, platform: string, executable: string) {
  if (platform !== "win32" || app.getLoginItemSettings(loginItemOptions(platform, executable)).openAtLogin) return;
  const legacy = app.getLoginItemSettings({ path: executable, args: [] });
  if (!legacy.openAtLogin) return;
  // Add the background argument without re-enabling an item disabled in Task Manager.
  app.setLoginItemSettings({ ...loginItemOptions(platform, executable), openAtLogin: true, enabled: legacy.executableWillLaunchAtLogin });
}
