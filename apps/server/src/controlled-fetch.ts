import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_FEED_FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_FULL_CONTENT_FETCH_MAX_BYTES = 3 * 1024 * 1024;

export type ControlledFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  url?: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

export type ControlledFetcher = (
  url: string,
  init?: RequestInit
) => Promise<ControlledFetchResponse>;

export type HostnameResolver = (hostname: string) => Promise<string[]>;

export type FetchPrivacyWarning = {
  url: string;
  hostname: string;
  reason: string;
};

export type ControlledFetchTextOptions = {
  fetcher?: ControlledFetcher;
  method?: RequestInit["method"];
  headers?: RequestInit["headers"];
  body?: RequestInit["body"];
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivateNetwork?: boolean;
  allowCidrs?: string[];
  maxRedirects?: number;
  onWarning?: (warning: FetchPrivacyWarning) => void;
  resolveHostname?: HostnameResolver;
};

export class ControlledFetchError extends Error {
  constructor(
    readonly code:
      | "FETCH_TIMEOUT"
      | "FETCH_TOO_LARGE"
      | "FETCH_READ_FAILED"
      | "FETCH_PRIVATE_TARGET",
    message: string
  ) {
    super(message);
    this.name = "ControlledFetchError";
  }
}

export async function controlledFetchText(
  url: string,
  options: ControlledFetchTextOptions = {}
): Promise<{ response: ControlledFetchResponse; body: string }> {
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs ?? readPositiveIntegerEnv("DIBAO_FETCH_TIMEOUT_MS"),
    DEFAULT_FETCH_TIMEOUT_MS
  );
  const maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_FEED_FETCH_MAX_BYTES);
  const maxRedirects = normalizeNonNegativeInteger(options.maxRedirects, 10);
  const privacyPolicy = privacyPolicyForOptions(options);

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let currentUrl = url;
  let currentMethod = options.method;
  let currentHeaders = options.headers;
  let currentBody = options.body;
  let response: ControlledFetchResponse | null = null;
  let closeResponseTransport: (() => Promise<void>) | null = null;

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ControlledFetchError("FETCH_TIMEOUT", `Fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const target = await Promise.race([
        resolveAllowedFetchTarget(currentUrl, privacyPolicy, options.onWarning),
        timeoutPromise
      ]);
      const attemptPromise = fetchControlledTarget(currentUrl, {
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        redirect: "manual",
        signal: controller.signal
      }, target, options.fetcher);
      attemptPromise.catch(() => undefined);
      const attempt = await Promise.race([attemptPromise, timeoutPromise]);
      response = attempt.response;
      closeResponseTransport = attempt.close;
      const responseUrl = response.url && response.url !== currentUrl ? response.url : currentUrl;
      await Promise.race([
        resolveAllowedFetchTarget(responseUrl, privacyPolicy, options.onWarning),
        timeoutPromise
      ]);

      const location = response.headers.get("location");
      if (isRedirectStatus(response.status) && location) {
        await response.body?.cancel().catch(() => undefined);
        await attempt.close();
        closeResponseTransport = null;
        if (redirects >= maxRedirects) {
          throw new ControlledFetchError(
            "FETCH_READ_FAILED",
            `Fetch exceeded ${maxRedirects} redirects`
          );
        }
        const nextUrl = new URL(location, responseUrl).toString();
        await Promise.race([
          resolveAllowedFetchTarget(nextUrl, privacyPolicy, options.onWarning),
          timeoutPromise
        ]);
        const redirectRequest = redirectedRequest({
          status: response.status,
          fromUrl: responseUrl,
          toUrl: nextUrl,
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody
        });
        currentUrl = nextUrl;
        currentMethod = redirectRequest.method;
        currentHeaders = redirectRequest.headers;
        currentBody = redirectRequest.body;
        continue;
      }
      break;
    }

    if (!response) {
      throw new ControlledFetchError("FETCH_READ_FAILED", "Fetch did not return a response");
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const parsedLength = Number(contentLength);
      if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
        throw new ControlledFetchError(
          "FETCH_TOO_LARGE",
          `Fetch response exceeded ${maxBytes} bytes`
        );
      }
    }

    const body = await Promise.race([
      readResponseBody(response, maxBytes),
      timeoutPromise
    ]);
    return { response, body };
  } catch (error) {
    if (timedOut || isAbortError(error)) {
      throw new ControlledFetchError("FETCH_TIMEOUT", `Fetch timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    await closeResponseTransport?.().catch(() => undefined);
  }
}

export async function assertControlledFetchTarget(
  url: string,
  options: Pick<
    ControlledFetchTextOptions,
    "allowPrivateNetwork" | "allowCidrs" | "onWarning" | "resolveHostname"
  > = {}
): Promise<void> {
  await resolveAllowedFetchTarget(url, privacyPolicyForOptions(options), options.onWarning);
}

export function feedFetchMaxBytes(): number {
  return normalizePositiveInteger(
    readPositiveIntegerEnv("DIBAO_FETCH_FEED_MAX_BYTES"),
    DEFAULT_FEED_FETCH_MAX_BYTES
  );
}

export function feedFetchAllowPrivateNetwork(): boolean {
  return readBooleanEnv("DIBAO_FETCH_FEED_ALLOW_PRIVATE") ?? true;
}

export function feedFetchAllowCidrs(): string[] {
  return readCsvEnv("DIBAO_FETCH_FEED_ALLOW_CIDRS") ?? [];
}

export function fullContentFetchMaxBytes(): number {
  return normalizePositiveInteger(
    readPositiveIntegerEnv("DIBAO_FETCH_FULL_CONTENT_MAX_BYTES"),
    DEFAULT_FULL_CONTENT_FETCH_MAX_BYTES
  );
}

async function readResponseBody(response: ControlledFetchResponse, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ControlledFetchError(
          "FETCH_TOO_LARGE",
          `Fetch response exceeded ${maxBytes} bytes`
        );
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    if (error instanceof ControlledFetchError) {
      throw error;
    }
    throw new ControlledFetchError("FETCH_READ_FAILED", errorMessage(error));
  }
}

type FetchPrivacyPolicy = {
  allowPrivateNetwork: boolean;
  allowCidrs: ParsedCidr[];
  resolveHostname: HostnameResolver;
};

type AllowedFetchTarget = {
  hostname: string;
  addresses: string[];
};

async function resolveAllowedFetchTarget(
  urlValue: string,
  policy: FetchPrivacyPolicy,
  onWarning?: (warning: FetchPrivacyWarning) => void
): Promise<AllowedFetchTarget> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return { hostname: "", addresses: [] };
  }

  const hostname = normalizeHostname(url.hostname);
  const hostnameReason = privateTargetReason(hostname);
  const directIpAllowed = isAllowedPrivateIp(hostname, policy);
  if (hostnameReason) {
    const warning = { url: url.toString(), hostname, reason: hostnameReason };
    onWarning?.(warning);
    if (!policy.allowPrivateNetwork && !directIpAllowed) {
      const addresses = await resolveHostnameAddresses(hostname, policy.resolveHostname);
      if (addresses.length === 0 || !addresses.every((address) => isAllowedPrivateIp(address, policy))) {
        throw privateTargetError(warning);
      }
      return { hostname, addresses };
    }
    if (isIP(hostname) !== 0) {
      return { hostname, addresses: [hostname] };
    }
    const addresses = await resolveHostnameAddresses(hostname, policy.resolveHostname);
    if (addresses.length === 0) {
      throw fetchTargetResolutionError(hostname);
    }
    return { hostname, addresses };
  }

  if (isIP(hostname) !== 0) {
    return { hostname, addresses: [hostname] };
  }

  const addresses = await resolveHostnameAddresses(hostname, policy.resolveHostname);
  if (addresses.length === 0) {
    throw fetchTargetResolutionError(hostname);
  }
  for (const address of addresses) {
    const reason = privateTargetReason(address);
    if (!reason) {
      continue;
    }
    const warning = { url: url.toString(), hostname: address, reason };
    onWarning?.(warning);
    if (!policy.allowPrivateNetwork && !isAllowedPrivateIp(address, policy)) {
      throw privateTargetError(warning);
    }
  }
  return { hostname, addresses };
}

function privateTargetError(warning: FetchPrivacyWarning): ControlledFetchError {
  return new ControlledFetchError(
    "FETCH_PRIVATE_TARGET",
    `Fetch target is blocked by private-network policy: ${warning.hostname} (${warning.reason})`
  );
}

function fetchTargetResolutionError(hostname: string): ControlledFetchError {
  return new ControlledFetchError(
    "FETCH_READ_FAILED",
    `Fetch target could not be resolved safely: ${hostname}`
  );
}

async function fetchControlledTarget(
  url: string,
  init: RequestInit,
  target: AllowedFetchTarget,
  fetcher: ControlledFetcher | undefined
): Promise<{ response: ControlledFetchResponse; close: () => Promise<void> }> {
  if (fetcher) {
    return {
      response: await fetcher(url, init),
      close: async () => undefined
    };
  }

  const address = target.addresses[0];
  if (!address) {
    throw fetchTargetResolutionError(target.hostname);
  }
  const agent = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const family = isIP(address) as 4 | 6;
        if (options.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      }
    }
  });
  try {
    const response = await fetch(url, {
      ...init,
      dispatcher: agent
    } as RequestInit);
    return {
      response,
      close: () => agent.destroy()
    };
  } catch (error) {
    await agent.destroy().catch(() => undefined);
    throw error;
  }
}

async function resolveHostnameAddresses(
  hostname: string,
  resolver: HostnameResolver
): Promise<string[]> {
  try {
    return await resolver(hostname);
  } catch {
    return [];
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
}

function privateTargetReason(hostname: string): string | null {
  hostname = normalizeHostname(hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "localhost";
  }
  if (hostname.endsWith(".local")) {
    return "local-domain";
  }
  if (hostname === "metadata.google.internal") {
    return "metadata-host";
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return privateIpv4Reason(hostname);
  }
  if (ipVersion === 6) {
    return privateIpv6Reason(hostname);
  }

  return null;
}

function privateIpv4Reason(hostname: string): string | null {
  const parts = hostname.split(".").map((part) => Number(part));
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) {
    return "private-ipv4";
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return "private-ipv4";
  }
  if (a === 192 && b === 168) {
    return "private-ipv4";
  }
  if (a === 169 && b === 254) {
    return "link-local-ipv4";
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "carrier-grade-nat-ipv4";
  }
  return null;
}

function privateIpv6Reason(hostname: string): string | null {
  if (hostname === "::1") {
    return "loopback-ipv6";
  }
  if (hostname.startsWith("fc") || hostname.startsWith("fd")) {
    return "unique-local-ipv6";
  }
  if (hostname.startsWith("fe80:")) {
    return "link-local-ipv6";
  }
  return null;
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function privacyPolicyForOptions(options: ControlledFetchTextOptions): FetchPrivacyPolicy {
  return {
    allowPrivateNetwork:
      options.allowPrivateNetwork ?? readBooleanEnv("DIBAO_FETCH_ALLOW_PRIVATE") ?? false,
    allowCidrs: parseCidrs(options.allowCidrs ?? readCsvEnv("DIBAO_FETCH_ALLOW_CIDRS")),
    resolveHostname: options.resolveHostname ?? resolveDnsHostname
  };
}

async function resolveDnsHostname(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

function readBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function readCsvEnv(name: string): string[] | undefined {
  const value = process.env[name];
  return value === undefined
    ? undefined
    : value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

type ParsedCidr = {
  version: 4 | 6;
  network: bigint;
  bits: number;
};

function parseCidrs(values: string[] | undefined): ParsedCidr[] {
  return (values ?? []).flatMap((value) => {
    const [address, prefixValue] = value.split("/");
    const version = isIP(address);
    if (version !== 4 && version !== 6) {
      return [];
    }
    const maxBits = version === 4 ? 32 : 128;
    const bits =
      prefixValue === undefined || prefixValue === ""
        ? maxBits
        : Number(prefixValue);
    if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
      return [];
    }
    const parsedAddress = ipToBigInt(address, version);
    if (parsedAddress === null) {
      return [];
    }
    return [{
      version,
      network: applyCidrMask(parsedAddress, bits, maxBits),
      bits
    }];
  });
}

function isAllowedPrivateIp(hostname: string, policy: FetchPrivacyPolicy): boolean {
  const version = isIP(hostname);
  if (version !== 4 && version !== 6) {
    return false;
  }
  const parsed = ipToBigInt(hostname, version);
  if (parsed === null) {
    return false;
  }
  const maxBits = version === 4 ? 32 : 128;
  return policy.allowCidrs.some((cidr) =>
    cidr.version === version && applyCidrMask(parsed, cidr.bits, maxBits) === cidr.network
  );
}

function ipToBigInt(address: string, version: 4 | 6): bigint | null {
  return version === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
}

function ipv4ToBigInt(address: string): bigint | null {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((value, part) => (value << 8n) + BigInt(part), 0n);
}

function ipv6ToBigInt(address: string): bigint | null {
  const normalized = address.toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = halves.length === 2
    ? [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    : left;
  if (
    groups.length !== 8 ||
    missing < 0 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))
  ) {
    return null;
  }
  return groups.reduce((value, group) => (value << 16n) + BigInt(Number.parseInt(group, 16)), 0n);
}

function applyCidrMask(value: bigint, bits: number, maxBits: number): bigint {
  if (bits === 0) {
    return 0n;
  }
  const shift = BigInt(maxBits - bits);
  return (value >> shift) << shift;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectedRequest(input: {
  status: number;
  fromUrl: string;
  toUrl: string;
  method: RequestInit["method"] | undefined;
  headers: RequestInit["headers"] | undefined;
  body: RequestInit["body"] | undefined;
}): {
  method: RequestInit["method"] | undefined;
  headers: RequestInit["headers"] | undefined;
  body: RequestInit["body"] | undefined;
} {
  const normalizedMethod = String(input.method ?? "GET").toUpperCase();
  const shouldRewriteToGet =
    (input.status === 303 && normalizedMethod !== "HEAD") ||
    ((input.status === 301 || input.status === 302) && normalizedMethod === "POST");
  const crossOrigin = new URL(input.fromUrl).origin !== new URL(input.toUrl).origin;
  let headers = input.headers;

  if (crossOrigin || shouldRewriteToGet) {
    const rewritten = new Headers(headers);
    if (crossOrigin) {
      for (const name of Array.from(rewritten.keys())) {
        if (isSensitiveRedirectHeader(name)) {
          rewritten.delete(name);
        }
      }
    }
    if (shouldRewriteToGet) {
      rewritten.delete("content-length");
      rewritten.delete("content-type");
    }
    headers = rewritten;
  }

  return {
    method: shouldRewriteToGet ? "GET" : input.method,
    headers,
    body: shouldRewriteToGet ? undefined : input.body
  };
}

function isSensitiveRedirectHeader(name: string): boolean {
  return /authorization|cookie|api[-_]?key|token|secret|signature/iu.test(name);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
