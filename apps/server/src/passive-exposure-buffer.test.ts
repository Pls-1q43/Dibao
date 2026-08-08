import { describe, expect, it } from "vitest";
import { PassiveExposureBuffer } from "./passive-exposure-buffer.js";

describe("PassiveExposureBuffer", () => {
  it("coalesces passive exposures before one durable batch write", () => {
    const calls: Array<{ clientSessionId: string; articleIds: string[]; exposedAt?: number }> = [];
    const buffer = new PassiveExposureBuffer({
      recordExposures(input) {
        calls.push(input);
        return { recorded: input.articleIds.length, existing: 0 };
      }
    });

    expect(buffer.record({ clientSessionId: "session", articleIds: ["a", "b"], exposedAt: 10 })).toEqual({
      recorded: 2,
      existing: 0
    });
    buffer.record({ clientSessionId: "session", articleIds: ["b", "c"], exposedAt: 10 });
    expect(calls).toEqual([]);

    buffer.flush();
    expect(calls).toEqual([{ clientSessionId: "session", articleIds: ["a", "b", "c"], exposedAt: 10 }]);
  });
});
