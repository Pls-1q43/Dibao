import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); mocks.spawn.mockReset();
});

describe("container process ownership", () => {
  it.each([
    { background: "false", worker: "true", role: "standalone", jobs: "false", children: 1 },
    { background: "true", worker: "false", role: "standalone", jobs: "true", children: 1 },
    { background: "true", worker: "true", role: "http", jobs: "false", children: 2 }
  ])("selects the upgrade owner for $background / $worker", async ({ background, worker, role, jobs, children }) => {
    vi.stubEnv("DIBAO_BACKGROUND_JOBS", background);
    vi.stubEnv("DIBAO_CONTAINER_WORKER_PROCESS", worker);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const beforeTerm = process.listeners("SIGTERM");
    const beforeInt = process.listeners("SIGINT");
    cleanups.push(() => {
      for (const listener of process.listeners("SIGTERM")) if (!beforeTerm.includes(listener)) process.removeListener("SIGTERM", listener);
      for (const listener of process.listeners("SIGINT")) if (!beforeInt.includes(listener)) process.removeListener("SIGINT", listener);
    });
    mocks.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, killed: false }));
    await import("./container-entrypoint.js");
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(children));
    expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({ DIBAO_PROCESS_ROLE: role, DIBAO_BACKGROUND_JOBS: jobs });
    if (children === 2) expect(mocks.spawn.mock.calls[1][2].env.DIBAO_PROCESS_ROLE).toBe("worker");
  });
});
