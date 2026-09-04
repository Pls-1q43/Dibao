import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dibaoVersion,
  sanitizeTelemetryEvent,
  sanitizeTelemetryUrl
} from "./index.js";

describe("shared package", () => {
  it("exports the root package version", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
    ) as { version: string };

    expect(dibaoVersion).toBe(rootPackageJson.version);
  });

  it("removes credentials, queries, and fragments from telemetry URLs", () => {
    expect(
      sanitizeTelemetryUrl("https://reader:secret@dibao.test/api/search?q=private#result")
    ).toBe("https://dibao.test/api/search");
    expect(sanitizeTelemetryUrl("/api/search?q=private#result")).toBe("/api/search");
  });

  it("sanitizes nested Sentry request, breadcrumb, and span data", () => {
    const event = {
      request: {
        url: "https://dibao.test/?view=search&q=private",
        query_string: "view=search&q=private"
      },
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: "/?view=recommended",
            to: "/?view=search&q=private",
            url: "/api/search?q=private",
            method: "GET"
          }
        }
      ],
      spans: [
        { data: { "url.full": "https://dibao.test/api/search?q=private" } }
      ]
    };

    expect(sanitizeTelemetryEvent(event)).toEqual({
      request: { url: "https://dibao.test/" },
      breadcrumbs: [{
        category: "navigation",
        data: {
          from: "/",
          to: "/",
          url: "/api/search",
          method: "GET"
        }
      }],
      spans: [{ data: { "url.full": "https://dibao.test/api/search" } }]
    });
  });
});
