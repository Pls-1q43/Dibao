import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { startFixtureServer } from "./fixtures.js";

const accessPassword = "correct horse battery";
const e2eDatabasePath = resolve(".tmp/e2e/dibao.sqlite");

test.beforeEach(async ({ page }) => {
  await blockExternalBrowserRequests(page);
});

test("mobile browser exposes PWA metadata", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/site.webmanifest"
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#f7f4ed"
  );
});

test("mobile PWA offers cached reading when the server becomes unreachable", async ({ page }) => {
  const offlineManifest = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/offline/manifest"
  );
  await login(page);
  await expect((await offlineManifest).status()).toBe(200);
  await expect.poll(() => hasActiveOfflineSnapshot(page), { timeout: 20_000 }).toBe(true);

  await page.route("**/api/auth/session", (route) => route.abort("failed"));
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      return page.getByRole("button", { name: "切换到离线模式" }).count();
    })
    .toBe(1);
  await expect(page.getByText(/服务器暂时无法连接。本机有 \d+ 篇离线文章/)).toBeVisible();

  await page.unroute("**/api/auth/session");
  await page.route("**/api/auth/session", () => undefined);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "切换到离线模式" })).toBeVisible();
  await page.getByRole("button", { name: "切换到离线模式" }).click();
  await expect(
    page.getByRole("button", { name: /查看离线阅读状态：服务器不可用/ })
  ).toBeVisible();
  await page.getByRole("link", { name: "最新" }).click();
  await expect(page.getByRole("link", { name: /E2E Article/ }).first()).toBeVisible();
});

test("mobile MVP reader smoke has visible controls and no horizontal overflow", async ({ page }) => {
  await login(page);

  await expect(page.getByRole("link", { name: /E2E Article Alpha/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开来源" })).toBeVisible();

  const initialLayout = await page.evaluate(mobilePanelState);
  expect(initialLayout.feedRight).toBeLessThanOrEqual(2);
  expect(initialLayout.listDisplay).toBe("block");
  expect(initialLayout.readerDisplay).toBe("none");

  await page.getByRole("button", { name: "打开来源" }).click();
  await expect(page.getByRole("button", { name: "全部订阅源" })).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(mobilePanelState)).feedLeft)
    .toBeGreaterThanOrEqual(-1);
  await page
    .getByTestId("feed-scroll-container")
    .getByRole("button", { name: "关闭来源" })
    .click();

  await page.getByRole("link", { name: /E2E Article Alpha/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Article Alpha" })).toBeVisible();
  await expect(page.getByRole("button", { name: "返回列表" })).toBeVisible();
  const readerPanel = page.getByTestId("reader-scroll-container");
  await expect(readerPanel.getByRole("button", { name: "收藏这篇文章" }).first()).toBeVisible();
  await expect(
    readerPanel.getByRole("button", { name: /稍后读这篇文章|移出稍后读/ }).first()
  ).toBeVisible();
  await expect(readerPanel.getByRole("button", { name: "不再推荐类似文章" }).first()).toBeVisible();
  const readingLayout = await page.evaluate(mobilePanelState);
  expect(readingLayout.listDisplay).toBe("none");
  expect(readingLayout.readerDisplay).toBe("block");

  await page.getByRole("button", { name: "返回列表" }).click();
  await expect(page.getByRole("link", { name: /E2E Article Alpha/ })).toBeVisible();
  const backLayout = await page.evaluate(mobilePanelState);
  expect(backLayout.listDisplay).toBe("block");
  expect(backLayout.readerDisplay).toBe("none");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(4);
});

test("mobile feed diagnostics stay compact without horizontal overflow", async ({ page }) => {
  await login(page);

  await page.getByRole("button", { exact: true, name: "更多" }).click();
  await page.getByRole("menuitem", { name: "订阅源" }).click();
  await expect(page.getByRole("region", { name: "订阅源管理" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "订阅源健康" })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加订阅源" })).toBeVisible();
  await page.getByRole("button", { name: "添加订阅源" }).click();
  await expect(page.getByLabel("网站或 RSS / Atom URL")).toBeVisible();
  await page.getByRole("dialog", { name: "添加订阅源" }).getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("button", { name: "只看异常" })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(4);
});

test("mobile full content settings and preview stay usable without horizontal overflow", async ({
  page
}) => {
  const fixture = await startFixtureServer();
  try {
    await login(page);

    await page.getByRole("button", { exact: true, name: "更多" }).click();
    await page.getByRole("menuitem", { name: "订阅源" }).click();
    await expect(page.getByRole("region", { name: "订阅源管理" })).toBeVisible();

    await page.getByLabel("Feed URL").fill(`${fixture.origin}/feeds/main.xml`);
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByLabel("正文来源")).toBeVisible();
    await expect(page.getByRole("button", { name: "预览全文抓取" })).toBeVisible();

    const previewPagePromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "预览全文抓取" }).click();
    const previewPage = await previewPagePromise;
    await previewPage.waitForLoadState("domcontentloaded");
    await expect(
      previewPage.locator('section[aria-labelledby="full-content-preview-title"]')
    ).toBeVisible();
    await expect(previewPage.getByText("Alpha extracted full content paragraph").first()).toBeVisible();
    await previewPage.getByRole("button", { name: "返回订阅源管理" }).click();
    await expect(previewPage.getByRole("region", { name: "订阅源管理" })).toBeVisible();
    await previewPage.close();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(4);
  } finally {
    await fixture.close();
  }
});

test("mobile unread debt control can cancel and confirm clearing without overflow", async ({
  page
}) => {
  seedUnreadArticle("article_mobile_clear_debt", "E2E Mobile Clear Debt");
  await login(page);

  await page.getByRole("link", { name: "最新" }).click();
  await expect(page.getByRole("link", { name: /E2E Mobile Clear Debt/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /未读 \d+/ }).first()).toBeVisible();

  const initialOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(initialOverflow).toBeLessThanOrEqual(4);

  await page.getByTitle("标记全部未读为已读").click();
  await expect(page.getByRole("heading", { name: "清理未读" })).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("heading", { name: "清理未读" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /未读 [1-9]\d*/ }).first()).toBeVisible();

  await page.getByTitle("标记全部未读为已读").click();
  await page.getByRole("button", { name: "标记已读" }).click();
  await expect(
    page.locator('[aria-live="polite"]').filter({
      hasText: /已将当前范围内 \d+ 篇文章标记为已读。/
    })
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: "未读 0" }).first()).toBeVisible();

  const finalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(finalOverflow).toBeLessThanOrEqual(4);
});

test("mobile recommended list keeps a dense first screen without horizontal overflow", async ({
  page
}) => {
  await login(page);

  await page.getByRole("link", { name: "推荐" }).click();
  await expect(page.getByRole("heading", { name: "推荐" })).toBeVisible();
  await expect(page.getByRole("button", { name: /查看推荐库存/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /E2E Article Alpha/ })).toBeVisible();

  const visibleArticles = await page.evaluate(visibleArticleCountInListViewport);
  expect(visibleArticles).toBeGreaterThanOrEqual(5);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(4);
});

test("mobile recommended article exposes algorithm transparency details", async ({ page }) => {
  await login(page);

  await page.getByRole("link", { name: "推荐" }).click();
  await expect(page.getByRole("heading", { name: "推荐" })).toBeVisible();
  await page.getByRole("link", { name: /E2E Article Alpha/ }).click();

  await expect(page.getByRole("heading", { name: "E2E Article Alpha" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看完整理由" })).toBeVisible();
  await page.getByRole("button", { name: "查看完整理由" }).click();
  await expect(page.getByRole("heading", { name: "为什么推荐" })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(/推荐|排序|稍后读|新鲜度/);
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
  await expect(page.getByRole("heading", { name: "为什么推荐" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "E2E Article Alpha" })).toBeVisible();
});

test("mobile search keeps advanced filters collapsed until requested", async ({ page }) => {
  await login(page);

  await page.getByRole("button", { exact: true, name: "更多" }).click();
  await page.getByRole("menuitem", { name: "搜索" }).click();
  await expect(page.getByRole("heading", { name: "搜索文章" })).toBeVisible();
  const searchPanel = page.getByRole("region", { name: "搜索文章" });
  await expect(searchPanel.getByRole("searchbox", { name: "关键词" })).toBeVisible();
  await expect(searchPanel.getByLabel("排序")).toBeVisible();
  await expect(searchPanel.getByLabel("状态")).toBeVisible();
  await expect(searchPanel.getByRole("button", { name: "高级搜索" })).toBeVisible();

  await expect(searchPanel.getByLabel("分组")).toBeHidden();
  await expect(searchPanel.getByLabel("订阅源")).toBeHidden();
  await expect(searchPanel.getByLabel("开始日期")).toBeHidden();
  await expect(searchPanel.getByLabel("结束日期")).toBeHidden();

  await searchPanel.getByRole("button", { name: "高级搜索" }).click();
  await expect(searchPanel.getByRole("button", { name: "收起高级搜索" })).toBeVisible();
  await expect(searchPanel.getByLabel("分组")).toBeVisible();
  await expect(searchPanel.getByLabel("订阅源")).toBeVisible();
  await expect(searchPanel.getByLabel("开始日期")).toBeVisible();
  await expect(searchPanel.getByLabel("结束日期")).toBeVisible();

  await searchPanel.getByRole("button", { name: "收起高级搜索" }).click();
  await expect(searchPanel.getByLabel("分组")).toBeHidden();
});

test("mobile article actions expose selected favorite and read-later state", async ({ page }) => {
  await login(page);

  await page.getByRole("link", { name: /E2E Article Extra 22/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Article Extra 22" })).toBeVisible();

  const readerPanel = page.getByTestId("reader-scroll-container");
  const favoriteButton = readerPanel.getByRole("button", { name: "收藏这篇文章" }).first();
  await favoriteButton.click();
  await expect(readerPanel.getByRole("button", { name: "取消收藏这篇文章" }).first()).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  const readLaterButton = readerPanel.getByRole("button", { name: "稍后读这篇文章" }).first();
  await readLaterButton.click();
  await expect(readerPanel.getByRole("button", { name: "移出稍后读" }).first()).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("mobile browser history back returns from article detail to the list", async ({ page }) => {
  await login(page);

  await page.getByRole("link", { name: /E2E Article Alpha/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Article Alpha" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("link", { name: /E2E Article Alpha/ })).toBeVisible();
  const backLayout = await page.evaluate(mobilePanelState);
  expect(backLayout.listDisplay).toBe("block");
  expect(backLayout.readerDisplay).toBe("none");
});

test("mobile load more keeps scroll-past ignore telemetry active for appended articles", async ({
  page
}) => {
  const baseTime = Date.parse("2026-05-25T08:00:00.000Z");
  const articleIds: string[] = [];
  for (let index = 1; index <= 70; index += 1) {
    const articleId = `article_mobile_load_more_ignore_${String(index).padStart(2, "0")}`;
    articleIds.push(articleId);
    seedUnreadArticle(
      articleId,
      `E2E Load More Ignore ${String(index).padStart(2, "0")}`,
      baseTime + index * 60_000
    );
  }

  try {
    await login(page);
    await page.getByRole("link", { name: "最新" }).click();
    await expect(page.getByRole("heading", { name: "最新" })).toBeVisible();
    await page.getByTitle("只看未读").click();

    let impressionRequestCount = 0;
    await page.route("**/api/articles/*/actions", async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { type?: string } | null;
      if (request.method() === "POST" && body?.type === "impression") {
        impressionRequestCount += 1;
        if (impressionRequestCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
      await route.continue();
    });

    await expect(page.getByRole("link", { name: /E2E Load More Ignore 70/ })).toBeVisible();
    await page.getByRole("button", { name: "加载更多" }).click();

    const appendedTitle = "E2E Load More Ignore 20";
    await expect(page.getByRole("link", { name: new RegExp(appendedTitle) })).toBeVisible();
    const listPanel = page.getByTestId("article-list-scroll-container");

    await scrollArticleIntoListView(page, appendedTitle);
    await expect.poll(() => articleStatusInList(page, appendedTitle)).toBe("unseen");

    await listPanel.evaluate((element, articleTitle) => {
      const row = Array.from(element.querySelectorAll("[data-article-id]")).find(
        (candidate) =>
          candidate instanceof HTMLElement && candidate.textContent?.includes(articleTitle)
      );
      if (!(row instanceof HTMLElement)) {
        throw new Error(`Missing row for ${articleTitle}`);
      }

      element.scrollTop = row.offsetTop + row.offsetHeight + element.clientHeight;
      element.dispatchEvent(new Event("scroll"));
    }, appendedTitle);

    await expect
      .poll(() => articleStatusInList(page, appendedTitle), { timeout: 20_000 })
      .toBe("ignored");
  } finally {
    deleteSeededArticles(articleIds);
  }
});

test("mobile browser history back preserves the unread list queue without refetching", async ({
  page
}) => {
  const baseTime = Date.parse("2026-05-24T08:00:00.000Z");
  for (let index = 1; index <= 16; index += 1) {
    seedUnreadArticle(
      `article_mobile_history_${String(index).padStart(2, "0")}`,
      `E2E Mobile History ${String(index).padStart(2, "0")}`,
      baseTime + index * 60_000
    );
  }

  await login(page);
  await page.getByRole("link", { name: "最新" }).click();
  await expect(page.getByRole("heading", { name: "最新" })).toBeVisible();
  await page.getByTitle("只看未读").click();

  const preservedTitle = "E2E Mobile History 16";
  const openTitle = "E2E Mobile History 15";
  await expect(page.getByRole("link", { name: new RegExp(preservedTitle) })).toBeVisible();

  const articleListRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const isUnreadCountProbe =
      url.pathname === "/api/articles" && url.searchParams.get("limit") === "1";
    if (request.method() === "GET" && url.pathname === "/api/articles" && !isUnreadCountProbe) {
      articleListRequests.push(url.search);
    }
  });

  const listPanel = page.getByTestId("article-list-scroll-container");
  await listPanel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() => articleStatusInList(page, preservedTitle), { timeout: 20_000 })
    .toBe("ignored");

  await listPanel.evaluate((element) => {
    element.scrollTop = 120;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("link", { name: new RegExp(openTitle) })).toBeVisible();
  const scrollTopBeforeOpen = await listPanel.evaluate((element) => element.scrollTop);

  await page.getByRole("link", { name: new RegExp(openTitle) }).click();
  await expect(page.getByRole("heading", { name: openTitle })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("link", { name: new RegExp(openTitle) })).toBeVisible();
  await expect.poll(() => articleStatusInList(page, preservedTitle)).toBe("ignored");

  const scrollTopAfterBack = await listPanel.evaluate((element) => element.scrollTop);
  expect(Math.abs(scrollTopAfterBack - scrollTopBeforeOpen)).toBeLessThanOrEqual(2);
  expect(articleListRequests).toEqual([]);
});

test("favorites page sort dropdown can switch order", async ({ page }) => {
  await login(page);

  await favoriteArticle(page, "E2E Article Alpha");
  await favoriteArticle(page, "E2E Article Extra 24");

  await page.getByRole("link", { name: "收藏" }).click();
  await expect(page.getByRole("heading", { name: "收藏" })).toBeVisible();
  await expect(page.getByLabel("排序")).toHaveValue("favorited_desc");
  await expect(firstArticleTitle(page)).resolves.toContain("E2E Article Extra 24");

  await page.getByLabel("排序").selectOption("favorited_asc");
  const oldestFavorite = await firstArticleTitle(page);
  expect(oldestFavorite).toContain("E2E Article");
  expect(oldestFavorite).not.toContain("E2E Article Extra 24");
});

test("read-later page can open a saved article", async ({ page }) => {
  await login(page);

  await saveArticleForLater(page, "E2E Article Extra 23");

  await page.getByRole("link", { name: "稍后读" }).click();
  await expect(page.getByRole("heading", { name: "稍后读" })).toBeVisible();
  await expect(page.getByLabel("排序")).toHaveValue("ranked");
  await page.getByLabel("排序").selectOption("read_later_desc");
  await expect(page.getByLabel("排序")).toHaveValue("read_later_desc");
  await page.getByRole("link", { name: /E2E Article Extra 23/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Article Extra 23" })).toBeVisible();
});

test("liking an article exposes visible pressed UI state", async ({ page }) => {
  await login(page);

  await page.getByRole("link", { name: /E2E Article Alpha/ }).click();
  await expect(page.getByRole("heading", { name: "E2E Article Alpha" })).toBeVisible();
  const readerPanel = page.getByTestId("reader-scroll-container");
  await readerPanel.getByRole("button", { name: "点赞这篇文章" }).first().click();
  await expect(readerPanel.getByRole("button", { name: "取消点赞这篇文章" }).first()).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

async function login(page: Page): Promise<void> {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "登录邸报" })).toBeVisible();
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e");
  await page.getByRole("textbox", { name: "访问密码" }).fill(accessPassword);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByRole("link", { name: "最新" })).toBeVisible();
  await expect(page.getByRole("link", { name: "推荐" })).toBeVisible();
}

async function hasActiveOfflineSnapshot(page: Page): Promise<boolean> {
  return page.evaluate(
    () => new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open("dibao-offline-reading");
      request.onerror = () => reject(request.error ?? new Error("Offline database unavailable"));
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("profiles")) {
          database.close();
          resolve(false);
          return;
        }
        const transaction = database.transaction("profiles", "readonly");
        const profiles = transaction.objectStore("profiles").getAll();
        profiles.onerror = () => reject(profiles.error ?? new Error("Offline profiles unavailable"));
        profiles.onsuccess = () => {
          const active = profiles.result.some((profile) =>
            Boolean((profile as { activeSnapshotId?: string | null }).activeSnapshotId)
          );
          database.close();
          resolve(active);
        };
      };
    })
  );
}

async function blockExternalBrowserRequests(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    const isLocal =
      requestUrl.hostname === "127.0.0.1" ||
      requestUrl.hostname === "localhost" ||
      requestUrl.hostname === "::1";

    if ((requestUrl.protocol === "http:" || requestUrl.protocol === "https:") && !isLocal) {
      await route.abort();
      return;
    }

    await route.continue();
  });
}

async function favoriteArticle(page: Page, title: string): Promise<void> {
  await page.getByRole("link", { name: "最新" }).click();
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const readerPanel = page.getByTestId("reader-scroll-container");
  const favorite = readerPanel.getByRole("button", { name: "收藏这篇文章" }).first();
  if (await favorite.isVisible()) {
    await favorite.click();
    await expect(readerPanel.getByRole("button", { name: "取消收藏这篇文章" }).first()).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  }
  await page.goBack();
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
}

async function saveArticleForLater(page: Page, title: string): Promise<void> {
  await page.getByRole("link", { name: "最新" }).click();
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const readerPanel = page.getByTestId("reader-scroll-container");
  const readLater = readerPanel.getByRole("button", { name: "稍后读这篇文章" }).first();
  if (await readLater.isVisible()) {
    await readLater.click();
    await expect(readerPanel.getByRole("button", { name: "移出稍后读" }).first()).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  }
  await page.goBack();
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
}

function seedUnreadArticle(articleId: string, title: string, publishedAt?: number): void {
  const db = new Database(e2eDatabasePath);
  try {
    const feed = db.prepare("select id from feeds where deleted_at is null limit 1").get() as
      | { id: string }
      | undefined;
    if (!feed) {
      throw new Error("No feed available for mobile unread seed");
    }
    const now = publishedAt ?? Date.parse("2026-05-23T08:00:00.000Z");
    db.prepare(
      `
        insert into articles (
          id,
          feed_id,
          url,
          title,
          summary,
          published_at,
          discovered_at,
          dedupe_key,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          title = excluded.title,
          published_at = excluded.published_at,
          discovered_at = excluded.discovered_at,
          updated_at = excluded.updated_at,
          deleted_at = null,
          status = 'active'
      `
    ).run(
      articleId,
      feed.id,
      `https://example.com/${articleId}`,
      title,
      "Mobile clear debt fixture",
      now,
      now,
      articleId,
      now,
      now
    );
    db.prepare("delete from article_states where article_id = ?").run(articleId);
    db.prepare("delete from behavior_events where article_id = ?").run(articleId);
  } finally {
    db.close();
  }
}

function deleteSeededArticles(articleIds: string[]): void {
  if (articleIds.length === 0) {
    return;
  }

  const db = new Database(e2eDatabasePath);
  try {
    const deleteBehavior = db.prepare("delete from behavior_events where article_id = ?");
    const deleteState = db.prepare("delete from article_states where article_id = ?");
    const deleteArticle = db.prepare("delete from articles where id = ?");
    const cleanup = db.transaction((ids: string[]) => {
      for (const articleId of ids) {
        deleteBehavior.run(articleId);
        deleteState.run(articleId);
        deleteArticle.run(articleId);
      }
    });
    cleanup(articleIds);
  } finally {
    db.close();
  }
}

async function articleStatusInList(page: Page, title: string): Promise<string | null> {
  return page.getByTestId("article-list-scroll-container").evaluate((element, articleTitle) => {
    const row = Array.from(element.querySelectorAll("[data-article-id]")).find(
      (candidate) => candidate instanceof HTMLElement && candidate.textContent?.includes(articleTitle)
    );

    return row instanceof HTMLElement ? row.dataset.interactionStatus ?? null : null;
  }, title);
}

async function scrollArticleIntoListView(page: Page, title: string): Promise<void> {
  await page.getByTestId("article-list-scroll-container").evaluate((element, articleTitle) => {
    const row = Array.from(element.querySelectorAll("[data-article-id]")).find(
      (candidate) => candidate instanceof HTMLElement && candidate.textContent?.includes(articleTitle)
    );

    if (!(row instanceof HTMLElement)) {
      throw new Error(`Missing row for ${articleTitle}`);
    }

    row.scrollIntoView({ block: "center" });
    element.dispatchEvent(new Event("scroll"));
  }, title);
}

async function firstArticleTitle(page: Page): Promise<string> {
  return page.getByTestId("article-list-scroll-container").evaluate((element) => {
    const button = Array.from(element.querySelectorAll("a")).find((candidate) =>
      candidate.textContent?.includes("E2E Article")
    );
    return button?.textContent ?? "";
  });
}

function mobilePanelState() {
  const feed = document.querySelector('[data-testid="feed-scroll-container"]');
  const list = document.querySelector('[data-testid="article-list-scroll-container"]');
  const reader = document.querySelector('[data-testid="reader-scroll-container"]');

  if (!(feed instanceof HTMLElement) || !(list instanceof HTMLElement) || !(reader instanceof HTMLElement)) {
    throw new Error("Missing mobile panels");
  }

  const feedRect = feed.getBoundingClientRect();
  return {
    feedLeft: feedRect.left,
    feedRight: feedRect.right,
    listDisplay: window.getComputedStyle(list).display,
    readerDisplay: window.getComputedStyle(reader).display
  };
}

function visibleArticleCountInListViewport() {
  const list = document.querySelector('[data-testid="article-list-scroll-container"]');
  if (!(list instanceof HTMLElement)) {
    throw new Error("Missing article list panel");
  }

  const listRect = list.getBoundingClientRect();
  return Array.from(list.querySelectorAll("[data-article-id]")).filter((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.top < listRect.bottom && rect.bottom > listRect.top;
  }).length;
}
