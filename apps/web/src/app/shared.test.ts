import { describe, expect, it } from "vitest";
import { isNavigationItemActive, normalizeArticleCodeBlockHtml } from "./shared.js";

describe("navigation active state", () => {
  it("does not mark Settings active for plugin pages", () => {
    expect(
      isNavigationItemActive("settings", {
        type: "plugin",
        pluginId: "app.dibao.daily-brief",
        route: "daily-brief"
      })
    ).toBe(false);
  });

  it("keeps algorithm pages grouped under Settings", () => {
    expect(isNavigationItemActive("settings", { type: "algorithm-transparency" })).toBe(true);
    expect(isNavigationItemActive("settings", { type: "algorithm-clusters" })).toBe(true);
  });
});

describe("normalizeArticleCodeBlockHtml", () => {
  it("removes Hexo-style code block gutters before article sanitization", () => {
    const html = `
      <figure class="highlight ts">
        <table>
          <tr>
            <td class="gutter"><pre><span class="line">1</span><br><span class="line">2</span><br></pre></td>
            <td class="code"><pre><span class="line">const ok = true;</span><br><span class="line">console.log(ok);</span><br></pre></td>
          </tr>
        </table>
      </figure>
    `;

    const normalized = normalizeArticleCodeBlockHtml(html);

    expect(normalized).not.toContain("class=\"gutter\"");
    expect(normalized).not.toContain("<span class=\"line\">1</span>");
    expect(normalized).toContain("class=\"code\"");
    expect(normalized).toContain("const ok = true;");
    expect(normalized).toContain("console.log(ok);");
  });
});
