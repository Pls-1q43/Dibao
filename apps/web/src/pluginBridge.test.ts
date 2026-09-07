import { describe, expect, it } from "vitest";
import {
  assertPluginBridgeCapability,
  hasPluginBridgeCapability
} from "./pluginBridge.js";

describe("plugin iframe bridge capabilities", () => {
  it.each([undefined, null, {}, "unknown", "constructor", "__proto__", "toString"])(
    "rejects unknown and inherited bridge methods: %s",
    (method) => {
      expect(hasPluginBridgeCapability([], method)).toBe(false);
      expect(() => assertPluginBridgeCapability([], method)).toThrow("Unsupported plugin bridge method");
    }
  );

  it("requires read and write capabilities independently", () => {
    expect(hasPluginBridgeCapability(["articles:read"], "readArticles")).toBe(true);
    expect(hasPluginBridgeCapability(["articles:read"], "recordArticleAction")).toBe(false);
    expect(hasPluginBridgeCapability(["articles:write"], "recordArticleAction")).toBe(true);
  });

  it("requires both article and ranking access for explanations", () => {
    expect(hasPluginBridgeCapability(["articles:read"], "getArticleExplanation")).toBe(false);
    expect(
      hasPluginBridgeCapability(
        ["articles:read", "ranking:read"],
        "getArticleExplanation"
      )
    ).toBe(true);
  });

  it("rejects privileged calls while allowing capability-free bridge methods", () => {
    expect(() => assertPluginBridgeCapability([], "listPluginSecrets")).toThrow(
      "Plugin capability required: secrets:plugin"
    );
    expect(() => assertPluginBridgeCapability([], "getLocale")).not.toThrow();
    expect(() => assertPluginBridgeCapability([], "pluginApi")).not.toThrow();
  });
});
