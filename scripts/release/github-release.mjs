import assert from "node:assert/strict";

export function findReleaseByTag(tag, ghJson) {
  const releases = "repos/{owner}/{repo}/releases";
  try {
    return ghJson(["api", `${releases}/tags/${tag}`]);
  } catch (error) {
    if (!String(error.stderr).includes("HTTP 404")) throw error;
  }
  // The tag endpoint excludes drafts. Authenticated release listings include them.
  const pages = ghJson(["api", "--paginate", "--slurp", `${releases}?per_page=100`]);
  assert(Array.isArray(pages) && pages.every(Array.isArray), "Invalid release listing");
  const matches = pages.flat().filter(release => release.tag_name === tag);
  assert(matches.length <= 1, "Multiple releases share this tag; refusing ambiguous publication");
  return matches[0];
}

export function assertUploadedRelease(release, expected) {
  assert(release?.draft === true, "Only a draft may be finalized");
  assert.equal(release.assets.length, expected.length, "Unexpected release asset count");
  for (const file of expected) {
    const asset = release.assets.find(asset => asset.name === file.name);
    assert(asset && asset.state === "uploaded" && asset.size === file.size
      && asset.digest === `sha256:${file.sha256}`, `Incomplete or altered release asset: ${file.name}`);
  }
}
