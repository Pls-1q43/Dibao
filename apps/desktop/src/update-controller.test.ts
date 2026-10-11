import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdater } from "electron-updater";
import { DesktopUpdateController } from "./update-controller.js";

function fixture(manual = false) {
  const emitter = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => undefined), downloadUpdate: vi.fn(async () => []), quitAndInstall: vi.fn(),
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, allowPrerelease: false, channel: "latest"
  });
  const gate = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const confirm = vi.fn(async () => true);
  const open = vi.fn(async () => undefined);
  const controller = new DesktopUpdateController(emitter as unknown as AppUpdater, "0.4.1-beta.1", manual, vi.fn(), gate, stop, confirm, open);
  return { emitter, gate, stop, confirm, open, controller };
}
describe("desktop update policy", () => {
  it("requires confirmation and graceful stop before installation", async () => {
    const f = fixture();
    expect(f.emitter.autoDownload).toBe(false); expect(f.emitter.autoInstallOnAppQuit).toBe(false);
    expect(f.emitter.allowDowngrade).toBe(false); expect(f.emitter.channel).toBe("beta");
    f.emitter.emit("update-available", { version: "0.4.1-beta.2" });
    await f.controller.download(); expect(f.emitter.downloadUpdate).toHaveBeenCalledOnce();
    f.emitter.emit("update-downloaded");
    await f.controller.install(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.emitter.quitAndInstall).toHaveBeenCalledOnce();
    expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.emitter.quitAndInstall.mock.invocationCallOrder[0]);
  });
  it("never installs when data upgrade or shutdown has failed", async () => {
    const f = fixture(); f.emitter.emit("update-downloaded");
    f.gate.mockRejectedValueOnce(new Error("migration pending"));
    await expect(f.controller.install()).rejects.toThrow("migration pending");
    expect(f.emitter.quitAndInstall).not.toHaveBeenCalled();
    f.stop.mockRejectedValueOnce(new Error("saving data"));
    await expect(f.controller.install()).rejects.toThrow("saving data");
    expect(f.emitter.quitAndInstall).not.toHaveBeenCalled(); expect(f.controller.state.status).toBe("downloaded");
  });
  it("does not download after cancellation and uses manual replacement on unsigned macOS", async () => {
    const f = fixture(); f.emitter.emit("update-available", { version: "0.4.1-beta.2" });
    f.confirm.mockResolvedValueOnce(false); await f.controller.download(); expect(f.emitter.downloadUpdate).not.toHaveBeenCalled();
    const mac = fixture(true); mac.emitter.emit("update-available", { version: "0.4.1-beta.2" });
    await mac.controller.download(); expect(mac.open).toHaveBeenCalledOnce(); expect(mac.emitter.downloadUpdate).not.toHaveBeenCalled();
    await expect(mac.controller.install()).rejects.toThrow("No installable");
  });
  it("tracks progress and reports errors without stopping the reader service", () => {
    const f = fixture(); f.emitter.emit("download-progress", { percent: 42 });
    expect(f.controller.state.progress).toBe(42);
    f.emitter.emit("error", new Error("network interrupted"));
    expect(f.controller.state.status).toBe("error"); expect(f.stop).not.toHaveBeenCalled();
  });
});
