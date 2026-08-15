import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api.js";
import {
  DEFAULT_OFFLINE_RECOMMENDED_TARGET,
  MAX_OFFLINE_RECOMMENDED_TARGET,
  MIN_OFFLINE_RECOMMENDED_TARGET,
  isOfflineFallbackError,
  normalizeOfflineDeviceSettings,
  normalizeRecommendedTarget,
  offlineScopeKey
} from "./offlineReading.js";

describe("offline reading helpers", () => {
  it.each([
    [Number.NaN, DEFAULT_OFFLINE_RECOMMENDED_TARGET],
    [1, MIN_OFFLINE_RECOMMENDED_TARGET],
    [74, MIN_OFFLINE_RECOMMENDED_TARGET],
    [75, 100],
    [200, 200],
    [1_500, MAX_OFFLINE_RECOMMENDED_TARGET]
  ])("normalizes target %s to %i", (value, expected) => {
    expect(normalizeRecommendedTarget(value)).toBe(expected);
  });

  it("isolates offline data by origin and username", () => {
    expect(offlineScopeKey("reader", "https://dibao.example")).toBe(
      "https://dibao.example::reader"
    );
  });

  it("keeps offline reading enabled for existing device settings", () => {
    expect(normalizeOfflineDeviceSettings({ recommendedTarget: 200 })).toEqual({
      enabled: true,
      recommendedTarget: 200
    });
    expect(
      normalizeOfflineDeviceSettings({ enabled: false, recommendedTarget: 1_000 })
    ).toEqual({ enabled: false, recommendedTarget: 1_000 });
  });

  it("falls back only for network and server availability failures", () => {
    expect(isOfflineFallbackError(new TypeError("network failed"))).toBe(true);
    expect(isOfflineFallbackError(new ApiRequestError(503, "UNAVAILABLE", "down"))).toBe(true);
    expect(isOfflineFallbackError(new ApiRequestError(401, "AUTH_REQUIRED", "login"))).toBe(false);
  });
});
