import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  openDatabase,
  SqliteArticleRepository,
  SqliteFeedRepository,
  type DibaoDatabase
} from "@dibao/db";
import {
  effectiveContentHash,
  FeedRefreshService,
  type FeedFetchResponse
} from "./feed-refresh-service.js";
import type { HostnameResolver } from "./controlled-fetch.js";

const publicTestResolver: HostnameResolver = async () => ["203.0.113.10"];

describe("FeedRefreshService full content maintenance", () => {
  it("allows self-hosted private feed URLs while still recording a warning", async () => {
    const db = fixtureDb();
    try {
      const warnings: Array<{ hostname: string; reason: string }> = [];
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const service = new FeedRefreshService({
        db,
        feeds,
        articles,
        fetcher: feedFetcher(fixtureRss()),
        onFetchWarning: (warning) =>
          warnings.push({ hostname: warning.hostname, reason: warning.reason }),
        now: () => 1000
      });

      const result = await service.addFeed({ feedUrl: "http://127.0.0.1:80/feed/10.xml" });

      expect(result.articlesCreated).toBe(2);
      expect(feeds.findByFeedUrl("http://127.0.0.1/feed/10.xml")).not.toBeNull();
      expect(warnings).toContainEqual({ hostname: "127.0.0.1", reason: "private-ipv4" });
    } finally {
      db.close();
    }
  });

  it("keeps feed_only refreshes on feed content and does not fetch article URLs", async () => {
    const db = fixtureDb();
    try {
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const extractor = { extract: vi.fn() };
      const service = new FeedRefreshService({
        db,
        feeds,
        articles,
        fullContentExtractor: extractor,
        fetcher: feedFetcher(fixtureRss()),
        resolveHostname: publicTestResolver,
        now: () => 1000
      });

      const result = await service.addFeed({ feedUrl: "https://example.com/feed.xml" });

      expect(extractor.extract).not.toHaveBeenCalled();
      expect(result.fullContent).toEqual({ attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
      expect(result.effectiveContentChangedArticleIds).toHaveLength(2);
      expect(articles.findDetailById(result.articleIds[0])?.extractionStatus).toBe("feed_only");
    } finally {
      db.close();
    }
  });

  it("fetches full content only when enabled and reports changed effective content", async () => {
    const db = fixtureDb();
    try {
      const feeds = new SqliteFeedRepository(db);
      const articles = new SqliteArticleRepository(db);
      const extractor = {
        extract: vi.fn(async (url: string) =>
          url.endsWith("/broken")
            ? {
                articleUrl: url,
                status: "failed" as const,
                title: null,
                contentHtml: null,
                contentText: null,
                excerpt: null,
                error: "HTTP 500"
              }
            : {
                articleUrl: url,
                status: "success" as const,
                title: "Full title",
                contentHtml: "<p>Expanded full content searchable refresh body.</p>",
                contentText: "Expanded full content searchable refresh body.",
                excerpt: "Expanded full content searchable refresh body.",
                error: null
              }
        )
      };
      const service = new FeedRefreshService({
        db,
        feeds,
        articles,
        fullContentExtractor: extractor,
        fetcher: feedFetcher(fixtureRss()),
        resolveHostname: publicTestResolver,
        now: () => 1000
      });

      await service.addFeed({ feedUrl: "https://example.com/feed.xml" });
      feeds.update({
        id: feeds.findByFeedUrl("https://example.com/feed.xml")!.id,
        fullContentMode: "fetch_full_content",
        now: 2000
      });
      const result = await service.refreshFeed(feeds.findByFeedUrl("https://example.com/feed.xml")!.id);

      expect(extractor.extract).toHaveBeenCalledTimes(2);
      expect(result.fullContent).toEqual({ attempted: 2, succeeded: 1, failed: 1, skipped: 0 });
      expect(result.effectiveContentChangedArticleIds).toHaveLength(1);

      const success = result.articleIds
        .map((id) => articles.findDetailById(id))
        .find((article) => article?.url.endsWith("/alpha"));
      const failed = result.articleIds
        .map((id) => articles.findDetailById(id))
        .find((article) => article?.url.endsWith("/broken"));
      expect(success?.extractionStatus).toBe("success");
      expect(success?.contentText).toContain("Expanded full content");
      expect(failed?.extractionStatus).toBe("failed");
      expect(failed?.contentText).toContain("Feed only broken body");
      expect(
        db.prepare("select count(*) as count from behavior_events").get() as { count: number }
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("includes the content source in effective content hashes", () => {
    const feedHash = effectiveContentHash({
      title: "Title",
      contentText: "Same text",
      source: "feed"
    });
    const fullHash = effectiveContentHash({
      title: "Title",
      contentText: "Same text",
      source: "full_content"
    });

    expect(feedHash).not.toBe(fullHash);
  });
});

function fixtureDb(): DibaoDatabase {
  const dir = mkdtempSync(join(tmpdir(), "dibao-feed-refresh-"));
  return openDatabase(join(dir, "test.sqlite"), { migrate: true });
}

function feedFetcher(xml: string) {
  return async (): Promise<FeedFetchResponse> => new Response(xml);
}

function fixtureRss(): string {
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    <description>Fixture feed</description>
    <item>
      <title>Alpha</title>
      <link>https://example.com/alpha</link>
      <guid>alpha</guid>
      <description>Alpha summary</description>
      <content:encoded><![CDATA[<p>Feed only alpha body</p>]]></content:encoded>
    </item>
    <item>
      <title>Broken</title>
      <link>https://example.com/broken</link>
      <guid>broken</guid>
      <description>Broken summary</description>
      <content:encoded><![CDATA[<p>Feed only broken body</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;
}
