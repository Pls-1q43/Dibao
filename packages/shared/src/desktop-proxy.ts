import type { DesktopProxySettings } from "./desktop.js";

export const defaultDesktopProxySettings: DesktopProxySettings = {
  mode: "system",
  server: "http://127.0.0.1:7890",
  bypassLocal: true
};

export function normalizeDesktopProxySettings(value: unknown): DesktopProxySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid desktop proxy settings");
  const input = value as Record<string, unknown>;
  if (typeof input.mode !== "string" || !["system", "direct", "manual"].includes(input.mode) ||
      typeof input.server !== "string" || input.server.length > 2048 ||
      /[\r\n\0]/.test(input.server) ||
      typeof input.bypassLocal !== "boolean") throw new Error("Invalid desktop proxy settings");
  const server = new URL(input.server.trim());
  if (!["http:", "https:", "socks5:"].includes(server.protocol) || !server.hostname ||
      server.username || server.password || server.search || server.hash || /[;=,\s]/.test(server.host) ||
      (server.pathname !== "/" && server.pathname !== "") ||
      server.port === "0" || server.hostname.toLowerCase().replace(/\.$/, "") === "dibao.localhost") throw new Error("Invalid desktop proxy address");
  if (server.protocol === "socks5:" && !server.port) server.port = "1080";
  return { mode: input.mode as DesktopProxySettings["mode"], server: `${server.protocol}//${server.host}`, bypassLocal: input.bypassLocal };
}

export function bypassesDesktopProxy(url: string, settings: DesktopProxySettings): boolean {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "0.0.0.0") return true;
  const parts = hostname.split(".").map(Number);
  const ipv4 = parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
  // Match Chromium's mandatory loopback/link-local bypass rather than subtracting it.
  if (ipv4 && (parts[0] === 127 || parts[0] === 169 && parts[1] === 254) || /^fe[89ab][0-9a-f]:/.test(hostname)) return true;
  // URL normalizes dotted IPv4-mapped IPv6 into hexadecimal groups.
  if (hostname.startsWith("::ffff:")) {
    const groups = hostname.slice(7).split(":");
    if (groups.length === 2 && groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) {
      const value = Number.parseInt(groups[0], 16) * 65536 + Number.parseInt(groups[1], 16);
      return bypassesDesktopProxy(`http://${[24, 16, 8, 0].map(shift => (value >>> shift) & 255).join(".")}`, settings);
    }
  }
  if (settings.mode !== "manual" || !settings.bypassLocal) return false;
  return hostname.endsWith(".local") || !hostname.includes(".") && !hostname.includes(":") ||
    ipv4 && (parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 ||
      parts[0] === 192 && parts[1] === 168) || /^(?:fc|fd)[0-9a-f]{2}:/.test(hostname);
}

export function desktopProxySessionConfig(settings: DesktopProxySettings): {
  mode: "system" | "direct" | "fixed_servers";
  proxyRules?: string;
  proxyBypassRules?: string;
} {
  if (settings.mode !== "manual") return { mode: settings.mode };
  return {
    mode: "fixed_servers",
    proxyRules: settings.server,
    proxyBypassRules: ["localhost", "*.localhost", "127.0.0.0/8", "[::1]", "::ffff:127.0.0.0/104",
      ...(settings.bypassLocal ? ["<local>", "*.local", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10"] : [])].join(";")
  };
}
