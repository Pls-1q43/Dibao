import { describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher } from "undici";
import { execFileSync } from "node:child_process";
import { defaultDesktopProxySettings } from "@dibao/shared";
import { DesktopProxyTransport, initializeDesktopProxy, proxyUrlFromResolution } from "./desktop-proxy.js";

describe("desktop proxy routing", () => {
  it("uses the selected system route without silently falling back to direct", () => {
    expect(proxyUrlFromResolution("DIRECT")).toBeNull();
    expect(proxyUrlFromResolution("PROXY 127.0.0.1:7890; DIRECT")).toBe("http://127.0.0.1:7890");
    expect(proxyUrlFromResolution("HTTPS proxy.example:8443")).toBe("https://proxy.example:8443");
    expect(proxyUrlFromResolution("SOCKS5 [::1]:7891")).toBe("socks5://[::1]:7891");
    for (const route of ["", "SOCKS proxy.example:1080", "SOCKS4 proxy.example:1080", "PROXY user:secret@proxy", "PROXY proxy/path", "UNKNOWN proxy"]) {
      expect(() => proxyUrlFromResolution(route)).toThrow();
    }
  });

  it("keeps system rules, manual bypass and direct mode distinct, including hot changes", async () => {
    const resolve = vi.fn(async () => "PROXY 127.0.0.1:7890");
    const transport = new DesktopProxyTransport(defaultDesktopProxySettings, resolve);
    try {
      expect(await transport.proxyFor("https://example.com")).toBe("http://127.0.0.1:7890");
      expect(await transport.proxyFor("http://192.168.1.2")).toBe("http://127.0.0.1:7890");
      expect(await transport.proxyFor("https://dibao.localhost")).toBeNull();
      expect(resolve).toHaveBeenCalledTimes(2);
      transport.update({ ...defaultDesktopProxySettings, mode: "manual" });
      expect(await transport.proxyFor("http://192.168.1.2")).toBeNull();
      expect(await transport.proxyFor("https://example.com")).toBe("http://127.0.0.1:7890");
      transport.update({ ...defaultDesktopProxySettings, mode: "direct" });
      expect(await transport.proxyFor("https://example.com")).toBeNull();
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally { await transport.close(); }
  });

  it("does not enable desktop networking in Docker or standalone Node without private IPC", () => {
    const dispatcher = getGlobalDispatcher();
    vi.stubEnv("DIBAO_DESKTOP_RUNTIME_TOKEN", "");
    vi.stubEnv("DIBAO_DESKTOP_PROXY_CONFIG", "invalid JSON");
    try { initializeDesktopProxy(); expect(getGlobalDispatcher()).toBe(dispatcher); }
    finally { vi.unstubAllEnvs(); }
    const module = new URL("../dist/desktop-proxy.js", import.meta.url).href;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { initializeDesktopProxy } from ${JSON.stringify(module)};
      initializeDesktopProxy(); console.log('no desktop IPC');
    `], { encoding: "utf8", env: { ...process.env, DIBAO_DESKTOP_RUNTIME_TOKEN: "no-private-parent", DIBAO_DESKTOP_PROXY_CONFIG: "invalid JSON" } }).trim()).toBe("no desktop IPC");
  });
});
