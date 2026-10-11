import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const directory = process.argv[2];
const manifest = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"));
const tag = process.env.RELEASE_TAG;
assert.equal(tag, `v${manifest.version}`);
const revision = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
assert.equal(revision, manifest.revision, "Tag differs from the verified desktop source");
const notes = `docs/release-notes-${tag}.md`;
const text = await readFile(notes, "utf8");
for (const language of ["## 简体中文", "## 日本語", "## English"]) assert(text.includes(language), "Missing user-facing release notes language");
const files = (await readdir(directory)).map(name => join(directory, name));
for (const file of manifest.artifacts) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(directory, file.name))) hash.update(chunk);
  assert.equal(hash.digest("hex"), file.sha256, "Release asset changed after acceptance");
}
const api = `repos/{owner}/{repo}/releases/tags/${tag}`;
let existing;
try { existing = JSON.parse(execFileSync("gh", ["api", api], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
catch (error) { if (!String(error.stderr).includes("HTTP 404")) throw error; }
if (existing) assert.equal(existing.draft, true, "Never replace assets on an already published release");
// An incomplete asset upload remains private; only a complete draft becomes public.
if (existing) {
  execFileSync("gh", ["release", "upload", tag, ...files, "--clobber"], { stdio: "inherit" });
  execFileSync("gh", ["release", "edit", tag, "--title", `Dibao ${tag}`, "--notes-file", notes], { stdio: "inherit" });
} else execFileSync("gh", ["release", "create", tag, ...files, "--verify-tag", "--draft", "--title", `Dibao ${tag}`, "--notes-file", notes], { stdio: "inherit" });
const uploaded = JSON.parse(execFileSync("gh", ["api", api], { encoding: "utf8" }));
for (const file of manifest.artifacts) assert(uploaded.assets.some(asset => asset.name === file.name && asset.size === file.size), "Incomplete release upload");
for (const name of ["SHA256SUMS.txt", "release-manifest.json"]) assert(uploaded.assets.some(asset => asset.name === name), "Missing release integrity evidence");
execFileSync("gh", ["release", "edit", tag, "--draft=false", "--latest"], { stdio: "inherit" });
