import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { defaultDesktopProxySettings, desktopProxySessionConfig, normalizeDesktopProxySettings, type DesktopProxySettings } from "@dibao/shared";

type ProxySession = {
  setProxy(config: ReturnType<typeof desktopProxySessionConfig>): Promise<void>;
  closeAllConnections(): Promise<void>;
  resolveProxy(url: string): Promise<string>;
};

export class DesktopProxyController {
  private settings = { ...defaultDesktopProxySettings };
  private saving = false;

  constructor(
    private readonly path: string,
    private readonly sessions: ProxySession[],
    private readonly applyRuntime: (settings: DesktopProxySettings) => Promise<void>,
    private readonly assertAvailable: () => void,
    private readonly onFailure: (message: string) => void = () => undefined
  ) {}

  get current(): DesktopProxySettings { return { ...this.settings }; }
  get busy(): boolean { return this.saving; }

  async initialize(): Promise<void> {
    try {
      const file = await lstat(this.path);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 8192) throw new Error("Invalid desktop proxy configuration");
      const saved = JSON.parse(await readFile(this.path, "utf8")) as { format: number; settings: unknown };
      if (saved.format !== 1) throw new Error("Invalid desktop proxy configuration");
      this.settings = normalizeDesktopProxySettings(saved.settings);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Desktop proxy configuration could not be read. Check desktop-proxy.json in the data directory.");
    }
    await this.applySessions(this.settings);
  }

  async save(value: unknown): Promise<DesktopProxySettings> {
    let next: DesktopProxySettings;
    try { next = normalizeDesktopProxySettings(value); }
    catch { throw new Error("DIBAO_PROXY_INVALID"); }
    this.assertAvailable();
    if (this.saving) throw new Error("DIBAO_PROXY_BUSY");
    this.saving = true;
    const previous = this.settings;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await this.applySessions(next);
      this.settings = next;
      await this.applyRuntime(next);
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify({ format: 1, settings: next }, null, 2)}\n`); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
      return this.current;
    } catch {
      this.settings = previous;
      let restored = true;
      await this.applySessions(previous).catch(() => { restored = false; });
      await this.applyRuntime(previous).catch(() => { restored = false; });
      if (!restored) this.onFailure("The previous proxy configuration could not be restored. Restart Dibao before making network requests.");
      throw new Error("DIBAO_PROXY_SAVE_FAILED");
    } finally {
      this.saving = false;
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  resolveProxy(url: string): Promise<string> { return this.sessions[0].resolveProxy(url); }

  private async applySessions(settings: DesktopProxySettings): Promise<void> {
    for (const session of this.sessions) {
      await session.setProxy(desktopProxySessionConfig(settings));
      await session.closeAllConnections();
    }
  }
}
