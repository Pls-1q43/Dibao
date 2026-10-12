import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { repoRoot, run } from "./prepare-resources.mjs";

export async function verifyMacApplication(app) {
  app = resolve(app);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const runtime = join(app, "Contents", "Resources", "dibao");
  await run("codesign", ["--verify", "--strict", join(runtime, "runtime", "node")]);
  let sqlite = false, vec = false;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(?:node|dylib)$/u.test(entry.name)) {
        await run("codesign", ["--verify", "--strict", path]);
        sqlite ||= entry.name === "better_sqlite3.node";
        vec ||= entry.name === "vec0.dylib";
      }
    }
  }
  await walk(join(runtime, "node_modules"));
  assert(sqlite && vec, "Missing signed native SQLite modules");
  await run(join(runtime, "runtime", "node"), ["--input-type=module", "-e", 'import Database from "better-sqlite3"; import * as vec from "sqlite-vec"; const db=new Database(":memory:"); vec.load(db); if(!db.prepare("select vec_version() as v").get().v)throw Error("Native vector module failed"); let total=0; for(let i=0;i<1000000;i++)total+=i; if(total!==499999500000)throw Error("Runtime execution failed"); db.close(); console.log(JSON.stringify({signedRuntimeAndNativeModulesRun:true}));'], { cwd: runtime });
  return { appSignatureValid: true, bundledNodeSignatureValid: true, nativeModulesSignatureValid: true };
}

export async function verifyMacInstallers(directory = join(repoRoot, "dist", "desktop")) {
  const folder = process.arch === "arm64" ? "mac-arm64" : "mac";
  const app = join(directory, folder, "Dibao.app");
  const version = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  const name = `Dibao-${version}-mac-${process.arch}`;
  const temporary = await mkdtemp(join(tmpdir(), "dibao-installer-verify-"));
  const mount = join(temporary, "volume");
  let mounted = false;
  try {
    const checks = await verifyMacApplication(app);
    await run("hdiutil", ["verify", join(directory, `${name}.dmg`)]);
    await run("hdiutil", ["attach", join(directory, `${name}.dmg`), "-readonly", "-nobrowse", "-mountpoint", mount]);
    mounted = true;
    // Check the drag-and-drop copy, not only the pre-installer staging folder.
    const installed = join(temporary, "Dibao.app");
    await cp(join(mount, "Dibao.app"), installed, { recursive: true, verbatimSymlinks: true });
    await verifyMacApplication(installed);
    await run("hdiutil", ["detach", mount]); mounted = false;
    const zip = join(temporary, "zip");
    await run("ditto", ["-x", "-k", join(directory, `${name}.zip`), zip]);
    await verifyMacApplication(join(zip, "Dibao.app"));
    // A real resource change must fail the very gate used for publication.
    await writeFile(join(installed, "Contents", "Resources", "signature-tamper-test.txt"), "tampered");
    let rejected = false;
    try { execFileSync("codesign", ["--verify", "--deep", "--strict", installed], { stdio: "ignore" }); }
    catch { rejected = true; }
    assert(rejected, "Signature gate accepted a modified application");
    return { passed: true, version, arch: process.arch, ...checks, dmgCopyVerified: true, zipVerified: true, tamperedResourceRejected: true, developerIdSigned: false, notarized: false };
  } finally {
    if (mounted) await run("hdiutil", ["detach", mount]);
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.platform, "darwin");
  const report = await verifyMacInstallers();
  await writeFile(join(repoRoot, "test-results", `desktop-darwin-${process.arch}`, "signature.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
