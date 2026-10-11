import { describe, expect, it, vi } from "vitest";
import { createDesktopTrayIcon } from "./tray-icon.js";

describe("desktop tray icon", () => {
  it.each([["darwin", 18, true], ["win32", 16, false]])("sizes the %s image before constructing the tray", (platform, size, template) => {
    const icon = { setTemplateImage: vi.fn() };
    const image = { resize: vi.fn(() => icon) };
    expect(createDesktopTrayIcon(image as unknown as Electron.NativeImage, String(platform))).toBe(icon);
    expect(image.resize).toHaveBeenCalledWith({ width: size, height: size, quality: "best" });
    expect(icon.setTemplateImage.mock.calls).toEqual(template ? [[true]] : []);
  });
});
