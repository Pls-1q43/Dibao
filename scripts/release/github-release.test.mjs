import test from "node:test";
import assert from "node:assert/strict";
import { findReleaseByTag, assertUploadedRelease } from "./github-release.mjs";

const tag = "v0.4.1";
const notFound = Object.assign(new Error("not found"), { stderr: "gh: Not Found (HTTP 404)" });

test("published release uses the tag endpoint", () => {
  const release = { id: 1, tag_name: tag, draft: false };
  assert.equal(findReleaseByTag(tag, args => {
    assert.equal(args[1], `repos/{owner}/{repo}/releases/tags/${tag}`);
    return release;
  }), release);
});

test("draft lookup falls back to the paginated authenticated listing", () => {
  const release = { id: 2, tag_name: tag, draft: true };
  assert.equal(findReleaseByTag(tag, args => {
    if (args[1].includes("/tags/")) throw notFound;
    assert.deepEqual(args, ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases?per_page=100"]);
    return [[{ tag_name: "v0.4.0" }], [release]];
  }), release);
});

test("only a genuinely missing release allows creation", () => {
  assert.equal(findReleaseByTag(tag, args => {
    if (args[1].includes("/tags/")) throw notFound;
    return [[]];
  }), undefined);
  const denied = Object.assign(new Error("denied"), { stderr: "HTTP 403" });
  assert.throws(() => findReleaseByTag(tag, () => { throw denied; }), /denied/);
});

test("ambiguous drafts cannot be published", () => {
  assert.throws(() => findReleaseByTag(tag, args => {
    if (args[1].includes("/tags/")) throw notFound;
    return [[{ tag_name: tag }, { tag_name: tag }]];
  }), /Multiple releases/);
});

const expected = [{ name: "installer.exe", size: 42, sha256: "a".repeat(64) }];
const complete = { draft: true, assets: [{ name: "installer.exe", size: 42, digest: `sha256:${"a".repeat(64)}`, state: "uploaded" }] };
test("a complete draft passes content digest verification", () => {
  assert.doesNotThrow(() => assertUploadedRelease(complete, expected));
});
for (const scenario of ["public", "missing", "extra", "size", "digest", "partial"]) {
  test(`publication rejects ${scenario} assets`, () => {
    const release = structuredClone(complete);
    if (scenario === "public") release.draft = false;
    if (scenario === "missing") release.assets = [];
    if (scenario === "extra") release.assets.push({ name: "foreign.exe" });
    if (scenario === "size") release.assets[0].size++;
    if (scenario === "digest") release.assets[0].digest = `sha256:${"b".repeat(64)}`;
    if (scenario === "partial") release.assets[0].state = "starter";
    assert.throws(() => assertUploadedRelease(release, expected));
  });
}
