import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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
  it("does not mistake bootstrap browser preferences for an existing database", async () => {
    const root = await mkdtemp(join(tmpdir(), "dibao-desktop-bootstrap-")); roots.push(root);
    const protection = new DesktopDataProtection(root);
    await mkdir(protection.paths.profile, { recursive: true });
    await writeFile(join(protection.paths.profile, "Preferences"), "bootstrap-preferences");
    expect((await protection.prepare("0.4.1")).pending?.backupId).toBeNull();
    expect(await protection.listBackups()).toEqual([]);
    expect(await readFile(join(protection.paths.profile, "Preferences"), "utf8")).toBe("bootstrap-preferences");
  });
  it.each(["missing", "empty"])("blocks a %s existing database instead of silently recreating it", async kind => {
    const { root, protection } = await fixture();
    await protection.prepare("0.4.1"); await protection.complete("0.4.1");
    const before = await protection.readState();
    if (kind === "missing") await rm(join(root, "data", "dibao.sqlite"));
    else await writeFile(join(root, "data", "dibao.sqlite"), "");
    await expect(protection.prepare("0.4.1")).rejects.toThrow("existing database");
    await expect(protection.prepare("0.4.2")).rejects.toThrow("existing database");
    expect(await protection.readState()).toEqual(before);
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
  });
  it.each(["missing", "empty"])("recovers a %s database while separately preserving incomplete current data", async kind => {
    const { root, protection } = await fixture();
    await protection.prepare("0.4.1"); await protection.complete("0.4.1");
    const saved = await protection.backup("0.4.1", "manual");
    await writeFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "current-key");
    if (kind === "missing") await rm(join(root, "data", "dibao.sqlite"));
    else await writeFile(join(root, "data", "dibao.sqlite"), "");
    await protection.restore(saved.id);
    await expect(protection.prepare("0.4.1")).resolves.toMatchObject({ successfulVersion: "0.4.1" });
    const quarantine = (await readdir(protection.paths.backups)).find(name => name.endsWith(".incomplete"))!;
    expect(quarantine).toBeTruthy();
    expect(await readFile(join(protection.paths.backups, quarantine, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("current-key");
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
    expect((await protection.listBackups()).every(backup => backup.files.some(entry => entry.path.replaceAll("\\", "/") === "data/dibao.sqlite" && entry.size > 0))).toBe(true);
    const db = new Database(join(root, "data", "dibao.sqlite"));
    expect(db.prepare("select count(*) as n from articles").get()).toEqual({ n: 1 }); db.close();
  });
  it("retains three successful upgrade backups without deleting recovery snapshots", async () => {
    const { protection } = await fixture();
    await protection.backup("0.4.0", "recovery");
    await protection.backup("0.4.0", "manual");
    for (let n = 1; n <= 5; n++) {
      await protection.prepare(`0.4.1-beta.${n}`); await protection.complete(`0.4.1-beta.${n}`);
    }
    const backups = await protection.listBackups();
    expect(backups.filter(b => b.reason === "upgrade")).toHaveLength(3);
    expect(backups.filter(b => b.reason === "recovery")).toHaveLength(1);
    expect(backups.filter(b => b.reason === "manual")).toHaveLength(1);
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
  it("backs up all data and client state on cold manual startup without changing version markers", async () => {
    const { root, protection } = await fixture();
    const version = "0.4.1-beta.2";
    await protection.prepare(version); await protection.complete(version);
    const before = await protection.readState();
    await protection.requestBackup(version);
    await new DesktopDataProtection(root).backupRequested();
    const backup = (await protection.listBackups()).find(item => item.reason === "manual")!;
    expect(backup.files.map(file => file.path.replaceAll("\\", "/"))).toEqual(expect.arrayContaining([
      "data/dibao.sqlite", "data/plugins/secrets/plugin-secret.key", "profile/IndexedDB/pending-actions"
    ]));
    expect(await protection.readState()).toEqual(before);
    await protection.restore(backup.id);
    const db = new Database(join(root, "data", "dibao.sqlite"));
    expect(db.prepare("select * from articles").get()).toEqual({ id: "article-a", state: "saved", embedding: Buffer.from([1, 2, 3, 4]) }); db.close();
    expect(await readFile(join(root, "profile", "IndexedDB", "pending-actions"), "utf8")).toBe("unsynced-actions");
  });
  it("records manual backup failure visibly and still permits opening unchanged current data", async () => {
    const { root, protection } = await fixture();
    const version = "0.4.1-beta.2";
    await protection.prepare(version); await protection.complete(version); await protection.requestBackup(version);
    const noSpace = new DesktopDataProtection(root, async () => 0);
    await noSpace.backupRequested();
    expect(await protection.lastOperation()).toMatchObject({ action: "backup", status: "error", error: "space" });
    expect((await noSpace.prepare(version)).pending).toBeNull();
    expect((await protection.listBackups()).some(item => item.reason === "manual")).toBe(false);
    await expect(readFile(join(root, "backup-request.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
  });
  it("listing backups never resumes a pending restore while the application is running", async () => {
    const { root, protection } = await fixture();
    const backup = await protection.backup("0.4.0", "manual");
    await cp(join(root, "backups", backup.id), join(root, "restore-abcdef12"), { recursive: true });
    await writeFile(join(root, "restore.json"), JSON.stringify({ stage: "restore-abcdef12", version: backup.version }));
    await writeFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "current-key");
    await protection.listBackups();
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("current-key");
  });
  it("keeps a damaged manifest from blocking healthy data or other restore points", async () => {
    const { root, protection } = await fixture();
    const broken = await protection.backup("0.4.0", "manual");
    const good = await protection.backup("0.4.0", "manual");
    await writeFile(join(root, "backups", broken.id, "manifest.json"), "{broken");
    expect((await protection.listBackups()).map(item => item.id)).toContain(good.id);
    await expect(protection.verifyBackup(broken.id)).rejects.toThrow();
    await protection.prepare("0.4.1"); await protection.complete("0.4.1");
    expect((await protection.readState())?.successfulVersion).toBe("0.4.1");
  });
  it.each(["empty", "traversal", "duplicate"])("rejects %s manifests without replacing data", async kind => {
    const { root, protection } = await fixture();
    const backup = await protection.backup("0.4.0", "manual");
    if (kind === "empty") backup.files = [];
    if (kind === "traversal") backup.files[0].path = "data/../profile/invalid";
    if (kind === "duplicate") backup.files.push({ ...backup.files[0] });
    await writeFile(join(root, "backups", backup.id, "manifest.json"), JSON.stringify(backup));
    await expect(protection.restore(backup.id)).rejects.toThrow("Invalid backup");
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
  });
  it("verifies a damaged interrupted restore before moving live data", async () => {
    const { root, protection } = await fixture();
    const backup = await protection.backup("0.4.0", "manual");
    const stage = "restore-abcdef12";
    await cp(join(root, "backups", backup.id), join(root, stage), { recursive: true });
    await writeFile(join(root, stage, "profile", "IndexedDB", "pending-actions"), "corrupt-stage");
    await writeFile(join(root, "restore.json"), JSON.stringify({ stage, version: backup.version }));
    await expect(new DesktopDataProtection(root).initialize()).rejects.toThrow("verification failed");
    expect(await readFile(join(root, "data", "plugins", "secrets", "plugin-secret.key"), "utf8")).toBe("persistent-key");
    await expect(readFile(join(root, stage, "old-data", "dibao.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
