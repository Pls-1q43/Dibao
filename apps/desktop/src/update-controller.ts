import type { AppUpdater } from "electron-updater";
import type { DesktopUpdateState } from "@dibao/shared";

export class DesktopUpdateController {
  state: DesktopUpdateState;
  constructor(
    private readonly updater: AppUpdater,
    version: string,
    manualInstall: boolean,
    private readonly emit: (state: DesktopUpdateState) => void,
    private readonly canInstall: () => Promise<void>,
    private readonly stop: () => Promise<void>,
    private readonly confirm: (step: "download" | "install") => Promise<boolean>,
    private readonly openManualRelease: () => Promise<void>
  ) {
    this.state = { status: "idle", currentVersion: version, manualInstall };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = version.includes("-");
    updater.channel = version.includes("-") ? "beta" : "latest";
    // Setting electron-updater's channel enables downgrades unless reset afterwards.
    updater.allowDowngrade = false;
    updater.on("checking-for-update", () => this.patch({ status: "checking", error: undefined }));
    updater.on("update-not-available", () => this.patch({ status: "current", latestVersion: undefined, progress: undefined }));
    updater.on("update-available", info => this.patch({ status: "available", latestVersion: info.version }));
    updater.on("download-progress", progress => this.patch({ status: "downloading", progress: progress.percent }));
    updater.on("update-downloaded", () => this.patch({ status: "downloaded", progress: 100 }));
    updater.on("error", () => this.patch({ status: "error", error: "Update check or download failed. Retry when the network is available." }));
  }

  private patch(patch: Partial<DesktopUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.emit(this.state);
  }

  async check() {
    if (["checking", "downloading", "downloaded", "installing"].includes(this.state.status)) return;
    await this.updater.checkForUpdates();
  }

  async download() {
    if (this.state.status !== "available") throw new Error("No update is available");
    if (!await this.confirm("download")) return;
    if (this.state.manualInstall) { await this.openManualRelease(); return; }
    await this.canInstall();
    this.patch({ status: "downloading", progress: 0 });
    await this.updater.downloadUpdate();
  }

  async install() {
    if (this.state.manualInstall || this.state.status !== "downloaded") throw new Error("No installable update has been downloaded");
    if (!await this.confirm("install")) return;
    try {
      await this.canInstall();
      this.patch({ status: "installing" });
      await this.stop();
      this.updater.quitAndInstall(true, true);
    } catch (error) {
      this.patch({ status: "downloaded", error: error instanceof Error ? error.message : "Update could not be installed" });
      throw error;
    }
  }
}
