import type { DesktopBridge } from "@dibao/shared";

declare global {
  interface Window { dibaoDesktop?: DesktopBridge }
}

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.dibaoDesktop;
}

export function isDesktopRuntime(): boolean { return desktopBridge() !== undefined; }
export function isLocalServiceOffline(): boolean {
  return !isDesktopRuntime() && typeof navigator !== "undefined" && navigator.onLine === false;
}
