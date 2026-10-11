import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, cp, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const yaml = createRequire(import.meta.url)("js-yaml");
export const desktopTargets = [
  { artifact: "Dibao-desktop-windows-x64", platform: "win32", arch: "x64", suffix: "win-x64", metadata: "latest.yml", types: ["exe"] },
  { artifact: "Dibao-desktop-macos-x64", platform: "darwin", arch: "x64", suffix: "mac-x64", metadata: "latest-mac.yml", types: ["dmg", "zip"] },
  { artifact: "Dibao-desktop-macos-arm64", platform: "darwin", arch: "arm64", suffix: "mac-arm64", metadata: "latest-mac.yml", types: ["dmg", "zip"] }
];
async function hashes(path) {
  const sha256 = createHash("sha256"), sha512 = createHash("sha512");
  for await (const chunk of createReadStream(path)) { sha256.update(chunk); sha512.update(chunk); }
  return { sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

export async function collectDesktopAssets(input, output, { version, revision }) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(revision, /^[a-f0-9]{40}$/);
  await mkdir(output, { recursive: true });
  assert.equal((await readdir(output)).length, 0, "Release staging directory must be empty");
  const artifacts = [], metadata = [];
  for (const target of desktopTargets) {
    const root = join(input, target.artifact);
    const evidence = join(root, "test-results", `desktop-${target.platform}-${target.arch}`);
    const build = JSON.parse(await readFile(join(evidence, "build.json"), "utf8"));
    assert.deepEqual(build, { version, platform: target.platform, arch: target.arch, revision }, "Desktop source or version mismatch");
    for (const path of ["result.json", "upgrade.json", "backup/result.json", "startup/result.json"]) {
      const report = JSON.parse(await readFile(join(evidence, path), "utf8"));
      assert.equal(report.passed, true, `${target.suffix}: ${path} did not pass`);
      if (path === "upgrade.json") assert.equal(report.from, version, "Wrong upgrade baseline");
    }
    const assets = join(root, "dist", "desktop");
    const update = yaml.load(await readFile(join(assets, target.metadata), "utf8"));
    assert.equal(update.version, version, "Updater metadata version mismatch");
    assert(Array.isArray(update.files) && update.files.length === target.types.length, "Unexpected updater files");
    const expected = target.types.map(type => `Dibao-${version}-${target.suffix}.${type}`);
    assert.deepEqual(update.files.map(file => file.url).sort(), [...expected].sort(), "Missing or foreign installer in updater metadata");
    for (const name of expected) {
      const path = join(assets, name);
      const size = (await stat(path)).size;
      assert(size > 0, "Empty installer");
      const checksums = await hashes(path);
      const file = update.files.find(file => file.url === name);
      assert.equal(file.size, size, "Installer size mismatch");
      assert.equal(file.sha512, checksums.sha512, "Installer checksum mismatch");
      await cp(path, join(output, name), { errorOnExist: true, force: false });
      artifacts.push({ name, size, ...checksums });
      const blockmap = `${name}.blockmap`;
      assert((await stat(join(assets, blockmap))).size > 0, "Missing installer blockmap");
      await cp(join(assets, blockmap), join(output, blockmap));
      artifacts.push({ name: blockmap, size: (await stat(join(output, blockmap))).size, ...await hashes(join(output, blockmap)) });
    }
    metadata.push(update);
  }
  const mac = { ...metadata[1], files: [...metadata[1].files, ...metadata[2].files] };
  for (const [name, value] of [["latest.yml", metadata[0]], ["latest-mac.yml", mac]]) {
    assert(value.files.every(file => basename(file.url) === file.url));
    await writeFile(join(output, name), yaml.dump(value));
    artifacts.push({ name, size: (await stat(join(output, name))).size, ...await hashes(join(output, name)) });
  }
  await writeFile(join(output, "SHA256SUMS.txt"), artifacts.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n");
  const manifest = { version, revision, unsignedDesktop: true, targets: desktopTargets.map(({ platform, arch }) => ({ platform, arch })), artifacts };
  await writeFile(join(output, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  const manifest = await collectDesktopAssets(process.argv[2], process.argv[3], { version, revision: process.env.EXPECTED_REVISION });
  console.log(JSON.stringify({ version, revision: manifest.revision, targets: manifest.targets, assets: manifest.artifacts.length }));
}
