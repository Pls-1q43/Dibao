import { homedir } from "node:os";
import { join } from "node:path";

export function desktopDataRoot(
  platform = process.platform,
  env = process.env,
  home = homedir()
): string {
  if (env.DIBAO_DESKTOP_DATA_DIR) return env.DIBAO_DESKTOP_DATA_DIR;
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Dibao");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Dibao");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "Dibao");
}

export function desktopPaths(root: string) {
  return {
    root,
    data: join(root, "data"),
    profile: join(root, "profile"),
    backups: join(root, "backups"),
    state: join(root, "desktop-state.json"),
    lock: join(root, "data.lock"),
    logs: join(root, "logs")
  };
}
