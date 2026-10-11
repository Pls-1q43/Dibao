import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function claimDesktopProcessOwnership(role: "http" | "worker") {
  const directory = process.env.DIBAO_DESKTOP_OWNER_DIR;
  if (!directory || !process.env.DIBAO_DESKTOP_RUNTIME_TOKEN) return;
  if (!process.connected) process.exit(0);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${role}.owner`);
  const file = openSync(path, "wx", 0o600);
  try { writeFileSync(file, JSON.stringify({ pid: process.pid })); }
  finally { closeSync(file); }
  process.once("exit", () => {
    try {
      if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) unlinkSync(path);
    } catch { /* A stale record is checked before the next desktop startup. */ }
  });
}
