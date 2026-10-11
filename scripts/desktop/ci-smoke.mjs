import { join } from "node:path";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { run, repoRoot } from "./prepare-resources.mjs";

const installed = await mkdtemp(join(tmpdir(), "dibao-standalone-"));
const source = process.platform === "win32"
  ? join(repoRoot, "dist", "desktop", "win-unpacked")
  : join(repoRoot, "dist", "desktop", process.arch === "arm64" ? "mac-arm64" : "mac", "Dibao.app");
await cp(source, installed, { recursive: true, verbatimSymlinks: true });
const executable = process.platform === "win32" ? join(installed, "Dibao.exe") : join(installed, "Contents", "MacOS", "Dibao");
await run(process.execPath, [join(repoRoot, "scripts", "desktop", "smoke.mjs")], {
  env: { ...process.env, DIBAO_DESKTOP_EXECUTABLE: executable }
});
