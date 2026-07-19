export default {
  async activate(ctx) {
    ctx.fullContent.register("balanced-readable-selectors", (input) => {
      if (!input || typeof input !== "object" || typeof input.html !== "string") {
        return null;
      }

      const cleaned = input.html
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
        .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
        .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
        .replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, "");

      const content =
        firstBalancedElementByClass(cleaned, ["post-content", "entry-content", "article-content"]) ??
        firstBalancedElementByClass(cleaned, ["markdown-body", "prose", "content"]);
      if (!content) {
        return null;
      }

      const blocks = htmlBlocks(content);
      if (blocks.length === 0) {
        return null;
      }

      const contentHtml = blocks.map((block) => block.html).join("\n");
      const contentText = cleanArticleText(blocks.map((block) => block.text).join("\n\n"));
      if (!contentText) {
        return null;
      }

      return {
        title: cleanText(firstCapture(input.html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)),
        contentHtml,
        contentText
      };
    });
  }
};

function firstBalancedElementByClass(html, classNames) {
  const tagPattern = /<\/?([a-z0-9]+)\b[^>]*>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const token = match[0];
    if (token.startsWith("</") || token.endsWith("/>")) {
      continue;
    }
    const classValue = firstCapture(token, /\bclass=["']([^"']+)["']/i);
    if (!classValue || !classValue.split(/\s+/).some((className) => classNames.includes(className))) {
      continue;
    }
    const openEnd = match.index + token.length;
    const closeStart = findBalancedCloseStart(html, match[1].toLowerCase(), openEnd);
    if (closeStart !== null) {
      return html.slice(openEnd, closeStart);
    }
  }
  return null;
}

function findBalancedCloseStart(html, tag, startIndex) {
  const tagPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = startIndex;
  let depth = 1;
  for (const match of html.matchAll(tagPattern)) {
    const token = match[0];
    if (token.startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return match.index;
      }
    } else if (!token.endsWith("/>")) {
      depth += 1;
    }
  }
  return null;
}

function htmlBlocks(html) {
  const blocks = [];
  const blockPattern = /<(h1|h2|h3|p|blockquote|pre|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;
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
        .filter(Boolean);
      if (items.length === 0) {
        continue;
      }
      blocks.push({
        html: `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`,
        text: items.join("\n")
      });
      continue;
    }
    blocks.push({ html: `<${tag}>${escapeHtml(text)}</${tag}>`, text });
  }
  return blocks;
}

function stripTags(html) {
  return html
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function firstCapture(value, pattern, index = 1) {
  return pattern.exec(value)?.[index] ?? null;
}

function cleanText(value) {
  if (!value) {
    return null;
  }
  const cleaned = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function cleanArticleText(value) {
  if (!value) {
    return null;
  }
  const cleaned = decodeHtmlEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || null;
}

function cleanPreText(value) {
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
  return cleaned || null;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}
