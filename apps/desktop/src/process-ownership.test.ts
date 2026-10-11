import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waitForPreviousDesktopWriters } from "./process-ownership.js";

describe("desktop writer ownership", () => {
  it("blocks opening data while an orphaned local service is still alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "dibao-owner-"));
    try {
      await mkdir(join(root, "runtime"));
      await writeFile(join(root, "runtime", "worker.owner"), JSON.stringify({ pid: process.pid }));
      await expect(waitForPreviousDesktopWriters(root, 0)).rejects.toThrow("still saving data");
      await rm(join(root, "runtime", "worker.owner"));
      await expect(waitForPreviousDesktopWriters(root, 0)).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
