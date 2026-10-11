import { useEffect, useState } from "react";
import type { DesktopBackupError, DesktopBackupState, DesktopBridge } from "@dibao/shared";
import { useI18n } from "../i18n.js";
import styles from "../design-system/AppShell/AppShell.module.css";

export const desktopBackupCopy = {
  "zh-CN": {
    title: "数据备份与恢复", create: "创建备份", restore: "恢复备份", point: "恢复点", refresh: "刷新备份列表",
    loading: "正在读取备份…", working: "正在检查并准备重启…", empty: "还没有备份。可先创建一份；之后升级应用前也会自动备份。",
    note: "备份保存在本机。创建或恢复需确认后重启；自动升级备份保留最近三份，手动备份和恢复前快照不会自动删除。",
    cancelled: "已取消，当前数据未改变。", backupDone: "备份已完成", restoreDone: "恢复已完成", backupFailed: "备份未完成", restoreFailed: "恢复未完成",
    reasons: { manual: "手动备份", upgrade: "升级前备份", recovery: "恢复前快照" },
    errors: {
      busy: "另一个操作正在进行，请等待完成后再试。", unsaved: "设置尚未保存，请先保存或撤销更改，再进行备份或恢复。",
      upgrade: "请先完成数据升级并打开文章列表，再进行备份或恢复。", missing: "所选备份不存在，请刷新备份列表。",
      space: "磁盘空间不足。请先腾出空间，当前数据未被替换。", invalid: "备份校验失败或版本不兼容，当前数据未被替换。",
      permission: "没有备份目录的读写权限，请检查目录权限后重试。", failed: "备份操作失败。请检查磁盘和数据目录后重试；当前数据未被替换。"
    }
  },
  "ja-JP": {
    title: "バックアップと復元", create: "バックアップを作成", restore: "バックアップを復元", point: "復元ポイント", refresh: "バックアップ一覧を更新",
    loading: "バックアップを読み込み中…", working: "確認して再起動を準備中…", empty: "バックアップはまだありません。まず作成できます。アプリの更新前にも自動で保存されます。",
    note: "バックアップはこのコンピューターに保存されます。作成・復元は確認後に再起動します。更新前の自動保存は最新3件を保持し、手動保存と復元前のスナップショットは自動削除しません。",
    cancelled: "キャンセルしました。現在のデータは変更されていません。", backupDone: "バックアップが完了しました", restoreDone: "復元が完了しました", backupFailed: "バックアップは完了していません", restoreFailed: "復元は完了していません",
    reasons: { manual: "手動バックアップ", upgrade: "更新前バックアップ", recovery: "復元前スナップショット" },
    errors: {
      busy: "別の処理が進行中です。完了後に再試行してください。", unsaved: "未保存の設定があります。保存または取り消してから再試行してください。",
      upgrade: "データ更新を完了して記事一覧を開いてから再試行してください。", missing: "選択したバックアップがありません。一覧を更新してください。",
      space: "ディスクの空き容量が不足しています。空きを確保してください。現在のデータは置き換えていません。", invalid: "検証に失敗したか、対応しないバージョンです。現在のデータは置き換えていません。",
      permission: "バックアップフォルダーの読み書き権限を確認してください。", failed: "バックアップ処理に失敗しました。ディスクとデータフォルダーを確認してください。現在のデータは置き換えていません。"
    }
  },
  "en-US": {
    title: "Backup and recovery", create: "Create backup", restore: "Restore backup", point: "Restore point", refresh: "Refresh backup list",
    loading: "Loading backups…", working: "Checking and preparing to restart…", empty: "No backups yet. Create one now; Dibao also backs up automatically before upgrades.",
    note: "Backups stay on this computer. Creating or restoring requires confirmation and a restart. The three latest upgrade backups are retained; manual backups and pre-restore snapshots are not automatically deleted.",
    cancelled: "Cancelled. Current data is unchanged.", backupDone: "Backup completed", restoreDone: "Restore completed", backupFailed: "Backup did not complete", restoreFailed: "Restore did not complete",
    reasons: { manual: "Manual backup", upgrade: "Pre-upgrade backup", recovery: "Pre-restore snapshot" },
    errors: {
      busy: "Another operation is in progress. Wait for it to finish.", unsaved: "Save or discard your unsaved settings before backing up or restoring.",
      upgrade: "Finish the data upgrade and open the article list before backing up or restoring.", missing: "The selected backup is missing. Refresh the backup list.",
      space: "Not enough free disk space. Free some space and retry. Current data was not replaced.", invalid: "Backup verification failed or its version is incompatible. Current data was not replaced.",
      permission: "Check read/write permissions for the backup directory and retry.", failed: "The backup operation failed. Check your disk and data directory and retry. Current data was not replaced."
    }
  }
};

export function desktopBackupErrorCode(error: unknown): DesktopBackupError {
  const match = String(error instanceof Error ? error.message : error).match(/dibao-backup:(busy|unsaved|upgrade|missing|space|invalid|permission|failed)/);
  return match ? match[1] as DesktopBackupError : "failed";
}

export function DesktopBackupSettings({ bridge }: { bridge: DesktopBridge }) {
  const { locale } = useI18n();
  const t = desktopBackupCopy[locale];
  const [state, setState] = useState<DesktopBackupState | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DesktopBackupError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const acceptState = (next: DesktopBackupState) => {
    setState(next);
    setSelected(previous => next.backups.some(item => item.id === previous) ? previous : next.backups[0]?.id ?? "");
  };
  useEffect(() => {
    let active = true;
    void bridge.getBackupState().then(next => { if (active) acceptState(next); })
      .catch(error => { if (active) setError(desktopBackupErrorCode(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [bridge]);
  const act = async (action: () => Promise<boolean>) => {
    setBusy(true); setError(null); setNotice(null);
    try { if (!await action()) setNotice(t.cancelled); }
    catch (error) { setError(desktopBackupErrorCode(error)); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    setLoading(true); setError(null); setNotice(null);
    try { acceptState(await bridge.getBackupState()); }
    catch (error) { setError(desktopBackupErrorCode(error)); }
    finally { setLoading(false); }
  };
  const disabled = busy || loading;
  const chosen = state?.backups.find(item => item.id === selected);
  const last = state?.lastOperation;
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  return <section className={`${styles.settingsSubsection} ${styles.desktopBackupStatus}`} aria-labelledby="desktop-backup-title">
    <h4 id="desktop-backup-title">{t.title}</h4>
    <div className={styles.desktopUpdateActions}>
      <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => void act(() => bridge.createBackup(locale))}>{t.create}</button>
      <button type="button" className={styles.secondaryButton} disabled={disabled || !selected} onClick={() => void act(() => bridge.recoverBackup(selected, locale))}>{t.restore}</button>
      <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => void refresh()}>{t.refresh}</button>
    </div>
    {state?.backups.length ? <label className={styles.settingsField} htmlFor="desktop-backup-point">
      <span>{t.point}</span>
      <select id="desktop-backup-point" value={selected} disabled={disabled} onChange={event => setSelected(event.target.value)}>
        {state.backups.map(item => <option key={item.id} value={item.id}>{date(item.createdAt)} · {t.reasons[item.reason]}</option>)}
      </select>
      {chosen ? <small>{chosen.version} · {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(chosen.bytes / 1024 / 1024)} MB</small> : null}
    </label> : !loading && !error ? <small>{t.empty}</small> : null}
    <small>{t.note}</small>
    {loading || busy ? <small role="status">{busy ? t.working : t.loading}</small> : null}
    {notice ? <small role="status">{notice}</small> : null}
    {last ? <small role={last.status === "error" ? "alert" : "status"}>
      {last.action === "backup" ? last.status === "success" ? t.backupDone : t.backupFailed : last.status === "success" ? t.restoreDone : t.restoreFailed}
      {` · ${date(last.completedAt)}`}{last.error ? ` · ${t.errors[last.error]}` : ""}
    </small> : null}
    {error ? <small role="alert">{t.errors[error]}</small> : null}
  </section>;
}
