import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { DESKTOP_ORIGIN } from "@dibao/shared";

export class DesktopRuntime {
  readonly token = randomBytes(32).toString("hex");
  port = 0;
  private children: ChildProcess[] = [];
  private stopping = false;
  private log;

  constructor(
    private readonly resourceRoot: string,
    private readonly dataRoot: string,
    logPath: string,
    private readonly onFailure: (message: string) => void,
    private readonly nodeExecutable = join(resourceRoot, "runtime", process.platform === "win32" ? "node.exe" : "node")
  ) {
    this.log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
    this.log.on("error", () => {
      if (!this.stopping) this.onFailure("The local service log could not be written. Check data directory permissions and available space.");
    });
  }

  async start(): Promise<void> {
    const child = this.launch("index.js", { DIBAO_PROCESS_ROLE: "http", DIBAO_BACKGROUND_JOBS: "false", DIBAO_PORT: "0" });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local service did not start within 90 seconds")), 90_000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Local service exited before startup")); });
      child.on("message", message => {
        if (typeof message === "object" && message !== null && "type" in message && message.type === "dibao-ready" && "port" in message && typeof message.port === "number") {
          this.port = message.port;
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    this.launch("worker.js", {
      DIBAO_PROCESS_ROLE: "worker", DIBAO_BACKGROUND_JOBS: "true", DIBAO_PORT: String(this.port), DIBAO_RECORD_FOREGROUND_ACTIVITY: "false"
    });
  }

  private launch(script: string, roleEnv: Record<string, string>): ChildProcess {
    const child = spawn(this.nodeExecutable, [join(this.resourceRoot, "apps", "server", "dist", script)], {
      cwd: this.resourceRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        DIBAO_HOST: "127.0.0.1",
        DIBAO_DATABASE_PATH: join(this.dataRoot, "dibao.sqlite"),
        DIBAO_PLUGIN_DATA_DIR: join(this.dataRoot, "plugins"),
        DIBAO_OFFICIAL_PLUGINS_DIR: join(this.resourceRoot, "plugins", "official"),
        DIBAO_DESKTOP_RUNTIME_TOKEN: this.token,
        DIBAO_DESKTOP_OWNER_DIR: join(this.dataRoot, "..", "runtime"),
        DIBAO_ALLOWED_ORIGINS: DESKTOP_ORIGIN,
        DIBAO_COOKIE_SECURE: "true",
        ...roleEnv
      }
    });
    this.children.push(child);
    child.stdout?.pipe(this.log, { end: false });
    child.stderr?.pipe(this.log, { end: false });
    child.once("error", () => {
      if (!this.stopping) this.onFailure("The local service could not be started. Open the data directory to inspect its log.");
    });
    child.once("exit", (code) => {
      if (!this.stopping) this.onFailure(`The local service stopped unexpectedly (exit ${code ?? "unknown"}).`);
    });
    return child;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Close the worker before HTTP so no background writer survives shutdown.
    for (const child of [...this.children].reverse()) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("The local service is still saving data. Try again when its task finishes.")), 60_000);
        child.once("exit", code => {
          clearTimeout(timeout);
          if (code === 0) resolve(); else reject(new Error("The local service could not finish saving data"));
        });
      });
      if (child.connected) child.send({ type: "dibao-stop" });
      else child.kill("SIGTERM");
      await exited;
    }
    this.children = [];
    this.log.end();
  }
}
