import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopBackupController } from "./backup-controller.js";
import { DesktopDataProtection } from "./data-protection.js";
import { backupError } from "./backup-errors.js";
import { backupDialogOptions } from "./backup-dialog.js";

const roots: string[] = [];
const version = "0.4.1-beta.2";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dibao-backup-controller-")); roots.push(root);
  const protection = new DesktopDataProtection(root);
  await protection.prepare(version); await protection.complete(version);
  await writeFile(join(root, "data", "content"), "saved-content");
  await writeFile(join(root, "data", "dibao.sqlite"), "database");
  const canRestart = vi.fn(async () => undefined);
  const confirm = vi.fn(async () => true);
  const stop = vi.fn(async () => undefined);
  const restart = vi.fn();
  const controller = new DesktopBackupController(protection, version, canRestart, confirm, stop, restart);
  return { root, protection, controller, canRestart, confirm, stop, restart };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("desktop backup controls", () => {
  it("reports an empty first-install backup list and schedules a cold manual backup", async () => {
    const { root, protection, controller, stop, restart } = await fixture();
    expect(await controller.state()).toEqual({ backups: [], lastOperation: null });
    await controller.run("backup", "zh-CN");
    expect(stop).toHaveBeenCalledOnce(); expect(restart).toHaveBeenCalledOnce();
    expect(await protection.listBackups()).toHaveLength(0);
    await new DesktopDataProtection(root).backupRequested();
    const state = await controller.state();
    expect(state.backups[0]).toMatchObject({ reason: "manual", version, bytes: 21 });
    expect(state.lastOperation).toMatchObject({ action: "backup", status: "success", backupId: state.backups[0].id });
  });
  it("cancels without stopping writers, scheduling work, or restarting", async () => {
    const { protection, controller, confirm, stop, restart } = await fixture();
    confirm.mockResolvedValue(false);
    expect(await controller.run("backup", "en-US")).toBe(false);
    expect(stop).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled();
    await protection.backupRequested();
    expect(await protection.listBackups()).toHaveLength(0);
  });
  it("rejects concurrent operations and rechecks unsaved changes after confirmation", async () => {
    const { controller, canRestart, confirm, stop } = await fixture();
    let answer!: (value: boolean) => void;
    confirm.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const running = controller.run("backup", "ja-JP");
    const rejected = expect(running).rejects.toThrow("dibao-backup:unsaved");
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await expect(controller.run("backup", "en-US")).rejects.toThrow("dibao-backup:busy");
    canRestart.mockRejectedValue(backupError("unsaved")); answer(true);
    await rejected;
    expect(stop).not.toHaveBeenCalled(); expect(controller.busy).toBe(false);
  });
  it.each(["unsaved", "upgrade", "busy"] as const)("blocks %s before showing a confirmation", async code => {
    const { controller, canRestart, confirm, stop } = await fixture();
    canRestart.mockRejectedValue(backupError(code));
    await expect(controller.run("backup", "zh-CN")).rejects.toThrow(`dibao-backup:${code}`);
    expect(confirm).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
  });
  it("rejects corrupt or invalid recovery selections before stopping", async () => {
    const { root, protection, controller, confirm, stop } = await fixture();
    const backup = await protection.backup(version, "manual");
    await writeFile(join(root, "backups", backup.id, "data", "content"), "corrupt");
    await expect(controller.run("restore", "zh-CN", backup.id)).rejects.toThrow("dibao-backup:invalid");
    await expect(controller.run("restore", "zh-CN", "../../data")).rejects.toThrow("dibao-backup:invalid");
    await expect(controller.run("backup", "unknown-locale")).rejects.toThrow("dibao-backup:invalid");
    expect(confirm).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
  });
  it("restores the explicitly selected point and preserves current data separately", async () => {
    const { root, protection, controller, confirm } = await fixture();
    const backup = await protection.backup(version, "manual");
    await writeFile(join(root, "data", "content"), "current-content");
    await controller.run("restore", "en-US", backup.id);
    expect(confirm).toHaveBeenCalledWith("restore", "en-US", backup);
    expect(await readFile(join(root, "data", "content"), "utf8")).toBe("current-content");
    await new DesktopDataProtection(root).restoreRequested();
    expect(await readFile(join(root, "data", "content"), "utf8")).toBe("saved-content");
    const state = await controller.state();
    expect(state.lastOperation).toMatchObject({ action: "restore", status: "success", backupId: backup.id });
    const safety = state.backups.find(item => item.reason === "recovery")!;
    expect(await readFile(join(root, "backups", safety.id, "data", "content"), "utf8")).toBe("current-content");
  });
  it("does not leave a restore request when graceful shutdown fails", async () => {
    const { root, protection, controller, stop, restart } = await fixture();
    const backup = await protection.backup(version, "manual");
    stop.mockRejectedValue(new Error("A pending write did not finish"));
    await expect(controller.run("restore", "en-US", backup.id)).rejects.toThrow("dibao-backup:failed");
    await expect(readFile(join(root, "restore-request.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(restart).not.toHaveBeenCalled();
  });
  it("reports insufficient space before confirmation or shutdown", async () => {
    const { root, canRestart, confirm, stop, restart } = await fixture();
    const controller = new DesktopBackupController(new DesktopDataProtection(root, async () => 0), version, canRestart, confirm, stop, restart);
    await expect(controller.run("backup", "en-US")).rejects.toThrow("dibao-backup:space");
    expect(confirm).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled();
  });
  it("localizes the destructive confirmation and makes cancel the default", () => {
    for (const locale of ["zh-CN", "ja-JP", "en-US"] as const) {
      const options = backupDialogOptions("restore", locale);
      expect(options.type).toBe("warning"); expect(options.defaultId).toBe(0); expect(options.cancelId).toBe(0);
      expect(options.buttons).toHaveLength(2); expect(options.detail).toBeTruthy();
    }
  });
});
