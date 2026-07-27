import { describe, expect, it } from "vitest";
import { ApiRequestError, createDibaoApi, userMessageForError } from "./api.js";
import { dictionaries } from "./i18n.js";

describe("web API client", () => {
  it("calls auth endpoints with same-origin credentials", async () => {
    const calls: Array<{
      body: unknown;
      credentials: RequestCredentials | undefined;
      method: string | undefined;
      path: string;
    }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        method: init?.method,
        credentials: init?.credentials,
        body: init?.body ? JSON.parse(String(init.body)) : null
      });

      return new Response(
        JSON.stringify({
          data: String(input).endsWith("/session")
            ? {
                setupCompleted: true,
                authenticated: false,
                username: null
              }
            : {
                ok: true
              }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(api.getAuthSession()).resolves.toEqual({
      setupCompleted: true,
      authenticated: false,
      username: null
    });
    await api.setupAuth("Pls", "correct horse battery");
    await api.login("Pls", "correct horse battery");
    await api.changePassword("correct horse battery", "new correct horse battery");
    await api.logoutAll();
    await api.logout();

    expect(calls).toEqual([
      {
        path: "/api/auth/session",
        method: undefined,
        credentials: "same-origin",
        body: null
      },
      {
        path: "/api/auth/setup",
        method: "POST",
        credentials: "same-origin",
        body: {
          username: "Pls",
          password: "correct horse battery"
        }
      },
      {
        path: "/api/auth/login",
        method: "POST",
        credentials: "same-origin",
        body: {
          username: "Pls",
          password: "correct horse battery"
        }
      },
      {
        path: "/api/auth/password",
        method: "POST",
        credentials: "same-origin",
        body: {
          currentPassword: "correct horse battery",
          newPassword: "new correct horse battery"
        }
      },
      {
        path: "/api/auth/logout-all",
        method: "POST",
        credentials: "same-origin",
        body: null
      },
      {
        path: "/api/auth/logout",
        method: "POST",
        credentials: "same-origin",
        body: null
      }
    ]);
  });

  it("fetches feed folders", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));

      return new Response(
        JSON.stringify({
          data: [
            {
              id: "folder_design",
              title: "Design",
              sortOrder: 1
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(api.listFeedFolders()).resolves.toEqual([
      {
        id: "folder_design",
        title: "Design",
        sortOrder: 1
      }
    ]);
    expect(calls).toEqual(["/api/feed-folders"]);
  });

  it("discovers feeds with the expected request body", async () => {
    const calls: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null
      });

      return new Response(
        JSON.stringify({
          data: {
            inputUrl: "https://example.com",
            normalizedUrl: "https://example.com/",
            inputKind: "html",
            candidates: [
              {
                feedUrl: "https://example.com/feed.xml",
                title: "Example Feed",
                siteUrl: "https://example.com/",
                description: "Fixture",
                format: "rss",
                status: "valid",
                existingFeedId: null,
                itemCount: 1,
                recentItems: [
                  {
                    title: "Latest",
                    url: "https://example.com/latest",
                    publishedAt: "2026-05-23T00:00:00.000Z"
                  }
                ],
                error: null
              }
            ],
            warnings: []
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(api.discoverFeeds("https://example.com")).resolves.toMatchObject({
      inputKind: "html",
      candidates: [
        {
          feedUrl: "https://example.com/feed.xml",
          status: "valid",
          recentItems: [
            {
              title: "Latest",
              publishedAt: "2026-05-23T00:00:00.000Z"
            }
          ]
        }
      ]
    });
    expect(calls).toEqual([
      {
        path: "/api/feeds/discover",
        method: "POST",
        body: {
          url: "https://example.com"
        }
      }
    ]);
  });

  it("fetches feed diagnostics", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));

      return new Response(
        JSON.stringify({
          data: {
            summary: {
              total: 1,
              enabled: 1,
              healthy: 0,
              warning: 0,
              error: 1,
              disabled: 0,
              neverFetched: 0
            },
            items: [
              {
                feed: {
                  id: "feed_1",
                  title: "Feed",
                  feedUrl: "https://example.com/feed.xml",
                  siteUrl: "https://example.com/",
                  enabled: true
                },
                diagnostic: {
                  feedId: "feed_1",
                  status: "failing",
                  severity: "error",
                  code: "FETCH_FAILED",
                  message: "The latest feed fetch failed.",
                  lastFetchedAt: "2026-05-23T00:00:00.000Z",
                  lastSuccessAt: null,
                  nextRefreshAt: "2026-05-23T01:00:00.000Z",
                  lastError: "Feed parse failed"
                }
              }
            ]
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(api.getFeedDiagnostics()).resolves.toMatchObject({
      summary: {
        error: 1
      },
      items: [
        {
          diagnostic: {
            status: "failing",
            lastError: "Feed parse failed"
          }
        }
      ]
    });
    expect(calls).toEqual(["/api/feeds/diagnostics"]);
  });

  it("fetches setup status", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));

      return new Response(
        JSON.stringify({
          data: {
            setupCompleted: true,
            hasFeeds: false,
            hasEmbeddingProvider: false,
            firstRefreshStatus: "idle"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(api.getSetupStatus()).resolves.toEqual({
      setupCompleted: true,
      hasFeeds: false,
      hasEmbeddingProvider: false,
      firstRefreshStatus: "idle"
    });
    expect(calls).toEqual(["/api/setup/status"]);
  });

  it("fetches and updates app settings", async () => {
    const calls: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null
      });

      const settings = {
        ui: {
          locale: "en-US",
          defaultHomeView: "latest"
        },
        reader: {
          fontSize: 20,
          lineHeight: 1.8,
          paragraphGap: 1.2,
          readerWidth: 760,
          theme: "paper"
        },
        retention: {
          retentionDays: 45,
          keepFavorites: false,
          keepReadLater: true
        },
        ranking: {
          preferFreshness: 0.5,
          preferSource: 0.5,
          preferDiversity: 0.5,
          cocoonLevel: 5,
          maxPositiveInterestClusters: 48,
          maxNegativeInterestClusters: 32,
          localLearningEnabled: true,
          localLearningShadowMode: false,
          explorationEnabled: true,
          evaluationEnabled: false
        }
      };

      return new Response(
        JSON.stringify({
          data:
            init?.method === "PATCH"
              ? {
                  ok: true,
                  settings
                }
              : settings
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(api.getSettings()).resolves.toMatchObject({
      ui: {
        locale: "en-US",
        defaultHomeView: "latest"
      },
      retention: {
        retentionDays: 45,
        keepFavorites: false
      }
    });
    await expect(
      api.updateSettings({
        ui: {
          locale: "en-US",
          defaultHomeView: "latest"
        },
        reader: {
          fontSize: 20
        },
        retention: {
          retentionDays: 45,
          keepFavorites: false
        },
        behavior: {
          infiniteArticleLoading: true
        },
        ranking: {
          maxPositiveInterestClusters: 48,
          maxNegativeInterestClusters: 32
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      settings: {
        reader: {
          fontSize: 20
        }
      }
    });

    expect(calls).toEqual([
      {
        path: "/api/settings",
        method: undefined,
        body: null
      },
      {
        path: "/api/settings",
        method: "PATCH",
        body: {
          ui: {
            locale: "en-US",
            defaultHomeView: "latest"
          },
          reader: {
            fontSize: 20
          },
          retention: {
            retentionDays: 45,
            keepFavorites: false
          },
          behavior: {
            infiniteArticleLoading: true
          },
          ranking: {
            maxPositiveInterestClusters: 48,
            maxNegativeInterestClusters: 32
          }
        }
      }
    ]);
  });

  it("calls embedding provider and index endpoints", async () => {
    const calls: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    const api = createDibaoApi(async (input, init) => {
      const path = String(input);
      calls.push({
        path,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null
      });

      const provider = {
        id: "provider/openai",
        type: "openai_compatible",
        name: "OpenAI Compatible",
        baseUrl: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        dimension: 1536,
        textMaxChars: 8000,
        requestsPerMinute: 60,
        requestsPerDay: 1000,
        enabled: true,
        qualityTier: "recommended",
        hasApiKey: true,
        lastTestStatus: "success",
        lastTestError: null,
        lastTestAt: "2026-05-14T08:00:00.000Z",
        createdAt: "2026-05-14T08:00:00.000Z",
        updatedAt: "2026-05-14T08:00:00.000Z"
      };

      const data = path === "/api/embedding/providers"
        ? init?.method === "POST"
          ? { id: "provider/openai" }
          : [provider]
        : path.endsWith("/activate")
          ? provider
        : path.endsWith("/test")
          ? { status: "success", dimension: 1536, latencyMs: 12 }
          : path === "/api/embedding/indexes"
            ? [
                {
                  id: "index/openai",
                  providerId: "provider/openai",
                  model: "text-embedding-3-small",
                  dimension: 1536,
                  textMaxChars: 8000,
                  distanceMetric: "cosine",
                  status: "active",
                  candidateCount: 4,
                  embeddingCount: 2,
                  coverageRatio: 0.5,
                  pendingJobs: 1,
                  failedJobs: 0,
                  lastFailedAt: null,
                  lastError: null,
                  createdAt: "2026-05-14T08:00:00.000Z",
                  updatedAt: "2026-05-14T08:00:00.000Z"
                }
              ]
            : path.includes("/embedding/indexes/")
              ? { jobId: "job/rebuild" }
              : init?.method === "DELETE"
                ? { ok: true }
                : provider;

      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    });

    await api.listEmbeddingProviders();
    await api.createEmbeddingProvider({
      type: "openai_compatible",
      name: "OpenAI Compatible",
      baseUrl: "https://api.example.com/v1",
      model: "text-embedding-3-small",
      dimension: 1536,
      apiKey: "secret",
      enabled: true,
      qualityTier: "recommended"
    });
    await api.updateEmbeddingProvider("provider/openai", {
      enabled: false
    });
    await api.activateEmbeddingProvider("provider/openai");
    await api.testEmbeddingProvider("provider/openai");
    await api.listEmbeddingIndexes();
    await api.rebuildEmbeddingIndex("index/openai");
    await api.backfillEmbeddingIndex("index/openai");
    await api.deleteEmbeddingProvider("provider/openai");

    expect(calls).toEqual([
      {
        path: "/api/embedding/providers",
        method: undefined,
        body: null
      },
      {
        path: "/api/embedding/providers",
        method: "POST",
        body: {
          type: "openai_compatible",
          name: "OpenAI Compatible",
          baseUrl: "https://api.example.com/v1",
          model: "text-embedding-3-small",
          dimension: 1536,
          apiKey: "secret",
          enabled: true,
          qualityTier: "recommended"
        }
      },
      {
        path: "/api/embedding/providers/provider%2Fopenai",
        method: "PATCH",
        body: {
          enabled: false
        }
      },
      {
        path: "/api/embedding/providers/provider%2Fopenai/activate",
        method: "POST",
        body: null
      },
      {
        path: "/api/embedding/providers/provider%2Fopenai/test",
        method: "POST",
        body: null
      },
      {
        path: "/api/embedding/indexes",
        method: undefined,
        body: null
      },
      {
        path: "/api/embedding/indexes/index%2Fopenai/rebuild",
        method: "POST",
        body: null
      },
      {
        path: "/api/embedding/indexes/index%2Fopenai/backfill",
        method: "POST",
        body: null
      },
      {
        path: "/api/embedding/providers/provider%2Fopenai",
        method: "DELETE",
        body: null
      }
    ]);
  });

  it("fetches recommendation diagnostics status", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));

      return new Response(
        JSON.stringify({
          data: {
            mode: "embedding",
            activeProvider: {
              id: "provider/openai",
              type: "openai_compatible",
              name: "OpenAI Compatible",
              model: "text-embedding-3-small",
              dimension: 1536,
              lastTestStatus: "success",
              lastTestAt: "2026-05-14T08:00:00.000Z"
            },
            activeIndex: {
              id: "index/openai",
              status: "active",
              model: "text-embedding-3-small",
              dimension: 1536
            },
            activeRankContext: "index/openai",
            coverage: {
              candidateCount: 4,
              embeddingCount: 2,
              coverageRatio: 0.5,
              pendingJobs: 1,
              failedJobs: 0,
              lastFailedAt: null,
              lastError: null
            },
            behaviorCounts: {
              open: 2,
              read_progress: 1
            },
            clusters: {
              positive: 1,
              negative: 0
            },
            rankedArticles: {
              base: 4,
              active: 2
            },
            lastProfileUpdate: "2026-05-14T08:09:00.000Z",
            lastRankingUpdate: "2026-05-14T08:11:00.000Z",
            warnings: []
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(api.getRecommendationStatus()).resolves.toMatchObject({
      mode: "embedding",
      coverage: {
        candidateCount: 4,
        coverageRatio: 0.5
      },
      clusters: {
        positive: 1,
        negative: 0
      }
    });
    await expect(
      api.getRecommendationStatus({ includeClusterItems: false })
    ).resolves.toMatchObject({
      mode: "embedding"
    });
    expect(calls).toEqual([
      "/api/recommendation/status",
      "/api/recommendation/status?includeClusterItems=false"
    ]);
  });

  it("calls feed and folder management endpoints", async () => {
    const calls: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    const api = createDibaoApi(async (input, init) => {
      const path = String(input);
      calls.push({
        path,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null
      });

      const data = path === "/api/feeds/refresh"
        ? {
            jobIds: ["job_1", "job_2"]
          }
        : path.includes("/feed-folders")
        ? {
            id: "folder_design",
            title: "Design",
            sortOrder: 1
          }
        : path === "/api/feeds"
          ? {
              feed: {
                id: "feed_design",
                folderId: "folder_design",
                title: "Design Feed",
                siteUrl: null,
                feedUrl: "https://example.com/feed.xml",
                description: null,
                enabled: true,
                sourceWeight: 0,
                lastFetchedAt: null,
                lastSuccessAt: null,
                nextRefreshAt: "2026-05-14T09:00:00.000Z",
                lastError: null,
                createdAt: "2026-05-14T08:00:00.000Z",
                updatedAt: "2026-05-14T08:00:00.000Z"
              },
              refreshJobId: "job_1"
            }
          : path.includes("/feeds/")
            ? init?.method === "DELETE"
              ? { ok: true }
              : {
                  id: "feed_design",
                  folderId: "folder_design",
                  title: "Design Feed",
                  siteUrl: null,
                  feedUrl: "https://example.com/feed.xml",
                  description: null,
                  enabled: false,
                  fullContentMode: "fetch_full_content",
                  sourceWeight: 0.2,
                  lastFetchedAt: null,
                  lastSuccessAt: null,
                  nextRefreshAt: "2026-05-14T09:00:00.000Z",
                  lastError: null,
                  createdAt: "2026-05-14T08:00:00.000Z",
                  updatedAt: "2026-05-14T08:00:00.000Z"
                }
            : { ok: true };

      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    });

    await api.createFeed("https://example.com/feed.xml", "folder_design");
    await api.createFeedFolder("Design");
    await api.updateFeedFolder("folder/design", { title: "Design Systems" });
    await api.deleteFeedFolder("folder/design");
    await api.updateFeed("feed/design", {
      title: "Design Feed",
      feedUrl: "https://example.com/design.xml",
      folderId: "folder_design",
      enabled: false,
      fullContentMode: "fetch_full_content",
      sourceWeight: 0.2
    });
    await api.previewFeedFullContent("feed/design");
    await api.previewFeedFullContent("feed/design", "https://example.com/article");
    await api.backfillCurrentFeedFullContent("feed/design");
    await api.deleteFeed("feed/design");
    await api.refreshAllFeeds();

    expect(calls).toEqual([
      {
        path: "/api/feeds",
        method: "POST",
        body: {
          feedUrl: "https://example.com/feed.xml",
          folderId: "folder_design"
        }
      },
      {
        path: "/api/feed-folders",
        method: "POST",
        body: {
          title: "Design"
        }
      },
      {
        path: "/api/feed-folders/folder%2Fdesign",
        method: "PATCH",
        body: {
          title: "Design Systems"
        }
      },
      {
        path: "/api/feed-folders/folder%2Fdesign",
        method: "DELETE",
        body: null
      },
      {
        path: "/api/feeds/feed%2Fdesign",
        method: "PATCH",
        body: {
          title: "Design Feed",
          feedUrl: "https://example.com/design.xml",
          folderId: "folder_design",
          enabled: false,
          fullContentMode: "fetch_full_content",
          sourceWeight: 0.2
        }
      },
      {
        path: "/api/feeds/feed%2Fdesign/full-content/preview",
        method: "POST",
        body: {}
      },
      {
        path: "/api/feeds/feed%2Fdesign/full-content/preview",
        method: "POST",
        body: {
          articleUrl: "https://example.com/article"
        }
      },
      {
        path: "/api/feeds/feed%2Fdesign/full-content/backfill-current",
        method: "POST",
        body: null
      },
      {
        path: "/api/feeds/feed%2Fdesign",
        method: "DELETE",
        body: null
      },
      {
        path: "/api/feeds/refresh",
        method: "POST",
        body: null
      }
    ]);
  });

  it("lists articles with view, folder, cursor, and unread filter query", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));

      return new Response(
        JSON.stringify({
          data: [],
          page: {
            nextCursor: null
          },
          meta: {
            unreadCount: 17
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    const first = await api.listArticles({
      view: "recommended",
      folderId: "folder_design",
      limit: 20,
      cursor: "cursor_1",
      unreadOnly: true,
      timeWindow: "7d"
    });
    await api.listArticles({
      view: "latest",
      unreadOnly: true,
      timeWindow: "24h"
    });
    await api.listArticles({
      view: "favorites",
      sort: "favorited_asc",
      unreadOnly: true
    });
    await api.listArticles({
      view: "read_later",
      sort: "read_later_desc",
      unreadOnly: true
    });

    expect(calls).toEqual([
      "/api/articles?view=recommended&limit=20&folderId=folder_design&cursor=cursor_1&unreadOnly=true&timeWindow=7d",
      "/api/articles?view=latest&limit=50&unreadOnly=true&timeWindow=24h",
      "/api/articles?view=favorites&limit=50&sort=favorited_asc",
      "/api/articles?view=read_later&limit=50&sort=read_later_desc"
    ]);
    expect(first.meta.unreadCount).toBe(17);
  });

  it("searches articles with encoded filters and preserves list response fallbacks", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));

      return new Response(
        JSON.stringify({
          data: [],
          page: {
            nextCursor: "next_cursor"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    const first = await api.searchArticles({ q: "ai" });
    await api.searchArticles({
      q: "local ai",
      feedId: "feed/design",
      folderId: "folder/design",
      state: "favorites",
      sort: "recommended",
      from: "2026-05-01",
      to: "2026-05-22",
      cursor: "cursor/1",
      limit: 25
    });

    expect(calls).toEqual([
      "/api/search?q=ai&limit=50",
      "/api/search?q=local+ai&limit=25&feedId=feed%2Fdesign&folderId=folder%2Fdesign&from=2026-05-01&to=2026-05-22&state=favorites&sort=recommended&cursor=cursor%2F1"
    ]);
    expect(first.page.nextCursor).toBe("next_cursor");
    expect(first.meta.unreadCount).toBeNull();
  });

  it("posts reader mark-scope-read commands", async () => {
    const calls: Array<{ path: string; method: string | undefined; body: unknown }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null
      });

      return new Response(
        JSON.stringify({
          data: {
            ok: true,
            commandId: "cmd_test",
            markedReadCount: 42
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(
      api.markScopeRead({
        type: "article_list",
        view: "latest",
        feedId: "feed_1",
        clearWindow: "7d"
      })
    ).resolves.toEqual({
      ok: true,
      commandId: "cmd_test",
      markedReadCount: 42
    });
    await api.markScopeRead({
      type: "search",
      q: "AI",
      folderId: "folder_1",
      from: "2026-05-01",
      to: "2026-05-23",
      state: "unread"
    });

    expect(calls).toEqual([
      {
        path: "/api/reader/commands/mark-scope-read",
        method: "POST",
        body: {
          scope: {
            type: "article_list",
            view: "latest",
            feedId: "feed_1",
            clearWindow: "7d"
          }
        }
      },
      {
        path: "/api/reader/commands/mark-scope-read",
        method: "POST",
        body: {
          scope: {
            type: "search",
            q: "AI",
            folderId: "folder_1",
            from: "2026-05-01",
            to: "2026-05-23",
            state: "unread"
          }
        }
      }
    ]);
  });

  it("posts reader command preview bodies", async () => {
    const calls: Array<{ path: string; method?: string; body: unknown }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body))
      });

      return new Response(
        JSON.stringify({
          data: {
            ok: true,
            markedReadCount: 7
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(
      api.previewMarkScopeRead({
        type: "article_list",
        view: "recommended",
        folderId: "folder_1",
        clearWindow: "24h"
      })
    ).resolves.toEqual({
      ok: true,
      markedReadCount: 7
    });

    expect(calls).toEqual([
      {
        path: "/api/reader/commands/mark-scope-read/preview",
        method: "POST",
        body: {
          scope: {
            type: "article_list",
            view: "recommended",
            folderId: "folder_1",
            clearWindow: "24h"
          }
        }
      }
    ]);
  });

  it("surfaces ApiRequestError for reader command failures", async () => {
    const api = createDibaoApi(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "scope.type must be article_list or search"
          }
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    await expect(
      api.markScopeRead({
        type: "article_list",
        view: "recommended"
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR"
    });
  });

  it("imports OPML without forcing a JSON content type", async () => {
    const calls: Array<{
      path: string;
      bodyIsFormData: boolean;
      contentType: string | null;
      method: string | undefined;
    }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        bodyIsFormData: init?.body instanceof FormData,
        contentType: new Headers(init?.headers).get("content-type"),
        method: init?.method
      });

      return new Response(
        JSON.stringify({
          data: {
            foldersCreated: 1,
            feedsCreated: 2,
            feedsSkipped: 3,
            errors: []
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(
      api.importOpml(new File(["<opml version=\"2.0\" />"], "subscriptions.opml"))
    ).resolves.toMatchObject({
      foldersCreated: 1,
      feedsCreated: 2,
      feedsSkipped: 3
    });
    expect(calls).toEqual([
      {
        path: "/api/opml/import",
        method: "POST",
        bodyIsFormData: true,
        contentType: null
      }
    ]);
  });

  it("exports OPML as XML text", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));

      return new Response("<?xml version=\"1.0\"?><opml version=\"2.0\"></opml>", {
        status: 200,
        headers: {
          "content-type": "application/xml"
        }
      });
    });

    await expect(api.exportOpml()).resolves.toBe(
      "<?xml version=\"1.0\"?><opml version=\"2.0\"></opml>"
    );
    expect(calls).toEqual(["/api/opml/export"]);
  });

  it("fetches article rank explanations", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));

      return new Response(
        JSON.stringify({
          data: {
            articleId: "article/one",
            reasons: [
              {
                type: "source",
                label: "Fixture Feed",
                impact: "positive"
              }
            ],
            generatedAt: "2026-05-14T08:10:00.000Z"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(api.getArticleExplanation("article/one")).resolves.toMatchObject({
      articleId: "article/one",
      reasons: [
        {
          type: "source",
          label: "Fixture Feed",
          impact: "positive"
        }
      ]
    });
    expect(calls).toEqual(["/api/articles/article%2Fone/explanation"]);
  });

  it("updates manual recommendation cluster labels", async () => {
    const calls: Array<{ path: string; body: unknown; method: string | undefined }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        method: init?.method
      });

      return new Response(
        JSON.stringify({
          data: {
            ok: true,
            clusterId: "cluster/one",
            displayLabel: "AI 编程代理",
            labelSource: "manual"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(
      api.updateRecommendationClusterLabel("cluster/one", "AI 编程代理")
    ).resolves.toMatchObject({
      ok: true,
      clusterId: "cluster/one",
      displayLabel: "AI 编程代理",
      labelSource: "manual"
    });
    expect(calls).toEqual([
      {
        path: "/api/recommendation/clusters/cluster%2Fone/label",
        method: "PATCH",
        body: {
          manualLabel: "AI 编程代理"
        }
      }
    ]);
  });

  it("loads recommendation transparency with optional cluster items", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          data: {
            mode: "personalized",
            activeProvider: null,
            activeIndex: null,
            activeRankContext: "base",
            algorithm: {
              version: "rec_v3",
              featureSchemaVersion: 3,
              cocoonLevel: 1,
              localLearning: { enabled: true, shadowMode: false },
              exploration: { enabled: true },
              evaluation: { enabled: false },
              cocoonParameters: {}
            },
            coverage: {
              candidateCount: 0,
              embeddingCount: 0,
              coverageRatio: 1,
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
            warnings: [],
            transparency: {
              currentFormula: "test",
              fallbackReason: null,
              rankingCore: {
                usesRemoteLlm: false,
                usesRemoteReranker: false,
                usesExternalSearchService: false,
                allowedRemoteDependency: "one embedding provider"
              },
              moduleStatus: {},
              algorithmModules: [],
              maintenance: {
                schemaMigration: "017_interest_families",
                backfillState: "tracked",
                explanationAuthority: "article_rank_explanations",
                scoreAuthority: "article_rank_scores",
                automaticMaintenanceEnabled: true,
                settings: null,
                schedule: []
              },
              failureStates: {}
            }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await api.getRecommendationTransparency();
    await api.getRecommendationTransparency({
      includeClusterItems: true,
      clusterItemLimit: 10,
      clusterDetailLevel: "summary"
    });

    expect(calls).toEqual([
      "/api/recommendation/transparency",
      "/api/recommendation/transparency?includeClusterItems=true&clusterItemLimit=10&clusterDetailLevel=summary"
    ]);
  });

  it("loads recommendation clusters with optional detail level", async () => {
    const calls: string[] = [];
    const api = createDibaoApi(async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          data: {
            activeIndex: null,
            total: 0,
            items: []
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await api.listRecommendationClusters("all", { clusterDetailLevel: "summary" });

    expect(calls).toEqual([
      "/api/recommendation/clusters?limit=all&clusterDetailLevel=summary"
    ]);
  });

  it("updates manual recommendation family labels", async () => {
    const calls: Array<{ path: string; body: unknown; method: string | undefined }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        method: init?.method
      });

      return new Response(
        JSON.stringify({
          data: {
            ok: true,
            familyId: "family/one",
            displayLabel: "AI 新闻",
            manualLabel: "AI 新闻"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await expect(
      api.updateRecommendationFamilyLabel("family/one", "AI 新闻")
    ).resolves.toMatchObject({
      ok: true,
      familyId: "family/one",
      displayLabel: "AI 新闻",
      manualLabel: "AI 新闻"
    });
    expect(calls).toEqual([
      {
        path: "/api/recommendation/families/family%2Fone/label",
        method: "PATCH",
        body: {
          manualLabel: "AI 新闻"
        }
      }
    ]);
  });

  it("posts article actions using the contract-shaped body", async () => {
    const calls: Array<{ path: string; body: unknown; method: string | undefined }> = [];
    const api = createDibaoApi(async (input, init) => {
      calls.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        method: init?.method
      });

      return new Response(
        JSON.stringify({
          data: {
            eventId: "event_1",
            state: {
              read: false,
              favorited: false,
              liked: false,
              readLater: false,
              hidden: false,
              notInterested: false,
              readingProgress: 0
            }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    await api.postArticleAction("article/one", {
      type: "favorite",
      value: false
    });
    await api.postArticleAction("article/one", {
      type: "like",
      value: true
    });
    await api.postArticleAction("article/one", {
      type: "read_progress",
      progress: 0.5,
      metadata: {
        durationMs: 6000,
        activeDurationMs: 5000,
        scrollSource: "reader"
      }
    });
    api.postArticleActionKeepalive("article/one", {
      type: "read_progress",
      progress: 0.75,
      metadata: {
        durationMs: 12000,
        activeDurationMs: 9000,
        scrollSource: "reader"
      }
    });

    expect(calls).toEqual([
      {
        path: "/api/articles/article%2Fone/actions",
        method: "POST",
        body: {
          type: "favorite",
          value: false
        }
      },
      {
        path: "/api/articles/article%2Fone/actions",
        method: "POST",
        body: {
          type: "like",
          value: true
        }
      },
      {
        path: "/api/articles/article%2Fone/actions",
        method: "POST",
        body: {
          type: "read_progress",
          progress: 0.5,
          metadata: {
            durationMs: 6000,
            activeDurationMs: 5000,
            scrollSource: "reader"
          }
        }
      },
      {
        path: "/api/articles/article%2Fone/actions",
        method: "POST",
        body: {
          type: "read_progress",
          progress: 0.75,
          metadata: {
            durationMs: 12000,
            activeDurationMs: 9000,
            scrollSource: "reader"
          }
        }
      }
    ]);
  });

  it("parses contract-shaped errors", async () => {
    const api = createDibaoApi(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "PROVIDER_ERROR",
            message: "Feed parse failed"
          }
        }),
        {
          status: 502,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    await expect(api.createFeed("https://example.com/feed.xml")).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_ERROR",
      message: "Feed parse failed"
    });
  });

  it("returns a stable user-facing error message", () => {
    expect(
      userMessageForError(
        new ApiRequestError(400, "VALIDATION_ERROR", "Invalid URL"),
        dictionaries["zh-CN"].errors.api
      )
    ).toBe("Invalid URL");
    expect(userMessageForError("nope", dictionaries["zh-CN"].errors.api)).toBe(
      dictionaries["zh-CN"].errors.api.requestFailed
    );
    expect(
      userMessageForError(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
        dictionaries["zh-CN"].errors.api
      )
    ).toBe(dictionaries["zh-CN"].errors.api.requestTimeout);
    expect(
      userMessageForError(
        new ApiRequestError(500, "INTERNAL_ERROR", "", undefined, false),
        dictionaries["en-US"].errors.api
      )
    ).toBe("Request failed (HTTP 500).");
    expect(
      userMessageForError(
        new ApiRequestError(503, "DATABASE_BUSY", "Internal server error"),
        dictionaries["zh-CN"].errors.api
      )
    ).toBe(dictionaries["zh-CN"].errors.api.databaseBusy);
  });
});
