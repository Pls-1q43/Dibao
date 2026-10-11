import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_STARTUP_ARG, FOREGROUND_STARTUP_ARG, foregroundRelaunchArgs, isBackgroundStartup, loginItemOptions, migrateLegacyLoginItem, setDesktopAutoLaunch } from "./startup.js";

describe("desktop launch intent", () => {
  it("shows manual launches even when login launch is enabled", () => {
    expect(isBackgroundStartup("win32", ["Dibao.exe"])).toBe(false);
    expect(isBackgroundStartup("darwin", ["Dibao"], false)).toBe(false);
  });
  it("recognizes macOS login launches and the Windows login argument", () => {
    expect(isBackgroundStartup("darwin", [], true)).toBe(true);
    expect(isBackgroundStartup("win32", [BACKGROUND_STARTUP_ARG])).toBe(true);
    expect(isBackgroundStartup("win32", [], true)).toBe(false);
  });
  it("keeps explicit backup/recovery restarts visible", () => {
    expect(isBackgroundStartup("darwin", [BACKGROUND_STARTUP_ARG, "--dibao-backups"], true)).toBe(false);
    expect(isBackgroundStartup("darwin", [FOREGROUND_STARTUP_ARG], true)).toBe(false);
    const args = foregroundRelaunchArgs(["Dibao", BACKGROUND_STARTUP_ARG, FOREGROUND_STARTUP_ARG, "--dibao-backups"]);
    expect(args).toEqual(["Dibao", "--dibao-backups", FOREGROUND_STARTUP_ARG]);
    expect(isBackgroundStartup("win32", args)).toBe(false);
  });
  it("uses matching Windows login registration and lookup arguments", () => {
    const app = { getLoginItemSettings: vi.fn(), setLoginItemSettings: vi.fn() };
    const path = "C:\\Users\\Test\\App Data\\Dibao.exe";
    setDesktopAutoLaunch(app, "win32", path, true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ path, args: [BACKGROUND_STARTUP_ARG], openAtLogin: true, enabled: true });
    expect(loginItemOptions("win32", path)).toEqual({ path, args: [BACKGROUND_STARTUP_ARG] });
    setDesktopAutoLaunch(app, "win32", path, false);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ path, args: [BACKGROUND_STARTUP_ARG], openAtLogin: false, enabled: false });
  });
  it("keeps macOS registration free of Windows-only or removed hidden options", () => {
    const app = { getLoginItemSettings: vi.fn(), setLoginItemSettings: vi.fn() };
    setDesktopAutoLaunch(app, "darwin", "/Applications/Dibao.app", true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    migrateLegacyLoginItem(app, "darwin", "/Applications/Dibao.app");
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });
  it.each([true, false])("migrates legacy Windows registration preserving enabled=%s", enabled => {
    const app = {
      getLoginItemSettings: vi.fn().mockReturnValueOnce({ openAtLogin: false }).mockReturnValueOnce({ openAtLogin: true, executableWillLaunchAtLogin: enabled }),
      setLoginItemSettings: vi.fn()
    };
    migrateLegacyLoginItem(app, "win32", "Dibao.exe");
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ path: "Dibao.exe", args: [BACKGROUND_STARTUP_ARG], openAtLogin: true, enabled });
  });
  it.each([true, false])("does not register login launch when no migration is needed (%s)", registered => {
    const app = { getLoginItemSettings: vi.fn().mockReturnValue({ openAtLogin: registered }), setLoginItemSettings: vi.fn() };
    if (!registered) app.getLoginItemSettings.mockReturnValue({ openAtLogin: false });
    migrateLegacyLoginItem(app, "win32", "Dibao.exe");
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
