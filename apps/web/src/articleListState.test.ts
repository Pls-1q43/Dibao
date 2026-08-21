import { describe, expect, it } from "vitest";
import {
  isArticleListIgnoreTelemetryEnabled,
  shouldSkipPassiveIgnoreTelemetry
} from "./articleListState.js";

describe("passive article ignore telemetry", () => {
  it("keeps list telemetry enabled for eligible views even when detail handles per-item protection", () => {
    expect(
      isArticleListIgnoreTelemetryEnabled({
        articleView: "recommended",
        markScrolledArticlesIgnored: true
      })
    ).toBe(true);

    expect(
      isArticleListIgnoreTelemetryEnabled({
        articleView: "latest",
        markScrolledArticlesIgnored: true
      })
    ).toBe(true);

    expect(
      isArticleListIgnoreTelemetryEnabled({
        articleView: "favorites",
        markScrolledArticlesIgnored: true
      })
    ).toBe(false);
  });

  it("disables passive ignore telemetry when the setting is turned off", () => {
    expect(
      isArticleListIgnoreTelemetryEnabled({
        articleView: "recommended",
        markScrolledArticlesIgnored: false
      })
    ).toBe(false);

    expect(
      isArticleListIgnoreTelemetryEnabled({
        articleView: "latest",
        markScrolledArticlesIgnored: false
      })
    ).toBe(false);
  });

  it("keeps other unseen articles eligible while a detail article is open", () => {
    expect(
      shouldSkipPassiveIgnoreTelemetry({
        articleId: "article_scrolled_past",
        interactionStatus: "unseen",
        isAlreadyIgnored: false,
        isOpened: false,
        selectedArticleId: "article_open_in_detail"
      })
    ).toBe(false);
  });

  it("does not passively ignore the article currently open in detail", () => {
    expect(
      shouldSkipPassiveIgnoreTelemetry({
        articleId: "article_open_in_detail",
        interactionStatus: "unseen",
        isAlreadyIgnored: false,
        isOpened: false,
        selectedArticleId: "article_open_in_detail"
      })
    ).toBe(true);
  });
});
