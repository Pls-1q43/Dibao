import type { BackupLocale } from "./backup-controller.js";
import type { BackupManifest } from "./data-protection.js";

const copy = {
  "zh-CN": {
    title: "邸报 · 数据备份", cancel: "取消", backup: "重启并创建备份", restore: "重启并恢复",
    backupMessage: "创建完整的本地备份？",
    backupDetail: "邸报将先保存阅读状态、停止后台任务并重启，再备份文章、订阅、设置、向量、插件数据及密钥、登录和客户端状态。备份成功后重新打开设置。备份保存在本机，不上传到云端。",
    restoreMessage: "恢复所选备份？",
    restoreDetail: "此恢复点之后的修改将回退。邸报会先保存当前状态，再重启验证备份；恢复前另存当前数据，之后重新打开设置。"
  },
  "ja-JP": {
    title: "邸報 · データのバックアップ", cancel: "キャンセル", backup: "再起動してバックアップ", restore: "再起動して復元",
    backupMessage: "完全なローカルバックアップを作成しますか？",
    backupDetail: "閲覧状態を保存してバックグラウンド処理を停止し、再起動後に記事、購読、設定、ベクトル、プラグインのデータと鍵、ログインとクライアント状態を保存します。完了後に設定を開きます。クラウドには送信しません。",
    restoreMessage: "選択したバックアップを復元しますか？",
    restoreDetail: "この時点以降の変更は巻き戻されます。現在の状態を保存して再起動し、バックアップを検証します。復元前に現在のデータを別途保存し、完了後に設定を開きます。"
  },
  "en-US": {
    title: "Dibao · Data backup", cancel: "Cancel", backup: "Restart and back up", restore: "Restart and restore",
    backupMessage: "Create a complete local backup?",
    backupDetail: "Dibao will save reading state, stop background tasks and restart before backing up articles, feeds, settings, vectors, plugin data and keys, login and client state. Settings will reopen afterwards. Backups stay on this computer, not in the cloud.",
    restoreMessage: "Restore the selected backup?",
    restoreDetail: "Changes after this restore point will be rolled back. Dibao will save current state, restart and verify the backup. Current data is saved separately before restoring, and Settings reopens afterwards."
  }
};

export function backupDialogOptions(action: "backup" | "restore", locale: BackupLocale, backup?: BackupManifest): Electron.MessageBoxOptions {
  const t = copy[locale];
  const point = backup ? `${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(backup.createdAt))} (${backup.version})\n\n` : "";
  return {
    type: action === "restore" ? "warning" : "question", title: t.title,
    message: action === "restore" ? t.restoreMessage : t.backupMessage,
    detail: point + (action === "restore" ? t.restoreDetail : t.backupDetail),
    buttons: [t.cancel, t[action]], defaultId: 0, cancelId: 0, noLink: true
  };
}
