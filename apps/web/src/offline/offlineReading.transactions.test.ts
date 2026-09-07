import { afterAll, beforeAll, describe, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

// Real IndexedDB, including cross-tab transaction scheduling and rollback.
describe("offline reading IndexedDB transactions", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let origin: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL("../../", import.meta.url)),
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error"
    });
    await server.listen();
    origin = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  for (const scenario of [
    "concurrentQueue", "progressBarrier", "attemptedProgress", "syncRebase",
    "syncLiveQueue", "clearDuringPost", "profileDisable", "staleRefreshClear",
    "staleRefreshTarget", "snapshotPending", "concurrentSnapshotStates", "rollback",
    "revocation", "revokeDuringRefresh", "unreadPagination", "progressCompression",
    "explicitUnreadRebase", "onlinePendingState", "stateSemantics", "concurrentContent",
    "snapshotCursor", "staleRefreshAfterAck", "workerGeneration", "missingArticleSettlement",
    "unregisteredWorkerCleanup"
  ]) {
    it(scenario, async () => {
      const context = await browser.newContext();
      try {
        if (scenario !== "unregisteredWorkerCleanup") {
          await context.addInitScript(() => {
            Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
          });
        }
        const page = await context.newPage();
        await page.goto(`${origin}src/offline/offlineReading.ts`);
        await page.evaluate(`import("/src/offline/offlineReading.transactions.browser.ts")
          .then(suite => suite.scenarios[${JSON.stringify(scenario)}]())`);
      } finally {
        await context.close();
      }
    }, 30_000);
  }

  it("serializes independent tabs sharing IndexedDB", async () => {
    const context = await browser.newContext();
    try {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "serviceWorker", { value: undefined });
      });
      const first = await context.newPage();
      const second = await context.newPage();
      await first.goto(`${origin}src/offline/offlineReading.ts`);
      await second.goto(`${origin}src/offline/offlineReading.ts`);
      const module = 'import("/src/offline/offlineReading.transactions.browser.ts")';
      await first.evaluate(`${module}.then(suite => suite.prepareCrossTab())`);
      await Promise.all([
        first.evaluate(`${module}.then(suite => suite.queueCrossTab("favorite"))`),
        second.evaluate(`${module}.then(suite => suite.queueCrossTab("like"))`)
      ]);
      await first.evaluate(`${module}.then(suite => suite.verifyCrossTab())`);
    } finally { await context.close(); }
  }, 30_000);
});
