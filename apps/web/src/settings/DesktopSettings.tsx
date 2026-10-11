import { useEffect, useState } from "react";
import type { DesktopRuntimeInfo, DesktopUpdateState } from "@dibao/shared";
import { desktopBridge } from "../desktop.js";
import { useI18n } from "../i18n.js";
import styles from "../design-system/AppShell/AppShell.module.css";
import { DesktopBackupSettings } from "./DesktopBackupSettings.js";

const startupErrors = {
  "zh-CN": "启动设置未能保存，请检查系统权限后重试。",
  "ja-JP": "起動設定を保存できませんでした。システムの権限を確認して再試行してください。",
  "en-US": "Startup settings could not be saved. Check system permissions and try again."
};

const copy = {
  "zh-CN": { check: "检查更新", download: "下载更新", install: "重启并更新", manual: "下载安装包", data: "打开数据目录", startup: "登录系统时在后台启动", idle: "尚未检查更新", checking: "正在检查更新", current: "已是最新版本", available: "有可用更新", downloading: "正在下载", downloaded: "下载完成", installing: "正在准备更新", error: "更新失败，可稍后重试", manualNote: "macOS 需下载安装包并覆盖应用。用户数据会保留。" },
  "ja-JP": { check: "更新を確認", download: "更新をダウンロード", install: "再起動して更新", manual: "インストーラーを取得", data: "データフォルダーを開く", startup: "ログイン時にバックグラウンドで起動", idle: "更新は未確認です", checking: "更新を確認中", current: "最新バージョンです", available: "更新があります", downloading: "ダウンロード中", downloaded: "ダウンロード完了", installing: "更新を準備中", error: "更新に失敗しました。後で再試行できます", manualNote: "macOS はインストーラーでアプリを上書きしてください。ユーザーデータは保持されます。" },
  "en-US": { check: "Check for updates", download: "Download update", install: "Restart and update", manual: "Get installer", data: "Open data directory", startup: "Start in the background at login", idle: "Updates not checked", checking: "Checking for updates", current: "Up to date", available: "Update available", downloading: "Downloading", downloaded: "Download complete", installing: "Preparing update", error: "Update failed. Try again later", manualNote: "On macOS, download the installer and replace the app. Your data is retained." }
};

export function DesktopSettings() {
  const { locale } = useI18n();
  const t = copy[locale];
  const bridge = desktopBridge();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startupPending, setStartupPending] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    void bridge.getUpdateState().then(setState).catch(() => setError(t.error));
    void bridge.getRuntime().then(setRuntime).catch(() => setStartupError(startupErrors[locale]));
    return bridge.onUpdateState(setState);
  }, [bridge, locale, t.error]);
  const act = (action: () => Promise<unknown>) => { setError(null); void action().catch(() => setError(t.error)); };
  const setStartup = async (enabled: boolean) => {
    if (!bridge || !runtime || startupPending) return;
    const previous = runtime;
    setStartupError(null);
    setStartupPending(true);
    setRuntime({ ...previous, autoLaunch: enabled });
    try {
      await bridge.setAutoLaunch(enabled);
      const saved = await bridge.getRuntime();
      setRuntime(saved);
      if (saved.autoLaunch !== enabled) setStartupError(startupErrors[locale]);
    } catch {
      setRuntime(previous);
      setStartupError(startupErrors[locale]);
    } finally { setStartupPending(false); }
  };
  if (!bridge) return null;
  return <div className={`${styles.latestReleaseStatus} ${styles.desktopUpdateStatus}`}>
    <span>{state ? t[state.status] : t.idle}{state?.latestVersion ? ` (${state.latestVersion})` : ""}</span>
    {state?.status === "downloading" ? <progress max={100} value={state.progress ?? 0} /> : null}
    <div className={styles.desktopUpdateActions}>
      <button type="button" className={styles.secondaryButton} disabled={state && ["checking", "downloading", "installing"].includes(state.status) || false} onClick={() => act(() => bridge.checkForUpdates())}>{t.check}</button>
      {state?.status === "available" ? <button type="button" className={styles.secondaryButton} onClick={() => act(() => bridge.downloadUpdate())}>{state.manualInstall ? t.manual : t.download}</button> : null}
      {state?.status === "downloaded" ? <button type="button" className={styles.secondaryButton} onClick={() => act(() => bridge.installUpdate())}>{t.install}</button> : null}
      <button type="button" className={styles.secondaryButton} onClick={() => act(() => bridge.openDataDirectory())}>{t.data}</button>
    </div>
    {state?.manualInstall ? <small>{t.manualNote}</small> : null}
    <label className={styles.desktopStartupSetting}><span>{t.startup}</span><input type="checkbox" checked={runtime?.autoLaunch ?? false} disabled={!runtime || startupPending} onChange={event => void setStartup(event.target.checked)} /></label>
    {startupError ? <small role="alert">{startupError}</small> : null}
    {error || state?.status === "error" ? <small role="alert">{error ?? t.error}</small> : null}
    <DesktopBackupSettings bridge={bridge} />
  </div>;
}
