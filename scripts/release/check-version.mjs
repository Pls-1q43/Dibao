import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function checkVersion(root, { tag = "", moving = false } = {}) {
  const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const pkg = json("package.json");
  const version = pkg.version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Invalid release version");
  const lock = json("package-lock.json");
  assert.equal(lock.version, version, "Root lockfile version drift");
  assert.equal(lock.packages[""].version, version, "Root lockfile package version drift");
  const packages = pkg.workspaces.flatMap((pattern) => {
    assert.match(pattern, /^[a-z]+\/\*$/, "Unsupported workspace pattern");
    const dir = pattern.slice(0, -2);
    return readdirSync(resolve(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => `${dir}/${entry.name}`);
  }).map((path) => ({ path, pkg: json(`${path}/package.json`) }));
  const names = new Set(packages.map(({ pkg }) => pkg.name));
  for (const { path, pkg } of packages) {
    assert.equal(pkg.version, version, `${path} version drift`);
    assert.equal(lock.packages[path]?.version, version, `${path} lockfile version drift`);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, dependency] of Object.entries(pkg[field] ?? {})) {
        if (!names.has(name)) continue;
        assert.equal(dependency, version, `${path} internal dependency drift: ${name}`);
        assert.equal(lock.packages[path]?.[field]?.[name], dependency, `${path} lockfile dependency drift: ${name}`);
      }
    }
  }
  const source = ts.createSourceFile("index.ts", readFileSync(resolve(root, "packages/shared/src/index.ts"), "utf8"), ts.ScriptTarget.Latest);
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((item) => ts.isIdentifier(item.name) && item.name.text === "dibaoVersion");
  assert(declaration?.initializer && ts.isStringLiteral(declaration.initializer), "Missing literal dibaoVersion");
  assert.equal(declaration.initializer.text, version, "Runtime version drift");
  if (tag) {
    assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, "Invalid image tag");
    assert(!["stable", "latest"].includes(tag), "Moving aliases must use the explicit promotion option");
    if (/^v\d+\.\d+\.\d+/.test(tag)) assert.equal(tag, `v${version}`, "Release tag differs from source version");
  }
  if (moving) {
    assert.equal(tag, `v${version}`, "Moving aliases require the matching formal version tag");
    assert(!version.includes("-"), "Prereleases cannot move stable/latest");
  }
  return version;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = checkVersion(process.cwd(), { tag: process.env.RELEASE_IMAGE_TAG, moving: process.env.RELEASE_MOVING_ALIASES === "true" });
  console.log(`Release version consistency passed: ${version}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
