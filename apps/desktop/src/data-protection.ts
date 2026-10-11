import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import semver from "semver";
import type { DesktopBackupOperation } from "@dibao/shared";
import { desktopPaths } from "./paths.js";
import { backupErrorCode } from "./backup-errors.js";

type Entry = { path: string; size: number; sha256: string };
export type BackupManifest = {
  format: 1;
  id: string;
  version: string;
  createdAt: string;
  reason: "upgrade" | "recovery" | "manual";
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

function validateManifest(value: unknown, incompleteRecovery = false): BackupManifest {
  const manifest = value as BackupManifest;
  if (!manifest || manifest.format !== 1 || typeof manifest.id !== "string" || !/^[a-z0-9-]+$/.test(manifest.id) ||
      !semver.valid(manifest.version) || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !["upgrade", "recovery", "manual"].includes(manifest.reason) || !Array.isArray(manifest.files) ||
      (!incompleteRecovery && !manifest.files.length)) throw new Error("Invalid backup manifest");
  const paths = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid backup entry");
    const path = entry.path.replaceAll("\\", "/");
    const parts = path.split("/");
    if (!["data", "profile"].includes(parts[0]) || parts.length < 2 ||
        parts.some(part => !part || part === "." || part === ".." || /[:\0]/.test(part)) || paths.has(path)) throw new Error("Invalid backup path");
    paths.add(path);
  }
  const database = manifest.files.find(entry => entry.path.replaceAll("\\", "/") === "data/dibao.sqlite");
  if (!incompleteRecovery && (!database || database.size === 0)) throw new Error("Invalid backup manifest: database is missing or empty");
  return manifest;
}

async function verifySnapshotFile(root: string, entry: Entry) {
  const parts = entry.path.replaceAll("\\", "/").split("/");
  let path = root;
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid backup directory");
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error("Invalid backup entry");
  }
  if (await digest(path) !== entry.sha256 || (await stat(path)).size !== entry.size) throw new Error("Backup verification failed");
}

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
    if (old?.successfulVersion) {
      const database = await lstat(join(this.paths.data, "dibao.sqlite")).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!database?.isFile() || database.isSymbolicLink() || database.size === 0) throw new Error("The existing database is missing or invalid. Restore a backup before opening your data.");
    }
    if (old?.pending) {
      if (old.pending.backupId === null && old.successfulVersion === null && old.pending.version === version) return old;
      if (!retry || old.pending.version !== version) throw new Error("The previous upgrade did not finish. Retry or restore a backup.");
      return old;
    }
    if (old?.successfulVersion === version) return old;
    // Chromium may initialize profile preferences before the first database exists.
    const hasData = (await entries(this.paths.data)).length > 0;
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
    return this.snapshot(version, reason);
  }

  private async snapshot(version: string, reason: BackupManifest["reason"], preserveIncomplete = false): Promise<BackupManifest> {
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
      const database = manifest.files.find(entry => entry.path.replaceAll("\\", "/") === "data/dibao.sqlite");
      const incomplete = preserveIncomplete && (!database || database.size === 0);
      validateManifest(manifest, incomplete);
      await writeJson(join(staging, "manifest.json"), manifest);
      // Incomplete current data is retained for inspection, never offered as a restore point.
      await rename(staging, join(this.paths.backups, `${id}${incomplete ? ".incomplete" : ""}`));
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
    // Listing from a running renderer must never resume a restore or replace data.
    await mkdir(this.paths.backups, { recursive: true, mode: 0o700 });
    const manifests: BackupManifest[] = [];
    for (const dir of await readdir(this.paths.backups, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.isSymbolicLink() || !/^[a-z0-9-]+$/.test(dir.name)) continue;
      try {
        const manifest = validateManifest(JSON.parse(await readFile(join(this.paths.backups, dir.name, "manifest.json"), "utf8")));
        if (manifest.id === dir.name) manifests.push(manifest);
      } catch { /* Keep damaged snapshots untouched; they must not block healthy data or other restore points. */ }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async lastOperation(): Promise<(DesktopBackupOperation & { requestId?: string }) | null> {
    try {
      const operation = JSON.parse(await readFile(join(this.paths.root, "backup-result.json"), "utf8")) as DesktopBackupOperation & { requestId?: string };
      if (!operation || !["backup", "restore"].includes(operation.action) || !["success", "error"].includes(operation.status) ||
          !Number.isFinite(Date.parse(operation.completedAt)) ||
          (operation.error && !["busy", "unsaved", "upgrade", "missing", "space", "invalid", "permission", "failed"].includes(operation.error))) throw new Error("Invalid backup operation result");
      return operation;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private async recordOperation(operation: Omit<DesktopBackupOperation, "completedAt"> & { requestId?: string }) {
    await writeJson(join(this.paths.root, "backup-result.json"), { ...operation, completedAt: new Date().toISOString() });
  }

  async requestBackup(version: string) {
    if (!semver.valid(version)) throw new Error("Invalid application version");
    await writeJson(join(this.paths.root, "backup-request.json"), { version, requestId: randomUUID() });
  }

  // Run only during cold startup, before opening any database or Chromium profile.
  async backupRequested() {
    const path = join(this.paths.root, "backup-request.json");
    let request: { version: string; requestId: string };
    try { request = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try {
      if (!semver.valid(request.version) || !/^[a-f0-9-]{36}$/.test(request.requestId)) throw new Error("Invalid backup request");
      const state = await this.readState();
      if (state?.pending || state?.successfulVersion !== request.version) throw new Error("Invalid backup data version");
      const previous = await this.lastOperation();
      if (previous?.requestId === request.requestId && previous.status === "success") {
        await rm(path, { force: true });
        return;
      }
      const saved = await this.backup(request.version, "manual");
      await this.recordOperation({ action: "backup", status: "success", backupId: saved.id, requestId: request.requestId });
    } catch (error) {
      await this.recordOperation({ action: "backup", status: "error", error: backupErrorCode(error) });
    }
    await rm(path, { force: true });
  }

  async verifyBackup(id: string): Promise<BackupManifest> {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid backup id");
    const sourceRoot = join(this.paths.backups, id);
    const directory = await lstat(sourceRoot);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid backup directory");
    const manifest = validateManifest(JSON.parse(await readFile(join(sourceRoot, "manifest.json"), "utf8")));
    if (manifest.id !== id) throw new Error("Invalid backup manifest");
    for (const entry of manifest.files) await verifySnapshotFile(sourceRoot, entry);
    return manifest;
  }

  async requestRestore(id: string) {
    await this.verifyBackup(id);
    await writeJson(join(this.paths.root, "restore-request.json"), { id });
  }

  async restoreRequested() {
    const path = join(this.paths.root, "restore-request.json");
    let request: { id: string };
    try { request = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!/^[a-z0-9-]+$/.test(request.id)) throw new Error("Invalid restore request");
    try { await this.restore(request.id); }
    catch (error) {
      await this.recordOperation({ action: "restore", status: "error", error: backupErrorCode(error) });
      // A failed preflight leaves current data intact. An interrupted journal must resume.
      const journal = await stat(join(this.paths.root, "restore.json")).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!journal) await rm(path, { force: true });
      throw error;
    }
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
    const manifest = await this.verifyBackup(id);
    const sourceRoot = join(this.paths.backups, id);
    const state = await this.readState();
    const restoreSize = manifest.files.reduce((sum, entry) => sum + entry.size, 0);
    await this.checkBackupSpace(restoreSize + 64 * 1024 * 1024);
    await this.snapshot(state?.highestVersion ?? manifest.version, "recovery", true);
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
    const manifest = validateManifest(JSON.parse(await readFile(join(staging, "manifest.json"), "utf8")));
    if (manifest.version !== journal.version) throw new Error("Invalid restore journal version");
    // Verify all remaining staged files before moving either live directory. A
    // completed directory move is verified in place when resuming after a crash.
    for (const entry of manifest.files) {
      const name = entry.path.replaceAll("\\", "/").split("/")[0];
      const staged = await lstat(join(staging, name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      await verifySnapshotFile(staged ? staging : this.paths.root, entry);
    }
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
    await this.recordOperation({ action: "restore", status: "success", backupId: manifest.id });
    await rm(journalPath);
    await rm(join(this.paths.root, "restore-request.json"), { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}
