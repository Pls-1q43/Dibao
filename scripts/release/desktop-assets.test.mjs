import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { collectDesktopAssets, desktopTargets } from "./desktop-assets.mjs";

const yaml = createRequire(import.meta.url)("js-yaml");
const identity = { version: "0.4.1", revision: "a".repeat(40) };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dibao-assets-"));
  for (const target of desktopTargets) {
    const base = join(root, "input", target.artifact);
    const evidence = join(base, "test-results", `desktop-${target.platform}-${target.arch}`);
    const assets = join(base, "dist", "desktop");
    await mkdir(assets, { recursive: true });
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "build.json"), JSON.stringify({ ...identity, platform: target.platform, arch: target.arch }));
    await writeFile(join(evidence, "previous-release.json"), JSON.stringify({ passed: true, from: "0.4.0", to: identity.version }));
    if (target.platform === "darwin") await writeFile(join(evidence, "signature.json"), JSON.stringify({ version: identity.version, arch: target.arch,
      passed: true, appSignatureValid: true, bundledNodeSignatureValid: true, nativeModulesSignatureValid: true, dmgCopyVerified: true, zipVerified: true, tamperedResourceRejected: true }));
    for (const name of ["result.json", "upgrade.json", "backup/result.json", "startup/result.json"]) {
      await mkdir(join(evidence, name, ".."), { recursive: true });
      await writeFile(join(evidence, name), JSON.stringify({ passed: true, from: identity.version }));
    }
    const files = [];
    for (const type of target.types) {
      const url = `Dibao-${identity.version}-${target.suffix}.${type}`;
      const data = Buffer.from(url);
      await writeFile(join(assets, url), data);
      await writeFile(join(assets, `${url}.blockmap`), "blockmap");
      files.push({ url, size: data.length, sha512: createHash("sha512").update(data).digest("base64") });
    }
    await writeFile(join(assets, target.metadata), yaml.dump({ version: identity.version, files, path: files[0].url, sha512: files[0].sha512 }));
  }
  return { root, input: join(root, "input"), output: join(root, "output") };
}

test("all native installers share one identity and both Mac architectures survive metadata merging", async () => {
  const f = await fixture();
  try {
    const manifest = await collectDesktopAssets(f.input, f.output, identity);
    assert.equal(manifest.targets.length, 3);
    const metadata = yaml.load(await readFile(join(f.output, "latest-mac.yml"), "utf8"));
    assert.equal(metadata.files.length, 4);
    assert(metadata.files.some(file => file.url.endsWith("mac-arm64.dmg")));
    assert(metadata.files.some(file => file.url.endsWith("mac-x64.dmg")));
    assert((await readFile(join(f.output, "SHA256SUMS.txt"), "utf8")).includes("win-x64.exe"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const scenario of ["missing-target", "foreign-revision", "failed-upgrade", "corrupt-installer", "invalid-signature", "missing-signature"]) {
  test(`release staging rejects ${scenario}`, async () => {
    const f = await fixture();
    try {
      const target = desktopTargets[2];
      const base = join(f.input, target.artifact);
      const evidence = join(base, "test-results", "desktop-darwin-arm64");
      if (scenario === "missing-target") await rm(base, { recursive: true });
      if (scenario === "foreign-revision") await writeFile(join(evidence, "build.json"), JSON.stringify({ ...identity, revision: "b".repeat(40), platform: "darwin", arch: "arm64" }));
      if (scenario === "failed-upgrade") await writeFile(join(evidence, "upgrade.json"), JSON.stringify({ passed: false, from: identity.version }));
      if (scenario === "corrupt-installer") await writeFile(join(base, "dist", "desktop", `Dibao-${identity.version}-mac-arm64.dmg`), "corrupted");
      if (scenario === "invalid-signature") await writeFile(join(evidence, "signature.json"), JSON.stringify({ version: identity.version, arch: "arm64", passed: false }));
      if (scenario === "missing-signature") await rm(join(evidence, "signature.json"));
      await assert.rejects(collectDesktopAssets(f.input, f.output, identity));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
