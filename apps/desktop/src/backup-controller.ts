import type { DesktopBackupState } from "@dibao/shared";
import semver from "semver";
import { DesktopDataProtection, type BackupManifest } from "./data-protection.js";
import { backupError, backupErrorCode } from "./backup-errors.js";

export type BackupLocale = "zh-CN" | "ja-JP" | "en-US";

export class DesktopBackupController {
  busy = false;
  constructor(
    private readonly protection: DesktopDataProtection,
    private readonly version: string,
    private readonly canRestart: () => Promise<void>,
    private readonly confirm: (action: "backup" | "restore", locale: BackupLocale, backup?: BackupManifest) => Promise<boolean>,
    private readonly stop: () => Promise<void>,
    private readonly restart: () => void
  ) {}

  async state(): Promise<DesktopBackupState> {
    const backups = await this.protection.listBackups();
    return {
      backups: backups.filter(item => semver.lte(item.version, this.version)).map(({ id, version, createdAt, reason, files }) => ({
        id, version, createdAt, reason, bytes: files.reduce((sum, file) => sum + file.size, 0)
      })),
      lastOperation: await this.protection.lastOperation()
    };
  }

  async run(action: "backup" | "restore", locale: unknown, id?: unknown) {
    if (this.busy) throw backupError("busy");
    if (typeof locale !== "string" || !["zh-CN", "ja-JP", "en-US"].includes(locale)) throw backupError("invalid");
    this.busy = true;
    try {
      await this.canRestart();
      const backup = action === "restore" ? await this.protection.verifyBackup(typeof id === "string" ? id : "") : undefined;
      if (backup && semver.gt(backup.version, this.version)) throw backupError("invalid");
      const restoreBytes = backup?.files.reduce((sum, file) => sum + file.size, 0) ?? 0;
      await this.protection.checkBackupSpace(restoreBytes + 64 * 1024 * 1024);
      if (!await this.confirm(action, locale as BackupLocale, backup)) return false;
      await this.canRestart();
      await this.stop();
      if (backup) await this.protection.requestRestore(backup.id);
      else await this.protection.requestBackup(this.version);
      this.restart();
      return true;
    } catch (error) { throw backupError(backupErrorCode(error)); }
    finally { this.busy = false; }
  }
}
