import { randomUUID } from "node:crypto";
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { bypassesDesktopProxy, normalizeDesktopProxySettings, type DesktopProxySettings, type DesktopProxyTestResult } from "@dibao/shared";

export const DESKTOP_PROXY_TEST_URL = "https://www.gstatic.com/generate_204";
type ProxyResolver = (url: string) => Promise<string>;
let desktopProxy: DesktopProxyTransport | null = null;

export function isDesktopNetworkingActive(): boolean { return desktopProxy !== null && process.connected; }

function sendToDesktop(value: unknown, onError: () => void = () => undefined): void {
  if (!process.connected || !process.send) { onError(); return; }
  try { process.send(value, error => { if (error) onError(); }); }
  catch { onError(); }
}

export function proxyUrlFromResolution(resolution: string): string | null {
  // Use the selected route, not a silent DIRECT fallback after a proxy failure.
  const first = resolution.split(";", 1)[0].trim();
  if (first === "DIRECT") return null;
  const match = /^(PROXY|HTTPS|SOCKS5) ([^\s]+)$/.exec(first);
  if (!match) throw new Error("Unsupported system proxy route");
  const scheme = { PROXY: "http", HTTPS: "https", SOCKS5: "socks5" }[match[1]];
  return normalizeDesktopProxySettings({ mode: "manual", server: `${scheme}://${match[2]}`, bypassLocal: true }).server;
}

export class DesktopProxyTransport {
  private settings: DesktopProxySettings;
  private readonly direct = new Agent();
  private readonly proxies = new Map<string, ProxyAgent>();
  private readonly retiring = new Set<Promise<void>>();
  private closed = false;
  readonly dispatcher: Dispatcher;

  constructor(settings: DesktopProxySettings, private readonly resolveProxy: ProxyResolver) {
    this.settings = normalizeDesktopProxySettings(settings);
    this.dispatcher = this.direct.compose(dispatch => (options, handler) => {
      void this.proxyFor(new URL(options.path, String(options.origin)).toString()).then(proxy => {
        if (this.closed) throw new Error("Desktop network is closed");
        if (!proxy) { dispatch(options, handler); return; }
        let agent = this.proxies.get(proxy);
        if (!agent) {
          agent = new ProxyAgent(proxy);
          this.proxies.set(proxy, agent);
          if (this.proxies.size > 32) this.retire(this.proxies.keys().next().value!);
        }
        agent.dispatch(options, handler);
      }).catch(error => handler.onError?.(error));
      return true;
    });
  }

  async proxyFor(url: string): Promise<string | null> {
    const settings = this.settings;
    if (settings.mode === "direct" || bypassesDesktopProxy(url, settings)) return null;
    if (settings.mode === "manual") return settings.server;
    return proxyUrlFromResolution(await this.resolveProxy(url));
  }

  update(value: unknown): void {
    this.settings = normalizeDesktopProxySettings(value);
    for (const key of this.proxies.keys()) this.retire(key);
  }

  private retire(key: string): void {
    const agent = this.proxies.get(key);
    if (!agent) return;
    this.proxies.delete(key);
    const closing = agent.close().catch(() => undefined);
    this.retiring.add(closing);
    void closing.finally(() => this.retiring.delete(closing));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const key of this.proxies.keys()) this.retire(key);
    await this.direct.close();
    await Promise.all(this.retiring);
  }
}

export function initializeDesktopProxy(): void {
  // Docker/standalone processes have no private parent IPC and keep their dispatcher unchanged.
  if (!process.env.DIBAO_DESKTOP_RUNTIME_TOKEN || !process.send || !process.connected) return;
  if (desktopProxy) return;
  const settings = normalizeDesktopProxySettings(JSON.parse(process.env.DIBAO_DESKTOP_PROXY_CONFIG ?? "null"));
  const pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const resolveProxy: ProxyResolver = url => new Promise((resolve, reject) => {
    if (pending.size >= 128 || !process.connected) { reject(new Error("Desktop proxy resolution is unavailable")); return; }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("System proxy resolution timed out")); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    sendToDesktop({ type: "dibao-proxy-resolve", id, url }, () => {
      clearTimeout(timer); pending.delete(id); reject(new Error("System proxy resolution is unavailable"));
    });
  });
  desktopProxy = new DesktopProxyTransport(settings, resolveProxy);
  setGlobalDispatcher(desktopProxy.dispatcher);
  process.on("message", value => {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    if (typeof message.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(message.id)) return;
    if (message.type === "dibao-proxy-resolved") {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (typeof message.resolution === "string" && message.resolution.length < 4096) request.resolve(message.resolution);
      else request.reject(new Error("System proxy resolution failed"));
    } else if (message.type === "dibao-proxy-config") {
      try {
        desktopProxy!.update(message.settings);
        sendToDesktop({ type: "dibao-proxy-result", id: message.id, ok: true });
      } catch { sendToDesktop({ type: "dibao-proxy-result", id: message.id, ok: false }); }
    } else if (message.type === "dibao-proxy-test") {
      const id = message.id;
      void testDesktopProxyConnection().then(result => {
        sendToDesktop({ type: "dibao-proxy-result", id, ...result });
      });
    }
  });
  process.once("disconnect", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Desktop network is closed")); }
    pending.clear();
  });
  sendToDesktop({ type: "dibao-proxy-ready" });
}

async function testDesktopProxyConnection(): Promise<DesktopProxyTestResult> {
  const started = Date.now();
  try {
    const response = await fetch(DESKTOP_PROXY_TEST_URL, { signal: AbortSignal.timeout(12_000), redirect: "error" });
    await response.body?.cancel();
    return { ok: response.ok, elapsedMs: Date.now() - started };
  } catch { return { ok: false, elapsedMs: Date.now() - started }; }
}

export async function desktopControlledProxyTransport(url: string, target: { hostname: string; addresses: string[] }): Promise<{ dispatcher: Dispatcher; close: () => Promise<void> } | null> {
  if (!desktopProxy) return null;
  const proxy = await desktopProxy.proxyFor(url);
  if (!proxy) return null;
  const address = target.addresses[0];
  if (!address) throw new Error("Fetch target could not be resolved safely");
  const original = new URL(url);
  const pinned = new URL(original);
  pinned.hostname = address.includes(":") ? `[${address}]` : address;
  const agent = new ProxyAgent({ uri: proxy, requestTls: { servername: target.hostname } });
  // Keep DNS pinning and the original Host/SNI; the proxy cannot re-resolve a checked hostname.
  const dispatcher = agent.compose(dispatch => (options, handler) => dispatch({
    ...options,
    origin: pinned.origin,
    headers: headersWithHost(options.headers, original.host)
  }, handler));
  return { dispatcher, close: () => agent.destroy() };
}

function headersWithHost(headers: Dispatcher.DispatchOptions["headers"], host: string): string[] {
  const result: string[] = [];
  const add = (key: string, value: string | string[] | undefined) => {
    if (key.toLowerCase() === "host" || value === undefined) return;
    for (const item of Array.isArray(value) ? value : [value]) result.push(key, item);
  };
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) add(headers[index], headers[index + 1]);
  } else if (headers && Symbol.iterator in headers) {
    for (const [key, value] of headers) add(key, value);
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) add(key, value);
  }
  result.push("host", host);
  return result;
}
