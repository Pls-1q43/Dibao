import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api.js";
import {
  DEFAULT_OFFLINE_RECOMMENDED_TARGET,
  MAX_OFFLINE_RECOMMENDED_TARGET,
  MIN_OFFLINE_RECOMMENDED_TARGET,
  isOfflineFallbackError,
  isOfflineModeActive,
  offlineModePromptReasonForError,
  normalizeOfflineDeviceSettings,
  normalizeRecommendedTarget,
  offlineScopeKey,
  setOfflineModeActive
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

  it("persists an explicitly selected offline mode until it is cleared", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    };

    setOfflineModeActive("reader-scope", storage);
    expect(isOfflineModeActive("reader-scope", storage)).toBe(true);
    expect(isOfflineModeActive("another-scope", storage)).toBe(false);
    setOfflineModeActive(null, storage);
    expect(isOfflineModeActive("reader-scope", storage)).toBe(false);
  });

  it("falls back only for network and server availability failures", () => {
    expect(isOfflineFallbackError(new TypeError("network failed"))).toBe(true);
    expect(isOfflineFallbackError(new ApiRequestError(503, "UNAVAILABLE", "down"))).toBe(true);
    expect(isOfflineFallbackError(new ApiRequestError(401, "AUTH_REQUIRED", "login"))).toBe(false);
  });

  it("distinguishes a disconnected browser from an unavailable server", () => {
    expect(offlineModePromptReasonForError(new TypeError("network failed"), false)).toBe(
      "server-unavailable"
    );
    expect(
      offlineModePromptReasonForError(
        new ApiRequestError(503, "UNAVAILABLE", "down"),
        false
      )
    ).toBe("server-unavailable");
    expect(
      offlineModePromptReasonForError(
        new ApiRequestError(503, "UNAVAILABLE", "down"),
        true
      )
    ).toBe("network-offline");
    expect(
      offlineModePromptReasonForError(
        new ApiRequestError(401, "AUTH_REQUIRED", "login"),
        false
      )
    ).toBeNull();
  });

  it("keeps offline mode entry and exit user-controlled", () => {
    const runtime = readFileSync(new URL("../AppRuntime.tsx", import.meta.url), "utf8");

    expect(runtime.match(/applyOfflineBootstrap\(/g)).toHaveLength(2);
    expect(runtime).toContain("isOfflineModeActive(bootstrap.profile.scopeKey)");
    expect(runtime).toContain('void offerOfflineMode("network-offline")');
    expect(runtime).toContain("setAuthGateRetryToken((value) => value + 1)");
    expect(runtime).toContain("onExit: isUsingOfflineData");
    expect(runtime).not.toContain("reconnectAttempt");
    expect(runtime).not.toContain("deferredOnlineActivation");
  });
});
