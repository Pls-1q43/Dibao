import { describe, expect, it } from "vitest";
import { FullContentExtractionService } from "./full-content-extraction-service.js";

describe("FullContentExtractionService", () => {
  it("extracts readable safe HTML and removes chrome/scripts", async () => {
    const service = new FullContentExtractionService({
      minTextLength: 20,
      fetcher: async () =>
        new Response(
          `<!doctype html>
          <html>
            <head><title>Fixture Title</title><script>bad()</script><style>p{}</style></head>
            <body>
              <nav>navigation noise</nav>
              <article>
                <h1>Article Heading</h1>
                <p>First useful paragraph for the article body.</p>
                <p>Second useful paragraph with enough text.</p>
              </article>
              <footer>footer noise</footer>
            </body>
          </html>`,
          { headers: { "content-type": "text/html" } }
        )
    });

    const result = await service.extract("https://example.com/article");

    expect(result.status).toBe("success");
    expect(result.title).toBe("Fixture Title");
    expect(result.contentText).toContain("First useful paragraph");
    expect(result.contentHtml).toContain("<p>First useful paragraph");
    expect(result.contentHtml).not.toContain("script");
    expect(result.contentHtml).not.toContain("navigation noise");
  });

  it("uses plugin extracted full content before the built-in extractor", async () => {
    const service = new FullContentExtractionService({
      minTextLength: 20,
      pluginExtractor: async () => ({
        title: "Plugin Title",
        contentHtml: "<p>Plugin extracted article body with enough text.</p>",
        contentText: "Plugin extracted article body with enough text."
      }),
      fetcher: async () =>
        new Response("<html><body><article><p>Built in article body should not win.</p></article></body></html>", {
          headers: { "content-type": "text/html" }
        })
    });

    const result = await service.extract("https://example.com/article");

    expect(result.status).toBe("success");
    expect(result.title).toBe("Plugin Title");
    expect(result.contentText).toContain("Plugin extracted article body");
    expect(result.contentText).not.toContain("Built in article body");
  });

  it("falls back to built-in extraction when a plugin returns short content", async () => {
    const service = new FullContentExtractionService({
      minTextLength: 20,
      pluginExtractor: async () => ({
        contentHtml: "<p>short</p>",
        contentText: "short"
      }),
      fetcher: async () =>
        new Response(
          "<html><body><article><p>Built in article body with enough text.</p></article></body></html>",
          { headers: { "content-type": "text/html" } }
        )
    });

    const result = await service.extract("https://example.com/article");

    expect(result.status).toBe("success");
    expect(result.contentText).toContain("Built in article body");
  });

  it("fails or skips invalid, non-html, short, and 500 responses", async () => {
    const service = new FullContentExtractionService({
      minTextLength: 200,
      fetcher: async (url) => {
        if (String(url).includes("json")) {
          return new Response("{}", { headers: { "content-type": "application/json" } });
        }
        if (String(url).includes("short")) {
          return new Response("<article><p>short</p></article>", {
            headers: { "content-type": "text/html" }
          });
        }
        return new Response("nope", { status: 500, headers: { "content-type": "text/html" } });
      }
    });

    await expect(service.extract("ftp://example.com/article")).resolves.toMatchObject({
      status: "failed"
    });
    await expect(service.extract("https://example.com/json")).resolves.toMatchObject({
      status: "skipped"
    });
    await expect(service.extract("https://example.com/short")).resolves.toMatchObject({
      status: "skipped"
    });
    await expect(service.extract("https://example.com/500")).resolves.toMatchObject({
      status: "failed"
    });
  });
});
