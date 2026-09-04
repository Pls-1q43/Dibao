import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api.js";
import {
  DEFAULT_OFFLINE_RECOMMENDED_TARGET,
  MAX_OFFLINE_RECOMMENDED_TARGET,
  MIN_OFFLINE_RECOMMENDED_TARGET,
  isOfflineFallbackError,
  isOfflineModeActive,
  isOfflineScopeRevokedInStorage,
  hasPendingServerLogoutInStorage,
  offlineModePromptReasonForError,
  normalizeOfflineDeviceSettings,
  normalizeRecommendedTarget,
  offlineScopeKey,
  resolveOfflineArticleImageUrl,
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

  it("resolves offline article images against the article instead of the Dibao page", () => {
    expect(
      resolveOfflineArticleImageUrl(
        "../media/cover.jpg#preview",
        "https://publisher.example/posts/2026/article.html",
        "https://dibao.example/?view=recommended"
      )
    ).toBe("https://publisher.example/posts/media/cover.jpg");
    expect(
      resolveOfflineArticleImageUrl(
        "/media/cover.jpg",
        null,
        "https://dibao.example/?view=recommended"
      )
    ).toBe("https://dibao.example/media/cover.jpg");
  });

  it("rejects non-http and credential-bearing offline image URLs", () => {
    expect(
      resolveOfflineArticleImageUrl(
        "data:image/png;base64,AA==",
        "https://publisher.example/article",
        "https://dibao.example/"
      )
    ).toBeNull();
    expect(
      resolveOfflineArticleImageUrl(
        "https://user:secret@publisher.example/image.jpg",
        "https://publisher.example/article",
        "https://dibao.example/"
      )
    ).toBeNull();
    expect(
      resolveOfflineArticleImageUrl(
        "http://127.0.0.1/admin/action",
        "https://publisher.example/article",
        "https://dibao.example/"
      )
    ).toBeNull();
    expect(
      resolveOfflineArticleImageUrl(
        "http://[::1]/admin/action",
        "https://publisher.example/article",
        "https://dibao.example/"
      )
    ).toBeNull();
    expect(
      resolveOfflineArticleImageUrl(
        "http://router.local/admin/action",
        "https://publisher.example/article",
        "https://dibao.example/"
      )
    ).toBeNull();
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

  it("treats logout and offline revocation markers as fail-closed state", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null
    };
    const scopeKey = "https://dibao.test::reader";
    values.set(`dibao:offline-reading:revoked-scope:v1:${scopeKey}`, "1");
    values.set("dibao:auth:pending-server-logout:v1:https://dibao.test", "1");

    expect(isOfflineScopeRevokedInStorage(scopeKey, storage)).toBe(true);
    expect(hasPendingServerLogoutInStorage("https://dibao.test", storage)).toBe(true);

    values.set(`dibao:offline-reading:revoked-scope:v1:${scopeKey}`, "0");
    values.set("dibao:auth:pending-server-logout:v1:https://dibao.test", "0");
    expect(isOfflineScopeRevokedInStorage(scopeKey, storage)).toBe(false);
    expect(hasPendingServerLogoutInStorage("https://dibao.test", storage)).toBe(false);
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
    expect(
      offlineModePromptReasonForError(
        new DOMException("Startup request timed out", "AbortError"),
        false
      )
    ).toBe("server-unavailable");
  });

  it("keeps offline mode entry and exit user-controlled", () => {
    const runtime = readFileSync(new URL("../AppRuntime.tsx", import.meta.url), "utf8");

    expect(runtime.match(/applyOfflineBootstrap\(/g)).toHaveLength(2);
    expect(runtime).toContain("isOfflineModeActive(bootstrap.profile.scopeKey)");
    expect(runtime).toContain('void offerOfflineMode("network-offline")');
    expect(runtime).toContain("AUTH_GATE_REQUEST_TIMEOUT_MS");
    expect(runtime).toContain("SERVER_AVAILABILITY_CHECK_INTERVAL_MS");
    expect(runtime).toContain("dibaoApi.getAuthSession(signal)");
    expect(runtime).toContain('window.addEventListener("focus", checkWhenVisible)');
    expect(runtime).toContain("setAuthGateRetryToken((value) => value + 1)");
    expect(runtime).toContain("onExit: isUsingOfflineData");
    expect(runtime).toContain("await markOfflineScopeRevoked(offlineScope)");
    expect(runtime).toContain("await markPendingServerLogout()");
    expect(runtime).toContain("if (await hasPendingServerLogout())");
    expect(runtime).toContain("dibaoApi.logout(signal)");
    expect(runtime).not.toContain("reconnectAttempt");
    expect(runtime).not.toContain("deferredOnlineActivation");
  });
});
