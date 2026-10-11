import { join } from "node:path";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { run, repoRoot } from "./prepare-resources.mjs";

const installed = await mkdtemp(join(tmpdir(), "dibao-standalone-"));
const source = process.platform === "win32"
  ? join(repoRoot, "dist", "desktop", "win-unpacked")
  : join(repoRoot, "dist", "desktop", process.arch === "arm64" ? "mac-arm64" : "mac", "Dibao.app");
await cp(source, installed, { recursive: true, verbatimSymlinks: true });
const executable = process.platform === "win32" ? join(installed, "Dibao.exe") : join(installed, "Contents", "MacOS", "Dibao");
await run(process.execPath, [join(repoRoot, "scripts", "desktop", "first-run-smoke.mjs")], {
  env: { ...process.env, DIBAO_DESKTOP_EXECUTABLE: executable }
});
await run(process.execPath, [join(repoRoot, "scripts", "desktop", "smoke.mjs")], {
  env: { ...process.env, DIBAO_DESKTOP_EXECUTABLE: executable }
});
await run(process.execPath, [join(repoRoot, "scripts", "desktop", "backup-smoke.mjs")], {
  env: { ...process.env, DIBAO_DESKTOP_EXECUTABLE: executable, DIBAO_DESKTOP_BACKUP_OUTPUT: join(repoRoot, "test-results", `desktop-${process.platform}-${process.arch}`, "backup") }
});
await run(process.execPath, [join(repoRoot, "scripts", "desktop", "startup-smoke.mjs")], {
  env: { ...process.env, DIBAO_DESKTOP_EXECUTABLE: executable, DIBAO_DESKTOP_STARTUP_OUTPUT: join(repoRoot, "test-results", `desktop-${process.platform}-${process.arch}`, "startup") }
});
const version = JSON.parse(await readFile(join(repoRoot, "apps", "desktop", "package.json"), "utf8")).version;
await writeFile(join(repoRoot, "test-results", `desktop-${process.platform}-${process.arch}`, "build.json"), JSON.stringify({
  version, platform: process.platform, arch: process.arch,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
}, null, 2));
