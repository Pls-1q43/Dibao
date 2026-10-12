import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlledFetchText, resolveDesktopFakeIpAddresses } from "./controlled-fetch.js";
import { isDesktopNetworkingActive } from "./desktop-proxy.js";

vi.mock("./desktop-proxy.js", () => ({
  isDesktopNetworkingActive: vi.fn(() => false),
  desktopControlledProxyTransport: vi.fn(async () => null)
}));

function dnsResponse(data: string[] = ["93.184.216.34"], hostname = "publisher.example") {
  return new Response(JSON.stringify({ Status: 0, Question: [{ name: `${hostname}.`, type: 1 }],
    Answer: data.map(address => ({ type: 1, data: address, TTL: 0 })) }));
}

describe("desktop Fake-IP compatibility", () => {
  beforeEach(() => vi.mocked(isDesktopNetworkingActive).mockReturnValue(true));
  afterEach(() => vi.unstubAllGlobals());

  it("resolves real public IPs over pinned, bounded HTTPS without exposing article paths", async () => {
    const fetcher = vi.fn(async () => dnsResponse());
    vi.stubGlobal("fetch", fetcher);
    expect(await resolveDesktopFakeIpAddresses("publisher.example", ["198.18.0.18"])).toEqual(["93.184.216.34"]);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloudflare-dns.com/dns-query?name=publisher.example&type=A");
    expect(options).toMatchObject({ redirect: "error", headers: { accept: "application/dns-json" } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not affect Docker, normal DNS, literal IPs, local names or mixed private answers", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const fake = ["198.18.0.18"];
    vi.mocked(isDesktopNetworkingActive).mockReturnValue(false);
    expect(await resolveDesktopFakeIpAddresses("publisher.example", fake)).toEqual(fake);
    vi.mocked(isDesktopNetworkingActive).mockReturnValue(true);
    for (const [hostname, addresses] of [
      ["publisher.example", ["93.184.216.34"]], ["198.18.0.18", fake], ["router.local", fake],
      ["metadata.google.internal", fake], ["localhost", fake], ["printer", fake],
      ["publisher.example", [...fake, "127.0.0.1"]]
    ] as [string, string[]][]) expect(await resolveDesktopFakeIpAddresses(hostname, addresses)).toEqual(addresses);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "198.18.0.19", "::1", "not-an-ip"])("rejects unsafe DNS answer %s without fetching an article", async address => {
    const fetcher = vi.fn(async () => dnsResponse([address])); vi.stubGlobal("fetch", fetcher);
    const article = vi.fn();
    await expect(controlledFetchText("https://publisher.example/article", {
      resolveHostname: hostname => resolveDesktopFakeIpAddresses(hostname, ["198.18.0.18"]), fetcher: article
    })).rejects.toThrow("could not be resolved safely");
    expect(article).not.toHaveBeenCalled();
  });

  it("fails closed on DNS errors, mismatched questions and oversized responses", async () => {
    for (const response of [new Response("down", { status: 503 }), dnsResponse([], "other.example"), new Response("x".repeat(33 * 1024))]) {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      await expect(resolveDesktopFakeIpAddresses("publisher.example", ["198.18.0.18"])).rejects.toThrow();
    }
  });

  it("keeps redirect destinations subject to the private-network policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => dnsResponse()));
    const article = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    await expect(controlledFetchText("https://publisher.example/article", {
      resolveHostname: hostname => resolveDesktopFakeIpAddresses(hostname, ["198.18.0.18"]), fetcher: article
    })).rejects.toMatchObject({ code: "FETCH_PRIVATE_TARGET" });
    expect(article).toHaveBeenCalledOnce();
  });
});
