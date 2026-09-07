import { spawn, type ChildProcess } from "node:child_process";

type ManagedProcess = {
  name: string;
  child: ChildProcess;
};

const managed: ManagedProcess[] = [];
let shuttingDown = false;
const useWorkerProcess =
  process.env.DIBAO_CONTAINER_WORKER_PROCESS !== "false" &&
  process.env.DIBAO_BACKGROUND_JOBS !== "false";

const http = startProcess("http", "apps/server/dist/index.js", {
  DIBAO_BACKGROUND_JOBS: useWorkerProcess
    ? "false"
    : process.env.DIBAO_BACKGROUND_JOBS === "false"
      ? "false"
      : "true",
  DIBAO_PROCESS_ROLE: useWorkerProcess ? "http" : "standalone"
});
managed.push(http);
watchProcess(http);

if (useWorkerProcess) {
  void startWorkerWhenHttpReady();
}

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("SIGINT", () => {
  void shutdown(0);
});

async function startWorkerWhenHttpReady(): Promise<void> {
  const ready = await waitForHttpReady();
  if (shuttingDown) {
    return;
  }
  if (!ready) {
    console.warn("[dibao] HTTP health was not ready before worker start timeout");
  }

  const worker = startProcess("worker", "apps/server/dist/worker.js", {
    DIBAO_BACKGROUND_JOBS: "true",
    DIBAO_PROCESS_ROLE: "worker",
    DIBAO_RECORD_FOREGROUND_ACTIVITY: "false"
  });
  managed.push(worker);
  watchProcess(worker);
}

function watchProcess(proc: ManagedProcess): void {
  proc.child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const exitCode = code ?? (signal ? 1 : 0);
    console.error(`[dibao] ${proc.name} exited`, { code, signal });
    void shutdown(exitCode);
  });
}

function startProcess(
  name: string,
  script: string,
  env: Record<string, string>
): ManagedProcess {
  const child = spawn(process.execPath, [script], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...env
    }
  });
  return { name, child };
}

async function waitForHttpReady(): Promise<boolean> {
  const port = process.env.DIBAO_PORT ?? "8080";
  const deadline = Date.now() + readPositiveInteger(process.env.DIBAO_WORKER_START_TIMEOUT_MS, 60_000);
  const url = `http://127.0.0.1:${port}/api/system/health`;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // The HTTP process is still starting.
    }
    await delay(500);
  }
  return false;
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const proc of managed) {
    if (!proc.child.killed && proc.child.exitCode === null) {
      proc.child.kill("SIGTERM");
    }
  }

  await Promise.all(managed.map((proc) => waitForExit(proc.child, 8_000)));

  for (const proc of managed) {
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
      proc.child.kill("SIGKILL");
    }
  }

  process.exit(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
