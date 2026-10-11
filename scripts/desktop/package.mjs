import { createRequire } from "node:module";
import { join } from "node:path";
import { prepareElectron, prepareResources, repoRoot, run } from "./prepare-resources.mjs";

const require = createRequire(import.meta.url);
const payload = await prepareResources();
const electronDist = await prepareElectron();
const builder = require.resolve("electron-builder/cli.js");
await run(process.execPath, [builder, "--projectDir", join(repoRoot, "apps", "desktop"), "--config", "electron-builder.cjs", "--publish", "never", ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: { ...process.env, DIBAO_DESKTOP_PAYLOAD: payload, DIBAO_ELECTRON_DIST: electronDist, CSC_IDENTITY_AUTO_DISCOVERY: "false" }
});
