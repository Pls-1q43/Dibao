export function createDesktopTrayIcon(image: Electron.NativeImage, platform: string) {
  const size = platform === "darwin" ? 18 : 16;
  const icon = image.resize({ width: size, height: size, quality: "best" });
  if (platform === "darwin") icon.setTemplateImage(true);
  return icon;
}
