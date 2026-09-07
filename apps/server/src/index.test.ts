import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ buildServer: vi.fn() }));
vi.mock("./app.js", () => ({ buildServer: mocks.buildServer }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); mocks.buildServer.mockReset(); });

describe("HTTP entry point upgrade ownership", () => {
  it.each([
    { jobs: undefined, role: undefined, owner: true },
    { jobs: "false", role: undefined, owner: true },
    { jobs: "false", role: "standalone", owner: true },
    { jobs: "true", role: "standalone", owner: true },
    { jobs: "false", role: "http", owner: false }
  ])("selects an explicit runner for jobs=$jobs role=$role", async ({ jobs, role, owner }) => {
    vi.stubEnv("DIBAO_BACKGROUND_JOBS", jobs);
    vi.stubEnv("DIBAO_PROCESS_ROLE", role);
    mocks.buildServer.mockReturnValue({ listen: vi.fn().mockResolvedValue(undefined), log: { error: vi.fn() } });
    await import("./index.js");
    expect(mocks.buildServer).toHaveBeenCalledWith(expect.objectContaining({
      backgroundJobs: jobs === "true", derivedUpgradeRunner: owner
    }));
  });
});
