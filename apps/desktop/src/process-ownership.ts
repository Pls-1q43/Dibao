import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export async function waitForPreviousDesktopWriters(root: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let active = false;
    for (const role of ["http", "worker"]) {
      const path = join(root, "runtime", `${role}.owner`);
      let owner: { pid: number };
      try { owner = JSON.parse(await readFile(path, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid local service ownership record");
      try { process.kill(owner.pid, 0); active = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        await rm(path, { force: true });
      }
    }
    if (!active) return;
    if (Date.now() >= deadline) throw new Error("The previous local service is still saving data. Wait for it to finish, then retry.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
