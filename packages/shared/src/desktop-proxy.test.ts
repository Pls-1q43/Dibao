import { describe, expect, it } from "vitest";
import { bypassesDesktopProxy, defaultDesktopProxySettings, desktopProxySessionConfig, normalizeDesktopProxySettings } from "./desktop-proxy.js";

describe("desktop proxy settings", () => {
  it("normalizes supported Clash proxy addresses", () => {
    for (const [input, server] of [[" http://127.0.0.1:7890/ ", "http://127.0.0.1:7890"], ["https://proxy.example:8443", "https://proxy.example:8443"], ["socks5://[::1]:7891", "socks5://[::1]:7891"], ["socks5://localhost", "socks5://localhost:1080"]]) {
      expect(normalizeDesktopProxySettings({ ...defaultDesktopProxySettings, mode: "manual", server }).server).toBe(server);
      expect(normalizeDesktopProxySettings({ ...defaultDesktopProxySettings, mode: "manual", server: input }).server).toBe(server);
    }
  });

  it("rejects credentials, rule injection, non-proxy URLs and malformed settings", () => {
    for (const server of ["file:///tmp/proxy", "http://user:secret@proxy.example:80", "http://proxy/path", "http://proxy?secret=value", "http://proxy#fragment", "http://dibao.localhost:8080", "http://DIBAO.localhost.:8080", "http://proxy:0", "http://proxy:65536", "http://proxy;DIRECT", "not a URL"]) {
      expect(() => normalizeDesktopProxySettings({ ...defaultDesktopProxySettings, server })).toThrow();
    }
    for (const input of [null, [], {}, { ...defaultDesktopProxySettings, mode: "pac" }, { ...defaultDesktopProxySettings, bypassLocal: "yes" }]) {
      expect(() => normalizeDesktopProxySettings(input)).toThrow();
    }
  });

  it("always keeps the local reader and loopback providers direct", () => {
    for (const url of ["https://dibao.localhost", "http://localhost.:8080", "http://127.0.0.2", "http://2130706433", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://169.254.1.1", "http://[fe80::1]"]) {
      expect(bypassesDesktopProxy(url, { ...defaultDesktopProxySettings, bypassLocal: false })).toBe(true);
    }
  });

  it("respects LAN bypass without bypassing lookalike public hosts", () => {
    const manual = { ...defaultDesktopProxySettings, mode: "manual" as const };
    for (const host of ["10.0.1.2", "172.20.1.2", "192.168.1.1", "[fd00::1]", "nas", "rss.local"]) {
      expect(bypassesDesktopProxy(`http://${host}`, manual)).toBe(true);
      expect(bypassesDesktopProxy(`http://${host}`, { ...manual, bypassLocal: false })).toBe(false);
      expect(bypassesDesktopProxy(`http://${host}`, defaultDesktopProxySettings)).toBe(false);
    }
    for (const host of ["example.com", "localhost.evil.com", "127.0.0.1.example.com", "172.32.1.1", "192.169.1.1", "[2001:4860::1]"]) {
      expect(bypassesDesktopProxy(`http://${host}`, defaultDesktopProxySettings)).toBe(false);
    }
    expect(desktopProxySessionConfig(defaultDesktopProxySettings)).toEqual({ mode: "system" });
    expect(desktopProxySessionConfig({ ...defaultDesktopProxySettings, mode: "direct" })).toEqual({ mode: "direct" });
    expect(desktopProxySessionConfig({ ...defaultDesktopProxySettings, mode: "manual" }).proxyBypassRules).not.toContain("<-loopback>");
  });
});
