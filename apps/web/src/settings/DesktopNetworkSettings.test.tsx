import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopProxySettings, normalizeDesktopProxySettings } from "@dibao/shared";
import { DibaoI18nProvider } from "../i18n.js";
import { DesktopNetworkSettings, desktopProxyCopy, desktopProxyDraftWithMode } from "./DesktopNetworkSettings.js";

describe("desktop network settings isolation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not expose proxy controls to Docker or ordinary web clients in any locale", () => {
    for (const locale of ["zh-CN", "ja-JP", "en-US"] as const) {
      expect(renderToStaticMarkup(<DibaoI18nProvider locale={locale}><DesktopNetworkSettings onDirtyChange={() => undefined} /></DibaoI18nProvider>)).toBe("");
      for (const key of ["title", "system", "direct", "manual", "invalid", "failed", "save", "test"] as const) expect(desktopProxyCopy[locale][key].length).toBeGreaterThan(0);
    }
  });

  it.each(["zh-CN", "ja-JP", "en-US"] as const)("renders the Desktop controls in %s", locale => {
    vi.stubGlobal("window", { dibaoDesktop: {} });
    const html = renderToStaticMarkup(<DibaoI18nProvider locale={locale}><DesktopNetworkSettings onDirtyChange={() => undefined} /></DibaoI18nProvider>);
    for (const key of ["title", "system", "direct", "manual", "save", "test", "local"] as const) expect(html).toContain(desktopProxyCopy[locale][key]);
    expect(html).toContain('id="desktop-proxy-mode"');
    expect(html).toContain('id="desktop-proxy-bypass"');
  });

  it("can leave manual mode with an empty or invalid hidden address", () => {
    for (const server of ["", "not a proxy", "http://user:password@127.0.0.1:7890", "http://proxy.example/path"]) {
      for (const mode of ["system", "direct"] as const) {
        const draft = desktopProxyDraftWithMode({ ...defaultDesktopProxySettings, mode: "manual", server, bypassLocal: false }, mode);
        expect(normalizeDesktopProxySettings(draft)).toEqual({ ...defaultDesktopProxySettings, mode, bypassLocal: false });
      }
    }
  });

  it("retains a valid manual endpoint and LAN preference when changing modes", () => {
    const draft = { ...defaultDesktopProxySettings, server: "socks5://127.0.0.1:7891", bypassLocal: false };
    for (const mode of ["manual", "system", "direct"] as const) expect(desktopProxyDraftWithMode(draft, mode)).toEqual({ ...draft, mode });
    expect(desktopProxyDraftWithMode({ ...draft, server: "" }, "manual").server).toBe("");
  });
});
