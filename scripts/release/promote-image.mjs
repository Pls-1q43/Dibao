import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function assertImmutableTags(tags, digest, inspect, allowRepair = false) {
  for (const tag of tags) {
    if (!/:v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) continue;
    const existing = inspect(tag);
    assert(!existing || existing === digest || allowRepair,
      "Existing formal version points to another digest; explicit pipeline-repair authorization required");
  }
}

export function isMissingManifest(stderr, tag) {
  return String(stderr).includes(`${tag}: not found`) || /\bmanifest unknown\b/i.test(String(stderr));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let stage = "immutable_version_guard";
  try {
    const source = process.env.IMAGE;
    assert.match(source, /@sha256:[a-f0-9]{64}$/);
    const digest = source.split("@")[1];
    const tags = (process.env.TAGS ?? "").split(/\s+/).filter(Boolean);
    assert(tags.length > 0);
    const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
    const inspect = (tag) => {
      try { return JSON.parse(docker("buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}")).digest; }
      catch (error) {
        if (isMissingManifest(error.stderr, tag)) return null;
        throw new Error("Registry lookup failed; cannot establish whether the version is already published");
      }
    };
    assertImmutableTags(tags, digest, inspect, process.env.ALLOW_EXISTING_RELEASE_REPAIR === "true");
    stage = "promote_verified_manifest";
    docker("buildx", "imagetools", "create", ...tags.flatMap((tag) => ["--tag", tag]), source);
    stage = "verify_final_tag_digests";
    for (const tag of tags) assert.equal(inspect(tag), digest, "Final tag differs from verified image");
    console.log("All final tags resolve to the verified multiarch digest.");
  } catch {
    console.error(JSON.stringify({ promotionFailed: true, stage }));
    process.exitCode = 1;
  }
}
