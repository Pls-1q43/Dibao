import {
  FeedParseError,
  normalizeFeedUrl,
  parseFeedXml,
  type ParsedFeed
} from "@dibao/rss";
import type { FeedRepository } from "@dibao/db";
import {
  controlledFetchText,
  feedFetchAllowCidrs,
  feedFetchAllowPrivateNetwork,
  feedFetchMaxBytes,
  type FetchPrivacyWarning,
  type HostnameResolver
} from "./controlled-fetch.js";
import type { FeedFetcher, FeedFetchResponse } from "./feed-refresh-service.js";

export type FeedDiscoveryInput = {
  url: string;
};

export type FeedDiscoveryCandidateStatus = "valid" | "duplicate" | "invalid";

export type FeedDiscoveryCandidate = {
  feedUrl: string;
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  format: "rss" | "atom" | "unknown";
  status: FeedDiscoveryCandidateStatus;
  existingFeedId: string | null;
  itemCount: number;
  recentItems: Array<{
    title: string;
    url: string | null;
    publishedAt: number | null;
  }>;
  error: string | null;
};

export type FeedDiscoveryResult = {
  inputUrl: string;
  normalizedUrl: string;
  inputKind: "feed" | "html" | "unknown";
  candidates: FeedDiscoveryCandidate[];
  warnings: string[];
};

export type FeedDiscoveryServiceOptions = {
  feeds: Pick<FeedRepository, "findByFeedUrl">;
  fetcher?: FeedFetcher;
  onFetchWarning?: (warning: FetchPrivacyWarning) => void;
  resolveHostname?: HostnameResolver;
};

export type FeedDiscoveryErrorCode = "VALIDATION_ERROR" | "PROVIDER_ERROR";

export class FeedDiscoveryError extends Error {
  constructor(
    readonly code: FeedDiscoveryErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "FeedDiscoveryError";
  }
}

type LinkCandidate = {
  feedUrl: string;
  title: string | null;
};

const alternateFeedTypes = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml"
]);

const fallbackFeedPaths = ["/feed", "/feed.xml", "/rss", "/rss.xml", "/atom.xml", "/index.xml"];

export class FeedDiscoveryService {
  private readonly fetcher: FeedFetcher | undefined;

  constructor(private readonly options: FeedDiscoveryServiceOptions) {
    this.fetcher = options.fetcher;
  }

  async discover(input: FeedDiscoveryInput): Promise<FeedDiscoveryResult> {
    const normalizedUrl = normalizeHttpUrl(input.url, "url");
    const warnings: string[] = [];
    const inputResponse = await this.fetchText(normalizedUrl, "Input URL fetch failed");

    let parsedInput: ParsedFeed | null = null;
    try {
      parsedInput = parseFeedXml(inputResponse.body, normalizedUrl);
    } catch {
      parsedInput = null;
    }

    if (parsedInput) {
      return {
        inputUrl: input.url,
        normalizedUrl,
        inputKind: "feed",
        candidates: [this.candidateForParsedFeed(normalizedUrl, parsedInput, inputResponse.body)],
        warnings
      };
    }

    const linkCandidates = linkCandidatesFromHtml(inputResponse.body, normalizedUrl);
    const discoveryCandidates =
      linkCandidates.length > 0
        ? linkCandidates
        : await this.fallbackCandidates(normalizedUrl, warnings);

    if (discoveryCandidates.length === 0) {
      warnings.push("No RSS or Atom feed was found for this page.");
      return {
        inputUrl: input.url,
        normalizedUrl,
        inputKind: "html",
        candidates: [],
        warnings
      };
    }

    const candidates: FeedDiscoveryCandidate[] = [];
    for (const candidate of dedupeLinkCandidates(discoveryCandidates)) {
      candidates.push(await this.preflightCandidate(candidate));
    }

    if (!candidates.some((candidate) => candidate.status === "valid")) {
      warnings.push("No addable RSS or Atom feed was found.");
    }

    return {
      inputUrl: input.url,
      normalizedUrl,
      inputKind: "html",
      candidates,
      warnings
    };
  }

  private async fallbackCandidates(baseUrl: string, warnings: string[]): Promise<LinkCandidate[]> {
    const candidates: LinkCandidate[] = [];
    const base = new URL(baseUrl);
    for (const path of fallbackFeedPaths) {
      const feedUrl = normalizeHttpUrl(new URL(path, base.origin).toString(), "feedUrl");
      try {
        const response = await this.fetchText(feedUrl, "Feed candidate fetch failed");
        parseFeedXml(response.body, feedUrl);
        candidates.push({ feedUrl, title: null });
      } catch {
        // Fallback probing is best-effort; individual failures are exposed only if a
        // candidate was explicitly advertised and then failed validation.
      }
    }

    if (candidates.length === 0) {
      warnings.push("The page did not declare an RSS or Atom alternate link.");
    }
    return candidates;
  }

  private async preflightCandidate(candidate: LinkCandidate): Promise<FeedDiscoveryCandidate> {
    const feedUrl = normalizeHttpUrl(candidate.feedUrl, "feedUrl");
    let body = "";

    try {
      const response = await this.fetchText(feedUrl, "Feed candidate fetch failed");
      body = response.body;
      const parsed = parseFeedXml(body, feedUrl);
      return this.candidateForParsedFeed(feedUrl, parsed, body, candidate.title);
    } catch (error) {
      return invalidCandidate(feedUrl, candidate.title, humanReadableError(error));
    }
  }

  private candidateForParsedFeed(
    feedUrl: string,
    parsed: ParsedFeed,
    body: string,
    fallbackTitle?: string | null
  ): FeedDiscoveryCandidate {
    const existing = this.options.feeds.findByFeedUrl(feedUrl);
    return {
      feedUrl,
      title: parsed.title || fallbackTitle || null,
      siteUrl: parsed.siteUrl,
      description: parsed.description,
      format: feedFormatForBody(body),
      status: existing ? "duplicate" : "valid",
      existingFeedId: existing?.id ?? null,
      itemCount: parsed.items.length,
      recentItems: parsed.items.slice(0, 3).map((item) => ({
        title: item.title,
        url: item.url ?? null,
        publishedAt: item.publishedAt
      })),
      error: null
    };
  }

  private async fetchText(url: string, failureMessage: string): Promise<{ body: string }> {
    let result: { response: FeedFetchResponse; body: string };
    try {
      result = await controlledFetchText(url, {
        fetcher: this.fetcher,
        headers: {
          accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8"
        },
        allowPrivateNetwork: feedFetchAllowPrivateNetwork(),
        allowCidrs: feedFetchAllowCidrs(),
        maxBytes: feedFetchMaxBytes(),
        onWarning: this.options.onFetchWarning,
        resolveHostname: this.options.resolveHostname
      });
    } catch (error) {
      throw new FeedDiscoveryError("PROVIDER_ERROR", 502, failureMessage, {
        cause: errorMessage(error)
      });
    }

    const response = result.response;
    if (!response.ok) {
      throw new FeedDiscoveryError("PROVIDER_ERROR", 502, failureMessage, {
        status: response.status,
        statusText: response.statusText ?? null
      });
    }

    return { body: result.body };
  }
}

function normalizeHttpUrl(input: string, field: string): string {
  let normalized: string;
  try {
    normalized = normalizeFeedUrl(input);
  } catch {
    throw new FeedDiscoveryError("VALIDATION_ERROR", 400, `${field} must be a valid URL`, {
      field
    });
  }

  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FeedDiscoveryError("VALIDATION_ERROR", 400, `${field} must use http or https`, {
      field
    });
  }

  return url.toString();
}

function linkCandidatesFromHtml(html: string, baseUrl: string): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  const linkTagPattern = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkTagPattern.exec(html)) !== null) {
    const attributes = parseHtmlAttributes(match[0]);
    const relTokens = (attributes.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const type = (attributes.type ?? "").toLowerCase();
    const href = attributes.href;

    if (!relTokens.includes("alternate") || !href || !alternateFeedTypes.has(type)) {
      continue;
    }

    try {
      candidates.push({
        feedUrl: normalizeHttpUrl(new URL(href, baseUrl).toString(), "feedUrl"),
        title: attributes.title?.trim() || null
      });
    } catch {
      // Ignore malformed alternate links; they are not actionable candidates.
    }
  }

  return dedupeLinkCandidates(candidates);
}

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern =
    /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(tag)) !== null) {
    attributes[match[1].toLowerCase()] = decodeHtmlAttribute(
      match[2] ?? match[3] ?? match[4] ?? ""
    );
  }
  return attributes;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function dedupeLinkCandidates(candidates: LinkCandidate[]): LinkCandidate[] {
  const seen = new Set<string>();
  const deduped: LinkCandidate[] = [];

  for (const candidate of candidates) {
    const key = candidate.feedUrl;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function feedFormatForBody(body: string): "rss" | "atom" | "unknown" {
  const rootMatch = body.match(/<\s*(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_-]+)/);
  const rootName = rootMatch?.[1]?.toLowerCase();
  if (rootName === "rss" || rootName === "rdf") {
    return "rss";
  }
  if (rootName === "feed") {
    return "atom";
  }
  return "unknown";
}

function invalidCandidate(
  feedUrl: string,
  title: string | null,
  error: string
): FeedDiscoveryCandidate {
  return {
    feedUrl,
    title,
    siteUrl: null,
    description: null,
    format: "unknown",
    status: "invalid",
    existingFeedId: null,
    itemCount: 0,
    recentItems: [],
    error
  };
}

function humanReadableError(error: unknown): string {
  if (error instanceof FeedDiscoveryError) {
    const status = readObject(error.details).status;
    return typeof status === "number"
      ? `${error.message}: HTTP ${status}`
      : error.message;
  }

  if (error instanceof FeedParseError) {
    return `Feed parse failed: ${error.message}`;
  }

  return errorMessage(error);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
