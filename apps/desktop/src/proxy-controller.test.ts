import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopProxySettings, type DesktopProxySettings } from "@dibao/shared";
import { DesktopProxyController } from "./proxy-controller.js";
import { DesktopDataProtection } from "./data-protection.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dibao-proxy-settings-")); directories.push(directory);
  const session = { setProxy: vi.fn(async () => undefined), closeAllConnections: vi.fn(async () => undefined), resolveProxy: vi.fn(async () => "PROXY localhost:7890") };
  const updater = { ...session, setProxy: vi.fn(async () => undefined), closeAllConnections: vi.fn(async () => undefined) };
  const apply = vi.fn(async (_settings: DesktopProxySettings) => undefined);
  const guard = vi.fn(() => undefined);
  const path = join(directory, "desktop-proxy.json");
  const controller = new DesktopProxyController(path, [session, updater], apply, guard);
  await controller.initialize();
  return { directory, path, controller, session, updater, apply, guard };
}

describe("desktop proxy configuration", () => {
  it("follows the system by default without writing a file or changing OS settings", async () => {
    const f = await fixture();
    expect(f.controller.current).toEqual(defaultDesktopProxySettings);
    expect(f.session.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(f.updater.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(f.apply).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual([]);
  });

  it("applies to browser, updater and background services, persists securely, and loads after restart", async () => {
    const f = await fixture();
    const settings = { ...defaultDesktopProxySettings, mode: "manual" as const, server: "socks5://127.0.0.1:7891" };
    expect(await f.controller.save(settings)).toEqual(settings);
    expect(f.apply).toHaveBeenCalledWith(settings);
    for (const session of [f.session, f.updater]) {
      expect(session.setProxy).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "fixed_servers", proxyRules: settings.server }));
      expect(session.closeAllConnections).toHaveBeenCalledTimes(2);
    }
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ format: 1, settings });
    if (process.platform !== "win32") expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    const next = new DesktopProxyController(f.path, [f.session], f.apply, f.guard);
    await next.initialize();
    expect(next.current).toEqual(settings);
    expect(await next.resolveProxy("https://example.com")).toBe("PROXY localhost:7890");
  });

  it("rejects unsafe settings before changing runtime state", async () => {
    const f = await fixture();
    await expect(f.controller.save({ ...defaultDesktopProxySettings, server: "http://user:secret@proxy" })).rejects.toThrow("DIBAO_PROXY_INVALID");
    expect(f.session.setProxy).toHaveBeenCalledTimes(1);
    expect(f.apply).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual([]);
  });

  it("rolls back all channels when a service or persistence fails", async () => {
    const f = await fixture();
    f.apply.mockRejectedValueOnce(new Error("Service unavailable"));
    const next = { ...defaultDesktopProxySettings, mode: "manual" as const };
    await expect(f.controller.save(next)).rejects.toThrow("DIBAO_PROXY_SAVE_FAILED");
    expect(f.controller.current).toEqual(defaultDesktopProxySettings);
    expect(f.apply).toHaveBeenLastCalledWith(defaultDesktopProxySettings);
    expect(f.session.setProxy).toHaveBeenLastCalledWith({ mode: "system" });
    expect(await readdir(f.directory)).toEqual([]);
    const missingPath = join(f.directory, "missing", "proxy.json");
    const missing = new DesktopProxyController(missingPath, [f.session], f.apply, f.guard);
    await expect(missing.save(next)).rejects.toThrow("DIBAO_PROXY_SAVE_FAILED");
    expect(missing.current).toEqual(defaultDesktopProxySettings);
  });

  it("blocks concurrent changes and guarded backup/update periods", async () => {
    const f = await fixture();
    let finish!: () => void;
    f.apply.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
    const saving = f.controller.save({ ...defaultDesktopProxySettings, mode: "direct" });
    await vi.waitFor(() => expect(f.controller.busy).toBe(true));
    await expect(f.controller.save(defaultDesktopProxySettings)).rejects.toThrow("DIBAO_PROXY_BUSY");
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish(); await saving;
    expect(f.controller.busy).toBe(false);
    f.guard.mockImplementationOnce(() => { throw new Error("DIBAO_PROXY_BUSY"); });
    await expect(f.controller.save(defaultDesktopProxySettings)).rejects.toThrow("DIBAO_PROXY_BUSY");
  });

  it("stops normal operation if reverting a failed change cannot be confirmed", async () => {
    const f = await fixture();
    const failure = vi.fn();
    f.apply.mockRejectedValue(new Error("Disconnected service"));
    const controller = new DesktopProxyController(f.path, [f.session], f.apply, f.guard, failure);
    await expect(controller.save({ ...defaultDesktopProxySettings, mode: "direct" })).rejects.toThrow("DIBAO_PROXY_SAVE_FAILED");
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("could not be restored"));
    expect(await readdir(f.directory)).toEqual([]);
  });

  it("refuses malformed or symlinked configuration instead of silently switching to direct", async () => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify({ format: 99, settings: defaultDesktopProxySettings }));
    await expect(new DesktopProxyController(f.path, [f.session], f.apply, f.guard).initialize()).rejects.toThrow("could not be read");
    if (process.platform !== "win32") {
      const linked = join(f.directory, "linked.json"); await symlink(f.path, linked);
      await expect(new DesktopProxyController(linked, [f.session], f.apply, f.guard).initialize()).rejects.toThrow("could not be read");
    }
  });

  it("includes proxy configuration in existing cold backups and recovery", async () => {
    const f = await fixture();
    const protection = new DesktopDataProtection(join(f.directory, "app"));
    await protection.initialize();
    await writeFile(join(protection.paths.data, "dibao.sqlite"), "test database");
    const path = join(protection.paths.data, "desktop-proxy.json");
    const controller = new DesktopProxyController(path, [f.session], f.apply, f.guard);
    await controller.save({ ...defaultDesktopProxySettings, mode: "direct" });
    const backup = await protection.backup("0.4.1", "manual");
    expect(backup.files.some(file => file.path.replaceAll("\\", "/") === "data/desktop-proxy.json")).toBe(true);
    await controller.save({ ...defaultDesktopProxySettings, mode: "manual" });
    await protection.restore(backup.id);
    expect(JSON.parse(await readFile(path, "utf8")).settings.mode).toBe("direct");
  });
});
