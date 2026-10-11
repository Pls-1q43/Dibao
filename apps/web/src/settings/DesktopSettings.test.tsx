import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DibaoI18nProvider } from "../i18n.js";
import { DesktopSettings } from "./DesktopSettings.js";

describe("desktop settings isolation", () => {
  it("renders no desktop-only controls without the privileged preload in every locale", () => {
    for (const locale of ["zh-CN", "ja-JP", "en-US"] as const) {
      expect(renderToStaticMarkup(<DibaoI18nProvider locale={locale}><DesktopSettings /></DibaoI18nProvider>)).toBe("");
    }
  });
});
