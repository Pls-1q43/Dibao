import type { DesktopBackupError } from "@dibao/shared";

export function backupErrorCode(error: unknown): DesktopBackupError {
  const message = error instanceof Error ? error.message : String(error);
  const known = message.match(/dibao-backup:(busy|unsaved|upgrade|missing|space|invalid|permission|failed)/);
  if (known) return known[1] as DesktopBackupError;
  if (/free space/.test(message)) return "space";
  if (/Backup not found|No data backup/.test(message)) return "missing";
  if (/Invalid|verification failed|newer version|symbolic link/.test(message)) return "invalid";
  if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "")) return "permission";
  return "failed";
}

export function backupError(code: DesktopBackupError) { return new Error(`dibao-backup:${code}`); }
