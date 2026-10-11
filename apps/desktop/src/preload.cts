import type { DesktopBridge, DesktopUpdateState } from "@dibao/shared";
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
const saveState = new Set<() => void | Promise<void>>();

const bridge: DesktopBridge = {
  getRuntime: () => ipcRenderer.invoke("dibao:runtime"),
  getUpdateState: () => ipcRenderer.invoke("dibao:update-state"),
  checkForUpdates: () => ipcRenderer.invoke("dibao:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("dibao:update-download"),
  installUpdate: () => ipcRenderer.invoke("dibao:update-install"),
  openDataDirectory: () => ipcRenderer.invoke("dibao:open-data"),
  getBackupState: () => ipcRenderer.invoke("dibao:backup-state"),
  createBackup: locale => ipcRenderer.invoke("dibao:backup-create", locale),
  recoverBackup: (id, locale) => ipcRenderer.invoke("dibao:recover", id, locale),
  setAutoLaunch: enabled => ipcRenderer.invoke("dibao:auto-launch", enabled),
  setHasUnsavedChanges: pending => ipcRenderer.invoke("dibao:pending-changes", pending),
  prepareToQuit: async () => { await Promise.all([...saveState].map(save => Promise.resolve().then(save))); },
  onPrepareToQuit: listener => { saveState.add(listener); return () => { saveState.delete(listener); }; },
  onUpdateState: listener => {
    const receive = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => listener(state);
    ipcRenderer.on("dibao:update-state", receive);
    return () => ipcRenderer.removeListener("dibao:update-state", receive);
  }
};
contextBridge.exposeInMainWorld("dibaoDesktop", bridge);
