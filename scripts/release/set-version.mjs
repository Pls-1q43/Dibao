import { readFile, writeFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";

const version = process.argv[2];
assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "Provide a stable release version");
const root = JSON.parse(await readFile("package.json", "utf8"));
const paths = ["package.json"];
for (const pattern of root.workspaces) {
  assert.match(pattern, /^[a-z]+\/\*$/);
  const group = pattern.slice(0, -2);
  for (const item of await readdir(group, { withFileTypes: true })) if (item.isDirectory()) paths.push(`${group}/${item.name}/package.json`);
}
const packages = await Promise.all(paths.map(async path => ({ path, pkg: JSON.parse(await readFile(path, "utf8")) })));
const names = new Set(packages.map(({ pkg }) => pkg.name));
for (const { path, pkg } of packages) {
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) if (names.has(name)) pkg[field][name] = version;
  }
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
console.log(`Updated ${packages.length} packages to ${version}. Regenerate the lockfile before tagging.`);
