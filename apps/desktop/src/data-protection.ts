import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, open, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import semver from "semver";
import { desktopPaths } from "./paths.js";

type Entry = { path: string; size: number; sha256: string };
export type BackupManifest = {
  format: 1;
  id: string;
  version: string;
  createdAt: string;
  reason: "upgrade" | "recovery";
  files: Entry[];
};
export type DesktopDataState = {
  format: 1;
  highestVersion: string;
  successfulVersion: string | null;
  pending: { version: string; backupId: string | null } | null;
};

const transient = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile", "LOCK", "DevToolsActivePort"]);
const cacheDirectories = new Set(["Cache", "Code Cache", "GPUCache", "GPUPersistentCache", "GraphiteDawnCache", "Crashpad", "DawnGraphiteCache", "DawnWebGPUCache"]);

async function entries(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (root.endsWith("profile") && (transient.has(entry.name) || cacheDirectories.has(entry.name))) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic link: ${relative(root, path)}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  try { await walk(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return result.sort();
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export class DesktopDataProtection {
  readonly paths;
  constructor(root: string, private readonly availableBytes?: () => Promise<number>) {
    this.paths = desktopPaths(root);
  }

  async initialize() {
    for (const dir of [this.paths.root, this.paths.backups, this.paths.logs]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(dir, 0o700);
    }
    await this.resumeRestore();
    await mkdir(this.paths.data, { recursive: true, mode: 0o700 });
  }

  async readState(): Promise<DesktopDataState | null> {
    try {
      const state = JSON.parse(await readFile(this.paths.state, "utf8")) as DesktopDataState;
      if (state.format !== 1 || !semver.valid(state.highestVersion) ||
          (state.successfulVersion !== null && !semver.valid(state.successfulVersion)) ||
          (state.pending !== null && (!state.pending || !semver.valid(state.pending.version) ||
            (state.pending.backupId !== null && !/^[a-z0-9-]+$/.test(state.pending.backupId))))) throw new Error("Invalid desktop data state");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async prepare(version: string, retry = false): Promise<DesktopDataState> {
    if (!semver.valid(version)) throw new Error("Invalid application version");
    await this.initialize();
    const old = await this.readState();
    if (old && semver.lt(version, old.highestVersion)) throw new Error("This data was opened by a newer version. Restore its pre-upgrade backup before downgrading.");
    if (old?.pending) {
      if (old.pending.backupId === null && old.successfulVersion === null && old.pending.version === version) return old;
      if (!retry || old.pending.version !== version) throw new Error("The previous upgrade did not finish. Retry or restore a backup.");
      return old;
    }
    if (old?.successfulVersion === version) return old;
    const hasData = (await entries(this.paths.data)).length > 0 || (await entries(this.paths.profile)).length > 0;
    const backup = hasData ? await this.backup(old?.successfulVersion ?? version, "upgrade") : null;
    const state: DesktopDataState = {
      format: 1,
      highestVersion: version,
      successfulVersion: old?.successfulVersion ?? null,
      pending: { version, backupId: backup?.id ?? null }
    };
    await writeJson(this.paths.state, state);
    return state;
  }

  async backup(version: string, reason: BackupManifest["reason"]): Promise<BackupManifest> {
    await this.initialize();
    const sourceFiles = [...await entries(this.paths.data), ...await entries(this.paths.profile)];
    await this.checkBackupSpace();
    const id = `${Date.now()}-${randomUUID()}`;
    const staging = join(this.paths.backups, `${id}.partial`);
    await mkdir(staging, { mode: 0o700 });
    const manifest: BackupManifest = { format: 1, id, version, createdAt: new Date().toISOString(), reason, files: [] };
    try {
      for (const source of sourceFiles) {
        const path = relative(this.paths.root, source);
        const destination = join(staging, path);
        await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
        await cp(source, destination, { errorOnExist: true, force: false });
        await chmod(destination, 0o600);
        const saved = await open(destination, "r+");
        try { await saved.sync(); } finally { await saved.close(); }
        const sourceHash = await digest(source);
        if (sourceHash !== await digest(destination)) throw new Error("Data changed during backup");
        manifest.files.push({ path, size: (await stat(destination)).size, sha256: sourceHash });
      }
      await writeJson(join(staging, "manifest.json"), manifest);
      await rename(staging, join(this.paths.backups, id));
      return manifest;
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }

  async checkBackupSpace(headroom = 64 * 1024 * 1024) {
    const sourceFiles = [...await entries(this.paths.data), ...await entries(this.paths.profile)];
    const sourceSizes = await Promise.all(sourceFiles.map(async path => (await stat(path)).size));
    const required = sourceSizes.reduce((sum, size) => sum + size, 0) + headroom;
    const filesystem = await statfs(this.paths.root);
    const available = this.availableBytes ? await this.availableBytes() : Number(filesystem.bavail) * Number(filesystem.bsize);
    if (available < required) throw new Error("Not enough free space for a complete data backup");
  }

  async listBackups(): Promise<BackupManifest[]> {
    await this.initialize();
    const manifests: BackupManifest[] = [];
    for (const dir of await readdir(this.paths.backups)) {
      if (dir.endsWith(".partial")) continue;
      const manifest = JSON.parse(await readFile(join(this.paths.backups, dir, "manifest.json"), "utf8")) as BackupManifest;
      if (manifest.format !== 1 || manifest.id !== dir) throw new Error("Invalid backup manifest");
      manifests.push(manifest);
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async requestRestore(id: string) {
    if (!(await this.listBackups()).some(backup => backup.id === id)) throw new Error("Backup not found");
    await writeJson(join(this.paths.root, "restore-request.json"), { id });
  }

  async restoreRequested() {
    const path = join(this.paths.root, "restore-request.json");
    let request: { id: string };
    try { request = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!/^[a-z0-9-]+$/.test(request.id)) throw new Error("Invalid restore request");
    await this.restore(request.id);
    await rm(path, { force: true });
  }

  async complete(version: string) {
    const state = await this.readState();
    if (!state || state.highestVersion !== version) throw new Error("Application data version mismatch");
    await writeJson(this.paths.state, { ...state, successfulVersion: version, pending: null });
    const backups = await this.listBackups();
    for (const backup of backups.filter(item => item.reason === "upgrade").slice(3)) {
      await rm(join(this.paths.backups, backup.id), { recursive: true });
    }
  }

  async restore(id: string) {
    const manifest = (await this.listBackups()).find(item => item.id === id);
    if (!manifest) throw new Error("Backup not found");
    const sourceRoot = join(this.paths.backups, id);
    for (const entry of manifest.files) {
      const source = resolve(sourceRoot, entry.path);
      if (!source.startsWith(`${sourceRoot}/`) && !source.startsWith(`${sourceRoot}\\`)) throw new Error("Invalid backup path");
      if (!entry.path.startsWith("data/") && !entry.path.startsWith("profile/") && !entry.path.startsWith("data\\") && !entry.path.startsWith("profile\\")) throw new Error("Invalid backup entry");
      if (await digest(source) !== entry.sha256 || (await stat(source)).size !== entry.size) throw new Error("Backup verification failed");
    }
    const state = await this.readState();
    const restoreSize = manifest.files.reduce((sum, entry) => sum + entry.size, 0);
    await this.checkBackupSpace(restoreSize + 64 * 1024 * 1024);
    await this.backup(state?.highestVersion ?? manifest.version, "recovery");
    const staging = join(this.paths.root, `restore-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    for (const name of ["data", "profile"]) await mkdir(join(staging, name), { mode: 0o700 });
    for (const entry of manifest.files) {
      const destination = join(staging, entry.path);
      await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      await cp(join(sourceRoot, entry.path), destination);
    }
    await writeJson(join(staging, "manifest.json"), manifest);
    await writeJson(join(this.paths.root, "restore.json"), { stage: relative(this.paths.root, staging), version: manifest.version });
    await this.resumeRestore();
  }

  private async resumeRestore() {
    const journalPath = join(this.paths.root, "restore.json");
    let journal: { stage: string; version: string };
    try { journal = JSON.parse(await readFile(journalPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!/^restore-[a-f0-9-]+$/.test(journal.stage) || !semver.valid(journal.version)) throw new Error("Invalid restore journal");
    const staging = join(this.paths.root, journal.stage);
    const manifest = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8")) as BackupManifest;
    for (const name of ["data", "profile"]) {
      const target = join(this.paths.root, name);
      try {
        await stat(join(staging, name));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      try { await rename(target, join(staging, `old-${name}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(join(staging, name), target);
    }
    for (const entry of manifest.files) {
      const path = resolve(this.paths.root, entry.path);
      if (!path.startsWith(`${this.paths.data}/`) && !path.startsWith(`${this.paths.profile}/`) &&
          !path.startsWith(`${this.paths.data}\\`) && !path.startsWith(`${this.paths.profile}\\`)) throw new Error("Invalid restored path");
      if (await digest(path) !== entry.sha256) throw new Error("Restored data verification failed");
    }
    await writeJson(this.paths.state, { format: 1, highestVersion: journal.version, successfulVersion: journal.version, pending: null });
    await rm(journalPath);
    await rm(join(this.paths.root, "restore-request.json"), { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}
