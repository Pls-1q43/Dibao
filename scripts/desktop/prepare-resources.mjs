import { cp, mkdir, readFile, readdir, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const NODE_VERSION = "22.23.3";

async function curlFile(url, destination, resume = false) {
  await run("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "600", "--retry", "2", ...(resume ? ["--continue-at", "-"] : []), "--output", destination, url]);
}

export async function prepareElectron() {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "apps", "desktop", "package.json"), "utf8"));
  const version = packageJson.devDependencies.electron;
  const cache = join(repoRoot, ".tmp", `electron-${version}-${process.platform}-${process.arch}`);
  await mkdir(cache, { recursive: true });
  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  const checksumFile = join(cache, "SHASUMS256.txt");
  await curlFile(`${base}/SHASUMS256.txt`, checksumFile);
  const expected = (await readFile(checksumFile, "utf8")).split("\n").map(line => line.trim().split(/\s+/)).find(([, path]) => path?.replace(/^\*/, "") === name)?.[0];
  if (!expected) throw new Error("Electron checksum was not published");
  const archive = join(cache, name);
  let cached = false;
  try { cached = createHash("sha256").update(await readFile(archive)).digest("hex") === expected; } catch {}
  if (!cached) await curlFile(`${base}/${name}`, archive, true);
  if (createHash("sha256").update(await readFile(archive)).digest("hex") !== expected) throw new Error("Electron checksum failed");
  const dist = join(cache, "dist");
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist);
  if (process.platform === "win32") {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(dist)}`]);
  } else await run("unzip", ["-q", archive, "-d", dist]);
  return dist;
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

export async function prepareResources(platform = process.platform, arch = process.arch) {
  if (!["darwin", "win32", "linux"].includes(platform) || !["x64", "arm64"].includes(arch) || platform === "win32" && arch !== "x64") throw new Error("Unsupported desktop target");
  if (platform !== process.platform || arch !== process.arch) throw new Error("Prepare resources on a matching native runner so SQLite binaries can be tested");
  const staging = join(repoRoot, ".tmp", `desktop-${platform}-${arch}`);
  const payload = join(staging, "payload");
  await rm(payload, { recursive: true, force: true });
  await mkdir(payload, { recursive: true });
  for (const file of ["package.json", "package-lock.json", "LICENSE.md", "LICENSE-PARAMETERS.md", "LICENSE-APACHE-2.0.md"]) await cp(join(repoRoot, file), join(payload, file));
  for (const group of ["apps", "packages"]) {
    for (const name of await readdir(join(repoRoot, group))) {
      if (group === "apps" && name === "desktop") continue;
      const source = join(repoRoot, group, name);
      try { await readFile(join(source, "package.json")); } catch { continue; }
      const destination = join(payload, group, name);
      await mkdir(destination, { recursive: true });
      await cp(join(source, "package.json"), join(destination, "package.json"));
      try { await cp(join(source, "dist"), join(destination, "dist"), { recursive: true, filter: path => !path.endsWith(".map") && !path.endsWith(".tsbuildinfo") }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (group === "packages" && name === "db") await cp(join(source, "migrations"), join(destination, "migrations"), { recursive: true });
    }
  }
  await cp(join(repoRoot, "plugins", "official"), join(payload, "plugins", "official"), { recursive: true });
  await mkdir(join(payload, ".dibao"));
  const telemetry = JSON.parse(await readFile(join(repoRoot, ".dibao", "sentry.json"), "utf8"));
  if ("authToken" in telemetry) throw new Error("Private Sentry build credentials cannot be packaged");
  if (!telemetry.dsn || !telemetry.org || !telemetry.project) throw new Error("Desktop build requires private runtime telemetry configuration");
  const assets = join(payload, "apps", "web", "dist", "assets");
  const bundles = (await Promise.all((await readdir(assets)).filter(file => file.endsWith(".js")).map(file => readFile(join(assets, file), "utf8")))).join("\n");
  if (!bundles.includes(telemetry.dsn)) throw new Error("Desktop browser telemetry configuration is missing");
  console.log(JSON.stringify({ telemetry: { hasDsn: true, hasOrg: true, hasProject: true, browserConfigured: true, hasBuildToken: false } }));
  await writeFile(join(payload, ".dibao", "sentry.json"), JSON.stringify(telemetry));
  await mkdir(join(payload, "desktop-assets"));
  await cp(join(repoRoot, "apps", "web", "public", "logo-32.png"), join(payload, "desktop-assets", "tray.png"));
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: payload, shell: process.platform === "win32" });
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["rebuild", "better-sqlite3"], { cwd: payload, shell: process.platform === "win32" });
  // Materialize workspace links so installers never depend on the build checkout.
  const workspaceModules = join(payload, "node_modules", "@dibao");
  for (const entry of await readdir(workspaceModules)) {
    const module = join(workspaceModules, entry);
    const source = await realpath(module);
    await rm(module, { recursive: true, force: true });
    await cp(source, module, { recursive: true, dereference: true });
  }

  const nodePlatform = platform === "win32" ? "win" : platform;
  const extension = platform === "win32" ? "zip" : "tar.gz";
  const archiveName = `node-v${NODE_VERSION}-${nodePlatform}-${arch}.${extension}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const checksumPath = join(staging, "SHASUMS256.txt");
  await run("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "60", "--retry", "2", "--output", checksumPath, `${base}/SHASUMS256.txt`]);
  const checksums = await readFile(checksumPath, "utf8");
  const expected = checksums.split("\n").map(line => line.trim().split(/\s+/)).find(([, name]) => name === archiveName)?.[0];
  if (!expected) throw new Error("Node runtime checksum was not published");
  const archivePath = join(staging, archiveName);
  let cached = false;
  try { cached = createHash("sha256").update(await readFile(archivePath)).digest("hex") === expected; } catch {}
  if (!cached) {
    console.log(`Downloading verified Node ${NODE_VERSION} runtime for ${platform}/${arch}`);
    await run("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "600", "--retry", "2", "--continue-at", "-", "--output", archivePath, `${base}/${archiveName}`]);
  }
  if (createHash("sha256").update(await readFile(archivePath)).digest("hex") !== expected) throw new Error("Node runtime checksum failed");
  const extracted = join(staging, "node-extracted");
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted);
  if (platform === "win32") {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(extracted)}`]);
  } else await run("tar", ["-xzf", archivePath, "-C", extracted]);
  const runtime = join(payload, "runtime");
  await mkdir(runtime);
  const extractedRoot = join(extracted, `node-v${NODE_VERSION}-${nodePlatform}-${arch}`);
  const executable = join(runtime, platform === "win32" ? "node.exe" : "node");
  await cp(join(extractedRoot, platform === "win32" ? "node.exe" : "bin/node"), executable);
  await chmod(executable, 0o755);
  await cp(join(extractedRoot, "LICENSE"), join(runtime, "LICENSE"));
  await writeFile(join(runtime, "version.json"), JSON.stringify({ version: NODE_VERSION, platform, arch, archiveSha256: expected }));
  await run(executable, ["--input-type=module", "-e", 'import Database from "better-sqlite3"; import * as vec from "sqlite-vec"; const db=new Database(":memory:"); vec.load(db); console.log(JSON.stringify({sqlite:db.prepare("select sqlite_version() as v").get().v,vec:db.prepare("select vec_version() as v").get().v,node:process.version})); db.close();'], { cwd: payload });
  return payload;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await prepareResources());
