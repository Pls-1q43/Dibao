import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { DesktopDataProtection } from "./data-protection.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dibao-desktop-data-")); roots.push(root);
  const protection = new DesktopDataProtection(root);
  await protection.initialize();
  await mkdir(join(root, "data", "plugins", "secrets"), { recursive: true });
  await mkdir(join(root, "profile", "IndexedDB"), { recursive: true });
  await writeFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "persistent-key");
  await writeFile(join(root, "profile", "IndexedDB", "pending-actions"), "unsynced-actions");
  const db = new Database(join(root, "data", "dibao.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec("create table articles (id text, state text, embedding blob)");
  db.prepare("insert into articles values (?, ?, ?)").run("article-a", "saved", Buffer.from([1, 2, 3, 4]));
  db.close();
  return { root, protection };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("desktop data upgrades", () => {
  it("blocks backup failures before changing the data version", async () => {
    const { root, protection } = await fixture();
    await protection.prepare("0.4.1-beta.1"); await protection.complete("0.4.1-beta.1");
    await symlink(join(root, "data"), join(root, "data", "unexpected-link"), process.platform === "win32" ? "junction" : "dir");
    await expect(protection.prepare("0.4.1-beta.2")).rejects.toThrow("symbolic link");
    expect((await protection.readState())?.highestVersion).toBe("0.4.1-beta.1");
  });
  it("resumes an unfinished fresh installation without requiring a nonexistent backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "dibao-desktop-fresh-")); roots.push(root);
    const protection = new DesktopDataProtection(root);
    await protection.prepare("0.4.1-beta.1");
    expect((await protection.prepare("0.4.1-beta.1")).pending?.backupId).toBeNull();
  });
  it("retains three successful upgrade backups without deleting recovery snapshots", async () => {
    const { protection } = await fixture();
    await protection.backup("0.4.0", "recovery");
    for (let n = 1; n <= 5; n++) {
      await protection.prepare(`0.4.1-beta.${n}`); await protection.complete(`0.4.1-beta.${n}`);
    }
    const backups = await protection.listBackups();
    expect(backups.filter(b => b.reason === "upgrade")).toHaveLength(3);
    expect(backups.filter(b => b.reason === "recovery")).toHaveLength(1);
  });
  it("defers confirmed recovery until the next startup", async () => {
    const { root, protection } = await fixture();
    const backup = await protection.backup("0.4.0", "upgrade");
    await writeFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "current-key");
    await protection.requestRestore(backup.id);
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("current-key");
    await protection.restoreRequested();
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
  });
  it("finishes an interrupted restore after a directory has already been moved", async () => {
    const { root, protection } = await fixture();
    const backup = await protection.backup("0.4.0", "upgrade");
    const stage = "restore-abcdef12";
    await cp(join(root, "backups", backup.id), join(root, stage), { recursive: true });
    await writeFile(join(root, "restore.json"), JSON.stringify({ stage, version: backup.version }));
    await rename(join(root, "data"), join(root, stage, "old-data"));
    await new DesktopDataProtection(root).initialize();
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
    expect((await protection.readState())?.highestVersion).toBe("0.4.0");
  });
  it("preserves committed SQLite WAL data after an interrupted process", async () => {
    const { root, protection } = await fixture();
    const databasePath = join(root, "data", "dibao.sqlite");
    const child = spawnSync(process.execPath, ["-e", 'const Database=require("better-sqlite3"); const db=new Database(process.argv[1]); db.pragma("journal_mode=WAL"); db.pragma("wal_autocheckpoint=0"); db.prepare("insert into articles values (?,?,?)").run("wal-article","read",Buffer.from([5,6])); process.kill(process.pid,"SIGKILL");', databasePath], { cwd: process.cwd() });
    expect(child.error).toBeUndefined();
    const backup = await protection.backup("0.4.1-beta.1", "upgrade");
    expect(backup.files.some(file => file.path.endsWith("dibao.sqlite-wal"))).toBe(true);
    await protection.restore(backup.id);
    const db = new Database(databasePath); expect(db.prepare("select state,embedding from articles where id=?").get("wal-article")).toEqual({ state: "read", embedding: Buffer.from([5, 6]) }); db.close();
  });
  it("restores articles, vectors, plugin keys and pending client actions together", async () => {
    const { root, protection } = await fixture();
    await protection.prepare("0.4.1-beta.1"); await protection.complete("0.4.1-beta.1");
    const state = await protection.prepare("0.4.1-beta.2");
    await writeFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "wrong-key");
    const db = new Database(join(root, "data", "dibao.sqlite")); db.exec("delete from articles"); db.close();
    await protection.restore(state.pending!.backupId!);
    const restored = new Database(join(root, "data", "dibao.sqlite"));
    expect(restored.prepare("select * from articles").get()).toEqual({ id: "article-a", state: "saved", embedding: Buffer.from([1, 2, 3, 4]) }); restored.close();
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
    expect(await readFile(join(root, "profile", "IndexedDB", "pending-actions"), "utf8")).toBe("unsynced-actions");
    expect((await protection.listBackups()).some(b => b.reason === "recovery")).toBe(true);
  });
  it("blocks insufficient-space upgrades without touching the data or version marker", async () => {
    const { root } = await fixture();
    const protection = new DesktopDataProtection(root, async () => 0);
    await expect(protection.prepare("0.4.1-beta.1")).rejects.toThrow("free space");
    expect(await protection.readState()).toBeNull();
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
  });
  it("blocks unfinished upgrades and prevents older applications opening newer data", async () => {
    const { protection } = await fixture();
    await protection.prepare("0.4.1-beta.2");
    await expect(protection.prepare("0.4.1-beta.2")).rejects.toThrow("did not finish");
    await expect(protection.prepare("0.4.1-beta.1", true)).rejects.toThrow("newer version");
    await protection.prepare("0.4.1-beta.2", true);
    await protection.complete("0.4.1-beta.2");
    expect((await protection.readState())?.pending).toBeNull();
  });
  it("rejects corrupted backups before replacing current data", async () => {
    const { root, protection } = await fixture();
    const backup = await protection.backup("0.4.1-beta.1", "upgrade");
    await writeFile(join(root, "backups", backup.id, "data", "dibao.sqlite"), "corrupt");
    await expect(protection.restore(backup.id)).rejects.toThrow("verification failed");
    const db = new Database(join(root, "data", "dibao.sqlite")); expect(db.prepare("select count(*) as n from articles").get()).toEqual({ n: 1 }); db.close();
  });
  it("keeps plugin directories named Cache while omitting regenerable browser caches", async () => {
    const { root, protection } = await fixture();
    await mkdir(join(root, "data", "plugins", "Cache"), { recursive: true });
    await writeFile(join(root, "data", "plugins", "Cache", "important"), "keep");
    await mkdir(join(root, "profile", "Cache")); await writeFile(join(root, "profile", "Cache", "item"), "discard");
    const backup = await protection.backup("0.4.1-beta.1", "upgrade");
    expect(backup.files.some(file => file.path.replaceAll("\\", "/") === "data/plugins/Cache/important")).toBe(true);
    expect(backup.files.some(file => file.path.includes("profile/Cache"))).toBe(false);
  });
});
