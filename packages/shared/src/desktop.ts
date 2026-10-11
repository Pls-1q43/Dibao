export const DESKTOP_ORIGIN = "https://dibao.localhost";

export type DesktopUpdateState = {
  status: "idle" | "checking" | "current" | "available" | "downloading" | "downloaded" | "installing" | "error";
  currentVersion: string;
  latestVersion?: string;
  progress?: number;
  error?: string;
  manualInstall: boolean;
};

export type DesktopRuntimeInfo = {
  platform: string;
  version: string;
  channel: "beta" | "latest";
  autoLaunch: boolean;
};

export type DesktopBridge = {
  getRuntime(): Promise<DesktopRuntimeInfo>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  openDataDirectory(): Promise<void>;
  recoverBackup(): Promise<boolean>;
  setAutoLaunch(enabled: boolean): Promise<void>;
  setHasUnsavedChanges(pending: boolean): Promise<void>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
};
