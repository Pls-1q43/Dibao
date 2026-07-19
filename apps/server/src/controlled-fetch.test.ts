import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  ControlledFetchError,
  controlledFetchText,
  type FetchPrivacyWarning
} from "./controlled-fetch.js";

const publicResolver = async () => ["93.184.216.34"];

describe("controlledFetchText", () => {
  it("reads normal text responses", async () => {
    const result = await controlledFetchText("https://example.com/feed.xml", {
      fetcher: async () => new Response("hello"),
      maxBytes: 100,
      resolveHostname: publicResolver
    });

    expect(result.body).toBe("hello");
    expect(result.response.ok).toBe(true);
  });

  it("fails before reading when content-length exceeds the byte limit", async () => {
    await expect(
      controlledFetchText("https://example.com/large.xml", {
        fetcher: async () =>
          new Response("small", {
            headers: {
              "content-length": "101"
            }
        }),
        maxBytes: 100,
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({
      code: "FETCH_TOO_LARGE"
    } satisfies Partial<ControlledFetchError>);
  });

  it("fails while streaming when the body exceeds the byte limit", async () => {
    await expect(
      controlledFetchText("https://example.com/large.xml", {
        fetcher: async () => new Response("x".repeat(101)),
        maxBytes: 100,
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({
      code: "FETCH_TOO_LARGE"
    } satisfies Partial<ControlledFetchError>);
  });

  it("times out slow fetches", async () => {
    await expect(
      controlledFetchText("https://example.com/slow.xml", {
        fetcher: () => new Promise<Response>(() => undefined),
        timeoutMs: 1,
        maxBytes: 100,
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({
      code: "FETCH_TIMEOUT"
    } satisfies Partial<ControlledFetchError>);
  });

  it("blocks private targets by default", async () => {
    const warnings: FetchPrivacyWarning[] = [];

    await expect(
      controlledFetchText("http://192.168.1.2/feed.xml", {
        fetcher: async () => new Response("ok"),
        maxBytes: 100,
        onWarning: (warning) => warnings.push(warning)
      })
    ).rejects.toMatchObject({
      code: "FETCH_PRIVATE_TARGET"
    } satisfies Partial<ControlledFetchError>);

    expect(warnings).toMatchObject([
      { hostname: "192.168.1.2", reason: "private-ipv4" }
    ]);
  });

  it("blocks localhost and metadata hostnames by default", async () => {
    for (const url of [
      "http://127.0.0.1:8080/rss.xml",
      "http://localhost/rss.xml",
      "http://metadata.google.internal/latest/meta-data"
    ]) {
      await expect(
        controlledFetchText(url, {
          fetcher: async () => new Response("ok"),
          maxBytes: 100
        })
      ).rejects.toMatchObject({
        code: "FETCH_PRIVATE_TARGET"
      } satisfies Partial<ControlledFetchError>);
    }
  });

  it("blocks private targets reached through redirects", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url === "https://example.com/feed.xml"
        ? new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/final" }
          })
        : new Response("ok")
    );

    await expect(
      controlledFetchText("https://example.com/feed.xml", {
        fetcher,
        maxBytes: 100,
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({
      code: "FETCH_PRIVATE_TARGET"
    } satisfies Partial<ControlledFetchError>);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("blocks hostnames that resolve to private IP addresses", async () => {
    await expect(
      controlledFetchText("https://private.example/feed.xml", {
        fetcher: async () => new Response("ok"),
        maxBytes: 100,
        resolveHostname: async () => ["169.254.169.254"]
      })
    ).rejects.toMatchObject({
      code: "FETCH_PRIVATE_TARGET"
    } satisfies Partial<ControlledFetchError>);
  });

  it("pins the default transport to the DNS address that passed policy validation", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(
        controlledFetchText(`http://does-not-resolve.invalid:${port}/feed.xml`, {
          allowCidrs: ["127.0.0.1/32"],
          maxBytes: 100,
          resolveHostname: async () => ["127.0.0.1"]
        })
      ).resolves.toMatchObject({ body: "pinned" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("allows private targets when explicitly enabled or allowlisted", async () => {
    const result = await controlledFetchText("http://192.168.1.2/feed.xml", {
      fetcher: async () => new Response("ok"),
      maxBytes: 100,
      allowPrivateNetwork: true
    });
    expect(result.body).toBe("ok");

    await expect(
      controlledFetchText("http://192.168.1.25/feed.xml", {
        fetcher: async () => new Response("allowed"),
        maxBytes: 100,
        allowCidrs: ["192.168.1.0/24"]
      })
    ).resolves.toMatchObject({ body: "allowed" });
  });

  it("passes timeout abort signals to the fetcher", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("ok");
    });

    await controlledFetchText("https://example.com/feed.xml", {
      fetcher,
      timeoutMs: 100,
      maxBytes: 100,
      resolveHostname: publicResolver
    });

    expect(fetcher).toHaveBeenCalledOnce();
  });
});
