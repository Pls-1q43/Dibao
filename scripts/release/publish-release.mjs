import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { findReleaseByTag, assertUploadedRelease } from "./github-release.mjs";

const directory = process.argv[2];
const manifest = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"));
const tag = process.env.RELEASE_TAG;
assert.equal(tag, `v${manifest.version}`);
const revision = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
assert.equal(revision, manifest.revision, "Tag differs from the verified desktop source");
const notes = `docs/release-notes-${tag}.md`;
const text = await readFile(notes, "utf8");
for (const language of ["## 简体中文", "## 日本語", "## English"]) assert(text.includes(language), "Missing user-facing release notes language");
const names = await readdir(directory);
const files = names.map(name => join(directory, name));
const expected = [];
for (const name of names) {
  const path = join(directory, name);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  expected.push({ name, size: (await stat(path)).size, sha256: hash.digest("hex") });
}
for (const file of manifest.artifacts) {
  const actual = expected.find(asset => asset.name === file.name);
  assert(actual && actual.sha256 === file.sha256 && actual.size === file.size, "Release asset changed after acceptance");
}
const ghJson = args => JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const existing = findReleaseByTag(tag, ghJson);
if (existing) assert.equal(existing.draft, true, "Never replace assets on an already published release");
// An incomplete asset upload remains private; only a complete draft becomes public.
if (existing) {
  const pending = expected.filter(file => !existing.assets.some(asset => asset.name === file.name
    && asset.state === "uploaded" && asset.size === file.size && asset.digest === `sha256:${file.sha256}`));
  if (pending.length) execFileSync("gh", ["release", "upload", tag, ...pending.map(file => join(directory, file.name)), "--clobber"], { stdio: "inherit" });
  execFileSync("gh", ["release", "edit", tag, "--title", `Dibao ${tag}`, "--notes-file", notes], { stdio: "inherit" });
} else execFileSync("gh", ["release", "create", tag, ...files, "--verify-tag", "--draft", "--title", `Dibao ${tag}`, "--notes-file", notes], { stdio: "inherit" });
const uploaded = findReleaseByTag(tag, ghJson);
assertUploadedRelease(uploaded, expected);
execFileSync("gh", ["release", "edit", tag, "--draft=false", "--latest"], { stdio: "inherit" });
