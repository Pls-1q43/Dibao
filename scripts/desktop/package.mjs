import { createRequire } from "node:module";
import { join } from "node:path";
import { prepareElectron, prepareResources, repoRoot, run } from "./prepare-resources.mjs";
import { verifyMacApplication } from "./verify-macos.mjs";

const require = createRequire(import.meta.url);
const payload = await prepareResources();
const electronDist = await prepareElectron();
const builder = require.resolve("electron-builder/cli.js");
await run(process.execPath, [builder, "--projectDir", join(repoRoot, "apps", "desktop"), "--config", "electron-builder.cjs", "--publish", "never", ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: { ...process.env, DIBAO_DESKTOP_PAYLOAD: payload, DIBAO_ELECTRON_DIST: electronDist, CSC_IDENTITY_AUTO_DISCOVERY: "false" }
});
if (process.platform === "darwin") {
  const output = process.argv.slice(2).find(argument => argument.startsWith("--config.directories.output="))?.split("=", 2)[1] ?? "../../dist/desktop";
  await verifyMacApplication(join(repoRoot, "apps", "desktop", output, process.arch === "arm64" ? "mac-arm64" : "mac", "Dibao.app"));
}
