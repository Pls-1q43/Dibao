import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const version = "0.75.0";
const platform = process.platform === "darwin" ? "macOS" : "Linux";
const arch = process.arch === "arm64" ? "ARM64" : "64bit";
const name = `trivy_${version}_${platform}-${arch}.tar.gz`;
const directory = resolve(".tmp", "release-trivy");
await mkdir(directory, { recursive: true });
const base = `https://github.com/aquasecurity/trivy/releases/download/v${version}`;
for (const file of [name, `trivy_${version}_checksums.txt`]) {
  execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--max-time", "600", "-o", join(directory, file), `${base}/${file}`], { stdio: "inherit" });
}
const expected = (await readFile(join(directory, `trivy_${version}_checksums.txt`), "utf8"))
  .split("\n").map(line => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
assert(expected && createHash("sha256").update(await readFile(join(directory, name))).digest("hex") === expected, "Trivy checksum mismatch");
execFileSync("tar", ["-xzf", join(directory, name), "-C", directory, "trivy"]);
await mkdir("test-results", { recursive: true });
const image = process.env.IMAGE;
assert(image, "IMAGE is required");
for (const target of (process.env.SCAN_PLATFORMS ?? "linux/amd64,linux/arm64").split(",")) {
  assert(["linux/amd64", "linux/arm64"].includes(target));
  const output = `test-results/image-security-${target.slice(6)}.json`;
  execFileSync(join(directory, "trivy"), ["image", "--scanners", "vuln", "--platform", target,
    "--format", "json", "--output", output, "--timeout", "15m", image], { stdio: "inherit" });
  const report = JSON.parse(await readFile(output, "utf8"));
  const issues = (report.Results ?? []).flatMap(result => (result.Vulnerabilities ?? []).map(issue => ({ target: result.Target, ...issue })));
  const serious = issues.filter(issue => ["HIGH", "CRITICAL"].includes(issue.Severity));
  const fixable = serious.filter(issue => issue.FixedVersion);
  console.log(JSON.stringify({ platform: target, highCritical: serious.length, fixable: fixable.length,
    unresolved: serious.map(issue => ({ id: issue.VulnerabilityID, package: issue.PkgName, installed: issue.InstalledVersion, fixed: issue.FixedVersion ?? null })) }));
  assert.equal(fixable.length, 0, "Release image has fixable high/critical vulnerabilities");
}
