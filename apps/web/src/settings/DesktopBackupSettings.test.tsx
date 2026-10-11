import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DesktopBridge } from "@dibao/shared";
import { DibaoI18nProvider } from "../i18n.js";
import { DesktopBackupSettings, desktopBackupCopy, desktopBackupErrorCode } from "./DesktopBackupSettings.js";

describe("desktop backup settings", () => {
  it("renders manual backup and disables restore until a point is available in every locale", () => {
    for (const locale of ["zh-CN", "ja-JP", "en-US"] as const) {
      const html = renderToStaticMarkup(<DibaoI18nProvider locale={locale}><DesktopBackupSettings bridge={{} as DesktopBridge} /></DibaoI18nProvider>);
      expect(html).toContain(desktopBackupCopy[locale].create);
      expect(html).toContain(desktopBackupCopy[locale].restore);
      expect(html).toMatch(/disabled=""[^>]*>[^<]+<\/button>/);
      expect(Object.keys(desktopBackupCopy[locale].errors)).toEqual(Object.keys(desktopBackupCopy["zh-CN"].errors));
    }
  });
  it("maps IPC failures to actionable backup errors without exposing private error details", () => {
    expect(desktopBackupErrorCode(new Error("Error invoking remote method 'dibao:backup-create': Error: dibao-backup:unsaved"))).toBe("unsaved");
    expect(desktopBackupErrorCode(new Error("dibao-backup:space"))).toBe("space");
    expect(desktopBackupErrorCode(new Error("private directory error"))).toBe("failed");
    expect(desktopBackupCopy["zh-CN"].errors.failed).not.toContain("更新失败");
  });
});
