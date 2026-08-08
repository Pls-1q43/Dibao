import {
  controlledFetchText,
  fullContentFetchMaxBytes,
  type ControlledFetcher,
  type FetchPrivacyWarning,
  type HostnameResolver
} from "./controlled-fetch.js";

export type FullContentExtractionStatus = "success" | "failed" | "skipped";

export type FullContentExtractionResult = {
  articleUrl: string;
  status: FullContentExtractionStatus;
  title: string | null;
  contentHtml: string | null;
  contentText: string | null;
  excerpt: string | null;
  error: string | null;
};

export type FullContentPluginExtractionInput = {
  articleUrl: string;
  html: string;
  contentType: string;
};

export type FullContentPluginExtractionResult = {
  title?: string | null;
  contentHtml: string;
  contentText: string;
  excerpt?: string | null;
};

export type FullContentExtractionServiceOptions = {
  fetcher?: ControlledFetcher;
  minTextLength?: number;
  pluginExtractor?: (
    input: FullContentPluginExtractionInput
  ) => Promise<FullContentPluginExtractionResult | null>;
  onFetchWarning?: (warning: FetchPrivacyWarning) => void;
  resolveHostname?: HostnameResolver;
};

const DEFAULT_MIN_TEXT_LENGTH = 200;

export class FullContentExtractionService {
  private readonly fetcher: ControlledFetcher | undefined;
  private readonly minTextLength: number;

  constructor(private readonly options: FullContentExtractionServiceOptions = {}) {
    this.fetcher = options.fetcher;
    this.minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
  }

  extract(articleUrl: string): Promise<FullContentExtractionResult> {
    return this.preview(articleUrl);
  }

  async preview(articleUrl: string): Promise<FullContentExtractionResult> {
    const normalized = normalizeArticleUrl(articleUrl);
    if (!normalized) {
      return failed(articleUrl, "Only http and https article URLs can be fetched");
    }

    try {
      const result = await controlledFetchText(normalized, {
        fetcher: this.fetcher,
        headers: {
          accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.5",
          "user-agent": "DibaoFullContentFetcher/0.1"
        },
        maxBytes: fullContentFetchMaxBytes(),
        onWarning: this.options.onFetchWarning,
        resolveHostname: this.options.resolveHostname
      });
      const response = result.response;
      const rawHtml = result.body;
      if (!response.ok) {
        return failed(normalized, `Article fetch failed with HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType && !contentType.includes("html") && !contentType.includes("xml")) {
        return skipped(normalized, `Article response is not HTML (${contentType})`);
      }

      const pluginExtracted = await this.options.pluginExtractor?.({
        articleUrl: normalized,
        html: rawHtml,
        contentType
      });
      if (pluginExtracted && pluginExtracted.contentText.length >= this.minTextLength) {
        return {
          articleUrl: normalized,
          status: "success",
          title: pluginExtracted.title ?? null,
          contentHtml: pluginExtracted.contentHtml,
          contentText: pluginExtracted.contentText,
          excerpt: pluginExtracted.excerpt ?? excerptFor(pluginExtracted.contentText),
          error: null
        };
      }

      const extracted = extractReadableContent(rawHtml);
      if (extracted.contentText.length < this.minTextLength) {
        return skipped(normalized, "Extracted article text is too short");
      }

      return {
        articleUrl: normalized,
        status: "success",
        title: extracted.title,
        contentHtml: extracted.contentHtml,
        contentText: extracted.contentText,
        excerpt: excerptFor(extracted.contentText),
        error: null
      };
    } catch (error) {
      return failed(normalized, `Article fetch failed: ${errorMessage(error)}`);
    }
  }
}

function normalizeArticleUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractReadableContent(html: string): {
  title: string | null;
  contentHtml: string;
  contentText: string;
} {
  const title = cleanText(firstCapture(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i));
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, "");

  const mainHtml =
    firstCapture(cleaned, /<article\b[^>]*>([\s\S]*?)<\/article>/i) ??
    firstCapture(cleaned, /<([a-z0-9]+)\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/\1>/i, 2) ??
    firstCapture(cleaned, /<main\b[^>]*>([\s\S]*?)<\/main>/i) ??
    firstCapture(
      cleaned,
      /<([a-z0-9]+)\b[^>]*(?:class|id)=["'][^"']*(?:content|post|article|entry)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
      2
    ) ??
    firstCapture(cleaned, /<body\b[^>]*>([\s\S]*?)<\/body>/i) ??
    cleaned;

  const blocks = htmlBlocks(mainHtml);
  const contentHtml = blocks.map((block) => block.html).join("\n");
  const contentText = cleanArticleText(blocks.map((block) => block.text).join("\n\n")) ?? "";

  return {
    title,
    contentHtml,
    contentText
  };
}

function htmlBlocks(html: string): Array<{ html: string; text: string }> {
  const blocks: Array<{ html: string; text: string }> = [];
  const blockPattern =
    /<(h1|h2|h3|p|blockquote|pre|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;

  for (const match of html.matchAll(blockPattern)) {
    const tag = (match[1] ?? "li").toLowerCase();
    const inner = match[2] ?? match[3] ?? "";
    const text = tag === "pre" ? cleanPreText(inner) : cleanText(stripTags(inner));
    if (!text) {
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((item) => cleanText(stripTags(item[1] ?? "")))
        .filter((item): item is string => Boolean(item));
      if (items.length === 0) {
        continue;
      }
      blocks.push({
        html: `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`,
        text: items.join("\n")
      });
      continue;
    }
    const safeTag = tag === "pre" ? "pre" : tag;
    blocks.push({
      html: `<${safeTag}>${escapeHtml(text)}</${safeTag}>`,
      text
    });
  }

  if (blocks.length > 0) {
    return blocks;
  }

  const text = cleanText(stripTags(html));
  return text ? [{ html: `<p>${escapeHtml(text)}</p>`, text }] : [];
}

function stripTags(html: string): string {
  return html
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function firstCapture(value: string, pattern: RegExp, index = 1): string | null {
  const match = pattern.exec(value);
  return match?.[index] ?? null;
}

function cleanText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const cleaned = decodeHtmlEntities(value)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned : null;
}

function cleanArticleText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const cleaned = decodeHtmlEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned ? cleaned : null;
}

function cleanPreText(value: string): string | null {
  const cleaned = decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|ul|ol|blockquote|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  return cleaned ? cleaned : null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function excerptFor(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function failed(articleUrl: string, error: string): FullContentExtractionResult {
  return {
    articleUrl,
    status: "failed",
    title: null,
    contentHtml: null,
    contentText: null,
    excerpt: null,
    error
  };
}

function skipped(articleUrl: string, error: string): FullContentExtractionResult {
  return {
    articleUrl,
    status: "skipped",
    title: null,
    contentHtml: null,
    contentText: null,
    excerpt: null,
    error
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
