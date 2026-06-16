import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  SqliteAppSettingsRepository,
  SqliteArticleActionRepository,
  SqliteArticleRepository,
  SqliteEmbeddingRepository,
  SqliteFeedFolderRepository,
  SqliteJobRepository,
  SqliteFeedRepository,
  SqliteProfileRepository,
  SqliteRankingRepository,
  SqliteVecVectorStore,
  toVectorBlob,
  type DibaoDatabase
} from "@dibao/db";
import { parseOpml } from "@dibao/rss";
import { buildServer as buildRealServer } from "./app.js";
import type { FeedFetcher } from "./feed-refresh-service.js";
import { JobRunner } from "./job-runner.js";
import {
  RankingRecalculateJobService,
  RANKING_RECALCULATE_JOB_TYPE
} from "./ranking-job-service.js";
import { RecommendationRankingService } from "./ranking-service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildServer(options: Parameters<typeof buildRealServer>[0] = {}) {
  return buildRealServer({
    authRequired: false,
    ...options
  });
}

describe("server API vertical slice", () => {
  it("reports database, FTS, and vector-store health", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/system/health"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: {
          ok: true,
          database: "ok",
          fts: "ok",
          vectorStore: "ok",
          version: "0.1.3"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("serves configured web static files and falls back to index for SPA routes", async () => {
    const db = createEmptyDatabase();
    const webDistDir = createTempDir();
    mkdirSync(join(webDistDir, "assets"), { recursive: true });
    writeFileSync(
      join(webDistDir, "index.html"),
      "<!doctype html><html><body><div id=\"root\">Dibao shell</div></body></html>"
    );
    writeFileSync(join(webDistDir, "assets", "app.js"), "console.log('dibao');");
    const app = buildServer({ db, logger: false, webDistDir });

    try {
      const root = await app.inject({
        method: "GET",
        url: "/"
      });
      const asset = await app.inject({
        method: "GET",
        url: "/assets/app.js"
      });
      const spaRoute = await app.inject({
        method: "GET",
        url: "/reader/latest"
      });
      const head = await app.inject({
        method: "HEAD",
        url: "/reader/latest"
      });

      expect(root.statusCode, root.body).toBe(200);
      expect(root.headers["content-type"]).toContain("text/html");
      expect(root.body).toContain("Dibao shell");
      expect(asset.statusCode, asset.body).toBe(200);
      expect(asset.headers["content-type"]).toContain("text/javascript");
      expect(asset.body).toContain("dibao");
      expect(spaRoute.statusCode, spaRoute.body).toBe(200);
      expect(spaRoute.body).toContain("Dibao shell");
      expect(head.statusCode, head.body).toBe(200);
      expect(head.body).toBe("");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("serves PWA manifest and service worker static assets with installability headers", async () => {
    const db = createEmptyDatabase();
    const webDistDir = createTempDir();
    writeFileSync(
      join(webDistDir, "index.html"),
      "<!doctype html><html><body><div id=\"root\">Dibao shell</div></body></html>"
    );
    writeFileSync(
      join(webDistDir, "site.webmanifest"),
      JSON.stringify({
        name: "邸报 Dibao",
        short_name: "邸报",
        start_url: "/?source=pwa",
        scope: "/",
        display: "standalone",
        icons: [
          { src: "/logo-192.png", sizes: "192x192", type: "image/png" },
          { src: "/logo-512.png", sizes: "512x512", type: "image/png" }
        ]
      })
    );
    writeFileSync(join(webDistDir, "sw.js"), "self.addEventListener('fetch', () => {});");
    const app = buildServer({ db, logger: false, webDistDir });

    try {
      const manifest = await app.inject({
        method: "GET",
        url: "/site.webmanifest"
      });
      const serviceWorker = await app.inject({
        method: "GET",
        url: "/sw.js"
      });
      const searchRoute = await app.inject({
        method: "GET",
        url: "/search"
      });
      const recommendedRoute = await app.inject({
        method: "GET",
        url: "/?view=recommended"
      });
      const health = await app.inject({
        method: "GET",
        url: "/api/system/health"
      });

      expect(manifest.statusCode, manifest.body).toBe(200);
      expect(manifest.headers["content-type"]).toContain("application/manifest+json");
      const manifestJson = manifest.json() as {
        icons: Array<{ sizes: string }>;
        scope: string;
        start_url: string;
      };
      expect(manifestJson.start_url).toBe("/?source=pwa");
      expect(manifestJson.scope).toBe("/");
      expect(manifestJson.icons.some((icon) => icon.sizes === "192x192")).toBe(true);
      expect(manifestJson.icons.some((icon) => icon.sizes === "512x512")).toBe(true);

      expect(serviceWorker.statusCode, serviceWorker.body).toBe(200);
      expect(serviceWorker.headers["content-type"]).toMatch(/javascript/);
      expect(serviceWorker.body).toContain("fetch");

      expect(searchRoute.statusCode, searchRoute.body).toBe(200);
      expect(searchRoute.body).toContain("Dibao shell");
      expect(recommendedRoute.statusCode, recommendedRoute.body).toBe(200);
      expect(recommendedRoute.body).toContain("Dibao shell");
      expect(health.statusCode, health.body).toBe(200);
      expect(health.headers["content-type"]).toContain("application/json");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("serves web static files before login while keeping API routes protected", async () => {
    const db = createEmptyDatabase();
    const webDistDir = createTempDir();
    writeFileSync(
      join(webDistDir, "index.html"),
      "<!doctype html><html><body><div id=\"root\">Dibao public shell</div></body></html>"
    );
    const app = buildRealServer({ db, logger: false, webDistDir, cookieSecure: false });

    try {
      const root = await app.inject({
        method: "GET",
        url: "/"
      });
      const protectedApi = await app.inject({
        method: "GET",
        url: "/api/feeds"
      });

      expect(root.statusCode, root.body).toBe(200);
      expect(root.body).toContain("Dibao public shell");
      expect(protectedApi.statusCode, protectedApi.body).toBe(401);
      expect(protectedApi.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("does not serve the SPA fallback for API paths", async () => {
    const db = createEmptyDatabase();
    const webDistDir = createTempDir();
    writeFileSync(
      join(webDistDir, "index.html"),
      "<!doctype html><html><body>should not serve for api</body></html>"
    );
    const app = buildServer({ db, logger: false, webDistDir });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/missing-route"
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toMatchObject({
        error: {
          code: "NOT_FOUND"
        }
      });
      expect(response.body).not.toContain("should not serve for api");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports anonymous auth session status before setup", async () => {
    const db = createEmptyDatabase();
    db.prepare(
      "insert into app_settings (key, value_json, updated_at) values (?, ?, ?)"
    ).run("setup.completed", "true", 1000);
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/session"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: {
          setupCompleted: false,
          authenticated: false
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("sets up the single user with a hashed password and secure session cookie", async () => {
    const db = createEmptyDatabase();
    const app = buildRealServer({
      db,
      logger: false,
      now: () => 1000,
      cookieSecure: true
    });

    try {
      const invalid = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "short"
      });
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR"
        }
      });

      const setup = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });
      expect(setup.statusCode, setup.body).toBe(200);
      expect(setup.json()).toEqual({
        data: {
          ok: true
        }
      });
      expectSessionCookieAttributes(setup.headers["set-cookie"], true);

      const credential = db
        .prepare(
          `
            select
              password_hash as passwordHash,
              username,
              password_algo as passwordAlgo
            from auth_credentials
          `
        )
        .get() as { passwordHash: string; username: string; passwordAlgo: string };
      expect(credential.username).toBe("Pls");
      expect(credential.passwordAlgo).toBe("scrypt:v1");
      expect(credential.passwordHash).toMatch(/^scrypt:v1:16384:8:1:32:64:/);
      expect(credential.passwordHash).not.toContain("correct horse battery");
      expect(
        db.prepare("select value_json as valueJson from app_settings where key = ?").get(
          "setup.completed"
        )
      ).toEqual({ valueJson: "true" });

      const session = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: {
          cookie: cookieHeaderFromSetCookie(setup.headers["set-cookie"])
        }
      });
      expect(session.statusCode, session.body).toBe(200);
      expect(session.json()).toEqual({
        data: {
          setupCompleted: true,
          authenticated: true
        }
      });

      const repeated = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "another password"
      });
      expect(repeated.statusCode, repeated.body).toBe(409);
      expect(repeated.json()).toMatchObject({
        error: {
          code: "CONFLICT"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("logs in, protects APIs, and logs out idempotently", async () => {
    const db = createEmptyDatabase();
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      const health = await app.inject({
        method: "GET",
        url: "/api/system/health"
      });
      expect(health.statusCode, health.body).toBe(200);

      const protectedResponse = await app.inject({
        method: "GET",
        url: "/api/feeds"
      });
      expect(protectedResponse.statusCode, protectedResponse.body).toBe(401);
      expect(protectedResponse.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });

      const setup = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });
      const setupCookie = cookieHeaderFromSetCookie(setup.headers["set-cookie"]);

      const wrongLogin = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "wrong password"
      });
      expect(wrongLogin.statusCode, wrongLogin.body).toBe(401);
      expect(wrongLogin.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });

      const logout = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: {
          cookie: setupCookie
        }
      });
      expect(logout.statusCode, logout.body).toBe(200);
      expect(logout.json()).toEqual({
        data: {
          ok: true
        }
      });
      expectClearSessionCookie(logout.headers["set-cookie"]);

      const invalidLogout = await app.inject({
        method: "POST",
        url: "/api/auth/logout"
      });
      expect(invalidLogout.statusCode, invalidLogout.body).toBe(200);
      expect(invalidLogout.json()).toEqual({
        data: {
          ok: true
        }
      });

      const login = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "correct horse battery"
      });
      expect(login.statusCode, login.body).toBe(200);
      expectSessionCookieAttributes(login.headers["set-cookie"], false);

      const feeds = await app.inject({
        method: "GET",
        url: "/api/feeds",
        headers: {
          cookie: cookieHeaderFromSetCookie(login.headers["set-cookie"])
        }
      });
      expect(feeds.statusCode, feeds.body).toBe(200);
      expect(feeds.json()).toEqual({
        data: []
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rate limits repeated failed logins and clears the counter after success", async () => {
    const db = createEmptyDatabase();
    let now = 1_000;
    const app = buildRealServer({
      db,
      logger: false,
      cookieSecure: false,
      now: () => now,
      authMaxFailedLoginAttempts: 2,
      authLoginLockoutMs: 60_000
    });

    try {
      await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });

      const first = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "wrong password"
      });
      const second = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "wrong password"
      });
      const limited = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "correct horse battery"
      });

      expect(first.statusCode, first.body).toBe(401);
      expect(second.statusCode, second.body).toBe(401);
      expect(limited.statusCode, limited.body).toBe(429);
      expect(limited.json()).toMatchObject({
        error: {
          code: "RATE_LIMITED"
        }
      });

      now += 60_001;
      const success = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "correct horse battery"
      });
      expect(success.statusCode, success.body).toBe(200);

      const afterSuccessWrong = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "wrong password"
      });
      expect(afterSuccessWrong.statusCode, afterSuccessWrong.body).toBe(401);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("changes the access password for an authenticated session", async () => {
    const db = createEmptyDatabase();
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      const setup = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });
      const cookie = cookieHeaderFromSetCookie(setup.headers["set-cookie"]);

      const unauthenticated = await postJson(app, "/api/auth/password", {
        currentPassword: "correct horse battery",
        newPassword: "new correct horse battery"
      });
      expect(unauthenticated.statusCode, unauthenticated.body).toBe(401);

      const wrongCurrent = await injectJsonWithCookie(app, "POST", "/api/auth/password", cookie, {
        currentPassword: "wrong password",
        newPassword: "new correct horse battery"
      });
      expect(wrongCurrent.statusCode, wrongCurrent.body).toBe(401);

      const changed = await injectJsonWithCookie(app, "POST", "/api/auth/password", cookie, {
        currentPassword: "correct horse battery",
        newPassword: "new correct horse battery"
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json()).toEqual({ data: { ok: true } });

      const oldLogin = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "correct horse battery"
      });
      expect(oldLogin.statusCode, oldLogin.body).toBe(401);

      const newLogin = await postJson(app, "/api/auth/login", {
        username: "Pls",
        password: "new correct horse battery"
      });
      expect(newLogin.statusCode, newLogin.body).toBe(200);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects expired sessions", async () => {
    const db = createEmptyDatabase();
    let now = 1000;
    const app = buildRealServer({
      db,
      logger: false,
      cookieSecure: false,
      now: () => now
    });

    try {
      const setup = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });
      const cookie = cookieHeaderFromSetCookie(setup.headers["set-cookie"]);
      now += 31 * 24 * 60 * 60 * 1000;

      const feeds = await app.inject({
        method: "GET",
        url: "/api/feeds",
        headers: {
          cookie
        }
      });
      expect(feeds.statusCode, feeds.body).toBe(401);

      const session = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: {
          cookie
        }
      });
      expect(session.json()).toEqual({
        data: {
          setupCompleted: true,
          authenticated: false
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("protects setup status and reports no feeds after login", async () => {
    const db = createEmptyDatabase();
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/api/setup/status"
      });
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      expect(anonymous.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });

      const setup = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });
      const status = await app.inject({
        method: "GET",
        url: "/api/setup/status",
        headers: {
          cookie: cookieHeaderFromSetCookie(setup.headers["set-cookie"])
        }
      });

      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toEqual({
        data: {
          setupCompleted: true,
          hasFeeds: false,
          hasEmbeddingProvider: false,
          firstRefreshStatus: "idle"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("protects recommendation diagnostics and jobs APIs", async () => {
    const db = createEmptyDatabase();
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      const jobs = await app.inject({
        method: "GET",
        url: "/api/jobs"
      });
      const status = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });

      expect(jobs.statusCode, jobs.body).toBe(401);
      expect(jobs.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });
      expect(status.statusCode, status.body).toBe(401);
      expect(status.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });
      for (const url of [
        "/api/recommendation/recalculate",
        "/api/recommendation/backfill/fingerprints",
        "/api/recommendation/rebuild-duplicates",
        "/api/recommendation/rebuild-keywords",
        "/api/recommendation/rebuild-recent-intent",
        "/api/recommendation/evaluate",
        "/api/recommendation/ftrl/reset",
        "/api/recommendation/ftrl/promote"
      ]) {
        const response = await app.inject({ method: "POST", url });
        expect(response.statusCode, `${url}: ${response.body}`).toBe(401);
        expect(response.json()).toMatchObject({
          error: {
            code: "UNAUTHORIZED"
          }
        });
      }
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports recommendation transparency modules honestly before completion backfills are active", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/recommendation/transparency"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          transparency: {
            currentFormula: "freshness + source + state fallback",
            moduleStatus: {
              bm25ProfileTerms: "not_active",
              recentIntent: "missing",
              ftrl: "shadow_no_samples",
              evaluation: "unavailable",
              duplicate: "not_built",
              evidence: "dynamic_fallback"
            },
            algorithmModules: expect.arrayContaining([
              expect.objectContaining({
                id: "provider",
                status: "warning"
              }),
              expect.objectContaining({
                id: "embedding_index",
                status: "stopped"
              }),
              expect.objectContaining({
                id: "local_learning",
                status: "disabled"
              })
            ]),
            failureStates: {
              bm25ProfileTermsActive: false,
              recentIntentMissing: true,
              ftrlTrained: false,
              duplicateNearMatchActive: false,
              evidenceUsingDynamicFallback: true
            }
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports setup status with existing undeleted feeds", async () => {
    const db = createEmptyDatabase();
    const feedRepository = new SqliteFeedRepository(db);
    feedRepository.upsert({
      id: "feed_fixture",
      title: "Fixture Feed",
      feedUrl: "https://example.com/feed.xml",
      now: 1000
    });
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      const setup = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });
      const status = await app.inject({
        method: "GET",
        url: "/api/setup/status",
        headers: {
          cookie: cookieHeaderFromSetCookie(setup.headers["set-cookie"])
        }
      });

      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toEqual({
        data: {
          setupCompleted: true,
          hasFeeds: true,
          hasEmbeddingProvider: false,
          firstRefreshStatus: "idle"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("blocks ordinary APIs while the v0.1.1 derived-data upgrade is pending", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const embeddings = new SqliteEmbeddingRepository(db);
    const actions = new SqliteArticleActionRepository(db);
    const vectorStore = new SqliteVecVectorStore(db);

    feeds.upsert({
      id: "feed_upgrade",
      title: "Upgrade Feed",
      feedUrl: "https://example.com/upgrade.xml",
      now: 1000
    });
    articles.upsert({
      id: "article_upgrade",
      feedId: "feed_upgrade",
      url: "https://example.com/upgrade",
      canonicalUrl: "https://example.com/upgrade",
      title: "Upgrade article",
      summary: "Profile signal",
      publishedAt: 1000,
      discoveredAt: 1000,
      contentHash: "hash_upgrade",
      dedupeKey: "article_upgrade",
      now: 1000
    });
    embeddings.upsertProvider({
      id: "provider_upgrade",
      type: "openai_compatible",
      name: "Provider",
      baseUrl: "https://api.example.com/v1",
      model: "fixture",
      dimension: 3,
      enabled: true,
      now: 1000
    });
    embeddings.createIndex({
      id: "index_upgrade",
      providerId: "provider_upgrade",
      model: "fixture",
      dimension: 3,
      now: 1000
    });
    vectorStore.upsertArticleVector({
      articleId: "article_upgrade",
      embeddingIndexId: "index_upgrade",
      vector: [1, 0, 0],
      contentHash: "hash_upgrade",
      now: 1000
    });
    actions.record({ articleId: "article_upgrade", type: "favorite", now: 2000 });

    const app = buildRealServer({
      db,
      logger: false,
      cookieSecure: false,
      backgroundJobs: false,
      now: () => 5000
    });

    try {
      const setup = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });
      const cookie = cookieHeaderFromSetCookie(setup.headers["set-cookie"]);

      const setupStatus = await app.inject({
        method: "GET",
        url: "/api/setup/status",
        headers: { cookie }
      });
      expect(setupStatus.statusCode, setupStatus.body).toBe(200);
      expect(setupStatus.json()).toMatchObject({
        data: {
          derivedDataUpgrade: {
            state: "pending",
            blocking: true,
            activeIndexId: "index_upgrade"
          }
        }
      });

      const blocked = await app.inject({
        method: "GET",
        url: "/api/feeds",
        headers: { cookie }
      });
      expect(blocked.statusCode, blocked.body).toBe(423);
      expect(blocked.json()).toMatchObject({
        error: {
          code: "DERIVED_DATA_UPGRADE_IN_PROGRESS"
        }
      });

      const upgradeStatus = await app.inject({
        method: "GET",
        url: "/api/system/upgrade/status",
        headers: { cookie }
      });
      expect(upgradeStatus.statusCode, upgradeStatus.body).toBe(200);
      expect(upgradeStatus.json()).toMatchObject({
        data: {
          blocking: true
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("lists jobs with filters and redacted payload summaries", async () => {
    const db = createEmptyDatabase();
    const jobs = new SqliteJobRepository(db);
    jobs.enqueue({
      id: "job_feed_refresh",
      type: "feed_refresh",
      payloadJson: JSON.stringify({ feedId: "feed_secret_shape" }),
      now: 1000
    });
    jobs.enqueue({
      id: "job_embedding",
      type: "embedding_generate",
      payloadJson: JSON.stringify({
        embeddingIndexId: "index_fixture",
        articleIds: ["article_a", "article_b"]
      }),
      now: 2000
    });
    const app = buildServer({ db, logger: false });

    try {
      const embedding = await app.inject({
        method: "GET",
        url: "/api/jobs?status=queued&type=embedding_generate&limit=1"
      });
      expect(embedding.statusCode, embedding.body).toBe(200);
      expect(embedding.json()).toEqual({
        data: [
          {
            id: "job_embedding",
            type: "embedding_generate",
            status: "queued",
            error: null,
            attempts: 0,
            maxAttempts: 3,
            runAfter: "1970-01-01T00:00:02.000Z",
            startedAt: null,
            finishedAt: null,
            createdAt: "1970-01-01T00:00:02.000Z",
            updatedAt: "1970-01-01T00:00:02.000Z",
            payloadSummary: {
              embeddingIndexId: "index_fixture",
              articleCount: 2
            }
          }
        ]
      });
      expect(embedding.body).not.toContain("payloadJson");
      expect(embedding.body).not.toContain("article_a");
      expect(embedding.body).not.toContain("article_b");

      const feedRefresh = await app.inject({
        method: "GET",
        url: "/api/jobs?type=feed_refresh"
      });
      expect(feedRefresh.statusCode, feedRefresh.body).toBe(200);
      expect(feedRefresh.json().data[0]).toMatchObject({
        id: "job_feed_refresh",
        payloadSummary: null
      });
      expect(feedRefresh.body).not.toContain("feed_secret_shape");

      const invalid = await app.inject({
        method: "GET",
        url: "/api/jobs?status=waiting"
      });
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          details: {
            field: "status"
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports baseline recommendation status without an active provider and index", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          mode: "baseline",
          activeProvider: null,
          activeIndex: null,
          activeRankContext: "base",
          coverage: {
            candidateCount: 0,
            eligibleArticleCount: 0,
            missingEmbeddingCount: 0,
            staleEmbeddingCount: 0,
            embeddingCount: 0,
            coverageRatio: 0,
            pendingJobs: 0,
            failedJobs: 0,
            lastFailedAt: null,
            lastError: null
          },
          behaviorCounts: {},
          clusters: {
            positive: 0,
            negative: 0,
            items: []
          },
          rankedArticles: {
            base: 0,
            active: 0
          },
          lastProfileUpdate: null,
          lastRankingUpdate: null,
          warnings: expect.arrayContaining([
            {
              code: "NO_PROVIDER",
              message:
                "No active embedding provider and index are configured; recommendations are using baseline ranking."
            },
            {
              code: "PROFILE_WARMUP",
              message: "The recommendation profile still has limited behavior and interest signals."
            }
          ])
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("keeps profile warmup active for open-only behavior", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    createActiveEmbeddingDiagnosticsFixture(db, { providerTestStatus: "success" });
    feeds.upsert({
      id: "feed_warmup_open",
      title: "Warmup Open Feed",
      feedUrl: "https://example.com/warmup-open.xml",
      now: 1000
    });
    for (let index = 0; index < 3; index += 1) {
      const articleId = `article_warmup_open_${index}`;
      articles.upsert({
        id: articleId,
        feedId: "feed_warmup_open",
        url: `https://example.com/warmup-open/${index}`,
        title: `Warmup open ${index}`,
        summary: "Open-only behavior should not complete profile warmup.",
        discoveredAt: 2000 + index,
        dedupeKey: articleId,
        now: 2000 + index
      });
      db.prepare(
        `
          insert into behavior_events (
            id,
            article_id,
            event_type,
            event_weight,
            created_at
          )
          values (?, ?, 'open', 0.2, ?)
        `
      ).run(`event_warmup_open_${index}`, articleId, 3000 + index);
    }
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.warnings).toEqual(
        expect.arrayContaining([
          {
            code: "PROFILE_WARMUP",
            message: "The recommendation profile still has limited behavior and interest signals."
          }
        ])
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("clears profile warmup after enough profile signals and positive clusters", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const profiles = new SqliteProfileRepository(db);
    const { index: activeIndex } = createActiveEmbeddingDiagnosticsFixture(db, {
      providerTestStatus: "success"
    });
    feeds.upsert({
      id: "feed_warmup_ready",
      title: "Warmup Ready Feed",
      feedUrl: "https://example.com/warmup-ready.xml",
      now: 1000
    });
    const signalEvents = [
      ["article_warmup_ready_0", "favorite"],
      ["article_warmup_ready_0", "like"],
      ["article_warmup_ready_1", "read_later"],
      ["article_warmup_ready_1", "read_progress"],
      ["article_warmup_ready_2", "favorite"],
      ["article_warmup_ready_3", "like"],
      ["article_warmup_ready_4", "read_later"],
      ["article_warmup_ready_4", "read_progress"]
    ] as const;
    for (let index = 0; index < 5; index += 1) {
      const articleId = `article_warmup_ready_${index}`;
      articles.upsert({
        id: articleId,
        feedId: "feed_warmup_ready",
        url: `https://example.com/warmup-ready/${index}`,
        title: `Warmup ready ${index}`,
        summary: "Enough profile behavior should clear warmup.",
        discoveredAt: 2000 + index,
        dedupeKey: articleId,
        now: 2000 + index
      });
    }
    signalEvents.forEach(([articleId, eventType], eventIndex) => {
      db.prepare(
        `
          insert into behavior_events (
            id,
            article_id,
            event_type,
            event_weight,
            metadata_json,
            created_at
          )
          values (?, ?, ?, 1, ?, ?)
        `
      ).run(
        `event_warmup_ready_${eventIndex}`,
        articleId,
        eventType,
        eventType === "read_progress" ? JSON.stringify({ progress: 0.75 }) : null,
        3000 + eventIndex
      );
    });
    for (const clusterId of ["cluster_warmup_ready_a", "cluster_warmup_ready_b"]) {
      profiles.upsertCluster({
        id: clusterId,
        embeddingIndexId: activeIndex.id,
        polarity: "positive",
        centroidVectorBlob: toVectorBlob([1, 0, 0]),
        weight: 8,
        sampleCount: 4,
        now: 4000
      });
    }
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.warnings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "PROFILE_WARMUP"
          })
        ])
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("creates, tests, and lists OpenAI-compatible embedding providers", async () => {
    const db = createEmptyDatabase();
    const embeddingCalls: Array<{ url: string; authorization: string | null; inputCount: number }> =
      [];
    const app = buildServer({
      db,
      logger: false,
      now: () => 1000,
      embeddingFetcher: embeddingFetcherFixture(embeddingCalls, 3)
    });

    try {
      const created = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "OpenAI Compatible",
        baseUrl: "https://api.example.com/v1/",
        model: "fixture-embedding",
        dimension: 3,
        textMaxChars: 12000,
        requestsPerMinute: 30,
        requestsPerDay: 1000,
        apiKey: "secret",
        enabled: true,
        qualityTier: "recommended"
      });
      expect(created.statusCode, created.body).toBe(200);
      const providerId = (created.json() as { data: { id: string } }).data.id;
      expect(providerId).toMatch(/^provider_/);

      const providers = await app.inject({
        method: "GET",
        url: "/api/embedding/providers"
      });
      expect(providers.statusCode, providers.body).toBe(200);
      expect(providers.json()).toMatchObject({
        data: [
          {
            id: providerId,
            type: "openai_compatible",
            name: "OpenAI Compatible",
            baseUrl: "https://api.example.com/v1",
            model: "fixture-embedding",
            dimension: 3,
            textMaxChars: 12000,
            requestsPerMinute: 30,
            requestsPerDay: 1000,
            enabled: true,
            qualityTier: "recommended",
            hasApiKey: true
          }
        ]
      });
      expect(providers.body).not.toContain("secret");

      const indexes = await app.inject({
        method: "GET",
        url: "/api/embedding/indexes"
      });
      expect(indexes.statusCode, indexes.body).toBe(200);
      expect(indexes.json()).toMatchObject({
        data: [
          {
            providerId,
            model: "fixture-embedding",
            dimension: 3,
            textMaxChars: 12000,
            distanceMetric: "cosine",
            status: "active",
            embeddingCount: 0
          }
        ]
      });

      const status = await app.inject({
        method: "GET",
        url: "/api/setup/status"
      });
      expect(status.json()).toMatchObject({
        data: {
          hasEmbeddingProvider: true
        }
      });

      const test = await app.inject({
        method: "POST",
        url: `/api/embedding/providers/${providerId}/test`
      });
      expect(test.statusCode, test.body).toBe(200);
      expect(test.json()).toMatchObject({
        data: {
          status: "success",
          dimension: 3,
          latencyMs: expect.any(Number)
        }
      });
      expect(embeddingCalls).toEqual([
        {
          url: "https://api.example.com/v1/embeddings",
          authorization: "Bearer secret",
          inputCount: 1
        }
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("creates, tests, and lists Ollama embedding providers", async () => {
    const db = createEmptyDatabase();
    const embeddingCalls: Array<{ url: string; authorization: string | null; inputCount: number; model: string }> =
      [];
    const app = buildServer({
      db,
      logger: false,
      now: () => 1000,
      embeddingFetcher: ollamaEmbeddingFetcherFixture(embeddingCalls, 3)
    });

    try {
      const created = await postJson(app, "/api/embedding/providers", {
        type: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434/",
        model: "nomic-embed-text",
        dimension: 3,
        enabled: true,
        qualityTier: "basic"
      });
      expect(created.statusCode, created.body).toBe(200);
      const providerId = (created.json() as { data: { id: string } }).data.id;

      const providers = await app.inject({
        method: "GET",
        url: "/api/embedding/providers"
      });
      expect(providers.statusCode, providers.body).toBe(200);
      expect(providers.json()).toMatchObject({
        data: [
          {
            id: providerId,
            type: "ollama",
            name: "Ollama",
            baseUrl: "http://127.0.0.1:11434",
            model: "nomic-embed-text",
            dimension: 3,
            textMaxChars: 4000,
            enabled: true,
            qualityTier: "basic",
            hasApiKey: false
          }
        ]
      });

      const test = await app.inject({
        method: "POST",
        url: `/api/embedding/providers/${providerId}/test`
      });
      expect(test.statusCode, test.body).toBe(200);
      expect(test.json()).toMatchObject({
        data: {
          status: "success",
          dimension: 3,
          latencyMs: expect.any(Number)
        }
      });
      expect(embeddingCalls).toEqual([
        {
          url: "http://127.0.0.1:11434/api/embed",
          authorization: null,
          inputCount: 1,
          model: "nomic-embed-text"
        }
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("creates, tests, and lists Gemini embedding providers", async () => {
    const db = createEmptyDatabase();
    const embeddingCalls: Array<{
      url: string;
      apiKey: string | null;
      inputCount: number;
      model: string;
      outputDimensionality: number | null;
    }> = [];
    const app = buildServer({
      db,
      logger: false,
      now: () => 1000,
      embeddingFetcher: geminiEmbeddingFetcherFixture(embeddingCalls, 3)
    });

    try {
      const created = await postJson(app, "/api/embedding/providers", {
        type: "gemini",
        name: "Gemini AI Studio",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
        model: "gemini-embedding-001",
        dimension: 3,
        apiKey: "gemini-secret",
        enabled: true,
        qualityTier: "recommended"
      });
      expect(created.statusCode, created.body).toBe(200);
      const providerId = (created.json() as { data: { id: string } }).data.id;

      const providers = await app.inject({
        method: "GET",
        url: "/api/embedding/providers"
      });
      expect(providers.statusCode, providers.body).toBe(200);
      expect(providers.json()).toMatchObject({
        data: [
          {
            id: providerId,
            type: "gemini",
            name: "Gemini AI Studio",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            model: "gemini-embedding-001",
            dimension: 3,
            enabled: true,
            hasApiKey: true
          }
        ]
      });
      expect(providers.body).not.toContain("gemini-secret");

      const test = await app.inject({
        method: "POST",
        url: `/api/embedding/providers/${providerId}/test`
      });
      expect(test.statusCode, test.body).toBe(200);
      expect(test.json()).toMatchObject({
        data: {
          status: "success",
          dimension: 3,
          latencyMs: expect.any(Number)
        }
      });
      expect(embeddingCalls).toEqual([
        {
          url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
          apiKey: "gemini-secret",
          inputCount: 1,
          model: "models/gemini-embedding-001",
          outputDimensionality: 3
        }
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("requests configured dimensions for Gemini through OpenAI-compatible providers", async () => {
    const db = createEmptyDatabase();
    const embeddingCalls: Array<{
      url: string;
      authorization: string | null;
      inputCount: number;
      dimensions: number | null;
    }> = [];
    const app = buildServer({
      db,
      logger: false,
      now: () => 1000,
      embeddingFetcher: googleOpenAiCompatibleEmbeddingFetcherFixture(embeddingCalls)
    });

    try {
      const created = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Google AI Studio",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
        model: "gemini-embedding-001",
        dimension: 768,
        apiKey: "google-secret",
        enabled: true,
        qualityTier: "recommended"
      });
      expect(created.statusCode, created.body).toBe(200);
      const providerId = (created.json() as { data: { id: string } }).data.id;

      const test = await app.inject({
        method: "POST",
        url: `/api/embedding/providers/${providerId}/test`
      });
      expect(test.statusCode, test.body).toBe(200);
      expect(test.json()).toMatchObject({
        data: {
          status: "success",
          dimension: 768,
          latencyMs: expect.any(Number)
        }
      });
      expect(embeddingCalls).toEqual([
        {
          url: "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
          authorization: "Bearer google-secret",
          inputCount: 1,
          dimensions: 768
        }
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects unsupported embedding providers and invalid provider base URLs", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const unsupported = await postJson(app, "/api/embedding/providers", {
        type: "custom_http",
        name: "Custom HTTP",
        model: "custom-embedding",
        dimension: 3,
        enabled: true
      });
      expect(unsupported.statusCode, unsupported.body).toBe(400);
      expect(unsupported.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR"
        }
      });

      const invalidBaseUrl = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Bad Endpoint",
        baseUrl: "https://api.example.com/v1/embeddings",
        model: "fixture-embedding",
        dimension: 3,
        enabled: true
      });
      expect(invalidBaseUrl.statusCode, invalidBaseUrl.body).toBe(400);
      expect(invalidBaseUrl.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          details: {
            field: "baseUrl"
          }
        }
      });

      const invalidOllamaBaseUrl = await postJson(app, "/api/embedding/providers", {
        type: "ollama",
        name: "Bad Ollama Endpoint",
        baseUrl: "http://127.0.0.1:11434/api/embed",
        model: "nomic-embed-text",
        dimension: 768,
        enabled: true
      });
      expect(invalidOllamaBaseUrl.statusCode, invalidOllamaBaseUrl.body).toBe(400);
      expect(invalidOllamaBaseUrl.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          details: {
            field: "baseUrl"
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records provider test failures without storing errors on indexes", async () => {
    const db = createEmptyDatabase();
    const embeddingCalls: Array<{ url: string; authorization: string | null; inputCount: number }> =
      [];
    const app = buildServer({
      db,
      logger: false,
      embeddingFetcher: embeddingFetcherFixture(embeddingCalls, 2)
    });

    try {
      const created = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "OpenAI Compatible",
        baseUrl: "https://api.example.com/v1",
        model: "fixture-embedding",
        dimension: 3,
        enabled: true
      });
      const providerId = (created.json() as { data: { id: string } }).data.id;

      const failed = await app.inject({
        method: "POST",
        url: `/api/embedding/providers/${providerId}/test`
      });
      expect(failed.statusCode, failed.body).toBe(502);
      expect(failed.json()).toMatchObject({
        error: {
          code: "PROVIDER_ERROR"
        }
      });

      const providers = await app.inject({
        method: "GET",
        url: "/api/embedding/providers"
      });
      expect(providers.json()).toMatchObject({
        data: [
          {
            id: providerId,
            lastTestStatus: "failed",
            lastTestError: expect.stringContaining("dimension 2")
          }
        ]
      });

      const indexes = await app.inject({
        method: "GET",
        url: "/api/embedding/indexes"
      });
      expect(indexes.body).not.toContain("lastTestError");
      expect(indexes.body).not.toContain("error");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("classifies embedding provider test failures with actionable public errors", async () => {
    const cases: Array<{
      name: string;
      fetcher: typeof fetch;
      expectedMessage: string;
      expectedCategory?: string;
      expectedStatus?: number;
    }> = [
      {
        name: "authentication",
        fetcher: embeddingErrorFetcher(401, {
          error: {
            message: "invalid api_key sk-test-secret",
            code: "invalid_api_key"
          }
        }),
        expectedMessage: "authentication failed",
        expectedCategory: "authentication",
        expectedStatus: 401
      },
      {
        name: "permission",
        fetcher: embeddingErrorFetcher(403, {
          error: {
            message: "permission denied"
          }
        }),
        expectedMessage: "authentication failed",
        expectedCategory: "authentication",
        expectedStatus: 403
      },
      {
        name: "missing model",
        fetcher: embeddingErrorFetcher(404, {
          error: {
            message: "model fixture-embedding was not found"
          }
        }),
        expectedMessage: "endpoint or model was not found",
        expectedCategory: "not_found",
        expectedStatus: 404
      },
      {
        name: "rate limit",
        fetcher: embeddingErrorFetcher(429, {
          error: {
            message: "rate limit exceeded"
          }
        }),
        expectedMessage: "rate limit was reached",
        expectedCategory: "rate_limit",
        expectedStatus: 429
      },
      {
        name: "unavailable",
        fetcher: embeddingErrorFetcher(503, {
          error: {
            message: "upstream is overloaded"
          }
        }),
        expectedMessage: "provider is unavailable",
        expectedCategory: "provider_unavailable",
        expectedStatus: 503
      },
      {
        name: "network",
        fetcher: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
        },
        expectedMessage: "could not be reached",
        expectedCategory: "network"
      },
      {
        name: "malformed response",
        fetcher: async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }),
        expectedMessage: "malformed response"
      }
    ];

    for (const scenario of cases) {
      const db = createEmptyDatabase();
      const app = buildServer({
        db,
        logger: false,
        embeddingFetcher: scenario.fetcher
      });

      try {
        const created = await postJson(app, "/api/embedding/providers", {
          type: "openai_compatible",
          name: `OpenAI Compatible ${scenario.name}`,
          baseUrl: "https://api.example.com/v1",
          model: "fixture-embedding",
          dimension: 3,
          enabled: true,
          apiKey: "secret"
        });
        const providerId = (created.json() as { data: { id: string } }).data.id;

        const failed = await app.inject({
          method: "POST",
          url: `/api/embedding/providers/${providerId}/test`
        });
        expect(failed.statusCode, `${scenario.name}: ${failed.body}`).toBe(502);
        expect(failed.json()).toMatchObject({
          error: {
            code: "PROVIDER_ERROR",
            message: expect.stringContaining(scenario.expectedMessage)
          }
        });
        if (scenario.expectedCategory) {
          expect(failed.json()).toMatchObject({
            error: {
              details: {
                category: scenario.expectedCategory
              }
            }
          });
        }
        if (scenario.expectedStatus) {
          expect(failed.json()).toMatchObject({
            error: {
              details: {
                status: scenario.expectedStatus
              }
            }
          });
        }
        expect(failed.body).not.toContain("sk-test-secret");
        expect(failed.body).not.toContain("Bearer secret");

        const providers = await app.inject({
          method: "GET",
          url: "/api/embedding/providers"
        });
        expect(providers.json()).toMatchObject({
          data: [
            {
              id: providerId,
              lastTestStatus: "failed",
              lastTestError: expect.stringContaining(scenario.expectedMessage)
            }
          ]
        });
        expect(providers.body).not.toContain("sk-test-secret");

        const indexes = await app.inject({
          method: "GET",
          url: "/api/embedding/indexes"
        });
        expect(indexes.body).not.toContain("lastTestError");
        expect(indexes.body).not.toContain("providerMessage");
      } finally {
        await app.close();
        db.close();
      }
    }
  });

  it("prevents deleting embedding providers that already have indexes", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 1000 });

    try {
      const enabled = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Enabled Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture-embedding",
        dimension: 3,
        enabled: true
      });
      const enabledProviderId = (enabled.json() as { data: { id: string } }).data.id;

      const conflict = await app.inject({
        method: "DELETE",
        url: `/api/embedding/providers/${enabledProviderId}`
      });
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(conflict.json()).toMatchObject({
        error: {
          code: "CONFLICT"
        }
      });

      const disabled = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Disabled Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture-embedding",
        dimension: 3,
        enabled: false
      });
      const disabledProviderId = (disabled.json() as { data: { id: string } }).data.id;

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/embedding/providers/${disabledProviderId}`
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json()).toEqual({
        data: {
          ok: true
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("enables embedding providers transactionally by disabling the previous active provider", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 1000 });

    try {
      const first = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "First Provider",
        baseUrl: "https://api.first.example/v1",
        model: "fixture-embedding",
        dimension: 3,
        enabled: true
      });
      const firstProviderId = (first.json() as { data: { id: string } }).data.id;

      const second = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Second Provider",
        baseUrl: "https://api.second.example/v1",
        model: "fixture-embedding",
        dimension: 3,
        enabled: true
      });
      const secondProviderId = (second.json() as { data: { id: string } }).data.id;

      const providers = await app.inject({
        method: "GET",
        url: "/api/embedding/providers"
      });
      expect(providers.statusCode, providers.body).toBe(200);
      expect(providers.json()).toMatchObject({
        data: [
          {
            id: secondProviderId,
            enabled: true
          },
          {
            id: firstProviderId,
            enabled: false
          }
        ]
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("activates a saved provider explicitly without editing the provider profile", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 1000 });

    try {
      const first = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "First Provider",
        baseUrl: "https://api.first.example/v1",
        model: "bge-m3",
        dimension: 1024,
        enabled: true
      });
      const firstProviderId = (first.json() as { data: { id: string } }).data.id;

      const second = await postJson(app, "/api/embedding/providers", {
        type: "ollama",
        name: "Second Provider",
        baseUrl: "http://127.0.0.1:11434",
        model: "BAAI/bge-m3",
        dimension: 1024,
        enabled: false
      });
      const secondProviderId = (second.json() as { data: { id: string } }).data.id;

      const activated = await app.inject({
        method: "POST",
        url: `/api/embedding/providers/${secondProviderId}/activate`
      });
      expect(activated.statusCode, activated.body).toBe(200);
      expect(activated.json()).toMatchObject({
        data: {
          id: secondProviderId,
          enabled: true,
          model: "BAAI/bge-m3",
          dimension: 1024
        }
      });

      const providers = await app.inject({
        method: "GET",
        url: "/api/embedding/providers"
      });
      expect(providers.json()).toMatchObject({
        data: [
          {
            id: secondProviderId,
            enabled: true
          },
          {
            id: firstProviderId,
            enabled: false
          }
        ]
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects provider switches across different embedding models or dimensions", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 1000 });

    try {
      const first = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "First Provider",
        baseUrl: "https://api.first.example/v1",
        model: "bge-m3",
        dimension: 1024,
        enabled: true
      });
      expect(first.statusCode, first.body).toBe(200);

      const incompatible = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Second Provider",
        baseUrl: "https://api.second.example/v1",
        model: "text-embedding-3-small",
        dimension: 1536,
        enabled: true
      });
      expect(incompatible.statusCode, incompatible.body).toBe(409);
      expect(incompatible.json()).toMatchObject({
        error: {
          code: "INCOMPATIBLE_PROVIDER_SWITCH"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("rejects explicit provider activation across different embedding models or dimensions", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 1000 });

    try {
      const first = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "First Provider",
        baseUrl: "https://api.first.example/v1",
        model: "bge-m3",
        dimension: 1024,
        enabled: true
      });
      expect(first.statusCode, first.body).toBe(200);

      const second = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Second Provider",
        baseUrl: "https://api.second.example/v1",
        model: "text-embedding-3-small",
        dimension: 1536,
        enabled: false
      });
      const secondProviderId = (second.json() as { data: { id: string } }).data.id;

      const incompatible = await app.inject({
        method: "POST",
        url: `/api/embedding/providers/${secondProviderId}/activate`
      });
      expect(incompatible.statusCode, incompatible.body).toBe(409);
      expect(incompatible.json()).toMatchObject({
        error: {
          code: "INCOMPATIBLE_PROVIDER_SWITCH"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("creates a new active index on model, dimension, or text slice change without polluting the old index", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 1000 });

    try {
      const created = await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Migration Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture-embedding-v1",
        dimension: 3,
        enabled: true
      });
      const providerId = (created.json() as { data: { id: string } }).data.id;
      const firstIndexes = await app.inject({
        method: "GET",
        url: "/api/embedding/indexes"
      });
      const oldIndex = (firstIndexes.json() as { data: Array<{ id: string }> }).data[0];

      new SqliteVecVectorStore(db).upsertArticleVector({
        articleId: "article_recommended",
        embeddingIndexId: oldIndex.id,
        vector: [1, 0, 0],
        contentHash: "article_recommended:2000",
        now: 1100
      });

      const updated = await injectJson(app, "PATCH", `/api/embedding/providers/${providerId}`, {
        model: "fixture-embedding-v2",
        dimension: 4,
        enabled: true
      });
      expect(updated.statusCode, updated.body).toBe(200);

      const indexes = await app.inject({
        method: "GET",
        url: "/api/embedding/indexes"
      });
      expect(indexes.statusCode, indexes.body).toBe(200);
      const data = (indexes.json() as { data: Array<{ id: string; status: string; model: string; dimension: number; textMaxChars: number; embeddingCount: number; coverageRatio: number }> }).data;
      const active = data.find((index) => index.status === "active");
      const retired = data.find((index) => index.id === oldIndex.id);

      expect(active).toMatchObject({
        model: "fixture-embedding-v2",
        dimension: 4,
        textMaxChars: 8000,
        embeddingCount: 0,
        coverageRatio: 0
      });
      expect(active?.id).not.toBe(oldIndex.id);
      expect(retired).toMatchObject({
        id: oldIndex.id,
        status: "retired",
        model: "fixture-embedding-v1",
        dimension: 3,
        textMaxChars: 8000,
        embeddingCount: 1
      });

      const textSliceUpdate = await injectJson(
        app,
        "PATCH",
        `/api/embedding/providers/${providerId}`,
        {
          textMaxChars: 12000,
          enabled: true
        }
      );
      expect(textSliceUpdate.statusCode, textSliceUpdate.body).toBe(200);
      const textSliceIndexes = await app.inject({
        method: "GET",
        url: "/api/embedding/indexes"
      });
      const textSliceData = (textSliceIndexes.json() as { data: Array<{ id: string; status: string; model: string; dimension: number; textMaxChars: number; embeddingCount: number }> }).data;
      const textSliceActive = textSliceData.find((index) => index.status === "active");
      expect(textSliceActive).toMatchObject({
        model: "fixture-embedding-v2",
        dimension: 4,
        textMaxChars: 12000,
        embeddingCount: 0
      });
      expect(textSliceActive?.id).not.toBe(active?.id);

      const recommended = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });
      expect(recommended.json()).toMatchObject({
        data: {
          activeIndex: {
            id: textSliceActive?.id
          },
          activeRankContext: "rec_v3:embedding:cocoon_5:schema_3"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("uses provider-specific embedding backfill batch sizes", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    feeds.upsert({
      id: "feed_batch",
      title: "Batch Feed",
      feedUrl: "https://example.com/batch.xml",
      now: 1000
    });
    for (let index = 0; index < 9; index += 1) {
      articles.upsert({
        id: `article_batch_${index}`,
        feedId: "feed_batch",
        url: `https://example.com/batch/${index}`,
        canonicalUrl: `https://example.com/batch/${index}`,
        title: `Batch article ${index}`,
        summary: "Batch sizing fixture",
        publishedAt: 1000 + index,
        discoveredAt: 1000 + index,
        dedupeKey: `article_batch_${index}`,
        now: 1000 + index
      });
    }
    const app = buildServer({ db, logger: false, now: () => 2000 });

    try {
      await postJson(app, "/api/embedding/providers", {
        type: "ollama",
        name: "Ollama Batch",
        baseUrl: "http://127.0.0.1:11434",
        model: "bge-m3",
        dimension: 1024,
        enabled: true
      });
      const indexes = await app.inject({
        method: "GET",
        url: "/api/embedding/indexes"
      });
      const indexId = (indexes.json() as { data: Array<{ id: string }> }).data[0].id;
      const backfill = await app.inject({
        method: "POST",
        url: `/api/embedding/indexes/${indexId}/backfill`
      });
      expect(backfill.statusCode, backfill.body).toBe(200);

      const payloads = db
        .prepare(
          `
            select payload_json as payloadJson
            from jobs
            where type = 'embedding_generate'
            order by id
          `
        )
        .all() as Array<{ payloadJson: string }>;
      const lengths = payloads.map(
        (row) => (JSON.parse(row.payloadJson) as { articleIds: string[] }).articleIds.length
      );
      expect(lengths.sort((left, right) => right - left)).toEqual([4, 4, 1]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("queues embedding jobs for newly refreshed articles without calling the provider inline", async () => {
    const db = createEmptyDatabase();
    const embeddingCalls: Array<{ url: string; authorization: string | null; inputCount: number }> =
      [];
    const app = buildServer({
      db,
      logger: false,
      feedFetcher: fixtureFetcher({ "https://example.com/feed.xml": fixtureRss }),
      embeddingFetcher: embeddingFetcherFixture(embeddingCalls, 3)
    });

    try {
      await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "OpenAI Compatible",
        baseUrl: "https://api.example.com/v1",
        model: "fixture-embedding",
        dimension: 3,
        enabled: true
      });

      const feed = await postJson(app, "/api/feeds", {
        feedUrl: "https://example.com/feed.xml"
      });
      expect(feed.statusCode, feed.body).toBe(200);

      const queued = db
        .prepare(
          `
            select payload_json as payloadJson
            from jobs
            where type = 'embedding_generate'
              and status = 'queued'
          `
        )
        .all() as Array<{ payloadJson: string }>;
      expect(queued).toHaveLength(1);
      const payload = JSON.parse(queued[0].payloadJson) as {
        embeddingIndexId: string;
        articleIds: string[];
      };
      expect(payload.embeddingIndexId).toMatch(/^index_/);
      expect(payload.articleIds).toHaveLength(2);
      expect(payload.articleIds.length).toBeLessThanOrEqual(16);
      expect(embeddingCalls).toEqual([]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports embedding coverage on index and recommendation diagnostics", async () => {
    const db = createFixtureDatabase();
    const { index } = createActiveEmbeddingDiagnosticsFixture(db, {
      providerTestStatus: "success"
    });
    const jobs = new SqliteJobRepository(db);
    jobs.enqueue({
      id: "job_embedding_pending",
      type: "embedding_generate",
      payloadJson: JSON.stringify({
        embeddingIndexId: index.id,
        articleIds: ["article_recent"]
      }),
      now: 6000
    });
    new SqliteVecVectorStore(db).upsertArticleVector({
      articleId: "article_recommended",
      embeddingIndexId: index.id,
      vector: [1, 0, 0],
      contentHash: "article_recommended:2000",
      now: 6100
    });
    new SqliteProfileRepository(db).upsertCluster({
      id: "cluster_overfit_probe",
      embeddingIndexId: index.id,
      polarity: "positive",
      centroidVectorBlob: toVectorBlob([1, 0, 0]),
      weight: 24,
      sampleCount: 1,
      now: 6150
    });
    db.prepare(
      `
        insert into behavior_events (
          id,
          article_id,
          event_type,
          event_weight,
          created_at
        )
        values (?, ?, ?, ?, ?)
      `
    ).run("event_cluster_favorite", "article_recommended", "favorite", 6, 6160);
    db.prepare(
      `
        insert into article_states (
          article_id,
          hidden_at,
          reading_progress,
          updated_at
        )
        values (?, ?, ?, ?)
        on conflict(article_id) do update set
          hidden_at = excluded.hidden_at,
          updated_at = excluded.updated_at
      `
    ).run("article_recommended", 6200, 0, 6200);
    const app = buildServer({ db, logger: false });

    try {
      const indexes = await app.inject({
        method: "GET",
        url: "/api/embedding/indexes"
      });
      expect(indexes.statusCode, indexes.body).toBe(200);
      expect(indexes.json().data[0]).toMatchObject({
        id: index.id,
        candidateCount: 2,
        eligibleArticleCount: 2,
        missingEmbeddingCount: 1,
        staleEmbeddingCount: 0,
        embeddingCount: 1,
        coverageRatio: 0.5,
        pendingJobs: 1,
        failedJobs: 0,
        lastFailedAt: null,
        lastError: null
      });

      const status = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toMatchObject({
        data: {
          mode: "embedding",
          activeProvider: {
            id: "provider_diagnostics",
            type: "openai_compatible",
            name: "Diagnostics Provider",
            model: "fixture-embedding",
            dimension: 3,
            lastTestStatus: "success",
            lastTestAt: "1970-01-01T00:00:05.000Z"
          },
          activeIndex: {
            id: index.id,
            status: "active",
            model: "fixture-embedding",
            dimension: 3
          },
          activeRankContext: "rec_v3:embedding:cocoon_5:schema_3",
          coverage: {
            candidateCount: 2,
            eligibleArticleCount: 2,
            missingEmbeddingCount: 1,
            staleEmbeddingCount: 0,
            embeddingCount: 1,
            coverageRatio: 0.5,
            pendingJobs: 1,
            failedJobs: 0,
            lastFailedAt: null,
            lastError: null
          },
          clusters: {
            positive: 1,
            negative: 0,
            families: {
              positive: 0,
              negative: 0,
              topFamilies: []
            },
            items: [
              {
                id: "cluster_overfit_probe",
                diagnostics: {
                  supportArticleCount: 1,
                  supportEventCount: 1,
                  sourceCount: 1,
                  strongSignalCount: 1,
                  strongSignalRatio: 1,
                  topSourceShare: 1,
                  averageSimilarity: 1,
                  maxSimilarity: 1,
                  overfitRisk: "medium",
                  warnings: ["HIGH_WEIGHT_LOW_SUPPORT"]
                }
              }
            ]
          },
          warnings: expect.arrayContaining([
            {
              code: "EMBEDDING_PENDING",
              message: "Embedding generation is still running or incomplete for the active index."
            }
          ])
        }
      });
      expect(status.body).not.toContain("apiKey");
      expect(status.body).not.toContain("apiKeyEncrypted");
      expect(status.body).not.toContain("hasApiKey");
      expect(status.body).not.toContain("vectorBlob");
      expect(status.body).not.toContain("tableName");

      const lightStatus = await app.inject({
        method: "GET",
        url: "/api/recommendation/status?includeClusterItems=false"
      });
      expect(lightStatus.statusCode, lightStatus.body).toBe(200);
      expect(lightStatus.json()).toMatchObject({
        data: {
          mode: "embedding",
          clusters: {
            positive: 1,
            negative: 0,
            families: {
              positive: 0,
              negative: 0,
              topFamilies: []
            },
            items: []
          }
        }
      });
      expect(lightStatus.body).not.toContain("cluster_overfit_probe");
      expect(lightStatus.body).not.toContain("vectorBlob");

      const invalidLightStatus = await app.inject({
        method: "GET",
        url: "/api/recommendation/status?includeClusterItems=maybe"
      });
      expect(invalidLightStatus.statusCode, invalidLightStatus.body).toBe(400);
      expect(invalidLightStatus.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          details: {
            field: "includeClusterItems"
          }
        }
      });

      const transparency = await app.inject({
        method: "GET",
        url: "/api/recommendation/transparency"
      });
      expect(transparency.statusCode, transparency.body).toBe(200);
      expect(transparency.json()).toMatchObject({
        data: {
          transparency: {
            algorithmModules: expect.arrayContaining([
              expect.objectContaining({
                id: "coverage_backfill",
                status: "stopped"
              }),
              expect.objectContaining({
                id: "semantic_ranking",
                status: "warning"
              })
            ])
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("backfills only active index missing or stale embeddings and deduplicates open jobs", async () => {
    const db = createFixtureDatabase();
    const { index } = createActiveEmbeddingDiagnosticsFixture(db, {
      providerTestStatus: "success"
    });
    const vectorStore = new SqliteVecVectorStore(db);
    vectorStore.upsertArticleVector({
      articleId: "article_recommended",
      embeddingIndexId: index.id,
      vector: [1, 0, 0],
      contentHash: "stale-hash",
      now: 6100
    });
    const app = buildServer({ db, logger: false, now: () => 7000 });

    try {
      const first = await app.inject({
        method: "POST",
        url: `/api/embedding/indexes/${index.id}/backfill`
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        data: {
          candidateCount: 2,
          enqueuedArticleCount: 2,
          dedupedArticleCount: 0
        }
      });
      expect(first.json().data.jobIds).toHaveLength(1);

      const second = await app.inject({
        method: "POST",
        url: `/api/embedding/indexes/${index.id}/backfill`
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({
        data: {
          candidateCount: 2,
          enqueuedArticleCount: 0,
          dedupedArticleCount: 2,
          jobIds: []
        }
      });

      const indexes = await app.inject({
        method: "GET",
        url: "/api/embedding/indexes"
      });
      expect(indexes.json().data[0]).toMatchObject({
        id: index.id,
        candidateCount: 2,
        eligibleArticleCount: 2,
        missingEmbeddingCount: 1,
        staleEmbeddingCount: 1,
        pendingJobs: 1
      });

      new SqliteEmbeddingRepository(db).markIndexStatus(index.id, "retired", 7100);
      const retired = await app.inject({
        method: "POST",
        url: `/api/embedding/indexes/${index.id}/backfill`
      });
      expect(retired.statusCode, retired.body).toBe(409);
      expect(retired.json()).toMatchObject({
        error: {
          code: "CONFLICT"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports degraded recommendation diagnostics for failed embedding jobs while recommendations remain usable", async () => {
    const db = createFixtureDatabase();
    const { index } = createActiveEmbeddingDiagnosticsFixture(db, {
      providerTestStatus: "success"
    });
    const jobs = new SqliteJobRepository(db);
    const failedJob = jobs.enqueue({
      id: "job_embedding_failed",
      type: "embedding_generate",
      payloadJson: JSON.stringify({
        embeddingIndexId: index.id,
        articleIds: ["article_recent", "article_recommended"]
      }),
      now: 7000
    });
    jobs.markFailed(failedJob.id, "Provider request failed", 7100);
    const profiles = new SqliteProfileRepository(db);
    profiles.upsertCluster({
      id: "cluster_positive",
      embeddingIndexId: index.id,
      polarity: "positive",
      centroidVectorBlob: toVectorBlob([1, 0, 0]),
      weight: 1,
      sampleCount: 1,
      now: 7200
    });
    profiles.upsertCluster({
      id: "cluster_negative",
      embeddingIndexId: index.id,
      polarity: "negative",
      centroidVectorBlob: toVectorBlob([0, 1, 0]),
      weight: 1,
      sampleCount: 1,
      now: 7300
    });
    const app = buildServer({ db, logger: false });

    try {
      const status = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toMatchObject({
        data: {
          mode: "degraded",
          coverage: {
            candidateCount: 2,
            eligibleArticleCount: 2,
            missingEmbeddingCount: 2,
            staleEmbeddingCount: 0,
            coveredArticleCount: 0,
            embeddingCount: 0,
            coverageRatio: 0,
            pendingJobs: 0,
            failedJobs: 1,
            lastFailedAt: "1970-01-01T00:00:07.100Z",
            lastError: "Provider request failed"
          },
          clusters: {
            positive: 1,
            negative: 1
          },
          warnings: expect.arrayContaining([
            {
              code: "EMBEDDING_JOB_FAILED",
              message: "Embedding generation has failed jobs for the active index."
            }
          ])
        }
      });

      const recommended = await app.inject({
        method: "GET",
        url: "/api/articles?view=recommended"
      });
      expect(recommended.statusCode, recommended.body).toBe(200);
      expect(recommended.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_recommended",
        "article_recent"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("does not keep recommendation diagnostics degraded for historical failed jobs after coverage recovers", async () => {
    const db = createFixtureDatabase();
    const { index } = createActiveEmbeddingDiagnosticsFixture(db, {
      providerTestStatus: "success"
    });
    const vectorStore = new SqliteVecVectorStore(db);
    vectorStore.upsertArticleVector({
      articleId: "article_recommended",
      embeddingIndexId: index.id,
      vector: [1, 0, 0],
      contentHash: "article_recommended:2000",
      now: 6100
    });
    vectorStore.upsertArticleVector({
      articleId: "article_recent",
      embeddingIndexId: index.id,
      vector: [0, 1, 0],
      contentHash: "article_recent:3000",
      now: 6200
    });
    const jobs = new SqliteJobRepository(db);
    const failedJob = jobs.enqueue({
      id: "job_embedding_historical_failed",
      type: "embedding_generate",
      payloadJson: JSON.stringify({
        embeddingIndexId: index.id,
        articleIds: ["article_recent"]
      }),
      now: 7000
    });
    jobs.markFailed(failedJob.id, "Provider request failed", 7100);
    const app = buildServer({ db, logger: false });

    try {
      const status = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });

      expect(status.statusCode, status.body).toBe(200);
      const body = status.json();
      expect(body).toMatchObject({
        data: {
          mode: "personalized",
          coverage: {
            candidateCount: 2,
            eligibleArticleCount: 2,
            missingEmbeddingCount: 0,
            staleEmbeddingCount: 0,
            coveredArticleCount: 2,
            embeddingCount: 2,
            coverageRatio: 1,
            pendingJobs: 0,
            failedJobs: 0,
            lastFailedAt: null,
            lastError: null
          }
        }
      });
      expect(body.data.warnings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "EMBEDDING_JOB_FAILED"
          })
        ])
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("reports degraded recommendation diagnostics when the active provider test failed", async () => {
    const db = createFixtureDatabase();
    createActiveEmbeddingDiagnosticsFixture(db, {
      providerTestStatus: "failed"
    });
    const app = buildServer({ db, logger: false });

    try {
      const status = await app.inject({
        method: "GET",
        url: "/api/recommendation/status"
      });

      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toMatchObject({
        data: {
          mode: "degraded",
          activeProvider: {
            lastTestStatus: "failed"
          },
          warnings: expect.arrayContaining([
            {
              code: "PROVIDER_TEST_FAILED",
              message: "The active embedding provider's latest connection test failed."
            }
          ])
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("protects, reads, and strictly updates app settings", async () => {
    const db = createEmptyDatabase();
    const app = buildRealServer({
      db,
      logger: false,
      cookieSecure: false,
      now: () => 5000
    });

    try {
      const anonymous = await app.inject({
        method: "GET",
        url: "/api/settings"
      });
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      expect(anonymous.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });

      const setup = await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });
      const cookie = cookieHeaderFromSetCookie(setup.headers["set-cookie"]);
      db.prepare(
        `
          insert into app_settings (key, value_json, updated_at)
          values (?, ?, ?)
          on conflict(key) do update set value_json = excluded.value_json
        `
      ).run("retention.articleDays", JSON.stringify("invalid"), 5000);

      const defaults = await app.inject({
        method: "GET",
        url: "/api/settings",
        headers: {
          cookie
        }
      });
      expect(defaults.statusCode, defaults.body).toBe(200);
      expect(defaults.json()).toEqual({
        data: {
          ui: {
            locale: "zh-CN",
            defaultHomeView: "recommended"
          },
          reader: {
            fontSize: 18,
            lineHeight: 1.75,
            paragraphGap: 1.1,
            readerWidth: 720,
            theme: "paper"
          },
          behavior: {
            markScrolledArticlesIgnored: true,
            removeReadLaterOnReadComplete: false
          },
          telemetry: {
            enabled: true
          },
          retention: {
            retentionDays: 0,
            keepFavorites: true,
            keepReadLater: true
          },
          ranking: {
            preferFreshness: 0.5,
            preferSource: 0.5,
            preferDiversity: 0.5,
            cocoonLevel: 5,
            maxPositiveInterestClusters: 48,
            maxNegativeInterestClusters: 32,
            maxPositiveInterestFamilies: 16,
            maxNegativeInterestFamilies: 12,
            localLearningEnabled: true,
            localLearningShadowMode: false,
            explorationEnabled: true,
            evaluationEnabled: false
          },
          recommendationMaintenance: {
            maintenanceEnabled: true,
            recentIntentAutoRebuildEnabled: true,
            keywordAutoRebuildEnabled: true,
            duplicateAutoRebuildEnabled: true,
            clusterLabelAutoRebuildEnabled: true,
            clusterMergeDiagnosticsEnabled: true,
            clusterAutoMergeEnabled: false,
            ftrlAutoTrainEnabled: true,
            ftrlAutoPromoteEnabled: false,
            evaluationAutoRunEnabled: false,
            evaluationAutoRunIntervalDays: 7,
            embeddingHealthAutoBackfillEnabled: true
          }
        }
      });

      const updated = await injectJsonWithCookie(app, "PATCH", "/api/settings", cookie, {
        ui: {
          locale: "ja-JP",
          defaultHomeView: "latest"
        },
        reader: {
          fontSize: 20,
          lineHeight: 1.8
        },
        retention: {
          retentionDays: 45,
          keepFavorites: false,
          keepReadLater: true
        },
        behavior: {
          markScrolledArticlesIgnored: false,
          removeReadLaterOnReadComplete: true
        },
        telemetry: {
          enabled: false
        },
        ranking: {
          cocoonLevel: 7,
          maxPositiveInterestClusters: 48,
          maxNegativeInterestClusters: 32,
          maxPositiveInterestFamilies: 20,
          maxNegativeInterestFamilies: 10
        }
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({
        data: {
          ok: true,
          settings: {
            ui: {
              locale: "ja-JP",
              defaultHomeView: "latest"
            },
            reader: {
              fontSize: 20,
              lineHeight: 1.8,
              paragraphGap: 1.1,
              readerWidth: 720
            },
            retention: {
              retentionDays: 45,
              keepFavorites: false,
              keepReadLater: true
            },
            behavior: {
              markScrolledArticlesIgnored: false,
              removeReadLaterOnReadComplete: true
            },
            telemetry: {
              enabled: false
            },
            ranking: {
              cocoonLevel: 7,
              maxPositiveInterestClusters: 48,
              maxNegativeInterestClusters: 32,
              maxPositiveInterestFamilies: 20,
              maxNegativeInterestFamilies: 10
            }
          }
        }
      });
      expect(
        db.prepare("select value_json as valueJson from app_settings where key = ?").get(
          "retention.articleDays"
        )
      ).toEqual({
        valueJson: "45"
      });

      const partial = await injectJsonWithCookie(app, "PATCH", "/api/settings", cookie, {
        reader: {
          paragraphGap: 1.3
        }
      });
      expect(partial.statusCode, partial.body).toBe(200);
      expect(partial.json()).toMatchObject({
        data: {
          settings: {
            reader: {
              fontSize: 20,
              lineHeight: 1.8,
              paragraphGap: 1.3,
              readerWidth: 720
            },
            retention: {
              retentionDays: 45
            },
            behavior: {
              markScrolledArticlesIgnored: false,
              removeReadLaterOnReadComplete: true
            },
            telemetry: {
              enabled: false
            }
          }
        }
      });

      for (const payload of [
        {
          reader: {
            theme: "paper"
          }
        },
        {
          ui: {
            locale: "fr-FR"
          }
        },
        {
          retention: {
            retentionDays: -1
          }
        },
        {
          retention: {
            retentionDays: "30"
          }
        },
        {
          behavior: {
            markScrolledArticlesIgnored: "yes"
          }
        },
        {
          behavior: {
            removeReadLaterOnReadComplete: "yes"
          }
        },
        {
          telemetry: {
            enabled: "yes"
          }
        },
        {
          ranking: {
            preferFreshness: 0.9
          }
        },
        {
          ranking: {
            maxPositiveInterestClusters: 7
          }
        },
        {
          ranking: {
            maxNegativeInterestClusters: 129
          }
        }
      ]) {
        const invalid = await injectJsonWithCookie(app, "PATCH", "/api/settings", cookie, payload);
        expect(invalid.statusCode, invalid.body).toBe(400);
        expect(invalid.json()).toMatchObject({
          error: {
            code: "VALIDATION_ERROR"
          }
        });
      }
    } finally {
      await app.close();
      db.close();
    }
  });

  it("checks the latest GitHub release once per installation-anchored day and on demand", async () => {
    const db = createEmptyDatabase();
    let now = Date.parse("2026-05-28T09:30:00.000Z");
    let requestCount = 0;
    const latestReleaseFetcher: typeof fetch = async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          name: "Dibao v0.2.0",
          html_url: "https://github.com/Pls-1q43/Dibao/releases/tag/v0.2.0",
          published_at: "2026-05-28T08:00:00.000Z"
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    };
    const app = buildServer({
      db,
      logger: false,
      now: () => now,
      latestReleaseFetcher
    });

    try {
      await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });

      const first = await app.inject({
        method: "GET",
        url: "/api/system/latest-release"
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        data: {
          currentVersion: "0.1.3",
          latestVersion: "v0.2.0",
          releaseUrl: "https://github.com/Pls-1q43/Dibao/releases/tag/v0.2.0",
          updateAvailable: true,
          status: "update_available",
          checkedAt: "2026-05-28T09:30:00.000Z",
          nextAutoCheckAt: "2026-05-29T09:30:00.000Z"
        }
      });
      expect(requestCount).toBe(1);

      now = Date.parse("2026-05-29T09:29:59.000Z");
      const sameWindow = await app.inject({
        method: "GET",
        url: "/api/system/latest-release"
      });
      expect(sameWindow.statusCode, sameWindow.body).toBe(200);
      expect(requestCount).toBe(1);

      now = Date.parse("2026-05-29T09:30:01.000Z");
      const nextWindow = await app.inject({
        method: "GET",
        url: "/api/system/latest-release"
      });
      expect(nextWindow.statusCode, nextWindow.body).toBe(200);
      expect(requestCount).toBe(2);

      const manual = await app.inject({
        method: "POST",
        url: "/api/system/latest-release/check"
      });
      expect(manual.statusCode, manual.body).toBe(200);
      expect(requestCount).toBe(3);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("treats a missing GitHub latest release as an empty release status", async () => {
    const db = createEmptyDatabase();
    const now = Date.parse("2026-05-28T09:30:00.000Z");
    const app = buildServer({
      db,
      logger: false,
      now: () => now,
      latestReleaseFetcher: async () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: {
            "content-type": "application/json"
          }
        })
    });

    try {
      await postJson(app, "/api/auth/setup", {
        username: "Pls",
        password: "correct horse battery"
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/system/latest-release"
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          latestVersion: null,
          releaseUrl: null,
          updateAvailable: false,
          status: "unknown",
          error: null,
          checkedAt: "2026-05-28T09:30:00.000Z"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("labels lightweight evaluation runs as diagnostic in transparency", async () => {
    const db = createEmptyDatabase();
    new SqliteAppSettingsRepository(db).setJson(
      "recommendation.settings",
      {
        preferFreshness: 0.5,
        preferSource: 0.5,
        preferDiversity: 0.5,
        cocoonLevel: 5,
        localLearningEnabled: false,
        localLearningShadowMode: true,
        explorationEnabled: true,
        evaluationEnabled: true
      },
      1000
    );
    db.prepare(
      `
        insert into ranking_eval_runs (
          id,
          algorithm_version,
          rank_context,
          status,
          metrics_json,
          error,
          created_at,
          started_at,
          finished_at
        )
        values ('eval_diagnostic', 'rec_v3', 'diagnostic', 'succeeded', ?, null, 1000, 1000, 1000)
      `
    ).run(
      JSON.stringify({
        evaluationMode: "lightweight_replay_diagnostic",
        diagnosticOnly: true,
        strictReplay: false,
        cutoffCount: 1,
        labelCount: 1,
        hitAt10: 0,
        ndcgAt10: 0,
        mrr: 0
      })
    );
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/recommendation/transparency"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          transparency: {
            moduleStatus: {
              evaluation: "lightweight_replay_diagnostic"
            }
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("shows FTRL insufficient sample state honestly in transparency", async () => {
    const db = createEmptyDatabase();
    new SqliteAppSettingsRepository(db).setJson(
      "recommendation.settings",
      {
        preferFreshness: 0.5,
        preferSource: 0.5,
        preferDiversity: 0.5,
        cocoonLevel: 5,
        localLearningEnabled: true,
        localLearningShadowMode: false,
        explorationEnabled: true,
        evaluationEnabled: false
      },
      1000
    );
    db.prepare(
      `
        insert into rank_model_versions (
          id,
          algorithm_version,
          feature_schema_version,
          status,
          sample_count,
          blend_alpha,
          metrics_json,
          created_at,
          updated_at
        )
        values ('ftrl_insufficient', 'rec_v3', 3, 'shadow', 12, 0, ?, 1000, 1000)
      `
    ).run(JSON.stringify({ highQualitySamples: 12 }));
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/recommendation/transparency"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          transparency: {
            moduleStatus: {
              ftrl: "insufficient_samples"
            }
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("shows FTRL ready-to-promote and active-low-weight lifecycle states", async () => {
    const db = createEmptyDatabase();
    new SqliteAppSettingsRepository(db).setJson(
      "recommendation.settings",
      {
        preferFreshness: 0.5,
        preferSource: 0.5,
        preferDiversity: 0.5,
        cocoonLevel: 5,
        localLearningEnabled: true,
        localLearningShadowMode: false,
        explorationEnabled: true,
        evaluationEnabled: false
      },
      1000
    );
    db.prepare(
      `
        insert into rank_model_versions (
          id,
          algorithm_version,
          feature_schema_version,
          status,
          sample_count,
          blend_alpha,
          metrics_json,
          created_at,
          updated_at
        )
        values ('ftrl_ready', 'rec_v3', 3, 'shadow', 120, 0.05, ?, 1000, 1000)
      `
    ).run(JSON.stringify({ highQualitySamples: 120 }));
    const app = buildServer({ db, logger: false });

    try {
      const ready = await app.inject({
        method: "GET",
        url: "/api/recommendation/transparency"
      });
      expect(ready.statusCode, ready.body).toBe(200);
      expect(ready.json()).toMatchObject({
        data: {
          transparency: {
            moduleStatus: {
              ftrl: "ready_to_promote"
            }
          }
        }
      });

      db.prepare("update rank_model_versions set status = 'active', updated_at = 2000 where id = 'ftrl_ready'").run();
      const active = await app.inject({
        method: "GET",
        url: "/api/recommendation/transparency"
      });
      expect(active.statusCode, active.body).toBe(200);
      expect(active.json()).toMatchObject({
        data: {
          transparency: {
            moduleStatus: {
              ftrl: "active_low_weight"
            }
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("queues ranking recalculation only when ranking settings actually change", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 5000 });
    const jobs = new SqliteJobRepository(db);

    try {
      const changed = await injectJson(app, "PATCH", "/api/settings", {
        ranking: {
          cocoonLevel: 7
        }
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json()).toMatchObject({
        data: {
          rankingRecalculateQueued: true,
          rankingRecalculateJobId: expect.any(String),
          settings: {
            ranking: {
              cocoonLevel: 7
            }
          }
        }
      });
      expect(jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "queued")).toBe(1);
      expect(jobs.countByTypeAndStatus("embedding_generate", "queued")).toBe(0);

      const same = await injectJson(app, "PATCH", "/api/settings", {
        ranking: {
          cocoonLevel: 7
        }
      });
      expect(same.statusCode, same.body).toBe(200);
      expect(same.json()).toMatchObject({
        data: {
          rankingRecalculateQueued: false,
          rankingRecalculateJobId: null
        }
      });
      expect(jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "queued")).toBe(1);

      const readerOnly = await injectJson(app, "PATCH", "/api/settings", {
        reader: {
          fontSize: 20
        }
      });
      expect(readerOnly.statusCode, readerOnly.body).toBe(200);
      expect(readerOnly.json()).toMatchObject({
        data: {
          rankingRecalculateQueued: false,
          rankingRecalculateJobId: null
        }
      });
      expect(jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "queued")).toBe(1);
      expect(jobs.countByTypeAndStatus("embedding_generate", "queued")).toBe(0);

      const shadowModeChanged = await injectJson(app, "PATCH", "/api/settings", {
        ranking: {
          localLearningShadowMode: true
        }
      });
      expect(shadowModeChanged.statusCode, shadowModeChanged.body).toBe(200);
      expect(shadowModeChanged.json()).toMatchObject({
        data: {
          rankingRecalculateQueued: true,
          rankingRecalculateJobId: changed.json().data.rankingRecalculateJobId
        }
      });
      expect(jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "queued")).toBe(1);
      expect(jobs.countByTypeAndStatus("embedding_generate", "queued")).toBe(0);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("queues retention cleanup when retention settings become more restrictive", async () => {
    const db = createEmptyDatabase();
    const settings = new SqliteAppSettingsRepository(db);
    const app = buildServer({ db, logger: false, now: () => 5000 });
    const jobs = new SqliteJobRepository(db);

    try {
      settings.setJson("retention.articleDays", 90, 4000);

      const changed = await injectJson(app, "PATCH", "/api/settings", {
        retention: {
          retentionDays: 30
        }
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json()).toMatchObject({
        data: {
          retentionCleanupQueued: true,
          retentionCleanupJobId: expect.any(String),
          rankingRecalculateQueued: false,
          settings: {
            retention: {
              retentionDays: 30
            }
          }
        }
      });
      expect(jobs.countByTypeAndStatus("retention_cleanup", "queued")).toBe(1);
      expect(jobs.countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "queued")).toBe(0);

      const same = await injectJson(app, "PATCH", "/api/settings", {
        retention: {
          retentionDays: 30
        }
      });
      expect(same.statusCode, same.body).toBe(200);
      expect(same.json()).toMatchObject({
        data: {
          retentionCleanupQueued: false,
          retentionCleanupJobId: null
        }
      });
      expect(jobs.countByTypeAndStatus("retention_cleanup", "queued")).toBe(1);

      const disabled = await injectJson(app, "PATCH", "/api/settings", {
        retention: {
          retentionDays: 0
        }
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(disabled.json()).toMatchObject({
        data: {
          retentionCleanupQueued: false,
          retentionCleanupJobId: null
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("queues delayed recommendation maintenance only for strong article actions", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    feeds.upsert({
      id: "feed_action_maintenance",
      title: "Action Feed",
      feedUrl: "https://example.com/action.xml",
      now: 1000
    });
    articles.upsert({
      id: "article_action_maintenance",
      feedId: "feed_action_maintenance",
      url: "https://example.com/action",
      title: "Action Article",
      discoveredAt: 1000,
      dedupeKey: "article_action_maintenance",
      now: 1000
    });
    const jobs = new SqliteJobRepository(db);
    const app = buildServer({ db, logger: false, now: () => 10_000 });

    try {
      const weak = await injectJson(app, "POST", "/api/articles/article_action_maintenance/actions", {
        type: "open"
      });
      expect(weak.statusCode, weak.body).toBe(200);
      expect(jobs.countByTypeAndStatus("recent_intent_rebuild", "queued")).toBe(0);
      expect(jobs.countByTypeAndStatus("ftrl_train", "queued")).toBe(0);

      const strong = await injectJson(app, "POST", "/api/articles/article_action_maintenance/actions", {
        type: "read_progress",
        progress: 0.8
      });
      expect(strong.statusCode, strong.body).toBe(200);
      await waitForDeferredPostActionWork();

      const recent = jobs.list({ type: "recent_intent_rebuild", status: "queued", limit: 1 })[0];
      const ftrl = jobs.list({ type: "ftrl_train", status: "queued", limit: 1 })[0];
      expect(recent?.runAfter).toBe(10_000 + 10 * 60_000);
      expect(ftrl?.runAfter).toBe(10_000 + 15 * 60_000);

      const repeatedStrong = await injectJson(app, "POST", "/api/articles/article_action_maintenance/actions", {
        type: "favorite"
      });
      expect(repeatedStrong.statusCode, repeatedStrong.body).toBe(200);
      await waitForDeferredPostActionWork();
      expect(jobs.countByTypeAndStatus("recent_intent_rebuild", "queued")).toBe(1);
      expect(jobs.countByTypeAndStatus("ftrl_train", "queued")).toBe(1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("dedupes recommendation maintenance jobs and exposes safe FTRL promotion", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 10_000 });

    try {
      for (const url of [
        "/api/recommendation/recalculate",
        "/api/recommendation/backfill/fingerprints",
        "/api/recommendation/rebuild-duplicates",
        "/api/recommendation/rebuild-keywords",
        "/api/recommendation/rebuild-recent-intent",
        "/api/recommendation/rebuild-cluster-labels",
        "/api/recommendation/evaluate"
      ]) {
        const first = await app.inject({ method: "POST", url });
        const second = await app.inject({ method: "POST", url });
        expect(first.statusCode, `${url}: ${first.body}`).toBe(200);
        expect(second.statusCode, `${url}: ${second.body}`).toBe(200);
        expect(second.json()).toMatchObject({
          data: {
            jobId: first.json().data.jobId,
            existing: true
          }
        });
      }

      const insufficient = await app.inject({ method: "POST", url: "/api/recommendation/ftrl/promote" });
      expect(insufficient.statusCode, insufficient.body).toBe(409);
      expect(insufficient.json()).toMatchObject({
        error: {
          code: "INSUFFICIENT_FTRL_SAMPLES"
        }
      });

      db.prepare(
        `
          insert into rank_model_versions (
            id,
            algorithm_version,
            feature_schema_version,
            status,
            sample_count,
            blend_alpha,
            metrics_json,
            created_at,
            updated_at
          )
          values ('ftrl_promote_test', 'rec_v3', 3, 'shadow', 120, 0.1, ?, 10_000, 10_000)
        `
      ).run(JSON.stringify({ highQualitySamples: 110 }));

      const promoted = await app.inject({ method: "POST", url: "/api/recommendation/ftrl/promote" });
      expect(promoted.statusCode, promoted.body).toBe(200);
      expect(promoted.json()).toMatchObject({
        data: {
          ok: true,
          modelVersionId: "ftrl_promote_test",
          sampleCount: 120,
          highQualitySampleCount: 110,
          blendAlpha: 0.1
        }
      });
      const model = db
        .prepare("select status from rank_model_versions where id = 'ftrl_promote_test'")
        .get() as { status: string } | undefined;
      expect(model?.status).toBe("active");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("requires authentication for manual interest cluster label updates", async () => {
    const db = createEmptyDatabase();
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/recommendation/clusters/cluster_missing/label",
        payload: {
          manualLabel: "AI 编程代理"
        }
      });

      expect(response.statusCode, response.body).toBe(401);
      expect(response.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("requires authentication for cluster label lexicon and merge APIs", async () => {
    const db = createEmptyDatabase();
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      for (const request of [
        { method: "GET", url: "/api/recommendation/cluster-label-lexicon" },
        { method: "POST", url: "/api/recommendation/clusters/merge-candidates/rebuild" },
        { method: "GET", url: "/api/recommendation/clusters/merge-candidates" },
        { method: "POST", url: "/api/recommendation/clusters/merge-candidates/candidate_missing/merge" },
        { method: "POST", url: "/api/recommendation/clusters/merge-candidates/candidate_missing/ignore" }
      ] as const) {
        const response = await app.inject(request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
      }
    } finally {
      await app.close();
      db.close();
    }
  });

  it("updates cluster label lexicon overrides and queues only label rebuild", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 30_000 });

    try {
      const current = await app.inject({
        method: "GET",
        url: "/api/recommendation/cluster-label-lexicon"
      });
      expect(current.statusCode, current.body).toBe(200);
      expect(current.json()).toMatchObject({
        data: {
          defaultVersion: 1,
          effective: {
            stopwords: expect.arrayContaining(["article"]),
            protectedTerms: expect.arrayContaining(["AI"])
          }
        }
      });

      const invalid = await app.inject({
        method: "PATCH",
        url: "/api/recommendation/cluster-label-lexicon",
        payload: {
          badTermPatternsAdd: ["["]
        }
      });
      expect(invalid.statusCode, invalid.body).toBe(400);

      const updated = await app.inject({
        method: "PATCH",
        url: "/api/recommendation/cluster-label-lexicon",
        payload: {
          stopwordsAdd: ["affiliation"],
          protectedTermsAdd: ["邸报"]
        }
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({
        data: {
          effective: {
            stopwords: expect.arrayContaining(["affiliation"]),
            protectedTerms: expect.arrayContaining(["邸报"])
          },
          rebuildJob: {
            existing: false
          }
        }
      });
      expect(
        db.prepare("select count(*) as count from jobs where type = 'interest_cluster_label_rebuild'").get()
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            "select count(*) as count from jobs where type in ('ranking_recalculate', 'embedding_generate')"
          )
          .get()
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("sets and clears manual interest cluster labels in transparency", async () => {
    const db = createFixtureDatabase();
    const { index } = createActiveEmbeddingDiagnosticsFixture(db, {
      providerTestStatus: "success"
    });
    insertApiClusterLabelFixture(db, index.id);
    const app = buildServer({ db, logger: false, now: () => 20_000 });

    try {
      const missing = await app.inject({
        method: "PATCH",
        url: "/api/recommendation/clusters/missing/label",
        payload: {
          manualLabel: "Missing"
        }
      });
      expect(missing.statusCode, missing.body).toBe(404);

      const tooLong = await app.inject({
        method: "PATCH",
        url: "/api/recommendation/clusters/cluster_label_api/label",
        payload: {
          manualLabel: "x".repeat(31)
        }
      });
      expect(tooLong.statusCode, tooLong.body).toBe(400);

      const set = await app.inject({
        method: "PATCH",
        url: "/api/recommendation/clusters/cluster_label_api/label",
        payload: {
          manualLabel: "AI 编程代理"
        }
      });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toMatchObject({
        data: {
          ok: true,
          clusterId: "cluster_label_api",
          displayLabel: "AI 编程代理",
          labelSource: "manual"
        }
      });

      const transparency = await app.inject({
        method: "GET",
        url: "/api/recommendation/transparency"
      });
      expect(transparency.statusCode, transparency.body).toBe(200);
      expect(transparency.json()).toMatchObject({
        data: {
          clusters: {
            items: [
              {
                id: "cluster_label_api",
                label: "AI 编程代理",
                displayLabel: "AI 编程代理",
                labelSource: "manual",
                autoLabel: expect.stringMatching(/AI|Agent|CLI/i),
                manualLabel: "AI 编程代理",
                topTerms: expect.arrayContaining([expect.stringMatching(/AI|Agent|CLI/i)])
              }
            ]
          }
        }
      });

      insertSemanticRankForContext(db, {
        articleId: "article_cluster_label_api",
        rankContext: "rec_v3:embedding:cocoon_5:schema_3",
        embeddingIndexId: index.id,
        score: 1.4,
        calculatedAt: 21_000
      });
      new SqliteRankingRepository(db).upsertRankContext({
        id: "rec_v3:embedding:cocoon_5:schema_3",
        algorithmVersion: "rec_v3",
        featureSchemaVersion: 3,
        embeddingIndexId: index.id,
        cocoonLevel: 5,
        now: 21_000
      });
      const explanation = await app.inject({
        method: "GET",
        url: "/api/articles/article_cluster_label_api/explanation"
      });
      expect(explanation.statusCode, explanation.body).toBe(200);
      expect(explanation.json()).toMatchObject({
        data: {
          reasons: expect.arrayContaining([
            expect.objectContaining({
              type: "interest",
              cluster: expect.objectContaining({
                id: "cluster_label_api",
                label: "AI 编程代理",
                displayLabel: "AI 编程代理",
                labelSource: "manual"
              })
            })
          ])
        }
      });

      const cleared = await app.inject({
        method: "PATCH",
        url: "/api/recommendation/clusters/cluster_label_api/label",
        payload: {
          manualLabel: null
        }
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().data).toMatchObject({
        clusterId: "cluster_label_api",
        labelSource: "keywords"
      });
      expect(cleared.json().data.displayLabel).toMatch(/AI|Agent|CLI/i);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("dedupes interest cluster label rebuild jobs", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 30_000 });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/recommendation/rebuild-cluster-labels"
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/recommendation/rebuild-cluster-labels"
      });

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({
        data: {
          jobId: first.json().data.jobId,
          existing: true
        }
      });
      expect(
        db
          .prepare(
            "select count(*) as count from jobs where type = 'interest_cluster_label_rebuild'"
          )
          .get()
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            "select count(*) as count from jobs where type in ('embedding_generate', 'ranking_recalculate')"
          )
          .get()
      ).toEqual({ count: 0 });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("lists, merges, and ignores interest cluster merge candidates", async () => {
    const db = createFixtureDatabase();
    const { index } = createActiveEmbeddingDiagnosticsFixture(db, {
      providerTestStatus: "success"
    });
    insertApiClusterMergeFixture(db, index.id);
    const app = buildServer({ db, logger: false, now: () => 40_000 });

    try {
      const rebuild = await app.inject({
        method: "POST",
        url: "/api/recommendation/clusters/merge-candidates/rebuild"
      });
      expect(rebuild.statusCode, rebuild.body).toBe(200);
      expect(rebuild.json()).toMatchObject({
        data: {
          jobId: expect.any(String),
          existing: false
        }
      });

      insertApiMergeCandidate(db, {
        id: "candidate_merge_api",
        embeddingIndexId: index.id,
        leftClusterId: "cluster_merge_left",
        rightClusterId: "cluster_merge_right",
        recommendation: "review"
      });
      insertApiMergeCandidate(db, {
        id: "candidate_ignore_api",
        embeddingIndexId: index.id,
        leftClusterId: "cluster_merge_left",
        rightClusterId: "cluster_merge_third",
        recommendation: "review"
      });

      const listed = await app.inject({
        method: "GET",
        url: "/api/recommendation/clusters/merge-candidates?status=all"
      });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json()).toMatchObject({
        data: {
          candidates: expect.arrayContaining([
            expect.objectContaining({
              id: "candidate_merge_api",
              centroidSimilarity: 0.94,
              labelJaccard: 0.7,
              evidenceOverlap: 0.4,
              mergeScore: 0.86,
              status: "open"
            })
          ])
        }
      });

      const ignored = await app.inject({
        method: "POST",
        url: "/api/recommendation/clusters/merge-candidates/candidate_ignore_api/ignore"
      });
      expect(ignored.statusCode, ignored.body).toBe(200);
      expect(ignored.json()).toMatchObject({
        data: {
          status: "ignored"
        }
      });
      expect(
        db.prepare("select count(*) as count from interest_clusters where id = 'cluster_merge_third'").get()
      ).toEqual({ count: 1 });

      const merged = await app.inject({
        method: "POST",
        url: "/api/recommendation/clusters/merge-candidates/candidate_merge_api/merge"
      });
      expect(merged.statusCode, merged.body).toBe(200);
      expect(merged.json()).toMatchObject({
        data: {
          ok: true,
          candidateId: "candidate_merge_api",
          survivorClusterId: "cluster_merge_left",
          mergedAwayClusterId: "cluster_merge_right",
          labelRebuild: {
            jobId: expect.any(String)
          },
          rankingRecalculate: {
            jobId: expect.any(String)
          }
        }
      });
      expect(
        db.prepare("select count(*) as count from interest_clusters where id = 'cluster_merge_right'").get()
      ).toEqual({ count: 0 });
      expect(
        db.prepare("select status from interest_cluster_merge_candidates where id = 'candidate_merge_api'").get()
      ).toEqual({ status: "merged" });
      expect(
        db
          .prepare(
            "select count(*) as count from jobs where type in ('interest_cluster_label_rebuild', 'ranking_recalculate')"
          )
          .get()
      ).toEqual({ count: 2 });

      const alreadyMerged = await app.inject({
        method: "POST",
        url: "/api/recommendation/clusters/merge-candidates/candidate_merge_api/merge"
      });
      expect(alreadyMerged.statusCode, alreadyMerged.body).toBe(409);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("lists feeds from the migrated database with API timestamps", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/feeds?enabled=true"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: [
          {
            id: "feed_design",
            folderId: null,
            title: "Design Notes",
            siteUrl: "https://example.com",
            feedUrl: "https://example.com/feed.xml",
            description: null,
            enabled: true,
            fullContentMode: "feed_only",
            sourceWeight: 0,
            lastFetchedAt: null,
            lastSuccessAt: null,
            nextRefreshAt: null,
            lastError: null,
            createdAt: "1970-01-01T00:00:01.000Z",
            updatedAt: "1970-01-01T00:00:01.000Z"
          }
        ]
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("lists feed folders with contract fields", async () => {
    const db = createEmptyDatabase();
    const folders = new SqliteFeedFolderRepository(db);
    folders.upsert({
      id: "folder_design",
      title: "Design",
      sortOrder: 2,
      now: 1000
    });
    folders.upsert({
      id: "folder_news",
      title: "News",
      sortOrder: 1,
      now: 1000
    });
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/feed-folders"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: [
          {
            id: "folder_news",
            title: "News",
            sortOrder: 1
          },
          {
            id: "folder_design",
            title: "Design",
            sortOrder: 2
          }
        ]
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("creates, renames, and deletes feed folders without deleting feeds", async () => {
    const db = createEmptyDatabase();
    const feedRepository = new SqliteFeedRepository(db);
    const app = buildServer({ db, logger: false, now: () => 7000 });

    try {
      const invalid = await postJson(app, "/api/feed-folders", {
        title: "   "
      });
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR"
        }
      });

      const created = await postJson(app, "/api/feed-folders", {
        title: "Design"
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json()).toMatchObject({
        data: {
          id: expect.stringMatching(/^folder_/),
          title: "Design",
          sortOrder: 0
        }
      });

      const folderId = created.json().data.id as string;
      const renamed = await injectJson(app, "PATCH", `/api/feed-folders/${folderId}`, {
        title: "Design Systems"
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json()).toMatchObject({
        data: {
          id: folderId,
          title: "Design Systems"
        }
      });

      feedRepository.upsert({
        id: "feed_folder_delete",
        folderId,
        title: "Folder Delete Feed",
        feedUrl: "https://example.com/folder-delete.xml",
        now: 7100
      });

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/feed-folders/${folderId}`
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json()).toEqual({
        data: {
          ok: true
        }
      });
      expect(feedRepository.findById("feed_folder_delete")).toMatchObject({
        folderId: null
      });
      const foldersAfterDelete = await app.inject({
        method: "GET",
        url: "/api/feed-folders"
      });
      expect(
        foldersAfterDelete.json().data.map((folder: { id: string }) => folder.id)
      ).not.toContain(folderId);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns not found for missing feed folders", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const update = await injectJson(app, "PATCH", "/api/feed-folders/missing", {
        title: "Missing"
      });
      const remove = await app.inject({
        method: "DELETE",
        url: "/api/feed-folders/missing"
      });

      expect(update.statusCode, update.body).toBe(404);
      expect(update.json()).toMatchObject({
        error: {
          code: "NOT_FOUND"
        }
      });
      expect(remove.statusCode, remove.body).toBe(404);
      expect(remove.json()).toMatchObject({
        error: {
          code: "NOT_FOUND"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("updates feed management fields and validates folder and source weight", async () => {
    const db = createEmptyDatabase();
    const folders = new SqliteFeedFolderRepository(db);
    const feeds = new SqliteFeedRepository(db);
    const folder = folders.upsert({
      id: "folder_design",
      title: "Design",
      now: 1000
    });
    feeds.upsert({
      id: "feed_manage",
      title: "Original Feed",
      feedUrl: "https://example.com/manage.xml",
      now: 1000
    });
    const app = buildServer({ db, logger: false, now: () => 8000 });

    try {
      const updated = await injectJson(app, "PATCH", "/api/feeds/feed_manage", {
        title: "Managed Feed",
        feedUrl: "https://example.com/managed.xml",
        folderId: folder.id,
        enabled: false,
        sourceWeight: 0.2
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({
        data: {
          id: "feed_manage",
          title: "Managed Feed",
          feedUrl: "https://example.com/managed.xml",
          folderId: "folder_design",
          enabled: false,
          sourceWeight: 0.2,
          updatedAt: "1970-01-01T00:00:08.000Z"
        }
      });
      expect(
        new SqliteJobRepository(db).countByTypeAndStatus(RANKING_RECALCULATE_JOB_TYPE, "queued")
      ).toBe(1);

      const missingFolder = await injectJson(app, "PATCH", "/api/feeds/feed_manage", {
        folderId: "folder_missing"
      });
      expect(missingFolder.statusCode, missingFolder.body).toBe(404);
      expect(missingFolder.json()).toMatchObject({
        error: {
          code: "NOT_FOUND"
        }
      });

      const invalidWeight = await injectJson(app, "PATCH", "/api/feeds/feed_manage", {
        sourceWeight: 1.5
      });
      expect(invalidWeight.statusCode, invalidWeight.body).toBe(400);
      expect(invalidWeight.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          details: {
            field: "sourceWeight",
            min: -1,
            max: 1
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("validates folderId when creating feeds", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await postJson(app, "/api/feeds", {
        feedUrl: "https://example.com/feed.xml",
        folderId: "folder_missing"
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({
        error: {
          code: "NOT_FOUND",
          message: "Folder not found"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("soft deletes feeds and removes their articles from API lists", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 9000 });

    try {
      const deleted = await app.inject({
        method: "DELETE",
        url: "/api/feeds/feed_design"
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json()).toEqual({
        data: {
          ok: true
        }
      });

      const feeds = await app.inject({
        method: "GET",
        url: "/api/feeds"
      });
      expect(feeds.statusCode, feeds.body).toBe(200);
      expect(feeds.json().data.map((feed: { id: string }) => feed.id)).not.toContain(
        "feed_design"
      );

      const articles = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest"
      });
      expect(articles.statusCode, articles.body).toBe(200);
      expect(articles.json().data).toEqual([]);
      expect(
        db.prepare("select deleted_at as deletedAt from feeds where id = ?").get("feed_design")
      ).toEqual({
        deletedAt: 9000
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns not found for missing feed management targets", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const update = await injectJson(app, "PATCH", "/api/feeds/missing", {
        title: "Missing"
      });
      const remove = await app.inject({
        method: "DELETE",
        url: "/api/feeds/missing"
      });

      expect(update.statusCode, update.body).toBe(404);
      expect(update.json()).toMatchObject({
        error: {
          code: "NOT_FOUND"
        }
      });
      expect(remove.statusCode, remove.body).toBe(404);
      expect(remove.json()).toMatchObject({
        error: {
          code: "NOT_FOUND"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("adds a feed and imports feed articles synchronously", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({
      db,
      logger: false,
      now: () => Date.parse("2026-05-14T08:00:00.000Z"),
      feedFetcher: fixtureFetcher({ "https://example.com/feed.xml": fixtureRss })
    });

    try {
      const response = await postJson(app, "/api/feeds", {
        feedUrl: "https://example.com/feed.xml"
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        data: {
          feed: {
            title: "Example Feed",
            feedUrl: "https://example.com/feed.xml",
            lastFetchedAt: "2026-05-14T08:00:00.000Z",
            lastSuccessAt: "2026-05-14T08:00:00.000Z",
            lastError: null
          },
          refreshJobId: expect.any(String)
        }
      });

      const articles = await app.inject({
        method: "GET",
        url: `/api/articles?feedId=${body.data.feed.id}`
      });
      const articleBody = articles.json();

      expect(articles.statusCode).toBe(200);
      expect(articleBody.data.map((article: { title: string }) => article.title)).toEqual([
        "Second fixture article",
        "First fixture article"
      ]);
      expect(jobCounts(db).ranking_recalculate).toBe(1);

      const detail = await app.inject({
        method: "GET",
        url: `/api/articles/${articleBody.data[1].id}`
      });

      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        data: {
          title: "First fixture article",
          contentHtml: "<p>Full first article</p>",
          contentText: "Full first article",
          extractionStatus: "feed_only"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("previews and backfills current feed full content without behavior events", async () => {
    const db = createEmptyDatabase();
    const fullText =
      "Expanded article body for full content extraction. ".repeat(8) +
      "searchable-full-content-marker";
    const app = buildServer({
      db,
      logger: false,
      now: () => Date.parse("2026-05-14T08:00:00.000Z"),
      feedFetcher: fixtureFetcher({ "https://example.com/feed.xml": fixtureRss }),
      fullContentFetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/second")) {
          return new Response("broken", { status: 500, headers: { "content-type": "text/html" } });
        }
        return new Response(
          `<html><body><nav>nav</nav><article><p>${fullText}</p></article></body></html>`,
          { headers: { "content-type": "text/html" } }
        );
      }
    });

    try {
      const add = await postJson(app, "/api/feeds", {
        feedUrl: "https://example.com/feed.xml"
      });
      const feedId = add.json().data.feed.id;

      const preview = await postJson(app, `/api/feeds/${feedId}/full-content/preview`, {});
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json()).toMatchObject({
        data: {
          feedId,
          articleUrl: "https://example.com/first",
          status: "success"
        }
      });
      expect(countTable(db, "behavior_events")).toBe(0);
      expect(contentStatusCounts(db)).toMatchObject({
        feed_only: 2
      });

      const blocked = await postJson(app, `/api/feeds/${feedId}/full-content/backfill-current`, {});
      expect(blocked.statusCode).toBe(409);

      await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Backfill Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture-embedding",
        dimension: 3,
        enabled: true
      });

      const patch = await injectJson(app, "PATCH", `/api/feeds/${feedId}`, {
        fullContentMode: "fetch_full_content"
      });
      expect(patch.statusCode, patch.body).toBe(200);
      expect(patch.json().data.fullContentMode).toBe("fetch_full_content");

      db.prepare("delete from jobs").run();
      const jobsBefore = jobCounts(db);
      const backfill = await postJson(
        app,
        `/api/feeds/${feedId}/full-content/backfill-current`,
        {}
      );
      expect(backfill.statusCode, backfill.body).toBe(200);
      expect(backfill.json()).toMatchObject({
        data: {
          feedId,
          articlesSeen: 2,
          attempted: 2,
          succeeded: 1,
          failed: 1,
          skipped: 0,
          limited: false
        }
      });
      expect(backfill.json().data.effectiveContentChangedArticleIds).toHaveLength(1);
      expect(countTable(db, "behavior_events")).toBe(0);
      expect(contentStatusCounts(db)).toMatchObject({
        failed: 1,
        success: 1
      });
      const jobsAfter = jobCounts(db);
      expect(jobsAfter.embedding_generate).toBe((jobsBefore.embedding_generate ?? 0) + 1);
      expect(jobsAfter.ranking_recalculate).toBe((jobsBefore.ranking_recalculate ?? 0) + 1);
      expectUniqueOpenEmbeddingArticleIds(db);
      expect(openEmbeddingArticleIds(db)).toEqual(
        expect.arrayContaining(backfill.json().data.effectiveContentChangedArticleIds)
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("refresh full content changes enqueue embedding and ranking once", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({
      db,
      logger: false,
      now: () => Date.parse("2026-05-14T08:00:00.000Z"),
      feedFetcher: fixtureFetcher({ "https://example.com/feed.xml": fixtureRss }),
      fullContentFetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/second")) {
          return new Response("broken", { status: 500, headers: { "content-type": "text/html" } });
        }
        return new Response(
          `<html><body><article><p>${"Refresh full content body. ".repeat(16)}</p></article></body></html>`,
          { headers: { "content-type": "text/html" } }
        );
      }
    });

    try {
      const add = await postJson(app, "/api/feeds", {
        feedUrl: "https://example.com/feed.xml"
      });
      const feedId = add.json().data.feed.id;
      await postJson(app, "/api/embedding/providers", {
        type: "openai_compatible",
        name: "Refresh Provider",
        baseUrl: "https://api.example.com/v1",
        model: "fixture-embedding",
        dimension: 3,
        enabled: true
      });
      await injectJson(app, "PATCH", `/api/feeds/${feedId}`, {
        fullContentMode: "fetch_full_content"
      });

      db.prepare("delete from jobs").run();
      const jobsBefore = jobCounts(db);
      const refresh = await app.inject({
        method: "POST",
        url: `/api/feeds/${feedId}/refresh`
      });
      expect(refresh.statusCode, refresh.body).toBe(200);

      const jobsAfter = jobCounts(db);
      expect(jobsAfter.embedding_generate).toBe((jobsBefore.embedding_generate ?? 0) + 1);
      expect(jobsAfter.ranking_recalculate).toBe((jobsBefore.ranking_recalculate ?? 0) + 1);
      expectUniqueOpenEmbeddingArticleIds(db);
      expect(openEmbeddingArticleIds(db)).toHaveLength(1);
      expect(countTable(db, "behavior_events")).toBe(0);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("discovers a direct feed URL without writing database rows", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({
      db,
      logger: false,
      feedFetcher: fixtureFetcher({ "https://example.com/feed.xml": fixtureRss })
    });

    try {
      const response = await postJson(app, "/api/feeds/discover", {
        url: "https://example.com/feed.xml#reader"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          normalizedUrl: "https://example.com/feed.xml",
          inputKind: "feed",
          candidates: [
            {
              feedUrl: "https://example.com/feed.xml",
              title: "Example Feed",
              siteUrl: "https://example.com/",
              description: "Fixture feed",
              format: "rss",
              status: "valid",
              existingFeedId: null,
              itemCount: 2,
              recentItems: [
                {
                  title: "First fixture article",
                  url: "https://example.com/first",
                  publishedAt: "2026-05-14T07:00:00.000Z"
                },
                {
                  title: "Second fixture article",
                  url: "https://example.com/second",
                  publishedAt: "2026-05-14T07:30:00.000Z"
                }
              ]
            }
          ]
        }
      });
      expect(db.prepare("select count(*) as count from feeds").get()).toEqual({ count: 0 });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("discovers alternate and relative feed links from a website homepage", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    feeds.upsert({
      id: "feed_existing",
      title: "Existing Feed",
      feedUrl: "https://example.com/feeds/main.xml",
      now: 1000
    });
    const app = buildServer({
      db,
      logger: false,
      feedFetcher: fixtureFetcher({
        "https://example.com/": fixtureHtmlWithFeeds,
        "https://example.com/feeds/main.xml": fixtureRss,
        "https://example.com/atom.xml": fixtureAtom
      })
    });

    try {
      const response = await postJson(app, "/api/feeds/discover", {
        url: "https://example.com/"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          inputKind: "html",
          candidates: [
            {
              feedUrl: "https://example.com/feeds/main.xml",
              status: "duplicate",
              existingFeedId: "feed_existing"
            },
            {
              feedUrl: "https://example.com/atom.xml",
              status: "valid",
              format: "atom",
              title: "Atom Fixture"
            }
          ]
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns discovery warnings for missing feeds and invalid candidates", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({
      db,
      logger: false,
      feedFetcher: fixtureFetcher({
        "https://example.com/": fixtureHtmlWithInvalidFeed,
        "https://example.com/broken.xml": "<html>not a feed</html>"
      })
    });

    try {
      const response = await postJson(app, "/api/feeds/discover", {
        url: "https://example.com/"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          candidates: [
            {
              feedUrl: "https://example.com/broken.xml",
              status: "invalid",
              error: expect.stringContaining("Feed parse failed")
            }
          ],
          warnings: [expect.stringContaining("No addable")]
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("validates discovery input and protects diagnostics when auth is required", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });
    const protectedDb = createEmptyDatabase();
    const protectedApp = buildRealServer({ db: protectedDb, logger: false, cookieSecure: false });

    try {
      const invalid = await postJson(app, "/api/feeds/discover", {
        url: "not a url"
      });
      const protectedDiagnostics = await protectedApp.inject({
        method: "GET",
        url: "/api/feeds/diagnostics"
      });

      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR"
        }
      });
      expect(protectedDiagnostics.statusCode, protectedDiagnostics.body).toBe(401);
    } finally {
      await app.close();
      await protectedApp.close();
      db.close();
      protectedDb.close();
    }
  });

  it("reports feed diagnostics summary and health states", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    feeds.upsert({
      id: "feed_healthy",
      title: "Healthy",
      feedUrl: "https://example.com/healthy.xml",
      enabled: true,
      now: 1000
    });
    feeds.recordFetchSuccess("feed_healthy", Date.parse("2026-05-23T07:30:00.000Z"));
    feeds.upsert({
      id: "feed_disabled",
      title: "Disabled",
      feedUrl: "https://example.com/disabled.xml",
      enabled: false,
      now: 1000
    });
    feeds.upsert({
      id: "feed_never",
      title: "Never",
      feedUrl: "https://example.com/never.xml",
      enabled: true,
      now: 1000
    });
    feeds.upsert({
      id: "feed_failing",
      title: "Failing",
      feedUrl: "https://example.com/failing.xml",
      enabled: true,
      now: 1000
    });
    feeds.recordFetchFailure(
      "feed_failing",
      "Feed parse failed",
      Date.parse("2026-05-23T08:00:00.000Z")
    );
    feeds.upsert({
      id: "feed_stale",
      title: "Stale",
      feedUrl: "https://example.com/stale.xml",
      enabled: true,
      now: 1000
    });
    feeds.recordFetchSuccess("feed_stale", Date.parse("2026-05-01T00:00:00.000Z"));
    const app = buildServer({
      db,
      logger: false,
      now: () => Date.parse("2026-05-23T08:29:00.000Z")
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/feeds/diagnostics"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          summary: {
            total: 5,
            enabled: 4,
            healthy: 1,
            warning: 1,
            error: 1,
            disabled: 1,
            neverFetched: 1
          },
          items: expect.arrayContaining([
            expect.objectContaining({
              feed: expect.objectContaining({ id: "feed_healthy" }),
              diagnostic: expect.objectContaining({ status: "healthy", code: "OK" })
            }),
            expect.objectContaining({
              feed: expect.objectContaining({ id: "feed_disabled" }),
              diagnostic: expect.objectContaining({ status: "disabled", code: "DISABLED" })
            }),
            expect.objectContaining({
              feed: expect.objectContaining({ id: "feed_never" }),
              diagnostic: expect.objectContaining({ status: "never_fetched", code: "NEVER_FETCHED" })
            }),
            expect.objectContaining({
              feed: expect.objectContaining({ id: "feed_failing" }),
              diagnostic: expect.objectContaining({
                status: "failing",
                code: "FETCH_FAILED",
                lastError: "Feed parse failed"
              })
            }),
            expect.objectContaining({
              feed: expect.objectContaining({ id: "feed_stale" }),
              diagnostic: expect.objectContaining({ status: "stale", code: "STALE" })
            })
          ])
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("refreshes an existing feed and writes articles", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    feeds.upsert({
      id: "feed_fixture",
      title: "Pending Feed",
      feedUrl: "https://example.com/feed.xml",
      now: 1000
    });
    const app = buildServer({
      db,
      logger: false,
      now: () => Date.parse("2026-05-14T08:00:00.000Z"),
      feedFetcher: fixtureFetcher({ "https://example.com/feed.xml": fixtureRss })
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/feeds/feed_fixture/refresh"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          jobId: expect.any(String)
        }
      });

      const articles = await app.inject({
        method: "GET",
        url: "/api/articles?feedId=feed_fixture"
      });

      expect(articles.json().data).toHaveLength(2);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("queues refresh-all jobs for enabled feeds and deduplicates open jobs", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    feeds.upsert({
      id: "feed_enabled",
      title: "Enabled Feed",
      feedUrl: "https://example.com/enabled.xml",
      enabled: true,
      now: 1000
    });
    feeds.upsert({
      id: "feed_disabled",
      title: "Disabled Feed",
      feedUrl: "https://example.com/disabled.xml",
      enabled: false,
      now: 1000
    });
    feeds.upsert({
      id: "feed_not_due",
      title: "Not Due Feed",
      feedUrl: "https://example.com/not-due.xml",
      enabled: true,
      now: 1000
    });
    feeds.recordFetchSuccess("feed_not_due", 1500);
    const app = buildServer({ db, logger: false, now: () => 2000 });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/feeds/refresh"
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/feeds/refresh"
      });

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(first.json().data.jobIds).toHaveLength(1);
      expect(second.json().data.jobIds).toEqual(first.json().data.jobIds);
      expect(new SqliteJobRepository(db).listOpenByType("feed_refresh")).toHaveLength(1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("queues refresh-all jobs only for feeds whose AutoTTL is due", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    feeds.upsert({
      id: "feed_due",
      title: "Due Feed",
      feedUrl: "https://example.com/due.xml",
      enabled: true,
      now: 1000
    });
    feeds.upsert({
      id: "feed_fresh",
      title: "Fresh Feed",
      feedUrl: "https://example.com/fresh.xml",
      enabled: true,
      now: 1000
    });
    feeds.upsert({
      id: "feed_never",
      title: "Never Fetched Feed",
      feedUrl: "https://example.com/never.xml",
      enabled: true,
      now: 1000
    });
    feeds.recordFetchSuccess("feed_due", 2_000);
    feeds.recordFetchSuccess("feed_fresh", 3_700_000);
    const app = buildServer({ db, logger: false, now: () => 3_800_000 });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/feeds/refresh"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.jobIds).toHaveLength(2);
      expect(
        new SqliteJobRepository(db)
          .listOpenByType("feed_refresh")
          .map((job) => job.payloadJson)
          .sort()
      ).toEqual([
        JSON.stringify({ feedId: "feed_due" }),
        JSON.stringify({ feedId: "feed_never" })
      ].sort());
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns nextRefreshAt on feed API responses", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    feeds.upsert({
      id: "feed_due",
      title: "Due Feed",
      feedUrl: "https://example.com/due.xml",
      enabled: true,
      now: 1000
    });
    feeds.recordFetchSuccess("feed_due", 2_000);
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/feeds"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual([
        expect.objectContaining({
          id: "feed_due",
          lastFetchedAt: "1970-01-01T00:00:02.000Z",
          nextRefreshAt: "1970-01-01T01:00:02.000Z"
        })
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("does not duplicate articles when the same feed is refreshed repeatedly", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    feeds.upsert({
      id: "feed_fixture",
      title: "Pending Feed",
      feedUrl: "https://example.com/feed.xml",
      now: 1000
    });
    const app = buildServer({
      db,
      logger: false,
      now: () => Date.parse("2026-05-14T08:00:00.000Z"),
      feedFetcher: fixtureFetcher({ "https://example.com/feed.xml": fixtureRss })
    });

    try {
      await app.inject({ method: "POST", url: "/api/feeds/feed_fixture/refresh" });
      await app.inject({ method: "POST", url: "/api/feeds/feed_fixture/refresh" });

      const articles = await app.inject({
        method: "GET",
        url: "/api/articles?feedId=feed_fixture"
      });

      expect(articles.statusCode).toBe(200);
      expect(articles.json().data).toHaveLength(2);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("imports OPML folders and feeds without refreshing articles", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 6000 });

    try {
      const response = await postMultipartOpml(app, fixtureOpml);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: {
          foldersCreated: 2,
          feedsCreated: 2,
          feedsSkipped: 1,
          errors: []
        }
      });
      expect(listFolderTitles(db)).toEqual(["Tech", "AI"]);
      expect(listFeedFolderAssignments(db)).toEqual([
        {
          title: "Design Feed",
          feedUrl: "https://example.com/design.xml",
          folderTitle: "Tech"
        },
        {
          title: "ML Feed",
          feedUrl: "https://example.com/ml.xml",
          folderTitle: "AI"
        }
      ]);
      expect(db.prepare("select count(*) as count from articles").get()).toEqual({ count: 0 });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("skips duplicate OPML feed URLs on repeated imports", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false, now: () => 6100 });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/opml/import",
        headers: {
          "content-type": "application/xml"
        },
        payload: singleFeedOpml
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/opml/import",
        headers: {
          "content-type": "application/xml"
        },
        payload: singleFeedOpml
      });

      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        data: {
          foldersCreated: 1,
          feedsCreated: 1,
          feedsSkipped: 0
        }
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({
        data: {
          foldersCreated: 0,
          feedsCreated: 0,
          feedsSkipped: 1
        }
      });
      expect(listFeedFolderAssignments(db)).toHaveLength(1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns contract-shaped error for invalid OPML import", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/opml/import",
        headers: {
          "content-type": "application/xml"
        },
        payload: "<rss></rss>"
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          message: "OPML parse failed"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("exports current folders and feeds as OPML", async () => {
    const db = createEmptyDatabase();
    const folders = new SqliteFeedFolderRepository(db);
    const feeds = new SqliteFeedRepository(db);
    const design = folders.upsert({
      id: "folder_design",
      title: "Design & Tech",
      sortOrder: 0,
      now: 1000
    });
    folders.upsert({
      id: "folder_empty",
      title: "Empty Folder",
      sortOrder: 1,
      now: 1000
    });
    feeds.upsert({
      id: "feed_design_export",
      folderId: design.id,
      title: "Design Feed",
      feedUrl: "https://example.com/design.xml",
      siteUrl: "https://example.com/design",
      now: 1000
    });
    feeds.upsert({
      id: "feed_loose_export",
      title: "Loose Feed",
      feedUrl: "https://example.com/loose.xml",
      now: 1000
    });
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/opml/export"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-type"]).toContain("application/xml");
      expect(response.body).toContain('<opml version="2.0">');
      expect(parseOpml(response.body)).toMatchObject({
        title: "Dibao Subscriptions",
        folders: ["Design & Tech", "Empty Folder"],
        feeds: [
          {
            title: "Design Feed",
            feedUrl: "https://example.com/design.xml",
            siteUrl: "https://example.com/design",
            folderTitle: "Design & Tech"
          },
          {
            title: "Loose Feed",
            feedUrl: "https://example.com/loose.xml",
            siteUrl: null,
            folderTitle: null
          }
        ]
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("keeps article identity stable when an item link changes but guid is stable", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    feeds.upsert({
      id: "feed_fixture",
      title: "Pending Feed",
      feedUrl: "https://example.com/feed.xml",
      now: 1000
    });
    const app = buildServer({
      db,
      logger: false,
      now: () => Date.parse("2026-05-14T08:00:00.000Z"),
      feedFetcher: sequenceFetcher("https://example.com/feed.xml", [
        fixtureRss,
        fixtureRssWithMovedFirstArticle
      ])
    });

    try {
      const firstRefresh = await app.inject({
        method: "POST",
        url: "/api/feeds/feed_fixture/refresh"
      });
      const secondRefresh = await app.inject({
        method: "POST",
        url: "/api/feeds/feed_fixture/refresh"
      });

      expect(firstRefresh.statusCode, firstRefresh.body).toBe(200);
      expect(secondRefresh.statusCode, secondRefresh.body).toBe(200);

      const articles = await app.inject({
        method: "GET",
        url: "/api/articles?feedId=feed_fixture"
      });
      const body = articles.json();
      const firstArticle = body.data.find(
        (article: { title: string }) => article.title === "First fixture article"
      );

      expect(articles.statusCode).toBe(200);
      expect(body.data).toHaveLength(2);
      expect(firstArticle).toMatchObject({
        url: "https://example.com/first-moved"
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns a contract-shaped error for invalid feedUrl", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await postJson(app, "/api/feeds", {
        feedUrl: "not a url"
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "feedUrl must be a valid URL"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns a contract-shaped error when feed parsing fails", async () => {
    const db = createEmptyDatabase();
    const app = buildServer({
      db,
      logger: false,
      feedFetcher: fixtureFetcher({ "https://example.com/feed.xml": "<html>no feed</html>" })
    });

    try {
      const response = await postJson(app, "/api/feeds", {
        feedUrl: "https://example.com/feed.xml"
      });

      expect(response.statusCode, response.body).toBe(502);
      expect(response.json()).toMatchObject({
        error: {
          code: "PROVIDER_ERROR",
          message: "Feed parse failed",
          details: {
            cause: expect.any(String)
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("lists and paginates article summaries", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const firstPage = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&limit=1"
      });
      const firstBody = firstPage.json();

      expect(firstPage.statusCode).toBe(200);
      expect(firstBody.data).toHaveLength(1);
      expect(firstBody.data[0]).toMatchObject({
        id: "article_recent",
        feedId: "feed_design",
        feedTitle: "Design Notes",
        title: "Dense reader interfaces",
        publishedAt: "1970-01-01T00:00:03.000Z",
        discoveredAt: "1970-01-01T00:00:03.000Z",
        state: {
          read: true,
          favorited: true,
          readLater: false,
          hidden: false,
          notInterested: false,
          readingProgress: 0.5
        }
      });
      expect(firstBody.page.nextCursor).toEqual(expect.any(String));

      const secondPage = await app.inject({
        method: "GET",
        url: `/api/articles?view=latest&limit=1&cursor=${firstBody.page.nextCursor}`
      });

      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json()).toMatchObject({
        data: [
          {
            id: "article_recommended",
            title: "Quiet ranking systems",
            state: {
              read: false,
              favorited: false,
              readLater: false,
              hidden: false,
              notInterested: false,
              readingProgress: 0
            }
          }
        ],
        page: {
          nextCursor: null
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("searches articles with filters, latest sort, empty results, and validation errors", async () => {
    const db = createEmptyDatabase();
    const folders = new SqliteFeedFolderRepository(db);
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const actions = new SqliteArticleActionRepository(db);
    const folder = folders.upsert({
      id: "folder_search_api",
      title: "Search API",
      now: 1000
    });
    feeds.upsert({
      id: "feed_search_api",
      folderId: folder.id,
      title: "Search API Feed",
      feedUrl: "https://example.com/search-api.xml",
      now: 1000
    });
    feeds.upsert({
      id: "feed_search_other",
      title: "Search Other Feed",
      feedUrl: "https://example.com/search-other.xml",
      now: 1000
    });
    for (const [id, feedId, title, publishedAt] of [
      ["article_search_old", "feed_search_api", "Local search apple", 2000],
      ["article_search_new", "feed_search_api", "Local search apple latest", 4000],
      ["article_search_other", "feed_search_other", "Local search apple other", 6000]
    ] as const) {
      articles.upsert({
        id,
        feedId,
        url: `https://example.com/${id}`,
        title,
        summary: "API search fixture",
        publishedAt,
        discoveredAt: publishedAt,
        dedupeKey: id,
        now: publishedAt
      });
    }
    actions.record({ articleId: "article_search_new", type: "favorite", now: 7000 });
    const app = buildServer({ db, logger: false });

    try {
      const result = await app.inject({
        method: "GET",
        url: "/api/search?q=apple&sort=latest&limit=2"
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        data: [
          {
            id: "article_search_other",
            title: "Local search apple other"
          },
          {
            id: "article_search_new",
            state: {
              favorited: true
            }
          }
        ],
        page: {
          nextCursor: expect.any(String)
        },
        meta: {
          unreadCount: 2
        }
      });

      const filtered = await app.inject({
        method: "GET",
        url: `/api/search?q=apple&feedId=feed_search_api&folderId=${folder.id}&state=favorites&from=1970-01-01T00:00:03.000Z&to=1970-01-01T00:00:05.000Z`
      });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_search_new"
      ]);

      const empty = await app.inject({
        method: "GET",
        url: "/api/search?q=missing"
      });
      expect(empty.statusCode, empty.body).toBe(200);
      expect(empty.json()).toEqual({
        data: [],
        page: {
          nextCursor: null
        },
        meta: {
          unreadCount: 0
        }
      });

      for (const url of [
        "/api/search",
        "/api/search?q=%20%20",
        "/api/search?q=apple&state=bad",
        "/api/search?q=apple&sort=bad",
        "/api/search?q=apple&from=1970-01-02&to=1970-01-01"
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, `${url}: ${response.body}`).toBe(400);
        expect(response.json()).toMatchObject({
          error: {
            code: "VALIDATION_ERROR"
          }
        });
      }
    } finally {
      await app.close();
      db.close();
    }
  });

  it("protects the search API when auth is required", async () => {
    const db = createFixtureDatabase();
    const app = buildRealServer({ db, logger: false, cookieSecure: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/search?q=ranking"
      });
      expect(response.statusCode, response.body).toBe(401);
      expect(response.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("search recommended sort uses the active rank context inside matched results only", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const embeddings = new SqliteEmbeddingRepository(db);
    const rankings = new SqliteRankingRepository(db);
    feeds.upsert({
      id: "feed_search_rank",
      title: "Search Rank Feed",
      feedUrl: "https://example.com/search-rank.xml",
      now: 1000
    });
    for (const [id, title, publishedAt] of [
      ["article_search_low", "Matched kiwi low", 2000],
      ["article_search_high", "Matched kiwi high", 1000],
      ["article_unmatched_high", "Unmatched banana high", 3000]
    ] as const) {
      articles.upsert({
        id,
        feedId: "feed_search_rank",
        url: `https://example.com/${id}`,
        title,
        summary: "Ranking fixture",
        publishedAt,
        discoveredAt: publishedAt,
        dedupeKey: id,
        now: publishedAt
      });
    }
    embeddings.upsertProvider({
      id: "provider_search_rank",
      type: "embedded_local",
      name: "Search Rank Provider",
      model: "fixture",
      dimension: 4,
      enabled: true,
      now: 4000
    });
    embeddings.createIndex({
      id: "index_search_rank",
      providerId: "provider_search_rank",
      model: "fixture",
      dimension: 4,
      now: 4000
    });
    const activeContext = "rec_v3:embedding:cocoon_5:schema_3";
    for (const [articleId, score, rerankPosition] of [
      ["article_search_low", 0.1, 2],
      ["article_search_high", 0.9, 1],
      ["article_unmatched_high", 1.0, 0]
    ] as const) {
      rankings.upsertScore({
        articleId,
        rankContext: activeContext,
        embeddingIndexId: "index_search_rank",
        score,
        baseScore: score,
        interestScore: 0,
        sourceScore: 0,
        freshnessScore: 0,
        stateScore: 0,
        diversityScore: 0,
        penaltyScore: 0,
        rerankPosition,
        calculatedAt: 5000
      });
    }
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/search?q=kiwi&sort=recommended"
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_search_high",
        "article_search_low"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("orders recommended articles by stored rank scores", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/articles?view=recommended"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_recommended",
        "article_recent"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("orders read later by active rank, base fallback, then saved time", async () => {
    const db = createArticleSortDatabase();
    const embeddings = new SqliteEmbeddingRepository(db);
    embeddings.upsertProvider({
      id: "provider_sort",
      type: "openai_compatible",
      name: "Sort Provider",
      baseUrl: "https://api.example.com/v1",
      model: "fixture",
      dimension: 3,
      enabled: true,
      now: 1000
    });
    embeddings.createIndex({
      id: "index_sort",
      providerId: "provider_sort",
      model: "fixture",
      dimension: 3,
      now: 1000
    });
    const actions = new SqliteArticleActionRepository(db);
    for (const [articleId, savedAt] of [
      ["article_read_later_active", 6000],
      ["article_read_later_base", 7000],
      ["article_read_later_unranked_new", 9000],
      ["article_read_later_unranked_old", 8000]
    ] as const) {
      actions.record({ articleId, type: "read_later", now: savedAt });
    }
    insertRank(db, "article_read_later_base", 0.8, 10_000);
    insertRankForContext(db, {
      articleId: "article_read_later_active",
      rankContext: "rec_v3:embedding:cocoon_5:schema_3",
      embeddingIndexId: "index_sort",
      score: 0.9,
      calculatedAt: 10_000
    });
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/articles?view=read_later"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_read_later_active",
        "article_read_later_base",
        "article_read_later_unranked_new",
        "article_read_later_unranked_old"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("orders read later by supported manual sort modes", async () => {
    const db = createArticleSortDatabase();
    const actions = new SqliteArticleActionRepository(db);
    for (const [articleId, savedAt] of [
      ["article_read_later_active", 6000],
      ["article_read_later_base", 7000],
      ["article_read_later_unranked_new", 9000],
      ["article_read_later_unranked_old", 8000]
    ] as const) {
      actions.record({ articleId, type: "read_later", now: savedAt });
    }
    insertRank(db, "article_read_later_base", 0.8, 10_000);
    const app = buildServer({ db, logger: false });

    try {
      const expected: Record<string, string[]> = {
        read_later_desc: [
          "article_read_later_unranked_new",
          "article_read_later_unranked_old",
          "article_read_later_base",
          "article_read_later_active"
        ],
        read_later_asc: [
          "article_read_later_active",
          "article_read_later_base",
          "article_read_later_unranked_old",
          "article_read_later_unranked_new"
        ],
        published_desc: [
          "article_read_later_unranked_old",
          "article_read_later_unranked_new",
          "article_read_later_base",
          "article_read_later_active"
        ],
        published_asc: [
          "article_read_later_active",
          "article_read_later_base",
          "article_read_later_unranked_new",
          "article_read_later_unranked_old"
        ]
      };

      for (const [sort, ids] of Object.entries(expected)) {
        const response = await app.inject({
          method: "GET",
          url: `/api/articles?view=read_later&sort=${sort}`
        });

        expect(response.statusCode, `${sort}: ${response.body}`).toBe(200);
        expect(response.json().data.map((article: { id: string }) => article.id)).toEqual(ids);
      }
    } finally {
      await app.close();
      db.close();
    }
  });

  it("orders favorites by supported sort modes without rank ordering", async () => {
    const db = createArticleSortDatabase();
    const actions = new SqliteArticleActionRepository(db);
    actions.record({ articleId: "article_favorite_old", type: "favorite", now: 5000 });
    actions.record({ articleId: "article_favorite_recent", type: "favorite", now: 4000 });
    actions.record({ articleId: "article_favorite_middle", type: "favorite", now: 6000 });
    insertRank(db, "article_favorite_old", 100, 10_000);
    insertRank(db, "article_favorite_recent", 0.1, 10_000);
    insertRank(db, "article_favorite_middle", 0.2, 10_000);
    const app = buildServer({ db, logger: false });

    try {
      const expected: Record<string, string[]> = {
        favorited_desc: [
          "article_favorite_middle",
          "article_favorite_old",
          "article_favorite_recent"
        ],
        favorited_asc: [
          "article_favorite_recent",
          "article_favorite_old",
          "article_favorite_middle"
        ],
        published_desc: [
          "article_favorite_recent",
          "article_favorite_middle",
          "article_favorite_old"
        ],
        published_asc: [
          "article_favorite_old",
          "article_favorite_middle",
          "article_favorite_recent"
        ]
      };

      for (const [sort, ids] of Object.entries(expected)) {
        const response = await app.inject({
          method: "GET",
          url: `/api/articles?view=favorites&sort=${sort}`
        });

        expect(response.statusCode, `${sort}: ${response.body}`).toBe(200);
        expect(response.json().data.map((article: { id: string }) => article.id)).toEqual(ids);
      }
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns contract-shaped errors for invalid view-specific sort", async () => {
    const db = createArticleSortDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const favorite = await app.inject({
        method: "GET",
        url: "/api/articles?view=favorites&sort=ranked"
      });

      expect(favorite.statusCode, favorite.body).toBe(400);
      expect(favorite.json()).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "sort must be favorited_desc, favorited_asc, published_desc, or published_asc",
          details: {
            field: "sort",
            allowed: ["favorited_desc", "favorited_asc", "published_desc", "published_asc"]
          }
        }
      });

      const readLater = await app.inject({
        method: "GET",
        url: "/api/articles?view=read_later&sort=favorited_desc"
      });

      expect(readLater.statusCode, readLater.body).toBe(400);
      expect(readLater.json()).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "sort must be ranked, read_later_desc, read_later_asc, published_desc, or published_asc",
          details: {
            field: "sort",
            allowed: [
              "ranked",
              "read_later_desc",
              "read_later_asc",
              "published_desc",
              "published_asc"
            ]
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("filters latest and recommended lists to unseen articles with unreadOnly", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5000 });

    try {
      const latest = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&unreadOnly=true"
      });
      const recommended = await app.inject({
        method: "GET",
        url: "/api/articles?view=recommended&unreadOnly=true"
      });

      expect(latest.statusCode, latest.body).toBe(200);
      expect(recommended.statusCode, recommended.body).toBe(200);
      expect(latest.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_recommended"
      ]);
      expect(latest.json().meta).toEqual({ unreadCount: 1 });
      expect(recommended.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_recommended"
      ]);
      expect(recommended.json().meta).toEqual({ unreadCount: 1 });

      const impression = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "impression"
      });
      expect(impression.statusCode, impression.body).toBe(200);

      const afterImpression = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&unreadOnly=true"
      });
      expect(afterImpression.statusCode, afterImpression.body).toBe(200);
      expect(afterImpression.json().data).toEqual([]);
      expect(afterImpression.json().meta).toEqual({ unreadCount: 0 });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("keeps article list payloads compact while preserving reader body content", async () => {
    const db = createFixtureDatabase();
    const articles = new SqliteArticleRepository(db);
    const longHtmlSummary = `<section>${"很长的列表摘要 ".repeat(80)}<strong>重点</strong></section>`;
    articles.upsert({
      id: "article_long_summary",
      feedId: "feed_design",
      url: "https://example.com/long-summary",
      title: "Long summary fixture",
      summary: longHtmlSummary,
      publishedAt: 4500,
      discoveredAt: 4500,
      dedupeKey: "long_summary",
      now: 4500
    });
    articles.upsertContent({
      articleId: "article_long_summary",
      contentHtml: "<article><p>完整正文 HTML</p></article>",
      contentText: "完整正文纯文本不需要和 HTML 同时返回。",
      extractionStatus: "success",
      extractedAt: 4500,
      now: 4500
    });
    const app = buildServer({ db, logger: false });

    try {
      const list = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&limit=1"
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().data[0]).toMatchObject({
        id: "article_long_summary",
        summary: expect.not.stringContaining("<section>")
      });
      expect(list.json().data[0].summary.length).toBeLessThanOrEqual(363);

      const detail = await app.inject({
        method: "GET",
        url: "/api/articles/article_long_summary"
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().data).toMatchObject({
        contentHtml: "<article><p>完整正文 HTML</p></article>",
        contentText: "完整正文纯文本不需要和 HTML 同时返回。"
      });
      expect(detail.json().data.summary.length).toBeLessThanOrEqual(363);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("marks the current article list scope read through the reader command API", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 6000 });

    try {
      const before = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&unreadOnly=true"
      });
      const behaviorCountBefore = countTable(db, "behavior_events");

      const response = await postJson(app, "/api/reader/commands/mark-scope-read", {
        scope: {
          type: "article_list",
          view: "latest",
          timeWindow: "all"
        }
      });
      const after = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&unreadOnly=true"
      });

      expect(before.statusCode, before.body).toBe(200);
      expect(before.json().meta).toEqual({ unreadCount: 1 });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toMatchObject({
        ok: true,
        markedReadCount: 1
      });
      expect(response.json().data.commandId).toMatch(/^cmd_/);
      expect(after.statusCode, after.body).toBe(200);
      expect(after.json().meta).toEqual({ unreadCount: 0 });
      expect(after.json().data).toEqual([]);
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        readAt: 6000,
        readingProgress: 1,
        updatedAt: 6000
      });
      expect(countTable(db, "behavior_events")).toBe(behaviorCountBefore);
      expect(listBehaviorEventTypes(db, "article_recommended")).not.toContain("mark_read");
      expect(
        db.prepare("select command_type as commandType from reader_command_events").get()
      ).toEqual({ commandType: "mark_scope_read" });
      expect(
        JSON.parse(
          (
            db
              .prepare("select result_json as resultJson from reader_command_events")
              .get() as { resultJson: string }
          ).resultJson
        )
      ).toEqual({
        markedReadCount: 1,
        sampleArticleIds: ["article_recommended"],
        limitedAudit: false
      });
      expect(
        db.prepare("select type from jobs where type = 'ranking_recalculate'").get()
      ).toEqual({ type: "ranking_recalculate" });
      expect(getArticleStateRow(db, "article_recent")).toMatchObject({
        favoritedAt: 3500
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("marks large scopes read with sampled audit and full ranking recalculation", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const app = buildServer({ db, logger: false, now: () => 9000 });

    feeds.upsert({
      id: "feed_reader_command_large",
      title: "Reader Command Large",
      feedUrl: "https://example.com/reader-command-large.xml",
      now: 1000
    });
    for (let index = 0; index < 510; index += 1) {
      const id = `article_command_large_${String(index).padStart(3, "0")}`;
      articles.upsert({
        id,
        feedId: "feed_reader_command_large",
        url: `https://example.com/${id}`,
        title: id,
        publishedAt: 2000 + index,
        discoveredAt: 2000 + index,
        dedupeKey: id,
        now: 2000 + index
      });
    }

    try {
      const response = await postJson(app, "/api/reader/commands/mark-scope-read", {
        scope: {
          type: "article_list",
          view: "latest",
          clearWindow: "all"
        }
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toMatchObject({
        ok: true,
        markedReadCount: 510
      });
      const result = JSON.parse(
        (
          db
            .prepare("select result_json as resultJson from reader_command_events")
            .get() as { resultJson: string }
        ).resultJson
      ) as { markedReadCount: number; sampleArticleIds: string[]; limitedAudit: boolean };
      expect(result.markedReadCount).toBe(510);
      expect(result.sampleArticleIds).toHaveLength(200);
      expect(result.limitedAudit).toBe(true);
      expect(JSON.stringify(result)).not.toContain("article_command_large_509");
      expect(
        db
          .prepare(
            "select count(*) as count from jobs where type = 'ranking_recalculate' and payload_json is null"
          )
          .get()
      ).toEqual({ count: 1 });
      expect(countTable(db, "behavior_events")).toBe(0);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("marks only unread debt older than the selected clear window", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const day = 24 * 60 * 60 * 1000;
    const now = 10 * day;
    const app = buildServer({ db, logger: false, now: () => now });

    feeds.upsert({
      id: "feed_reader_command_age",
      title: "Reader Command Age",
      feedUrl: "https://example.com/reader-command-age.xml",
      now: 1000
    });
    for (const [id, publishedAt] of [
      ["article_debt_old", now - 8 * day],
      ["article_debt_recent", now - day]
    ] as const) {
      articles.upsert({
        id,
        feedId: "feed_reader_command_age",
        url: `https://example.com/${id}`,
        title: id,
        publishedAt,
        discoveredAt: publishedAt,
        dedupeKey: id,
        now: publishedAt
      });
    }

    try {
      const preview = await postJson(app, "/api/reader/commands/mark-scope-read/preview", {
        scope: {
          type: "article_list",
          view: "latest",
          clearWindow: "7d"
        }
      });
      const response = await postJson(app, "/api/reader/commands/mark-scope-read", {
        scope: {
          type: "article_list",
          view: "latest",
          clearWindow: "7d"
        }
      });

      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().data).toEqual({ ok: true, markedReadCount: 1 });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.markedReadCount).toBe(1);
      expect(getArticleStateRow(db, "article_debt_old")).toMatchObject({
        readAt: now,
        readingProgress: 1
      });
      expect(getArticleStateRow(db, "article_debt_recent")).toBeUndefined();
      expect(countTable(db, "reader_command_events")).toBe(1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("marks submitted search scope read without profile behavior events", async () => {
    const db = createEmptyDatabase();
    const feeds = new SqliteFeedRepository(db);
    const articles = new SqliteArticleRepository(db);
    const app = buildServer({ db, logger: false, now: () => 8000 });

    feeds.upsert({
      id: "feed_reader_command_search",
      title: "Reader Command Search",
      feedUrl: "https://example.com/reader-command-search.xml",
      now: 1000
    });
    for (const [id, title] of [
      ["article_command_search_one", "Command search apple"],
      ["article_command_search_two", "Command search apple second"]
    ] as const) {
      articles.upsert({
        id,
        feedId: "feed_reader_command_search",
        url: `https://example.com/${id}`,
        title,
        summary: "Reader command search fixture",
        publishedAt: 2000,
        discoveredAt: 2000,
        dedupeKey: id,
        now: 2000
      });
      articles.upsertContent({
        articleId: id,
        contentText: `${title} body`,
        extractionStatus: "success",
        extractedAt: 2000,
        now: 2000
      });
    }

    try {
      const response = await postJson(app, "/api/reader/commands/mark-scope-read", {
        scope: {
          type: "search",
          q: "apple",
          feedId: "feed_reader_command_search",
          state: "all"
        }
      });
      const unread = await app.inject({
        method: "GET",
        url: "/api/search?q=apple&state=unread"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.markedReadCount).toBe(2);
      expect(unread.statusCode, unread.body).toBe(200);
      expect(unread.json().meta).toEqual({ unreadCount: 0 });
      expect(countTable(db, "behavior_events")).toBe(0);
      expect(countTable(db, "reader_command_events")).toBe(1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("validates reader command scopes and protects the route when auth is required", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });
    const protectedDb = createFixtureDatabase();
    const protectedApp = buildRealServer({ db: protectedDb, logger: false });

    try {
      for (const payload of [
        { scope: { type: "article_list", view: "favorites" } },
        { scope: { type: "article_list", view: "latest", clearWindow: "soon" } },
        { scope: { type: "search", q: "" } },
        { scope: { type: "missing" } }
      ]) {
        const response = await postJson(app, "/api/reader/commands/mark-scope-read", payload);
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().error.code).toBe("VALIDATION_ERROR");
      }

      const unauthenticated = await protectedApp.inject({
        method: "POST",
        url: "/api/reader/commands/mark-scope-read",
        payload: {
          scope: {
            type: "article_list",
            view: "latest"
          }
        }
      });
      expect(unauthenticated.statusCode, unauthenticated.body).toBe(401);
    } finally {
      await app.close();
      await protectedApp.close();
      db.close();
      protectedDb.close();
    }
  });

  it("filters latest and recommended lists to articles from today", async () => {
    const db = createFixtureDatabase();
    const articles = new SqliteArticleRepository(db);
    const today = 86_400_000 + 5_000;
    const app = buildServer({ db, logger: false, now: () => today });

    articles.upsert({
      id: "article_today",
      feedId: "feed_design",
      url: "https://example.com/today",
      canonicalUrl: "https://example.com/today",
      title: "Today only fixture",
      summary: "Today filter article.",
      publishedAt: today - 1,
      discoveredAt: today - 1,
      dedupeKey: "today",
      now: today
    });
    insertRank(db, "article_today", 0.7, today);

    try {
      const latest = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&todayOnly=true"
      });
      const recommended = await app.inject({
        method: "GET",
        url: "/api/articles?view=recommended&todayOnly=true"
      });
      const invalid = await app.inject({
        method: "GET",
        url: "/api/articles?todayOnly=maybe"
      });

      expect(latest.statusCode, latest.body).toBe(200);
      expect(recommended.statusCode, recommended.body).toBe(200);
      expect(latest.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_today"
      ]);
      expect(recommended.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_today"
      ]);
      expect(latest.json().meta).toEqual({ unreadCount: 1 });
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.json().error.message).toBe("todayOnly must be true or false");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns baseline rank explanation reasons", async () => {
    const db = createFixtureDatabase();
    insertRank(db, "article_recommended", 1.2, 7000, {
      interestScore: 0.08,
      sourceScore: 0.12,
      freshnessScore: 0.2,
      stateScore: 0.5,
      penaltyScore: -0.25
    });
    const app = buildServer({ db, logger: false, now: () => 8000 });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/articles/article_recommended/explanation"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: {
          articleId: "article_recommended",
          generatedAt: "1970-01-01T00:00:07.000Z",
          reasons: [
            {
              type: "negative",
              label: "Negative interest match",
              impact: "negative"
            },
            {
              type: "freshness",
              label: "Recent article",
              impact: "positive"
            },
            {
              type: "source",
              label: "Design Notes",
              impact: "positive"
            },
            {
              type: "interest",
              label: "Interest match",
              impact: "positive"
            }
          ]
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns an interest family explanation when semantic rank has no cluster match", async () => {
    const db = createFixtureDatabase();
    insertRank(db, "article_recommended", 1.2, 7000, {
      interestScore: 0.12,
      sourceScore: 0.03,
      freshnessScore: 0.04,
      stateScore: 0.01
    });
    db.prepare(
      "update article_rank_scores set semantic_score = ? where article_id = ? and rank_context = 'base'"
    ).run(0.12, "article_recommended");
    new SqliteRankingRepository(db).upsertExplanation({
      articleId: "article_recommended",
      rankContext: "base",
      embeddingIndexId: null,
      payloadJson: JSON.stringify({
        components: {
          primaryFamilyId: "family_product_ai",
          primaryFamilyLabel: "产品 / AI",
          primaryFamilyMaturity: 0.82,
          primaryFamilyDominanceRatio: 0.24,
          matchedFamilyCount: 2
        }
      }),
      createdAt: 7000
    });
    const app = buildServer({ db, logger: false, now: () => 8000 });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/articles/article_recommended/explanation"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          reasons: expect.arrayContaining([
            expect.objectContaining({
              type: "interest",
              label: "Interest family match",
              family: {
                id: "family_product_ai",
                label: "产品 / AI",
                maturity: 0.82,
                dominanceRatio: 0.24,
                matchedFamilyCount: 2
              }
            })
          ])
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns fallback explanation when rank is missing", async () => {
    const db = createRankingFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 9000 });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/articles/article_rank_neutral/explanation"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        data: {
          articleId: "article_rank_neutral",
          generatedAt: "1970-01-01T00:00:09.000Z",
          reasons: [
            {
              type: "fallback",
              label: "Ranking has not been calculated yet",
              impact: "neutral"
            }
          ]
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("recalculates base rank after article actions and orders recommended by score", async () => {
    const db = createRankingFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 10_000 });

    try {
      const progress = await postJson(app, "/api/articles/article_rank_progress/actions", {
        type: "read_progress",
        progress: 0.5
      });
      const readLater = await postJson(app, "/api/articles/article_rank_later/actions", {
        type: "read_later"
      });
      const favorite = await postJson(app, "/api/articles/article_rank_favorite/actions", {
        type: "favorite"
      });

      expect(progress.statusCode, progress.body).toBe(200);
      expect(readLater.statusCode, readLater.body).toBe(200);
      expect(favorite.statusCode, favorite.body).toBe(200);
      await waitForDeferredPostActionWork();

      await drainRankingJobs(db, 10_000);

      expect(getRankScore(db, "article_rank_favorite")).toBeGreaterThan(
        getRankScore(db, "article_rank_later")
      );
      expect(getRankScore(db, "article_rank_later")).toBeGreaterThan(
        getRankScore(db, "article_rank_progress")
      );

      const recommended = await app.inject({
        method: "GET",
        url: "/api/articles?view=recommended"
      });

      expect(recommended.statusCode, recommended.body).toBe(200);
      expect(recommended.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_rank_favorite",
        "article_rank_later",
        "article_rank_progress",
        "article_rank_neutral"
      ]);

      const notInterested = await postJson(
        app,
        "/api/articles/article_rank_favorite/actions",
        {
          type: "not_interested"
        }
      );
      const hide = await postJson(app, "/api/articles/article_rank_later/actions", {
        type: "hide"
      });

      expect(notInterested.statusCode, notInterested.body).toBe(200);
      expect(hide.statusCode, hide.body).toBe(200);
      await drainRankingJobs(db, 10_000);

      const filtered = await app.inject({
        method: "GET",
        url: "/api/articles?view=recommended"
      });

      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json().data.map((article: { id: string }) => article.id)).toEqual([
        "article_rank_progress",
        "article_rank_neutral"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns article details with content and state", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/articles/article_recent"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          id: "article_recent",
          contentHtml: "<p>Reader density without visual clutter.</p>",
          contentText: "Reader density without visual clutter.",
          extractionStatus: "success",
          extractionError: null,
          rank: {
            score: 0.4,
            calculatedAt: "1970-01-01T00:00:04.000Z"
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records favorite and unfavorite article actions", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5000 });

    try {
      const favorite = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "favorite"
      });
      const unfavorite = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "unfavorite"
      });

      expect(favorite.statusCode, favorite.body).toBe(200);
      expect(favorite.json().data.state).toMatchObject({
        favorited: true
      });
      expect(unfavorite.statusCode, unfavorite.body).toBe(200);
      expect(unfavorite.json().data.state).toMatchObject({
        favorited: false
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        favoritedAt: null,
        updatedAt: 5000
      });
      expect(listBehaviorEventTypes(db, "article_recommended")).toEqual([
        "favorite",
        "unfavorite"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records like and unlike article actions without exposing event ids", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5050 });

    try {
      const like = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "like"
      });
      const unlike = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "unlike"
      });

      expect(like.statusCode, like.body).toBe(200);
      expect(like.json().data).not.toHaveProperty("eventId");
      expect(like.json().data.state).toMatchObject({
        liked: true
      });
      expect(unlike.statusCode, unlike.body).toBe(200);
      expect(unlike.json().data).not.toHaveProperty("eventId");
      expect(unlike.json().data.state).toMatchObject({
        liked: false
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        likedAt: null,
        updatedAt: 5050
      });
      expect(listBehaviorEventTypes(db, "article_recommended")).toEqual([
        "like",
        "unlike"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records read later and remove read later article actions", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5100 });

    try {
      const readLater = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_later"
      });
      const removeReadLater = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "remove_read_later"
      });

      expect(readLater.statusCode, readLater.body).toBe(200);
      expect(readLater.json().data.state).toMatchObject({
        readLater: true
      });
      expect(removeReadLater.statusCode, removeReadLater.body).toBe(200);
      expect(removeReadLater.json().data.state).toMatchObject({
        readLater: false
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        readLaterAt: null,
        updatedAt: 5100
      });
      expect(listBehaviorEventTypes(db, "article_recommended")).toEqual([
        "read_later",
        "remove_read_later"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records mark read and mark unread article actions", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5200 });

    try {
      const markRead = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "mark_read"
      });
      const markUnread = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "mark_unread"
      });

      expect(markRead.statusCode, markRead.body).toBe(200);
      expect(markRead.json().data.state).toMatchObject({
        read: true,
        readingProgress: 1
      });
      expect(markUnread.statusCode, markUnread.body).toBe(200);
      expect(markUnread.json().data.state).toMatchObject({
        read: false,
        readingProgress: 0
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        readAt: null,
        readingProgress: 0,
        updatedAt: 5200
      });
      expect(listBehaviorEventTypes(db, "article_recommended")).toEqual([
        "mark_read",
        "mark_unread"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records scrolled-past impressions as ignored until the article is opened", async () => {
    const db = createFixtureDatabase();
    let now = 5400;
    const app = buildServer({ db, logger: false, now: () => now });

    try {
      const unreadBefore = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&unreadOnly=true"
      });
      const impression = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "impression",
        metadata: {
          reason: "scrolled_past_unopened"
        }
      });
      const unreadLatestAfterImpression = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&unreadOnly=true"
      });
      const unreadRecommendedAfterImpression = await app.inject({
        method: "GET",
        url: "/api/articles?view=recommended&unreadOnly=true"
      });
      now = 5500;
      const open = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "open"
      });

      expect(unreadBefore.statusCode, unreadBefore.body).toBe(200);
      expect(unreadBefore.json().data.map((article: { id: string }) => article.id)).toContain(
        "article_recommended"
      );
      expect(impression.statusCode, impression.body).toBe(200);
      expect(impression.json().data.state).toMatchObject({
        interactionStatus: "ignored",
        ignoredAt: 5400,
        openedAt: null
      });
      expect(unreadLatestAfterImpression.statusCode, unreadLatestAfterImpression.body).toBe(200);
      expect(
        unreadLatestAfterImpression.json().data.map((article: { id: string }) => article.id)
      ).not.toContain("article_recommended");
      expect(
        unreadRecommendedAfterImpression.json().data.map((article: { id: string }) => article.id)
      ).not.toContain("article_recommended");
      expect(open.statusCode, open.body).toBe(200);
      expect(open.json().data.state).toMatchObject({
        interactionStatus: "opened",
        ignoredAt: null,
        openedAt: 5500
      });
      expect(listBehaviorEventTypes(db, "article_recommended")).toEqual([
        "impression",
        "open"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("keeps saved unread articles out of ignored state when later impressions arrive", async () => {
    const db = createFixtureDatabase();
    let now = 5400;
    const app = buildServer({ db, logger: false, now: () => now });

    try {
      const favorite = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "favorite",
        value: true
      });
      now = 5500;
      const impression = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "impression",
        metadata: {
          reason: "scrolled_past_unopened"
        }
      });
      const unread = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest&unreadOnly=true"
      });

      expect(favorite.statusCode, favorite.body).toBe(200);
      expect(favorite.json().data.state).toMatchObject({
        favorited: true,
        interactionStatus: "saved",
        ignoredAt: null
      });
      expect(impression.statusCode, impression.body).toBe(200);
      expect(impression.json().data.state).toMatchObject({
        favorited: true,
        interactionStatus: "saved",
        ignoredAt: null
      });
      expect(listBehaviorEvents(db, "article_recommended").at(-1)).toEqual({
        eventType: "impression",
        eventWeight: 0,
        metadataJson: JSON.stringify({ reason: "scrolled_past_unopened" })
      });
      expect(unread.statusCode, unread.body).toBe(200);
      expect(unread.json().data.map((article: { id: string }) => article.id)).not.toContain(
        "article_recommended"
      );
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records read progress article actions", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5300 });

    try {
      const response = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_progress",
        progress: 0.72,
        metadata: {
          durationMs: 42000
        }
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.state).toMatchObject({
        read: false,
        readingProgress: 0.72
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        readingProgress: 0.72,
        updatedAt: 5300
      });
      expect(listBehaviorEvents(db, "article_recommended")).toEqual([
        {
          eventType: "read_progress",
          eventWeight: 0.1,
          metadataJson: JSON.stringify({ durationMs: 42000, progress: 0.72 })
        }
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("can auto-remove completed articles from read later without recording removal behavior", async () => {
    const db = createFixtureDatabase();
    db.prepare(
      `
        insert into app_settings (key, value_json, updated_at)
        values (?, ?, ?)
        on conflict(key) do update set value_json = excluded.value_json
      `
    ).run(
      "behavior.settings",
      JSON.stringify({
        markScrolledArticlesIgnored: true,
        removeReadLaterOnReadComplete: true
      }),
      5400
    );
    const app = buildServer({ db, logger: false, now: () => 5400 });

    try {
      const readLater = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_later"
      });
      const complete = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_progress",
        progress: 0.9
      });

      expect(readLater.statusCode, readLater.body).toBe(200);
      expect(readLater.json().data.state).toMatchObject({
        readLater: true
      });
      expect(complete.statusCode, complete.body).toBe(200);
      expect(complete.json().data.state).toMatchObject({
        readLater: false,
        readingProgress: 0.9,
        interactionStatus: "read"
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        readLaterAt: null,
        readingProgress: 0.9
      });
      expect(listBehaviorEventTypes(db, "article_recommended")).toEqual([
        "read_later",
        "read_progress"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("accepts contract-shaped article action values", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5350 });

    try {
      const favorite = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "favorite",
        value: true
      });
      const unfavorite = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "favorite",
        value: false
      });
      const readProgress = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_progress",
        value: 0.5
      });
      const like = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "like",
        value: false
      });

      expect(favorite.statusCode, favorite.body).toBe(200);
      expect(favorite.json().data.state).toMatchObject({
        favorited: true
      });
      expect(unfavorite.statusCode, unfavorite.body).toBe(200);
      expect(unfavorite.json().data.state).toMatchObject({
        favorited: false
      });
      expect(readProgress.statusCode, readProgress.body).toBe(200);
      expect(readProgress.json().data.state).toMatchObject({
        readingProgress: 0.5
      });
      expect(like.statusCode, like.body).toBe(200);
      expect(like.json().data.state).toMatchObject({
        liked: false
      });
      expect(listBehaviorEventTypes(db, "article_recommended")).toEqual([
        "favorite",
        "unfavorite",
        "read_progress",
        "unlike"
      ]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("does not lower reading progress when a stale progress event arrives", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5360 });

    try {
      const highProgress = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_progress",
        progress: 0.8
      });
      const staleProgress = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_progress",
        progress: 0.2
      });

      expect(highProgress.statusCode, highProgress.body).toBe(200);
      expect(staleProgress.statusCode, staleProgress.body).toBe(200);
      expect(staleProgress.json().data.state).toMatchObject({
        readingProgress: 0.8
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        readingProgress: 0.8
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns a contract-shaped error for invalid read progress", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_progress",
        progress: 1.25
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "progress or value must be a number between 0 and 1",
          details: {
            fields: ["progress", "value"],
            min: 0,
            max: 1
          }
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records not interested article actions", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5400 });

    try {
      await postJson(app, "/api/articles/article_recommended/actions", {
        type: "favorite",
        value: true
      });
      await postJson(app, "/api/articles/article_recommended/actions", {
        type: "like",
        value: true
      });
      await postJson(app, "/api/articles/article_recommended/actions", {
        type: "read_later",
        value: true
      });
      const response = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "not_interested"
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.state).toMatchObject({
        favorited: false,
        liked: false,
        readLater: false,
        interactionStatus: "ignored",
        notInterested: true
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        notInterestedAt: 5400,
        updatedAt: 5400
      });
      expect(listBehaviorEvents(db, "article_recommended").at(-1)).toEqual(
        {
          eventType: "not_interested",
          eventWeight: -1,
          metadataJson: null
        }
      );

      const articles = await app.inject({
        method: "GET",
        url: "/api/articles?view=latest"
      });
      expect(articles.statusCode, articles.body).toBe(200);
      expect(
        articles.json().data.map((article: { id: string }) => article.id)
      ).not.toContain("article_recommended");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("records open and hide article actions", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false, now: () => 5500 });

    try {
      const open = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "open"
      });
      const hide = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "hide"
      });

      expect(open.statusCode, open.body).toBe(200);
      expect(open.json().data.state).toMatchObject({
        hidden: false
      });
      expect(hide.statusCode, hide.body).toBe(200);
      expect(hide.json().data.state).toMatchObject({
        hidden: true
      });
      expect(getArticleStateRow(db, "article_recommended")).toMatchObject({
        hiddenAt: 5500,
        lastOpenedAt: 5500,
        updatedAt: 5500
      });
      expect(listBehaviorEventTypes(db, "article_recommended")).toEqual(["open", "hide"]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns a contract-shaped error when article action target is missing", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await postJson(app, "/api/articles/missing/actions", {
        type: "favorite"
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Article not found"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns a contract-shaped error for invalid article actions", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await postJson(app, "/api/articles/article_recommended/actions", {
        type: "archive"
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "type must be impression, open, mark_read, mark_unread, favorite, unfavorite, like, unlike, read_later, remove_read_later, hide, not_interested, or read_progress"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns a contract-shaped error for missing articles", async () => {
    const db = createFixtureDatabase();
    const app = buildServer({ db, logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/articles/missing"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Article not found"
        }
      });
    } finally {
      await app.close();
      db.close();
    }
  });
});

function createEmptyDatabase(): DibaoDatabase {
  return openDatabase(tempDatabasePath(), { migrate: true });
}

function createFixtureDatabase(): DibaoDatabase {
  const db = createEmptyDatabase();
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);

  feeds.upsert({
    id: "feed_design",
    title: "Design Notes",
    feedUrl: "https://example.com/feed.xml",
    siteUrl: "https://example.com",
    now: 1000
  });
  feeds.upsert({
    id: "feed_disabled",
    title: "Disabled Feed",
    feedUrl: "https://example.com/disabled.xml",
    enabled: false,
    now: 1000
  });

  articles.upsert({
    id: "article_recommended",
    feedId: "feed_design",
    url: "https://example.com/recommended",
    canonicalUrl: "https://example.com/recommended",
    title: "Quiet ranking systems",
    summary: "Ranking without theatrics.",
    publishedAt: 2000,
    discoveredAt: 2000,
    dedupeKey: "recommended",
    now: 2000
  });
  articles.upsert({
    id: "article_recent",
    feedId: "feed_design",
    url: "https://example.com/recent",
    canonicalUrl: "https://example.com/recent",
    title: "Dense reader interfaces",
    summary: "A practical reader layout.",
    publishedAt: 3000,
    discoveredAt: 3000,
    dedupeKey: "recent",
    now: 3000
  });
  articles.upsertContent({
    articleId: "article_recent",
    contentHtml: "<p>Reader density without visual clutter.</p>",
    contentText: "Reader density without visual clutter.",
    extractionStatus: "success",
    extractedAt: 3000,
    now: 3000
  });

  db.prepare(
    `
      insert into article_states (
        article_id,
        read_at,
        favorited_at,
        read_later_at,
        hidden_at,
        not_interested_at,
        reading_progress,
        last_opened_at,
        updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run("article_recent", 3500, 3500, null, null, null, 0.5, 3500, 3500);

  insertRank(db, "article_recommended", 0.9, 4000);
  insertRank(db, "article_recent", 0.4, 4000);

  return db;
}

function createRankingFixtureDatabase(): DibaoDatabase {
  const db = createEmptyDatabase();
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);

  feeds.upsert({
    id: "feed_ranking",
    title: "Ranking Feed",
    feedUrl: "https://example.com/ranking.xml",
    now: 1000
  });

  for (const id of [
    "article_rank_favorite",
    "article_rank_later",
    "article_rank_progress",
    "article_rank_neutral"
  ]) {
    articles.upsert({
      id,
      feedId: "feed_ranking",
      url: `https://example.com/${id}`,
      canonicalUrl: `https://example.com/${id}`,
      title: id,
      summary: "Ranking fixture article.",
      publishedAt: 1000,
      discoveredAt: 1000,
      dedupeKey: id,
      now: 1000
    });
  }

  return db;
}

function createArticleSortDatabase(): DibaoDatabase {
  const db = createEmptyDatabase();
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);

  feeds.upsert({
    id: "feed_sort",
    title: "Sort Feed",
    feedUrl: "https://example.com/sort.xml",
    now: 1000
  });

  for (const [id, publishedAt] of [
    ["article_read_later_active", 1000],
    ["article_read_later_base", 2000],
    ["article_read_later_unranked_new", 3000],
    ["article_read_later_unranked_old", 4000],
    ["article_favorite_old", 1000],
    ["article_favorite_recent", 3000],
    ["article_favorite_middle", 2000]
  ] as const) {
    articles.upsert({
      id,
      feedId: "feed_sort",
      url: `https://example.com/${id}`,
      canonicalUrl: `https://example.com/${id}`,
      title: id,
      summary: "Sort fixture article.",
      publishedAt,
      discoveredAt: publishedAt,
      dedupeKey: id,
      now: publishedAt
    });
  }

  return db;
}

function createActiveEmbeddingDiagnosticsFixture(
  db: DibaoDatabase,
  input: { providerTestStatus: "success" | "failed" }
) {
  const embeddings = new SqliteEmbeddingRepository(db);
  embeddings.upsertProvider({
    id: "provider_diagnostics",
    type: "openai_compatible",
    name: "Diagnostics Provider",
    baseUrl: "https://api.example.com/v1",
    model: "fixture-embedding",
    dimension: 3,
    apiKeyEncrypted: "plain:v1:secret",
    enabled: true,
    now: 5000
  });
  embeddings.recordProviderTestResult({
    id: "provider_diagnostics",
    status: input.providerTestStatus,
    error: input.providerTestStatus === "failed" ? "Provider request failed" : null,
    testedAt: 5000
  });
  const index = embeddings.createIndex({
    id: "index_diagnostics",
    providerId: "provider_diagnostics",
    model: "fixture-embedding",
    dimension: 3,
    status: "active",
    now: 5000
  });

  return {
    provider: embeddings.findProviderById("provider_diagnostics"),
    index
  };
}

function insertApiClusterLabelFixture(db: DibaoDatabase, embeddingIndexId: string): void {
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);
  const profiles = new SqliteProfileRepository(db);
  feeds.upsert({
    id: "feed_cluster_label_api",
    title: "AI Engineering Notes",
    feedUrl: "https://example.com/cluster-label.xml",
    now: 6000
  });
  articles.upsert({
    id: "article_cluster_label_api",
    feedId: "feed_cluster_label_api",
    url: "https://example.com/cluster-label",
    canonicalUrl: "https://example.com/cluster-label",
    title: "AI Agent CLI for local model workflows",
    summary: "OpenAI and Gemini agents can run from a command line interface.",
    publishedAt: 6100,
    discoveredAt: 6100,
    dedupeKey: "article_cluster_label_api",
    now: 6100
  });
  new SqliteVecVectorStore(db).upsertArticleVector({
    articleId: "article_cluster_label_api",
    embeddingIndexId,
    vector: [1, 0, 0],
    contentHash: "article_cluster_label_api:6100",
    now: 6200
  });
  profiles.upsertCluster({
    id: "cluster_label_api",
    embeddingIndexId,
    polarity: "positive",
    centroidVectorBlob: toVectorBlob([1, 0, 0]),
    weight: 8,
    sampleCount: 3,
    now: 6300
  });
  db.prepare(
    `
      insert into behavior_events (
        id,
        article_id,
        event_type,
        event_weight,
        created_at
      )
      values ('event_cluster_label_api', 'article_cluster_label_api', 'favorite', 5, 6400)
    `
  ).run();
  profiles.insertClusterEvidence({
    id: "evidence_cluster_label_api",
    clusterId: "cluster_label_api",
    articleId: "article_cluster_label_api",
    behaviorEventId: "event_cluster_label_api",
    evidenceSource: "live_event",
    confidence: 0.95,
    similarity: 0.98,
    weightDelta: 5,
    createdAt: 6500
  });
  db.prepare(
    `
      insert into profile_terms (
        term,
        polarity,
        scope,
        weight,
        evidence_count,
        last_event_at,
        updated_at
      )
      values ('AI Agent', 'positive', 'long', 3, 3, 6500, 6500)
    `
  ).run();
}

function insertApiClusterMergeFixture(db: DibaoDatabase, embeddingIndexId: string): void {
  const feeds = new SqliteFeedRepository(db);
  const articles = new SqliteArticleRepository(db);
  const profiles = new SqliteProfileRepository(db);
  feeds.upsert({
    id: "feed_cluster_merge_api",
    title: "AI Merge Notes",
    feedUrl: "https://example.com/cluster-merge.xml",
    now: 6000
  });
  for (const articleId of [
    "article_merge_shared",
    "article_merge_left",
    "article_merge_right",
    "article_merge_third"
  ]) {
    articles.upsert({
      id: articleId,
      feedId: "feed_cluster_merge_api",
      url: `https://example.com/${articleId}`,
      title: `AI Agent CLI ${articleId}`,
      summary: "AI Agent CLI workflow",
      discoveredAt: 6100,
      dedupeKey: articleId,
      now: 6100
    });
  }
  for (const cluster of [
    { id: "cluster_merge_left", vector: [1, 0, 0], weight: 8, articles: ["article_merge_shared", "article_merge_left"] },
    { id: "cluster_merge_right", vector: [0.99, 0.01, 0], weight: 4, articles: ["article_merge_shared", "article_merge_right"] },
    { id: "cluster_merge_third", vector: [0.98, 0.02, 0], weight: 2, articles: ["article_merge_shared", "article_merge_third"] }
  ]) {
    profiles.upsertCluster({
      id: cluster.id,
      embeddingIndexId,
      polarity: "positive",
      centroidVectorBlob: toVectorBlob(cluster.vector),
      weight: cluster.weight,
      sampleCount: 2,
      now: 6300
    });
    for (const articleId of cluster.articles) {
      db.prepare(
        `
          insert or ignore into behavior_events (
            id,
            article_id,
            event_type,
            event_weight,
            created_at
          )
          values (?, ?, 'favorite', 5, 6400)
        `
      ).run(`event_${cluster.id}_${articleId}`, articleId);
      profiles.insertClusterEvidence({
        id: `evidence_${cluster.id}_${articleId}`,
        clusterId: cluster.id,
        articleId,
        behaviorEventId: `event_${cluster.id}_${articleId}`,
        evidenceSource: "live_event",
        confidence: 0.95,
        similarity: 0.98,
        weightDelta: 5,
        createdAt: 6500
      });
    }
    db.prepare(
      `
        insert into interest_cluster_labels (
          cluster_id,
          auto_label,
          manual_label,
          label_source,
          label_terms_json,
          representative_articles_json,
          feed_titles_json,
          label_diagnostics_json,
          confidence,
          generated_at,
          updated_at
        )
        values (?, 'AI Agent / CLI', ?, ?, ?, ?, ?, null, 0.8, 6500, 6500)
      `
    ).run(
      cluster.id,
      cluster.id === "cluster_merge_left" ? "AI 编程代理" : null,
      cluster.id === "cluster_merge_left" ? "manual" : "keywords",
      JSON.stringify([
        { term: "AI Agent", weight: 5 },
        { term: "CLI", weight: 4 }
      ]),
      JSON.stringify(cluster.articles.map((articleId) => ({ articleId, title: articleId }))),
      JSON.stringify(["AI Merge Notes"])
    );
  }
}

function insertApiMergeCandidate(
  db: DibaoDatabase,
  input: {
    id: string;
    embeddingIndexId: string;
    leftClusterId: string;
    rightClusterId: string;
    recommendation: "auto_merge" | "review";
  }
): void {
  db.prepare(
    `
      insert into interest_cluster_merge_candidates (
        id,
        embedding_index_id,
        left_cluster_id,
        right_cluster_id,
        polarity,
        centroid_similarity,
        label_jaccard,
        evidence_overlap,
        representative_overlap,
        source_overlap,
        merge_score,
        recommendation,
        status,
        reason_json,
        created_at,
        updated_at,
        decided_at
      )
      values (?, ?, ?, ?, 'positive', 0.94, 0.7, 0.4, 0.4, 1, 0.86, ?, 'open', '{}', 7000, 7000, null)
    `
  ).run(
    input.id,
    input.embeddingIndexId,
    input.leftClusterId,
    input.rightClusterId,
    input.recommendation
  );
}

function insertRank(
  db: DibaoDatabase,
  articleId: string,
  score: number,
  calculatedAt: number,
  components: {
    interestScore?: number;
    sourceScore?: number;
    freshnessScore?: number;
    stateScore?: number;
    diversityScore?: number;
    penaltyScore?: number;
  } = {}
): void {
  db.prepare(
    `
      insert into article_rank_scores (
        article_id,
        rank_context,
        embedding_index_id,
        score,
        interest_score,
        source_score,
        freshness_score,
        state_score,
        diversity_score,
        penalty_score,
        calculated_at
      )
      values (?, 'base', null, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(article_id, rank_context) do update set
        score = excluded.score,
        interest_score = excluded.interest_score,
        source_score = excluded.source_score,
        freshness_score = excluded.freshness_score,
        state_score = excluded.state_score,
        diversity_score = excluded.diversity_score,
        penalty_score = excluded.penalty_score,
        calculated_at = excluded.calculated_at
    `
  ).run(
    articleId,
    score,
    components.interestScore ?? 0,
    components.sourceScore ?? 0,
    components.freshnessScore ?? 0,
    components.stateScore ?? 0,
    components.diversityScore ?? 0,
    components.penaltyScore ?? 0,
    calculatedAt
  );
}

function insertRankForContext(
  db: DibaoDatabase,
  input: {
    articleId: string;
    rankContext: string;
    embeddingIndexId?: string | null;
    score: number;
    calculatedAt: number;
  }
): void {
  db.prepare(
    `
      insert into article_rank_scores (
        article_id,
        rank_context,
        embedding_index_id,
        score,
        interest_score,
        source_score,
        freshness_score,
        state_score,
        diversity_score,
        penalty_score,
        calculated_at
      )
      values (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?)
      on conflict(article_id, rank_context) do update set
        score = excluded.score,
        calculated_at = excluded.calculated_at
    `
  ).run(
    input.articleId,
    input.rankContext,
    input.embeddingIndexId ?? null,
    input.score,
    input.calculatedAt
  );
}

function insertSemanticRankForContext(
  db: DibaoDatabase,
  input: {
    articleId: string;
    rankContext: string;
    embeddingIndexId: string;
    score: number;
    calculatedAt: number;
  }
): void {
  db.prepare(
    `
      insert into article_rank_scores (
        article_id,
        rank_context,
        embedding_index_id,
        score,
        interest_score,
        semantic_score,
        source_score,
        freshness_score,
        state_score,
        diversity_score,
        penalty_score,
        calculated_at
      )
      values (?, ?, ?, ?, 0.8, 0.8, 0, 0, 0, 0, 0, ?)
      on conflict(article_id, rank_context) do update set
        score = excluded.score,
        semantic_score = excluded.semantic_score,
        calculated_at = excluded.calculated_at
    `
  ).run(
    input.articleId,
    input.rankContext,
    input.embeddingIndexId,
    input.score,
    input.calculatedAt
  );
}

function getRankScore(db: DibaoDatabase, articleId: string): number {
  const row = db
    .prepare(
      `
        select score
        from article_rank_scores
        where article_id = ?
          and rank_context = 'base'
      `
    )
    .get(articleId) as { score: number } | undefined;

  if (!row) {
    throw new Error(`Missing rank score for ${articleId}`);
  }

  return row.score;
}

async function drainRankingJobs(db: DibaoDatabase, now: number): Promise<void> {
  const jobs = new SqliteJobRepository(db);
  const embeddings = new SqliteEmbeddingRepository(db);
  const profiles = new SqliteProfileRepository(db);
  const rankings = new SqliteRankingRepository(db);
  const ranking = new RecommendationRankingService({
    embeddings,
    profiles,
    rankings,
    now: () => now
  });
  const rankingJobs = new RankingRecalculateJobService({
    jobs,
    ranking,
    now: () => now
  });
  const runner = new JobRunner({
    jobs,
    handlers: {
      [RANKING_RECALCULATE_JOB_TYPE]: (job) => rankingJobs.handleRankingRecalculateJob(job)
    },
    now: () => now
  });

  await runner.drainDue();
}

function tempDatabasePath(): string {
  const dir = createTempDir();
  return join(dir, "dibao.sqlite");
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dibao-server-"));
  tempDirs.push(dir);
  return dir;
}

function fixtureFetcher(fixtures: Record<string, string>): FeedFetcher {
  return async (url) =>
    new Response(fixtures[url] ?? "", {
      status: fixtures[url] === undefined ? 404 : 200,
      statusText: fixtures[url] === undefined ? "Not Found" : "OK"
    });
}

function embeddingFetcherFixture(
  calls: Array<{ url: string; authorization: string | null; inputCount: number }>,
  dimension: number
): typeof fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
    const values = Array.isArray(body.input) ? body.input : [body.input];
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      inputCount: values.length
    });

    return new Response(
      JSON.stringify({
        data: values.map((_, index) => ({
          index,
          embedding: Array.from({ length: dimension }, (_value, vectorIndex) => vectorIndex + 1)
        }))
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };
}

function embeddingErrorFetcher(status: number, payload: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: {
        "content-type": "application/json"
      }
    });
}

function googleOpenAiCompatibleEmbeddingFetcherFixture(
  calls: Array<{
    url: string;
    authorization: string | null;
    inputCount: number;
    dimensions: number | null;
  }>
): typeof fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input?: unknown;
      dimensions?: unknown;
    };
    const values = Array.isArray(body.input) ? body.input : [body.input];
    const dimensions = typeof body.dimensions === "number" ? body.dimensions : 3072;
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      inputCount: values.length,
      dimensions: typeof body.dimensions === "number" ? body.dimensions : null
    });

    return new Response(
      JSON.stringify({
        data: values.map((_, index) => ({
          index,
          embedding: Array.from(
            { length: dimensions },
            (_value, vectorIndex) => vectorIndex + 1
          )
        }))
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };
}

function ollamaEmbeddingFetcherFixture(
  calls: Array<{ url: string; authorization: string | null; inputCount: number; model: string }>,
  dimension: number
): typeof fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown; model?: unknown };
    const values = Array.isArray(body.input) ? body.input : [body.input];
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization"),
      inputCount: values.length,
      model: typeof body.model === "string" ? body.model : ""
    });

    return new Response(
      JSON.stringify({
        model: body.model,
        embeddings: values.map(() =>
          Array.from({ length: dimension }, (_value, vectorIndex) => vectorIndex + 1)
        )
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };
}

function geminiEmbeddingFetcherFixture(
  calls: Array<{
    url: string;
    apiKey: string | null;
    inputCount: number;
    model: string;
    outputDimensionality: number | null;
  }>,
  dimension: number
): typeof fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      requests?: Array<{
        model?: unknown;
        outputDimensionality?: unknown;
        content?: { parts?: Array<{ text?: unknown }> };
      }>;
    };
    const requests = Array.isArray(body.requests) ? body.requests : [];
    const outputDimensionality =
      typeof requests[0]?.outputDimensionality === "number"
        ? requests[0].outputDimensionality
        : null;
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      apiKey: headers.get("x-goog-api-key"),
      inputCount: requests.length,
      model: typeof requests[0]?.model === "string" ? requests[0].model : "",
      outputDimensionality
    });

    return new Response(
      JSON.stringify({
        embeddings: requests.map(() => ({
          values: Array.from(
            { length: outputDimensionality ?? dimension },
            (_value, vectorIndex) => vectorIndex + 1
          )
        }))
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };
}

function sequenceFetcher(url: string, responses: string[]): FeedFetcher {
  let requestCount = 0;

  return async (requestedUrl) => {
    const xml =
      requestedUrl === url
        ? responses[Math.min(requestCount, responses.length - 1)]
        : undefined;
    requestCount += 1;

    return new Response(xml ?? "", {
      status: xml === undefined ? 404 : 200,
      statusText: xml === undefined ? "Not Found" : "OK"
    });
  };
}

async function postJson(app: ReturnType<typeof buildServer>, url: string, payload: unknown) {
  return injectJson(app, "POST", url, payload);
}

async function injectJson(
  app: ReturnType<typeof buildServer>,
  method: "PATCH" | "POST",
  url: string,
  payload: unknown
) {
  return app.inject({
    method,
    url,
    headers: {
      "content-type": "application/json"
    },
    payload: JSON.stringify(payload)
  });
}

async function injectJsonWithCookie(
  app: ReturnType<typeof buildServer>,
  method: "PATCH" | "POST",
  url: string,
  cookie: string,
  payload: unknown
) {
  return app.inject({
    method,
    url,
    headers: {
      "content-type": "application/json",
      cookie
    },
    payload: JSON.stringify(payload)
  });
}

function cookieHeaderFromSetCookie(value: string | string[] | undefined): string {
  const cookie = Array.isArray(value) ? value[0] : value;
  if (!cookie) {
    throw new Error("Expected set-cookie header");
  }

  return cookie.split(";")[0];
}

function expectSessionCookieAttributes(
  value: string | string[] | undefined,
  secure: boolean
): void {
  const cookie = Array.isArray(value) ? value[0] : value;
  expect(cookie).toBeDefined();
  expect(cookie).toContain("dibao_session=");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("Max-Age=2592000");
  expect(cookie).toMatch(/Expires=[^;]+GMT/);
  if (secure) {
    expect(cookie).toContain("Secure");
  } else {
    expect(cookie).not.toContain("Secure");
  }
}

function expectClearSessionCookie(value: string | string[] | undefined): void {
  const cookie = Array.isArray(value) ? value[0] : value;
  expect(cookie).toBeDefined();
  expect(cookie).toContain("dibao_session=");
  expect(cookie).toContain("Max-Age=0");
  expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Path=/");
}

async function postMultipartOpml(app: ReturnType<typeof buildServer>, xml: string) {
  const boundary = `dibao-${Date.now()}`;
  const payload = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="subscriptions.opml"',
    "Content-Type: text/xml",
    "",
    xml,
    `--${boundary}--`,
    ""
  ].join("\r\n");

  return app.inject({
    method: "POST",
    url: "/api/opml/import",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    payload
  });
}

function getArticleStateRow(db: DibaoDatabase, articleId: string) {
  return db
    .prepare(
      `
        select
          read_at as readAt,
          favorited_at as favoritedAt,
          liked_at as likedAt,
          read_later_at as readLaterAt,
          hidden_at as hiddenAt,
          not_interested_at as notInterestedAt,
          reading_progress as readingProgress,
          last_opened_at as lastOpenedAt,
          updated_at as updatedAt
        from article_states
        where article_id = ?
      `
    )
    .get(articleId);
}

function countTable(db: DibaoDatabase, tableName: string): number {
  const row = db.prepare(`select count(*) as count from ${tableName}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function jobCounts(db: DibaoDatabase): Record<string, number> {
  const rows = db
    .prepare(
      `
        select type, count(*) as count
        from jobs
        group by type
      `
    )
    .all() as Array<{ type: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.type, row.count]));
}

function openEmbeddingArticleIds(db: DibaoDatabase): string[] {
  const rows = db
    .prepare(
      `
        select payload_json as payloadJson
        from jobs
        where type = 'embedding_generate'
          and status in ('queued', 'running')
      `
    )
    .all() as Array<{ payloadJson: string }>;
  return rows.flatMap((row) => (JSON.parse(row.payloadJson) as { articleIds: string[] }).articleIds);
}

function expectUniqueOpenEmbeddingArticleIds(db: DibaoDatabase): void {
  const articleIds = openEmbeddingArticleIds(db);
  expect(new Set(articleIds).size).toBe(articleIds.length);
}

function contentStatusCounts(db: DibaoDatabase): Record<string, number> {
  const rows = db
    .prepare(
      `
        select extraction_status as status, count(*) as count
        from article_contents
        group by extraction_status
      `
    )
    .all() as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function listBehaviorEventTypes(db: DibaoDatabase, articleId: string): string[] {
  return listBehaviorEvents(db, articleId).map((event) => event.eventType);
}

function listBehaviorEvents(db: DibaoDatabase, articleId: string) {
  return db
    .prepare(
      `
        select
          event_type as eventType,
          event_weight as eventWeight,
          metadata_json as metadataJson
        from behavior_events
        where article_id = ?
        order by rowid
      `
    )
    .all(articleId) as Array<{
    eventType: string;
    eventWeight: number;
    metadataJson: string | null;
    }>;
}

function listFolderTitles(db: DibaoDatabase): string[] {
  return db
    .prepare(
      `
        select title
        from feed_folders
        where deleted_at is null
        order by sort_order, title collate nocase
      `
    )
    .all()
    .map((row) => (row as { title: string }).title);
}

function listFeedFolderAssignments(db: DibaoDatabase) {
  return db
    .prepare(
      `
        select
          feeds.title,
          feeds.feed_url as feedUrl,
          feed_folders.title as folderTitle
        from feeds
        left join feed_folders on feed_folders.id = feeds.folder_id
        where feeds.deleted_at is null
        order by feeds.title collate nocase
      `
    )
    .all() as Array<{
    title: string;
    feedUrl: string;
    folderTitle: string | null;
  }>;
}

const fixtureOpml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Fixture Subscriptions</title></head>
  <body>
    <outline text="Tech">
      <outline type="rss" text="Design Feed" xmlUrl="https://example.com/design.xml" htmlUrl="https://example.com/design" />
      <outline text="AI">
        <outline type="rss" title="ML Feed" xmlUrl="https://example.com/ml.xml" htmlUrl="https://example.com/ml" />
        <outline type="rss" title="ML Duplicate" xmlUrl="https://example.com/ml.xml" />
      </outline>
    </outline>
  </body>
</opml>`;

const singleFeedOpml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="News">
      <outline type="rss" text="News Feed" xmlUrl="https://example.com/news.xml" />
    </outline>
  </body>
</opml>`;

const fixtureRss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    <description>Fixture feed</description>
    <item>
      <title>First fixture article</title>
      <link>https://example.com/first</link>
      <guid>fixture-first</guid>
      <author>Ada</author>
      <pubDate>Thu, 14 May 2026 07:00:00 GMT</pubDate>
      <description>First summary</description>
      <content:encoded><![CDATA[<p>Full first article</p>]]></content:encoded>
    </item>
    <item>
      <title>Second fixture article</title>
      <link>https://example.com/second</link>
      <guid>fixture-second</guid>
      <pubDate>Thu, 14 May 2026 07:30:00 GMT</pubDate>
      <description>Second summary</description>
    </item>
  </channel>
</rss>`;

const fixtureAtom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Fixture</title>
  <link href="https://example.com/" rel="alternate" />
  <link href="https://example.com/atom.xml" rel="self" />
  <subtitle>Atom feed fixture</subtitle>
  <entry>
    <title>Atom article</title>
    <link href="https://example.com/atom-article" />
    <id>atom-article</id>
    <updated>2026-05-14T08:00:00.000Z</updated>
    <summary>Atom summary</summary>
  </entry>
</feed>`;

const fixtureHtmlWithFeeds = `<!doctype html>
<html>
  <head>
    <link title="Main Feed" href="/feeds/main.xml" rel="alternate feed" type="application/rss+xml">
    <link href="https://example.com/atom.xml" type="application/atom+xml" rel="alternate">
  </head>
  <body>Example</body>
</html>`;

const fixtureHtmlWithInvalidFeed = `<!doctype html>
<html>
  <head>
    <link rel="alternate" type="application/rss+xml" href="/broken.xml" title="Broken">
  </head>
  <body>Example</body>
</html>`;

const fixtureRssWithMovedFirstArticle = fixtureRss.replace(
  "https://example.com/first",
  "https://example.com/first-moved"
);

function waitForDeferredPostActionWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
