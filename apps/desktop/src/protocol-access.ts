import { DESKTOP_ORIGIN } from "@dibao/shared";

export function desktopRequestAccess(request: Request & { initiatorOrigin?: string | null }): "trusted" | "public-style" | "denied" {
  const url = new URL(request.url);
  if (url.origin !== DESKTOP_ORIGIN) return "denied";
  if (request.initiatorOrigin === undefined || request.initiatorOrigin === DESKTOP_ORIGIN) return "trusted";
  // Sandboxed plugin frames have opaque origins. Only this anonymous stylesheet is shared.
  if ((request.initiatorOrigin === null || request.initiatorOrigin === "null") &&
      url.pathname === "/api/plugins/ui.css" && ["GET", "HEAD"].includes(request.method)) return "public-style";
  return "denied";
}

