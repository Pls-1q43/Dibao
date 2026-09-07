// CI: IMAGE=<registry/name>@sha256:... EXPECTED_VERSION=... EXPECTED_REVISION=... node scripts/release/verify-docker-release.mjs
// Reuses the local review-image validator's isolated, network-disabled image flow.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

let context = { stage: "initialize", platform: "registry", fixture: "none" };
function stage(name, platform = context.platform, fixture = context.fixture) {
  context = { stage: name, platform, fixture };
  console.log(JSON.stringify(context));
}

// Only forward our own allowlisted probe marker, never raw stderr/SDK errors.
export function safeProbeFailure(stderr) {
  for (const line of String(stderr ?? "").split("\n")) {
    try {
      const marker = JSON.parse(line);
      if (marker.releaseProbeFailed === true && typeof marker.stage === "string" && /^[a-z_]{1,80}$/.test(marker.stage)) return marker.stage;
    } catch { /* Non-marker output may contain private configuration. */ }
  }
  return "probe_process_or_output";
}

export function platformImages(manifest, image) {
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.digest, image.split("@")[1], "Registry manifest digest mismatch");
  return ["amd64", "arm64"].map((arch) => {
    const found = manifest.manifests?.filter((m) => m.platform?.os === "linux" && m.platform?.architecture === arch);
    assert.equal(found?.length, 1, `Missing or ambiguous linux/${arch} manifest`);
    assert.match(found[0].digest, /^sha256:[a-f0-9]{64}$/);
    return { arch, platform: `linux/${arch}`, image: `${image.split("@")[0]}@${found[0].digest}` };
  });
}

export async function verifyRelease({ image, version, revision }) {
  const docker = (...args) => execFileSync(process.env.DOCKER ?? "docker", args,
    { encoding: "utf8", maxBuffer: 5e6, timeout: 300_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  const probe = readFileSync(fileURLToPath(new URL("./image-probe.mjs", import.meta.url)), "utf8");
  const node = (args, mode) => {
    try { return JSON.parse(execFileSync(process.env.DOCKER ?? "docker", [...args, "--input-type=module", "-", mode],
      { input: probe, encoding: "utf8", maxBuffer: 5e6, timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] })); }
    catch (error) {
      if (mode !== "status") console.error(JSON.stringify({ ...context, probeStage: safeProbeFailure(error.stderr), failed: true }));
      throw new Error("Image probe failed");
    }
  };
  stage("resolve_published_manifest");
  const manifest = JSON.parse(docker("buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"));
  const platforms = platformImages(manifest, image);
  const report = { image, version, revision, platforms: [], cases: [] };
  const repository = image.split("@")[0];
  // Historical images seed with their own shipped migrations on amd64. The
  // same portable SQLite fixture must upgrade on BOTH target architectures.
  const previous = ["v0.3.1", "v0.1.0", "v0.1.3"];
  const historical = new Map();
  for (const tag of previous) {
    stage("pull_historical_image", "linux/amd64", tag);
    const ref = `${repository}:${tag}`;
    docker("pull", "--platform", "linux/amd64", ref);
    const inspected = JSON.parse(docker("image", "inspect", ref))[0];
    historical.set(tag, inspected.Id);
  }
  for (const target of platforms) {
    stage("pull_exact_platform_digest", target.platform, "none");
    docker("pull", "--platform", target.platform, target.image);
    const labels = JSON.parse(docker("image", "inspect", target.image))[0].Config.Labels;
    stage("verify_image_revision_and_sentry", target.platform, "none");
    assert.equal(labels["org.opencontainers.image.revision"], revision, "Published image source revision mismatch");
    const assets = node(["run", "--rm", "-i", "--network", "none", "--platform", target.platform,
      "-e", `EXPECTED_VERSION=${version}`, "-e", `EXPECTED_ARCH=${target.arch}`, "--entrypoint", "node", target.image], "assets");
    report.platforms.push({ ...target, ...assets });
    for (const fixture of [
      { previous: null }, ...previous.map((tag) => ({ previous: tag })),
      { previous: "v0.3.1", noWorker: "background" },
      { previous: "v0.3.1", noWorker: "container" }
    ]) {
      const name = `dibao-release-${randomUUID()}`;
      const volume = `${name}-data`;
      let created = false;
      let before = { count: 0, digest: createHash("sha256").digest("hex") };
      try {
        stage("create_isolated_fixture", target.platform, `${fixture.previous ?? "fresh"}:${fixture.noWorker ?? "worker"}`);
        docker("volume", "create", volume);
        if (fixture.previous) {
          stage("seed_historical_image");
          before = node(["run", "--rm", "-i", "--network", "none", "--platform", "linux/amd64",
            "-v", `${volume}:/data`, "-e", `EXPECTED_VERSION=${fixture.previous.slice(1)}`, "--entrypoint", "node", historical.get(fixture.previous)], "seed");
          assert.equal(before.count, 65);
        }
        stage("start_upgrade_container");
        docker("run", "-d", "--name", name, "--network", "none", "--platform", target.platform,
          "-v", `${volume}:/data`, "-e", `EXPECTED_VERSION=${version}`, "-e", `SEEDED=${Boolean(fixture.previous)}`,
          "-e", "DIBAO_TELEMETRY_ENABLED=false", "-e", "DIBAO_FEED_REFRESH_INTERVAL_MS=0",
          "-e", "DIBAO_PROFILE_DECAY_INTERVAL_MS=0", "-e", "DIBAO_RETENTION_CLEANUP_INTERVAL_MS=0",
          ...(fixture.noWorker === "background" ? ["-e", "DIBAO_BACKGROUND_JOBS=false"] : []),
          ...(fixture.noWorker === "container" ? ["-e", "DIBAO_CONTAINER_WORKER_PROCESS=false"] : []), target.image);
        created = true;
        const deadline = Date.now() + 600_000;
        stage("wait_for_derived_upgrade_completion");
        let terminal = false;
        while (Date.now() < deadline) {
          assert.equal(docker("inspect", "--format", "{{.State.Running}}", name), "true", "Release container exited during upgrade");
          let state;
          try { state = node(["exec", "-i", name, "node"], "status"); } catch { /* Core migration can precede the status table. */ }
          assert.notEqual(state?.state, "failed", "Derived upgrade failed");
          if (state?.blocking === false && state.state === (fixture.previous ? "completed" : "not_required")) { terminal = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        assert(terminal, "Derived upgrade did not reach the required terminal state");
        stage("verify_migrations_ranks_vectors_and_http");
        const result = node(["exec", "-i", name, "node"], "verify");
        stage("compare_embedding_bytes_and_metadata");
        assert.deepEqual(result.embeddings, before, "Stored embedding bytes or metadata changed");
        const entry = { platform: target.platform, previous: fixture.previous ?? "fresh", noWorker: fixture.noWorker ?? false, ...result };
        report.cases.push(entry);
        console.log(JSON.stringify(entry));
      } finally {
        if (created) docker("rm", "-f", name);
        docker("volume", "rm", volume);
      }
    }
  }
  console.log(JSON.stringify({ verifiedImage: image, platforms: report.platforms, casesPassed: report.cases.length }));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\nVerified image: \`${image}\`\n\nBoth architectures passed runtime/browser Sentry, version and ${report.cases.length} isolated install/upgrade cases. Stored embedding bytes, hashes and timestamps preserved.\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert(process.env.EXPECTED_VERSION && /^[a-f0-9]{40}$/.test(process.env.EXPECTED_REVISION ?? ""));
    await verifyRelease({ image: process.env.IMAGE, version: process.env.EXPECTED_VERSION, revision: process.env.EXPECTED_REVISION });
  } catch {
    console.error(JSON.stringify({ ...context, releaseGateFailed: true, promotionPermitted: false }));
    process.exitCode = 1;
  }
}
