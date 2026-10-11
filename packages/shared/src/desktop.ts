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

export type DesktopBackupError = "busy" | "unsaved" | "upgrade" | "missing" | "space" | "invalid" | "permission" | "failed";
export type DesktopBackupInfo = {
  id: string;
  version: string;
  createdAt: string;
  reason: "upgrade" | "recovery" | "manual";
  bytes: number;
};
export type DesktopBackupOperation = {
  action: "backup" | "restore";
  status: "success" | "error";
  completedAt: string;
  backupId?: string;
  error?: DesktopBackupError;
};
export type DesktopBackupState = {
  backups: DesktopBackupInfo[];
  lastOperation: DesktopBackupOperation | null;
};

export type DesktopBridge = {
  getRuntime(): Promise<DesktopRuntimeInfo>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  openDataDirectory(): Promise<void>;
  getBackupState(): Promise<DesktopBackupState>;
  createBackup(locale: "zh-CN" | "ja-JP" | "en-US"): Promise<boolean>;
  recoverBackup(id: string, locale: "zh-CN" | "ja-JP" | "en-US"): Promise<boolean>;
  setAutoLaunch(enabled: boolean): Promise<void>;
  setHasUnsavedChanges(pending: boolean): Promise<void>;
  prepareToQuit(): Promise<void>;
  onPrepareToQuit(listener: () => void | Promise<void>): () => void;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
};
