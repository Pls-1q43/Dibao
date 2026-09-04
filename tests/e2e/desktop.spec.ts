import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { startFixtureServer } from "./fixtures.js";

const accessPassword = "correct horse battery";
const e2eDatabasePath = resolve(".tmp/e2e/dibao.sqlite");

test.setTimeout(90_000);

test.beforeEach(async ({ page }) => {
  await blockExternalBrowserRequests(page);
});

test("desktop MVP self-host smoke flow", async ({ page }) => {
  const fixture = await startFixtureServer();

  try {
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/site.webmanifest"
    );
    await waitForActiveServiceWorker(page);

    await expect(page.getByRole("heading", { name: "欢迎使用邸报" })).toBeVisible();
    await page.getByRole("button", { name: "开始设置" }).click();

    await page.getByRole("textbox", { name: "用户名" }).fill("e2e");
    await page.getByRole("textbox", { name: "访问密码" }).fill(accessPassword);
    await page.getByRole("button", { name: "完成设置" }).click();

    await expect(page.getByRole("heading", { name: "添加订阅源" })).toBeVisible();
    await page.getByLabel("网站或 RSS / Atom URL").fill(`${fixture.origin}/site-with-feeds`);
    await page.getByRole("button", { name: "检查" }).click();
    await expect(page.getByText("发现的订阅源")).toBeVisible();
    await expect(page.getByText("E2E Fixture Feed")).toBeVisible();
    await expect(page.getByText("E2E Alternate Feed")).toBeVisible();
    await expect(page.getByText("E2E Article Alpha")).toBeVisible();
    await page.getByRole("button", { name: "添加此源" }).first().click();

    await expect(page.getByRole("heading", { name: "每日简报" })).toBeVisible();
    await page.getByRole("button", { name: "暂不启用" }).click();

    await expect(page.getByRole("heading", { name: "推荐能力" })).toBeVisible();
    await page.getByRole("button", { name: "跳过，使用基础排序" }).click();

    await expect(page.getByRole("link", { name: /E2E Article Beta/ })).toBeVisible();

    await page.getByRole("button", { name: "退出" }).click();
    await expect(page.getByRole("heading", { name: "登录邸报" })).toBeVisible();
    await page.getByRole("textbox", { name: "用户名" }).fill("e2e");
    await page.getByRole("textbox", { name: "访问密码" }).fill(accessPassword);
    await page.getByRole("button", { name: "登录" }).click();

    await expect(page.getByRole("heading", { name: "推荐文章" })).toBeVisible();
    await page.getByRole("link", { name: "最新" }).click();
    await expect(page.getByRole("heading", { name: "最新文章" })).toBeVisible();
    await expect(page.getByRole("link", { name: /E2E Article Beta/ })).toBeVisible();
    await page.getByRole("link", { name: "搜索" }).click();
    await expect(page.getByRole("heading", { name: "搜索文章" })).toBeVisible();
    await page.getByRole("searchbox", { name: "关键词" }).fill("Alpha");
    await page.getByRole("button", { name: "搜索" }).click();
    await expect(page.getByRole("link", { name: /E2E Article Alpha/ })).toBeVisible();
    await page.getByLabel("排序").selectOption("recommended");
    await page.getByRole("button", { name: "搜索" }).click();
    await expect(page.getByRole("link", { name: /E2E Article Alpha/ })).toBeVisible();
    await page.getByRole("link", { name: /E2E Article Alpha/ }).click();
    await expect(page.getByRole("heading", { name: "E2E Article Alpha" })).toBeVisible();
    await page.getByRole("link", { name: "最新" }).click();
    await expect(page.getByRole("heading", { name: "最新文章" })).toBeVisible();
    await page.getByTitle("只看未读").click();
    await page.getByTestId("article-list-scroll-container").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => latestBehaviorEvent("E2E Article Beta", "impression") !== null, {
        timeout: 20_000
      })
      .toBe(true);
    await page.getByTestId("article-list-scroll-container").evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(page.getByRole("link", { name: /E2E Article Beta/ })).toBeVisible();
    await page.getByRole("link", { name: /E2E Article Beta/ }).click();
    await expect(page.getByRole("link", { name: /E2E Article Beta/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "E2E Article Beta" })).toBeVisible();
    await expect(page.getByText("当前视图正按照发布时间排序")).toBeVisible();
    await expect(readerExplainButtons(page)).toHaveCount(0);

    const scrollMetrics = await page.evaluate(() => {
      function panelMetrics(testId: string) {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (!(element instanceof HTMLElement)) {
          throw new Error(`Missing ${testId}`);
        }
        const style = window.getComputedStyle(element);
        return {
          clientHeight: element.clientHeight,
          overflowY: style.overflowY,
          scrollHeight: element.scrollHeight
        };
      }

      return {
        documentClientHeight: document.documentElement.clientHeight,
        documentScrollHeight: document.documentElement.scrollHeight,
        feed: panelMetrics("feed-scroll-container"),
        list: panelMetrics("article-list-scroll-container"),
        reader: panelMetrics("reader-scroll-container")
      };
    });
    expect(scrollMetrics.documentScrollHeight).toBeLessThanOrEqual(
      scrollMetrics.documentClientHeight + 4
    );
    expect(scrollMetrics.feed.overflowY).toBe("auto");
    expect(scrollMetrics.list.overflowY).toBe("auto");
    expect(scrollMetrics.reader.overflowY).toBe("auto");
    expect(scrollMetrics.list.scrollHeight).toBeGreaterThan(scrollMetrics.list.clientHeight);
    expect(scrollMetrics.reader.scrollHeight).toBeGreaterThan(scrollMetrics.reader.clientHeight);

    await page.getByTestId("reader-scroll-container").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => latestReadProgressEvent("E2E Article Beta")?.metadata.scrollSource)
      .toBe("reader");
    await expect
      .poll(() =>
        page.getByTestId("reader-scroll-container").evaluate((element) => element.scrollTop)
      )
      .toBeGreaterThan(0);
    const readProgress = latestReadProgressEvent("E2E Article Beta");
    expect(readProgress?.metadata.durationMs).toBeGreaterThanOrEqual(0);
    expect(readProgress?.metadata.activeDurationMs).toBeGreaterThanOrEqual(0);
    expect(readProgress?.metadata.progress).toBeGreaterThanOrEqual(0.25);

    const readerPanel = page.getByTestId("reader-scroll-container");
    await readerPanel.getByRole("button", { name: "收藏这篇文章" }).first().click();
    await expect(readerPanel.getByRole("button", { name: "取消收藏这篇文章" }).first()).toBeVisible();
    await readerPanel.getByRole("button", { name: "稍后读这篇文章" }).first().click();
    await expect(readerPanel.getByRole("button", { name: "移出稍后读" }).first()).toBeVisible();
    await readerPanel.getByRole("button", { name: "不再推荐类似文章" }).first().click();
    await expect(readerPanel.getByRole("button", { name: "已标记不感兴趣" }).first()).toBeVisible();

    await page.getByTitle("只看未读").click();
    await page.getByRole("link", { name: "推荐" }).click();
    await expect(page.getByRole("heading", { name: "推荐文章" })).toBeVisible();
    await page.getByRole("button", { name: /查看推荐库存/ }).click();
    const recommendationInventory = page.getByRole("dialog");
    await expect(recommendationInventory.getByText("推荐库存", { exact: true })).toBeVisible();
    await expect(recommendationInventory.getByText(/行为 \d+/)).toBeVisible();
    await expect(recommendationInventory.getByText(/Coverage \d+%/)).toBeVisible();
    await page.getByRole("button", { name: "关闭推荐库存" }).last().click();
    await expect(page.getByRole("link", { name: /E2E Article Alpha/ })).toBeVisible();
    await page.getByRole("link", { name: /E2E Article Alpha/ }).click();
    const recommendedReader = page.getByTestId("reader-scroll-container");
    await expect(recommendedReader.getByRole("button", { name: "为什么推荐" })).toBeVisible();
    await expect(recommendedReader.getByRole("heading", { name: "为什么推荐" })).toBeVisible();
    await expect(recommendedReader.getByText("阅读过半后显示推荐解释。")).toBeVisible();
    await expect(recommendedReader.getByText("与你近期的正向兴趣相似")).toHaveCount(0);
    const scrollTopBeforeExplanation = await recommendedReader.evaluate(
      (element) => element.scrollTop
    );
    await recommendedReader.getByRole("button", { name: "为什么推荐" }).click();
    const explanationDialog = page.getByRole("dialog", { name: "为什么推荐" });
    await expect(explanationDialog).toBeVisible();
    await expect(explanationDialog).toContainText(/推荐|排序|稍后读|新鲜度/);
    await expect
      .poll(() => recommendedReader.evaluate((element) => element.scrollTop))
      .toBe(scrollTopBeforeExplanation);
    await explanationDialog.getByRole("button", { name: "关闭" }).click();
    await expect(explanationDialog).toHaveCount(0);

    await page.getByRole("link", { name: "最新" }).click();
    await page.getByRole("button", { name: "打开来源" }).click();
    await page.getByTitle("刷新 E2E Fixture Feed").click();
    await expect(page.getByText("已刷新：E2E Fixture Feed")).toBeVisible();

    await page.getByRole("link", { name: "最新" }).click();
    await expect(page.getByRole("button", { name: /未读 \d+/ }).first()).toBeVisible();
    await page.getByRole("link", { name: /E2E Article Alpha/ }).click();
    await page
      .getByTestId("reader-scroll-container")
      .getByRole("button", { name: "稍后读这篇文章" })
      .first()
      .click();
    await expect(
      page
        .getByTestId("reader-scroll-container")
        .getByRole("button", { name: "移出稍后读" })
        .first()
    ).toBeVisible();
    await page.getByTitle("只看未读").click();
    await expect(page.getByTitle("只看未读")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "清账" }).click();
    await expect(page.getByRole("heading", { name: "清理未读" })).toBeVisible();
    await expect(page.getByText("这不会清除收藏或稍后读，也不会作为推荐正反馈。")).toBeVisible();
    await page.getByRole("button", { name: "标记已读" }).click();
    await expect(page.getByText(/已将当前范围内 \d+ 篇文章标记为已读。|当前范围没有未读文章。/)).toBeVisible();
    await expect(page.getByRole("button", { name: "清账" })).toBeDisabled();
    await page.getByRole("link", { name: "稍后读" }).click();
    await expect(page.getByRole("link", { name: /E2E Article Alpha/ })).toBeVisible();

    await page.getByRole("link", { name: "设置" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
    const offlineToggle = page.getByRole("switch", { name: "启用离线阅读" });
    await expect(offlineToggle).not.toBeChecked();
    const offlineManifest = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/offline/manifest"
    );
    await offlineToggle.check();
    await expect((await offlineManifest).status()).toBe(200);
    await expect.poll(() => hasActiveOfflineSnapshot(page), { timeout: 20_000 }).toBe(true);
    await page.getByRole("tab", { name: "算法" }).click();
    await page.getByLabel("Base URL").fill(`${fixture.origin}/v1`);
    await page.getByLabel("模型").fill("e2e-embedding");
    await page.getByLabel("维度").fill("4");
    await page.getByRole("button", { name: "保存配置档" }).click();
    await expect(page.getByText("Embedding provider 已保存。")).toBeVisible();
    await page.getByRole("button", { name: "设为当前 Provider" }).click();
    await expect(page.getByText("当前 embedding provider 已切换。")).toBeVisible();
    await expect(page.getByText(/0 \/ \d+ · 0%/).first()).toBeVisible();
    await expect(page.getByText(/待处理 \d+/)).toBeVisible();
    await expect(page.getByText("失败 0")).toBeVisible();
    await expect(page.getByRole("button", { name: "重建向量索引" })).toBeVisible();
    await page.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByText("连接测试成功。")).toBeVisible();

    await page.getByRole("link", { name: "查看算法透明说明" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "算法透明说明" })).toBeVisible();
    await expect(page.getByText("当前推荐状态")).toBeVisible();
    await expect(page.getByText("算法解释")).toBeVisible();
    await expect(page.getByText("候选收集")).toBeVisible();

    await page.getByRole("link", { name: "订阅源" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "订阅源管理" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "订阅源" })).toBeVisible();
    await expect(page.getByRole("button", { name: "添加订阅源" })).toBeVisible();
    await page.getByRole("button", { name: "添加订阅源" }).click();
    await expect(page.getByLabel("网站或 RSS / Atom URL")).toBeVisible();
    await page.getByRole("dialog", { name: "添加订阅源" }).getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("heading", { name: "订阅源健康" })).toBeVisible();
    await expect(page.getByText("正常").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新全部" })).toBeVisible();
    await expect(page.getByText("Feed URL")).toBeVisible();

    await page.getByRole("link", { name: "订阅源" }).click();
    await page.getByLabel("Feed URL").fill(`${fixture.origin}/feeds/broken.xml`);
    await saveFeedAndWait(page);
    await page.getByRole("link", { name: "最新" }).click();
    await page.getByRole("button", { name: "打开来源" }).click();
    await page.getByTitle("刷新 E2E Fixture Feed").click();
    await expect(page.getByText("Feed candidate fetch failed").or(page.getByText("Feed fetch failed"))).toBeVisible();
    await page.getByRole("link", { name: "订阅源" }).click();
    await expect(page.getByText("抓取失败").first()).toBeVisible();
    await expect(page.getByText("Feed fetch failed").first()).toBeVisible();
    await page.getByRole("button", { name: "只看异常" }).click();
    await expect(page.getByRole("button", { name: "重试刷新" })).toBeVisible();
    await page.getByRole("button", { name: "重试刷新" }).click();

    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByRole("heading", { level: 1, name: "订阅源管理" })).toBeVisible();
    await expect(page.getByText(/网络连接已中断。本机有 \d+ 篇离线文章/)).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#root main")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("ERR_INTERNET_DISCONNECTED");
    await expect(page.getByText(/网络连接已中断。本机有 \d+ 篇离线文章/)).toBeVisible();
    await page.getByRole("button", { name: "切换到离线模式" }).click();
    await expect(
      page.getByRole("button", { name: /查看离线阅读状态：离线 · \d+ 篇可用/ })
    ).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#root main")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("ERR_INTERNET_DISCONNECTED");
    await expect(
      page.getByRole("button", { name: /查看离线阅读状态：离线 · \d+ 篇可用/ })
    ).toBeVisible();
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page
      .getByRole("button", { name: /查看离线阅读状态：离线 · \d+ 篇可用/ })
      .click();
    await page.getByRole("button", { name: "退出离线模式" }).click();
    await expect(page.getByRole("button", { name: "退出离线模式" })).toHaveCount(0);
  } finally {
    await page.context().setOffline(false).catch(() => undefined);
    await fixture.close();
  }
});

test("desktop full content extraction can preview and backfill current feed items", async ({
  page
}) => {
  const fixture = await startFixtureServer();

  try {
    await loginDesktop(page);

    await page.getByRole("link", { name: "订阅源" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "订阅源管理" })).toBeVisible();
    await page.getByLabel("Feed URL").fill(`${fixture.origin}/feeds/main.xml`);
    await page.getByLabel("正文来源").selectOption("feed_only");
    await saveFeedAndWait(page);
    await expect(page.getByLabel("正文来源")).toHaveValue("feed_only");
    await expect(page.getByRole("button", { name: "预览全文抓取" })).toBeVisible();

    const previewPagePromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "预览全文抓取" }).click();
    const previewPage = await previewPagePromise;
    await previewPage.waitForLoadState("domcontentloaded");
    await expect(
      previewPage.locator('section[aria-labelledby="full-content-preview-title"]')
    ).toBeVisible();
    await expect(previewPage.getByText(`${fixture.origin}/articles/alpha`)).toBeVisible();
    await expect(
      previewPage.getByText("Alpha extracted full content paragraph").first()
    ).toBeVisible();
    await previewPage.getByRole("button", { name: "返回订阅源管理" }).click();
    await expect(previewPage.getByRole("region", { name: "订阅源管理" })).toBeVisible();
    await previewPage.close();

    await page.getByLabel("正文来源").selectOption("fetch_full_content");
    await saveFeedAndWait(page);
    await expect(page.getByLabel("正文来源")).toHaveValue("fetch_full_content");
    await expect(page.getByRole("button", { name: "抓取当前 Feed 文章全文" })).toBeVisible();
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    const backfillResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/full-content/backfill-current")
    );
    await page.getByRole("button", { name: "抓取当前 Feed 文章全文" }).click();
    await expect((await backfillResponse).status()).toBe(200);
    await expect(page.getByText("内容发生变化")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("当前 RSS 文章数")).toBeVisible();
    await expect(page.getByText("尝试")).toBeVisible();
    await expect(page.getByText("成功", { exact: true })).toBeVisible();
    await expect(page.getByText(/已限制为前 50 篇|未触发/)).toBeVisible();

    await openArticleFromSearch(page, "Alpha");
    await expect(page.getByText("正文来自网页全文抓取。")).toBeVisible();
    await expect(page.getByText("Alpha extracted full content paragraph").first()).toBeVisible();

    await openArticleFromSearch(page, "Broken Full Content");
    await expect(page.getByText("网页全文抓取失败，当前显示 Feed 内容。")).toBeVisible();
  } finally {
    await fixture.close();
  }
});

function latestReadProgressEvent(articleTitle: string):
  | {
      metadata: {
        activeDurationMs: number;
        durationMs: number;
        progress: number;
        scrollSource: string;
      };
    }
  | null {
  const db = new Database(e2eDatabasePath, {
    readonly: true
  });
  try {
    const row = db
      .prepare(
        `
          select be.metadata_json as metadataJson
          from behavior_events be
          join articles a on a.id = be.article_id
          where a.title = ?
            and be.event_type = 'read_progress'
          order by be.created_at desc
          limit 1
        `
      )
      .get(articleTitle) as { metadataJson: string | null } | undefined;

    if (!row?.metadataJson) {
      return null;
    }

    return {
      metadata: JSON.parse(row.metadataJson) as {
        activeDurationMs: number;
        durationMs: number;
        progress: number;
        scrollSource: string;
      }
    };
  } finally {
    db.close();
  }
}

async function loginDesktop(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录邸报" })).toBeVisible();
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e");
  await page.getByRole("textbox", { name: "访问密码" }).fill(accessPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("link", { name: "最新" })).toBeVisible();
}

async function hasActiveOfflineSnapshot(
  page: import("@playwright/test").Page
): Promise<boolean> {
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

async function saveFeedAndWait(page: import("@playwright/test").Page): Promise<void> {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PATCH" &&
      /\/api\/feeds\/[^/]+$/.test(new URL(candidate.url()).pathname)
  );
  await page.getByRole("button", { name: "保存" }).click();
  await expect((await response).status()).toBe(200);
}

async function openArticleFromSearch(
  page: import("@playwright/test").Page,
  keyword: string
): Promise<void> {
  await page.getByRole("link", { name: "搜索" }).click();
  await expect(page.getByRole("heading", { name: "搜索文章" })).toBeVisible();
  await page.getByRole("searchbox", { name: "关键词" }).fill(keyword);
  await page.getByRole("button", { name: "搜索" }).click();
  await page.getByRole("link", { name: new RegExp(`E2E Article ${keyword}`) }).click();
}

function readerExplainButtons(page: import("@playwright/test").Page) {
  return page.getByTestId("reader-scroll-container").getByRole("button", {
    name: "查看完整理由"
  });
}

function latestBehaviorEvent(articleTitle: string, eventType: string): { metadata: unknown } | null {
  const db = new Database(e2eDatabasePath, {
    readonly: true
  });
  try {
    const row = db
      .prepare(
        `
          select be.metadata_json as metadataJson
          from behavior_events be
          join articles a on a.id = be.article_id
          where a.title = ?
            and be.event_type = ?
          order by be.created_at desc
          limit 1
        `
      )
      .get(articleTitle, eventType) as { metadataJson: string | null } | undefined;

    if (!row) {
      return null;
    }

    return {
      metadata: row.metadataJson ? JSON.parse(row.metadataJson) : null
    };
  } finally {
    db.close();
  }
}

async function blockExternalBrowserRequests(page: import("@playwright/test").Page): Promise<void> {
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

async function waitForActiveServiceWorker(page: import("@playwright/test").Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) {
          return "unsupported";
        }

        const registration = await navigator.serviceWorker.ready;
        return registration.active?.state ?? "missing";
      })
    )
    .toBe("activated");

  await expect
    .poll(async () =>
      page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js") ?? false)
    )
    .toBe(true);
}
