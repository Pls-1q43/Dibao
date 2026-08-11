# 邸报 Dibao API Contract v0

## 文档目的

本文定义邸报 MVP 的 HTTP API 合约，供前端、后端和测试用例共同使用。

MVP API 只服务单用户自托管实例，不提供多用户、组织、公开开放平台或第三方 OAuth。

## 通用约定

### Base URL

```text
/api
```

### 数据格式

请求和响应默认使用：

```text
Content-Type: application/json
```

OPML 导入使用：

```text
multipart/form-data
```

OPML 导出返回：

```text
application/xml
```

### 时间

API 中时间使用 ISO 8601 string。

数据库内部可以使用 epoch milliseconds，API 层负责转换。

示例：

```json
"2026-05-14T12:30:00.000Z"
```

### ID

所有业务 ID 使用 string。

### 成功响应

单对象：

```json
{
  "data": {}
}
```

列表：

```json
{
  "data": [],
  "page": {
    "nextCursor": "string-or-null"
  }
}
```

操作结果：

```json
{
  "data": {
    "ok": true
  }
}
```

### 错误响应

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human readable message",
    "details": {}
  }
}
```

常见错误码：

```text
UNAUTHORIZED
FORBIDDEN
NOT_FOUND
VALIDATION_ERROR
CONFLICT
PROVIDER_ERROR
JOB_FAILED
INTERNAL_ERROR
```

### 认证

登录后使用 httpOnly session cookie。

除以下接口外，其余 API 都需要 session：

```text
GET  /api/auth/session
POST /api/auth/setup
POST /api/auth/login
POST /api/auth/logout
GET  /api/system/health
```

说明：

- `POST /api/auth/logout` 允许匿名调用并保持幂等，用于清理可能存在的 session cookie。
- `GET /api/system/health` 是自托管部署和反向代理健康检查的匿名例外。

### Pagination

列表分页使用 cursor。

请求：

```text
?limit=50&cursor=...
```

响应：

```json
{
  "page": {
    "nextCursor": null
  }
}
```

默认 `limit = 50`，最大 `limit = 100`。

## 类型摘要

### Feed

```ts
type Feed = {
  id: string;
  folderId: string | null;
  title: string;
  siteUrl: string | null;
  feedUrl: string;
  description: string | null;
  enabled: boolean;
  fullContentMode: "feed_only" | "fetch_full_content";
  sourceWeight: number;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  nextRefreshAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
```

### FeedFolder

```ts
type FeedFolder = {
  id: string;
  title: string;
  sortOrder: number;
};
```

### ArticleListItem

```ts
type ArticleListItem = {
  id: string;
  feedId: string;
  feedTitle: string;
  title: string;
  url: string;
  author: string | null;
  summary: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  state: {
    read: boolean;
    favorited: boolean;
    liked: boolean;
    readLater: boolean;
    hidden: boolean;
    notInterested: boolean;
    readingProgress: number;
    interactionStatus: "unseen" | "seen" | "saved" | "ignored" | "opened" | "reading" | "read";
    openedAt: number | null;
    ignoredAt: number | null;
  };
  rank?: {
    score: number;
    calculatedAt: string;
  };
};
```

### ArticleDetail

```ts
type ArticleDetail = ArticleListItem & {
  contentHtml: string | null;
  contentText: string | null;
  extractionStatus: "pending" | "feed_only" | "success" | "failed" | "skipped";
  extractionError: string | null;
};
```

### RankExplanation

```ts
type RankExplanation = {
  articleId: string;
  reasons: Array<{
    type:
      | "interest"
      | "source"
      | "freshness"
      | "state"
      | "fallback"
      | "negative"
      | "penalty"
      | "exploration";
    label: string;
    impact: "positive" | "negative" | "neutral";
    cluster?: {
      id: string;
      polarity: "positive" | "negative";
      label: string | null;
      displayLabel?: string;
      labelSource?: "manual" | "keywords" | "representative_titles" | "feeds" | "fallback";
      autoLabel?: string | null;
      manualLabel?: string | null;
      confidence?: number;
      topTerms?: string[];
      displayIndex: number;
      weight: number;
      sampleCount: number;
      similarity: number;
      lastMatchedAt: string | null;
      updatedAt: string;
    };
  }>;
  generatedAt: string;
};
```

说明：

- `label` 是后端提供的轻量调试/辅助文本，不作为最终 UI 文案。
- 前端应优先按 `type` 和 `impact` 使用本地化 dictionary 展示推荐理由。
- 推荐解释中的 `cluster.label` / `cluster.displayLabel` 使用兴趣簇显示标签，优先级为 `manualLabel > autoLabel > interest_clusters.label > 兴趣簇 #N`。
- `cluster.displayIndex` 是 fallback 编号的稳定来源。

## Auth

### GET /api/auth/session

查询当前 session 和首次设置状态。

响应：

```json
{
  "data": {
    "setupCompleted": true,
    "authenticated": true
  }
}
```

### POST /api/auth/setup

首次启动设置访问密码。

请求：

```json
{
  "password": "string"
}
```

响应：

```json
{
  "data": {
    "ok": true
  }
}
```

错误：

- `CONFLICT`: 已完成 setup。
- `VALIDATION_ERROR`: 密码不符合要求。

### POST /api/auth/login

登录。

请求：

```json
{
  "password": "string"
}
```

响应：

```json
{
  "data": {
    "ok": true
  }
}
```

### POST /api/auth/logout

退出登录。

响应：

```json
{
  "data": {
    "ok": true
  }
}
```

## Setup

### GET /api/setup/status

用于首次设置向导。

响应：

```json
{
  "data": {
    "setupCompleted": false,
    "hasFeeds": false,
    "hasEmbeddingProvider": false,
    "firstRefreshStatus": "idle"
  }
}
```

`firstRefreshStatus`：

- `hasEmbeddingProvider` 为真实状态：存在已启用 provider 且存在 active embedding index 时为 `true`。
- 有 active embedding index 时，`recommended` 可使用 Ranking v1；无 provider、无 embedding、无画像或 provider 失败时继续 fallback 到 baseline ranking。

```text
idle
running
succeeded
failed
```

## Feeds

### GET /api/feed-folders

获取订阅源分组。

响应：

```json
{
  "data": [
    {
      "id": "folder_01",
      "title": "科技",
      "sortOrder": 0
    }
  ]
}
```

### POST /api/feed-folders

创建分组。

请求：

```json
{
  "title": "科技"
}
```

响应：

```json
{
  "data": {
    "id": "folder_01",
    "title": "科技",
    "sortOrder": 0
  }
}
```

### PATCH /api/feed-folders/:id

更新分组。

请求：

```json
{
  "title": "设计",
  "sortOrder": 2
}
```

响应：

```json
{
  "data": {
    "id": "folder_01",
    "title": "设计",
    "sortOrder": 2
  }
}
```

### DELETE /api/feed-folders/:id

删除分组。

说明：

- 删除分组不会删除 feeds。
- feeds 的 `folderId` 置为 `null`。

响应：

```json
{
  "data": {
    "ok": true
  }
}
```

### GET /api/feeds

获取订阅源列表。

查询参数：

```text
folderId
enabled=true|false
```

响应：

```json
{
  "data": [
    {
      "id": "feed_01",
      "folderId": "folder_01",
      "title": "The Verge",
      "siteUrl": "https://www.theverge.com",
      "feedUrl": "https://www.theverge.com/rss/index.xml",
      "description": null,
      "enabled": true,
      "fullContentMode": "feed_only",
      "sourceWeight": 0,
      "lastFetchedAt": null,
      "lastSuccessAt": null,
      "nextRefreshAt": null,
      "lastError": null,
      "createdAt": "2026-05-14T12:00:00.000Z",
      "updatedAt": "2026-05-14T12:00:00.000Z"
    }
  ]
}
```

### POST /api/feeds/discover

添加前预检网站或 RSS / Atom URL。

说明：

- 需要认证。
- 不写数据库。
- 不创建 feed。
- 不 enqueue jobs。
- 输入必须是 `http` / `https` URL，会去除 hash 并规范化。
- 系统会先尝试把输入直接解析为 RSS / Atom；如果不是 feed，再把它当作 HTML 页面解析 `<link rel="alternate">`。
- 支持 `application/rss+xml`、`application/atom+xml`、`application/xml`、`text/xml` 的 alternate link，支持相对 URL 和属性顺序变化。
- 页面没有声明 feed 时，会尝试 `/feed`、`/feed.xml`、`/rss`、`/rss.xml`、`/atom.xml`、`/index.xml`，最多 6 个常见路径。
- 预检候选会返回 `valid`、`duplicate` 或 `invalid`。`duplicate` 表示该 `feedUrl` 已订阅，前端不应再次调用 `POST /api/feeds`。
- URL 格式错误返回 `400 VALIDATION_ERROR`。输入 URL 完全无法抓取可返回 `502 PROVIDER_ERROR`。候选 feed 抓取或解析失败通常返回 `200`，并在 candidate 上标记 `invalid` 与 `error`。

请求：

```json
{
  "url": "https://example.com"
}
```

响应：

```json
{
  "data": {
    "inputUrl": "https://example.com",
    "normalizedUrl": "https://example.com/",
    "inputKind": "html",
    "candidates": [
      {
        "feedUrl": "https://example.com/feed.xml",
        "title": "Example Feed",
        "siteUrl": "https://example.com/",
        "description": "Example description",
        "format": "rss",
        "status": "valid",
        "existingFeedId": null,
        "itemCount": 12,
        "recentItems": [
          {
            "title": "Latest post",
            "url": "https://example.com/latest",
            "publishedAt": "2026-05-23T00:00:00.000Z"
          }
        ],
        "error": null
      }
    ],
    "warnings": []
  }
}
```

### GET /api/feeds/diagnostics

读取订阅源健康诊断。

说明：

- 需要认证。
- 只读，不写数据库。
- 不 enqueue jobs。
- 健康状态基于 `enabled`、`lastFetchedAt`、`lastSuccessAt`、`nextRefreshAt`、`lastError` 计算，不新增数据库字段。
- 状态包括 `healthy`、`never_fetched`、`due`、`stale`、`failing`、`disabled`。
- `stale` 表示最近成功超过 7 天且已到下次抓取时间。
- `failing` 优先级高于 `never_fetched`、`due`、`stale`，因为 `lastError` 是用户最需要看到的状态。

响应：

```json
{
  "data": {
    "summary": {
      "total": 10,
      "enabled": 9,
      "healthy": 7,
      "warning": 1,
      "error": 1,
      "disabled": 1,
      "neverFetched": 1
    },
    "items": [
      {
        "feed": {
          "id": "feed_01",
          "title": "Example",
          "feedUrl": "https://example.com/feed.xml",
          "siteUrl": "https://example.com",
          "enabled": true
        },
        "diagnostic": {
          "feedId": "feed_01",
          "status": "failing",
          "severity": "error",
          "code": "FETCH_FAILED",
          "message": "The latest feed fetch failed.",
          "lastFetchedAt": "2026-05-23T00:00:00.000Z",
          "lastSuccessAt": "2026-05-20T00:00:00.000Z",
          "nextRefreshAt": "2026-05-23T01:00:00.000Z",
          "lastError": "Feed parse failed"
        }
      }
    ]
  }
}
```

### POST /api/feeds

添加 RSS / Atom 订阅源。

说明：

- 保持兼容：调用方仍可直接传 `feedUrl` 添加订阅源。
- Web UI 默认先调用 `POST /api/feeds/discover`，用户确认候选后再把 `candidate.feedUrl` 传给本接口。
- 本接口会实际抓取、解析并写入 feed/articles。
- 新 feed 默认 `fullContentMode = "feed_only"`，不会请求文章网页 URL。
- 已存在的 `feedUrl` 会沿用当前 upsert 语义，恢复或更新该 feed，并同步刷新文章；前端应优先通过 discovery 的 `duplicate` 状态避免让用户重复添加。

请求：

```json
{
  "feedUrl": "https://example.com/feed.xml",
  "folderId": "folder_01"
}
```

`folderId` 可选。若传入非空值，目标 folder 必须存在，否则返回 `NOT_FOUND`。

响应：

```json
{
  "data": {
    "feed": {},
    "refreshJobId": "job_01"
  }
}
```

### PATCH /api/feeds/:id

更新订阅源。

请求：

```json
{
  "title": "Example",
  "folderId": null,
  "enabled": true,
  "fullContentMode": "fetch_full_content",
  "sourceWeight": 0.2
}
```

`sourceWeight` 范围为 `-1..1`。
`fullContentMode` 可为 `feed_only` 或 `fetch_full_content`。默认和推荐基线是 `feed_only`；只有显式设置为 `fetch_full_content` 后，后续刷新或当前 Feed 回溯才会请求文章网页全文。

响应：

```json
{
  "data": {
    "id": "feed_01",
    "folderId": null,
    "title": "Example",
    "siteUrl": "https://example.com",
    "feedUrl": "https://example.com/feed.xml",
    "description": null,
    "enabled": true,
    "fullContentMode": "fetch_full_content",
    "sourceWeight": 0.2,
    "lastFetchedAt": null,
    "lastSuccessAt": null,
    "nextRefreshAt": null,
    "lastError": null,
    "createdAt": "2026-05-14T12:00:00.000Z",
    "updatedAt": "2026-05-14T12:05:00.000Z"
  }
}
```

### POST /api/feeds/:id/full-content/preview

预览订阅源的网页全文抓取结果。

说明：

- 需要认证。
- 不写数据库，不更新 `article_contents`，不 enqueue jobs。
- 不传 `articleUrl` 时，重新读取当前 RSS / Atom 响应并取第一篇 item URL 预览。
- 只抓取 `http` / `https` HTML，不执行 JS，不使用 headless browser，不绕过付费墙，不下载图片。
- 抓取失败或内容太短时返回 `failed` 或 `skipped`；这不会影响现有 Feed 内容。

请求：

```json
{}
```

或：

```json
{
  "articleUrl": "https://example.com/post"
}
```

响应：

```json
{
  "data": {
    "feedId": "feed_01",
    "articleUrl": "https://example.com/post",
    "status": "success",
    "title": "Article title",
    "excerpt": "first 500 chars",
    "contentText": "extracted text",
    "contentHtml": "<p>extracted safe html</p>",
    "error": null
  }
}
```

### POST /api/feeds/:id/full-content/backfill-current

对当前 RSS / Atom 响应中仍出现的 items 执行网页全文抓取。

说明：

- 需要认证。
- 仅当 feed `fullContentMode = "fetch_full_content"` 时可用，否则返回 `409 VALIDATION_ERROR`。
- 只处理当前 RSS / Atom 响应中的前 50 篇 items；不会扫描该订阅源所有历史文章。
- 单篇抓取失败不中断整体回溯；失败/跳过文章保留 Feed 内容并记录 `extraction_status` / `extraction_error`。
- 全文成功会更新文章有效正文和 `articles.content_hash`；hash 变化会 enqueue embedding regeneration，并 enqueue ranking recalculation。
- 回溯是 content maintenance / corpus update：不写 `behavior_events`，不调用 article action，不作为用户偏好信号。若受影响文章存在历史行为，只能触发推荐维护重算，不伪造新行为。
- 内容变化后的 embedding、ranking 和 recommendation maintenance 副作用统一由 server/coordinator 层处理；feed refresh service 只返回 `effectiveContentChangedArticleIds`。

响应：

```json
{
  "data": {
    "feedId": "feed_01",
    "articlesSeen": 20,
    "attempted": 20,
    "succeeded": 15,
    "failed": 3,
    "skipped": 2,
    "articleIds": ["article_01"],
    "effectiveContentChangedArticleIds": ["article_01"],
    "limited": false
  }
}
```

### DELETE /api/feeds/:id

删除订阅源。

说明：

- MVP 使用软删除。
- 默认不立即物理删除历史文章。

响应：

```json
{
  "data": {
    "ok": true
  }
}
```

### POST /api/feeds/:id/refresh

手动刷新订阅源。

响应：

```json
{
  "data": {
    "jobId": "job_01"
  }
}
```

### POST /api/feeds/refresh

刷新所有已到期的启用订阅源。

说明：

- 只为未删除、`enabled = true` 且 `nextRefreshAt <= now` 的 feeds 创建 `feed_refresh` jobs；从未成功抓取的 feed 视为到期。
- 已有 queued/running `feed_refresh` job 的 feed 不重复创建 job，返回既有 `jobId`。
- 单个 feed 的 `POST /api/feeds/:id/refresh` 不受 `nextRefreshAt` 限制，仍可手动立即刷新。
- 接口返回表示已加入刷新队列，不表示所有抓取已经完成。
- 单个 feed 抓取失败不会阻塞其他 feeds；失败记录在 `jobs.error` 和 feed 的 `lastError`。
- 抓取成功会更新 feed 的 `lastFetchedAt`、`lastSuccessAt`，并清空 `lastError`。
- 抓取失败会更新 feed 的 `lastFetchedAt`、`lastError`，保留 `lastSuccessAt`。
- `nextRefreshAt` 由后端根据 feed 的历史文章出现频率自动推导：默认 TTL 为 60 分钟，自动 TTL 只作用于仍使用默认 TTL 的 feed，并夹在 60 分钟到 24 小时之间。

响应：

```json
{
  "data": {
    "jobIds": ["job_01", "job_02"]
  }
}
```

## OPML

### POST /api/opml/import

导入 OPML。

请求：

```text
multipart/form-data
file=<opml file>
```

MVP 也接受 `application/xml` 请求体，便于本地自托管和自动化测试。

导入行为：

- 创建不存在的 feed folders。
- 创建不存在的 feeds。
- 已存在 `feedUrl` 的订阅源跳过，不重复创建。
- 不自动抓取 RSS 内容，不触发 feed refresh。
- 嵌套分组会扁平化为一层 folders，feed 归属最近的父分组。

响应：

```json
{
  "data": {
    "foldersCreated": 3,
    "feedsCreated": 42,
    "feedsSkipped": 5,
    "errors": []
  }
}
```

### GET /api/opml/export

导出 OPML。

响应：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">...</opml>
```

## Articles

### GET /api/articles

获取文章列表。

说明：

- `latest` 始终按发布时间/发现时间排序。
- `recommended` 在无 active embedding index 时使用 `rank_context = "base"`。
- 存在 active embedding index 时使用 active V2 rank context，例如 `rec_v2:embedding:cocoon_5:schema_2`；`recommended` 优先按该 context 的 `rerank_position asc`，缺失时 fallback 到 active/base score，避免推荐列表为空。
- `read_later` 默认使用 active rank context 个性化排序，缺 active 分数时 fallback 到 base rank，再 fallback 到 `read_later_at desc`；也可用 `sort` 手动切换加入时间或发布时间排序。
- `favorites` 不使用 rank 排序，默认按 `favorited_at desc`；可用 `sort` 显式切换。

查询参数：

```text
view=recommended|latest|favorites|read_later
feedId
folderId
status=unread|read|all
unreadOnly=true|false
todayOnly=true|false
limit
cursor
sort=favorited_desc|favorited_asc|ranked|read_later_desc|read_later_asc|published_desc|published_asc
```

`unreadOnly=true` 可用于 `latest` 与 `recommended`，只返回当前派生 `interactionStatus = "unseen"` 的文章。响应中的 `meta.unreadCount` 始终表示当前 view/source 条件下的真实未读总数，而不是当前分页返回数量。客户端可以在列表滚过产生 `impression`、点进文章产生 `open`、阅读进度产生 `read_progress` 后乐观更新该数字，同时保留当前已加载队列，避免用户在未读模式中误划过或点进后丢失当前文章。

`todayOnly=true` 可用于 `latest` 与 `recommended`，按服务端本地日期筛选 `publishedAt ?? discoveredAt` 落在当天的文章。与 `unreadOnly` 同时启用时，先形成当前 view/source/今日候选集，再返回其中未读文章；`meta.unreadCount` 也遵循相同的今日/source 条件。

`sort` 仅定义 `favorites` 与 `read_later` view 的排序语义；非法值返回 `VALIDATION_ERROR`。

- `favorites`: `favorited_desc` 默认、`favorited_asc`、`published_desc`、`published_asc`。
- `read_later`: `ranked` 默认、`read_later_desc`、`read_later_asc`、`published_desc`、`published_asc`。

响应：

```json
{
  "data": [
    {
      "id": "article_01",
      "feedId": "feed_01",
      "feedTitle": "The Verge",
      "title": "Example article",
      "url": "https://example.com/a",
      "author": null,
      "summary": "Short summary",
      "publishedAt": "2026-05-14T08:00:00.000Z",
      "discoveredAt": "2026-05-14T08:05:00.000Z",
      "state": {
        "read": false,
        "favorited": false,
        "liked": false,
        "readLater": false,
        "hidden": false,
        "notInterested": false,
        "readingProgress": 0
      },
      "rank": {
        "score": 0.82,
        "calculatedAt": "2026-05-14T08:10:00.000Z"
      }
    }
  ],
  "page": {
    "nextCursor": null
  },
  "meta": {
    "unreadCount": 42
  }
}
```

### GET /api/articles/:id

获取文章详情。

响应：

```json
{
  "data": {
    "id": "article_01",
    "feedId": "feed_01",
    "feedTitle": "The Verge",
    "title": "Example article",
    "url": "https://example.com/a",
    "author": null,
    "summary": "Short summary",
    "publishedAt": "2026-05-14T08:00:00.000Z",
    "discoveredAt": "2026-05-14T08:05:00.000Z",
    "contentHtml": "<p>...</p>",
    "contentText": "...",
    "extractionStatus": "success",
    "extractionError": null,
    "state": {
      "read": false,
      "favorited": false,
      "liked": false,
      "readLater": false,
      "hidden": false,
      "notInterested": false,
      "readingProgress": 0.35,
      "interactionStatus": "reading",
      "openedAt": 1790000000000,
      "ignoredAt": null
    }
  }
}
```

### POST /api/articles/:id/actions

记录文章动作。

请求：

```json
{
  "type": "favorite",
  "value": true,
  "metadata": {}
}
```

`type` 可选值：

```text
impression
open
mark_read
mark_unread
favorite
unfavorite
like
unlike
read_later
remove_read_later
hide
not_interested
read_progress
```

说明：

- `interactionStatus="unseen"` 是唯一未读状态；`seen`/`saved`/`opened`/`reading`/`read` 都会移出未读筛选，但只有 `read` 表示已读。
- `saved` 表示 `favorited`、`liked` 或 `readLater` 至少一个为真；它可以与后续 `opened`、`reading`、`read` 的行为叠加。
- `impression` 表示文章在列表中被滚过但未点进。只有完全未触达文章会因此派生为 `ignored` 并产生轻度负向投影；已收藏、点赞、稍后读、打开、阅读或已有其他行为的文章收到 `impression` 时只保留中性曝光记录，不得变为 `ignored`。
- `open` 表示用户点进文章，是轻度正向行为。若一篇已忽略文章之后被点进，服务端会把 `interactionStatus` 派生回 `opened`。
- `read_progress` 是判断真实阅读深度的主要信号；前端不再提供“标记已读”按钮。
- `favorite`、`like`、`read_later`、`mark_read` 支持 `value: false`，服务端会分别规范化为 `unfavorite`、`unlike`、`remove_read_later`、`mark_unread`。
- 也可以直接发送 `unfavorite`、`unlike`、`remove_read_later`、`mark_unread`。
- `mark_read` / `mark_unread` 仅作为兼容旧客户端或未来批量管理的 API 保留，不是当前 Web 的主行为入口。
- `read_complete` 不作为 MVP 显式 API action；后续可由阅读进度或阅读时长派生。

`read_progress` 示例，`progress` 与 `value` 都可用，推荐新代码使用 `progress`：

```json
{
  "type": "read_progress",
  "progress": 0.72,
  "metadata": {
    "durationMs": 42000
  }
}
```

响应：

```json
{
  "data": {
    "state": {
      "read": true,
      "favorited": true,
      "liked": false,
      "readLater": false,
      "hidden": false,
      "notInterested": false,
      "readingProgress": 1,
      "interactionStatus": "read",
      "openedAt": 1790000000000,
      "ignoredAt": null
    }
  }
}
```

响应只返回最新 `state`；行为事件 ID 保留在服务端内部，不暴露给客户端。

### POST /api/reader/commands/mark-scope-read

Reader Command。将阅读器清账 scope 内的未读文章批量标记为已读。

该接口需要认证。

请求：

```json
{
  "scope": {
    "type": "article_list",
    "view": "latest",
    "feedId": "optional",
    "folderId": "optional",
    "clearWindow": "7d"
  }
}
```

搜索 scope：

```json
{
  "scope": {
    "type": "search",
    "q": "AI",
    "feedId": "optional",
    "folderId": "optional",
    "from": "2026-05-01",
    "to": "2026-05-23",
    "state": "all"
  }
}
```

响应：

```json
{
  "data": {
    "ok": true,
    "commandId": "cmd_...",
    "markedReadCount": 42
  }
}
```

语义约束：

- `mark_scope_read` 是 Reader Command，不是 Behavior Event。
- 它写入 `reader_command_events`，记录 command type、scope 和 result。
- 它不写入 `behavior_events`，不作为 `mark_read` 正反馈。
- 它不进入 profile event process，不更新兴趣簇，不触发强行为维护任务。
- 它会更新 `article_states.read_at`、`article_states.reading_progress=1`、`article_states.updated_at`。
- 它可以 enqueue ranking recalculation，使 read state 影响后续列表排序。
- 收藏、点赞、稍后读、不感兴趣等状态不会被清除。
- `article_list.clearWindow` 是清账债务窗口，不是阅读视图窗口；`24h` 表示清理 24 小时前的未读，`7d` 表示清理 7 天前的未读，`30d` 表示清理 30 天前的未读，`all` 表示全部未读。
- 当前批量操作只支持批量已读；不支持批量删除、批量收藏、批量不感兴趣。

校验：

- `scope.type` 必须是 `article_list` 或 `search`。
- `article_list.view` 只能是 `latest` 或 `recommended`。
- `article_list.clearWindow` 默认为 `all`，可选 `24h`、`7d`、`30d`；兼容旧 `timeWindow` 字段作为 alias，但主语义以 `clearWindow` 为准。
- `feedId` 与 `folderId` 不能同时传。
- `search.q` 必填，trim 后最长 256。
- `search.state` 默认为 `all`。
- `search.from` / `search.to` 支持 ISO 或 `YYYY-MM-DD`；`from > to` 返回 `VALIDATION_ERROR`。

### POST /api/reader/commands/mark-scope-read/preview

Reader Command preview。只计算同一个 scope 将会标记多少篇未读文章，不写入 `reader_command_events`，不更新 article state，不触发 ranking。

请求体与 `POST /api/reader/commands/mark-scope-read` 相同。

响应：

```json
{
  "data": {
    "ok": true,
    "markedReadCount": 42
  }
}
```

兼容 alias：

```text
POST /api/articles/bulk/mark-read
```

该 alias 只转发同一个 `ReaderCommandService`，不得直接更新 SQL。

### GET /api/articles/:id/explanation

获取推荐解释。

响应：

```json
{
  "data": {
    "articleId": "article_01",
    "reasons": [
      {
        "type": "interest",
        "label": "Interest match",
        "impact": "positive",
        "cluster": {
          "id": "cluster_01",
          "polarity": "positive",
          "label": "AI 编程代理",
          "displayLabel": "AI 编程代理",
          "labelSource": "manual",
          "autoLabel": "AI Agent / CLI / 本地模型",
          "manualLabel": "AI 编程代理",
          "confidence": 0.74,
          "topTerms": ["AI", "Agent", "CLI"],
          "displayIndex": 1,
          "weight": 8,
          "sampleCount": 3,
          "similarity": 0.82,
          "lastMatchedAt": "2026-05-14T08:08:00.000Z",
          "updatedAt": "2026-05-14T08:09:00.000Z"
        }
      },
      {
        "type": "source",
        "label": "The Verge",
        "impact": "positive"
      },
      {
        "type": "freshness",
        "label": "Recent article",
        "impact": "positive"
      }
    ],
    "generatedAt": "2026-05-14T08:10:00.000Z"
  }
}
```

当推荐解释返回 cluster match 时，文案应使用 `displayLabel`。示例：`与你的兴趣簇「AI 编程代理」相似`。如果没有可用标签，前端可回退为 `与你的一个正向兴趣簇相似`。该接口不调用 LLM。

如果文章尚未精排：

```json
{
  "data": {
    "articleId": "article_01",
    "reasons": [
      {
        "type": "fallback",
        "label": "Ranking has not been calculated yet",
        "impact": "neutral"
      }
    ],
    "generatedAt": "2026-05-14T08:10:00.000Z"
  }
}
```

`reason.type` 当前可选：

```text
interest
source
freshness
state
fallback
negative
penalty
exploration
```

前端 UI 应按 `type` 和 `impact` 本地化展示文案；`label` 只作为可读提示或来源名，不应作为最终 UI 文案。
当 `type = "exploration"` 时，表示文章由较低信息茧房水平下的探索/破茧机制打捞进入推荐位置。

## Search

### GET /api/search

关键词搜索。

查询参数：

```text
q
feedId
folderId
from
to
state=all|unread|read|favorites|read_later
sort=relevance|recommended|latest
limit
cursor
```

参数说明：

- `q` 必填，trim 后至少 1 个字符，最大 256 字符。
- `feedId` / `folderId` 限定搜索来源。
- `from` / `to` 接受 ISO 8601 或 `YYYY-MM-DD`，按 `coalesce(publishedAt, discoveredAt)` 过滤；`from > to` 返回 `VALIDATION_ERROR`。
- `state` 默认 `all`；`unread` 使用文章列表同一未读语义，`favorites` 对应收藏，`read_later` 对应稍后读。
- `sort` 默认 `relevance`。

排序语义：

- `relevance`：先按关键词相关性，再按当前推荐分 / rerank position，再按发布时间。
- `recommended`：先用关键词搜索召回候选文章，再只在命中候选内部按当前 active rank context 排序；不会扩大到非关键词命中的推荐文章。缺少 active rank score 时 fallback 到 base rank score、搜索相关性和发布时间。
- `latest`：先用关键词搜索召回候选文章，再按 `coalesce(publishedAt, discoveredAt)` 倒序，之后 fallback 到搜索相关性。

响应同 `GET /api/articles`：

```json
{
  "data": [ArticleListItem],
  "page": {
    "nextCursor": "string-or-null"
  },
  "meta": {
    "unreadCount": 12
  }
}
```

`meta.unreadCount` 表示同一搜索条件下的未读匹配数。Search v0 使用 SQLite FTS5 + CJK/短词 LIKE fallback，不引入 Meilisearch、Typesense、Tantivy 或额外搜索服务。

## Settings

### GET /api/settings

获取设置。

响应：

```json
{
  "data": {
    "ui": {
      "locale": "zh-CN",
      "defaultHomeView": "recommended"
    },
    "reader": {
      "fontSize": 18,
      "lineHeight": 1.75,
      "paragraphGap": 1.1,
      "readerWidth": 720,
      "theme": "paper"
    },
    "behavior": {
      "markScrolledArticlesIgnored": true,
      "removeReadLaterOnReadComplete": false
    },
    "retention": {
      "retentionDays": 0,
      "keepFavorites": true,
      "keepReadLater": true
    },
    "ranking": {
      "preferFreshness": 0.5,
      "preferSource": 0.5,
      "preferDiversity": 0.5
    },
    "recommendationMaintenance": {
      "maintenanceEnabled": true,
      "recentIntentAutoRebuildEnabled": true,
      "keywordAutoRebuildEnabled": true,
      "duplicateAutoRebuildEnabled": true,
      "clusterLabelAutoRebuildEnabled": true,
      "clusterMergeDiagnosticsEnabled": true,
      "clusterAutoMergeEnabled": false,
      "ftrlAutoTrainEnabled": true,
      "ftrlAutoPromoteEnabled": false,
      "evaluationAutoRunEnabled": false,
      "evaluationAutoRunIntervalDays": 7,
      "embeddingHealthAutoBackfillEnabled": true
    }
  }
}
```

### PATCH /api/settings

更新设置。

请求是严格 partial merge：

- 只更新请求中出现的字段。
- 未出现字段保持原值；如果原值缺失或非法，使用默认值。
- 任意未知字段、不可写字段、类型错误或越界值返回 `VALIDATION_ERROR`。
- API 字段 `retention.retentionDays` 持久化到 storage key `retention.articleDays`。
- `retention.retentionDays = 0` 表示永久保留普通文章，后台 retention cleanup 不会清理旧文章。
- 当 `retention.retentionDays` 从永久保留改为正数、或被调小、或收藏/稍后读保留开关从 `true` 改为 `false` 时，API 会 enqueue 一个 deduped `retention_cleanup` job；保存设置请求不会同步删除文章。
- `ui.defaultHomeView` 可为 `recommended` 或 `latest`，控制进入 reader 后默认打开的首页视图。
- `retention.keepFavorites` 和 `retention.keepReadLater` 控制 retention cleanup 是否永久保留收藏/稍后读文章，默认均为 `true`。
- `behavior.markScrolledArticlesIgnored` 控制最新 / 推荐列表中“滚过未打开文章 -> 已忽略”的自动行为记录。
- `behavior.removeReadLaterOnReadComplete` 控制稍后读文章触发完读后是否自动移出稍后读；当前完读阈值为 `read_progress >= 0.9` 或兼容 action `mark_read`。自动移出只更新文章状态，不额外写入 `remove_read_later` 行为事件。
- `ranking.cocoonLevel`、`ranking.localLearningEnabled`、`ranking.localLearningShadowMode`、`ranking.explorationEnabled`、`ranking.evaluationEnabled` 实际变化时会 enqueue 一个 deduped `ranking_recalculate` job；reader/behavior/retention 变化不会触发 ranking job。
- `recommendationMaintenance` 存储在 `recommendation.maintenanceSettings`，控制推荐自动维护调度；默认 `maintenanceEnabled=true`、`clusterLabelAutoRebuildEnabled=true`、`clusterMergeDiagnosticsEnabled=true`、`clusterAutoMergeEnabled=false`、`ftrlAutoPromoteEnabled=false`、`evaluationAutoRunEnabled=false`。
- settings 变化不会触发 `embedding_generate`、FTS rebuild 或 vector index rebuild。

请求：

```json
{
  "ui": {
    "locale": "en-US",
    "defaultHomeView": "latest"
  },
  "reader": {
    "fontSize": 19,
    "lineHeight": 1.8
  },
  "behavior": {
    "markScrolledArticlesIgnored": true,
    "removeReadLaterOnReadComplete": false
  },
  "retention": {
    "retentionDays": 90
  }
}
```

响应：

```json
{
  "data": {
    "ok": true,
    "rankingRecalculateQueued": true,
    "rankingRecalculateJobId": "job_rank_...",
    "retentionCleanupQueued": true,
    "retentionCleanupJobId": "job_...",
    "settings": {
      "ui": {
        "locale": "en-US",
        "defaultHomeView": "latest"
      },
      "reader": {
        "fontSize": 19,
        "lineHeight": 1.8,
        "paragraphGap": 1.1,
        "readerWidth": 720,
        "theme": "paper"
      },
      "behavior": {
        "markScrolledArticlesIgnored": true,
        "removeReadLaterOnReadComplete": false
      },
      "retention": {
        "retentionDays": 90,
        "keepFavorites": false,
        "keepReadLater": true
      },
      "ranking": {
        "preferFreshness": 0.5,
        "preferSource": 0.5,
        "preferDiversity": 0.5,
        "cocoonLevel": 7,
        "localLearningEnabled": true,
        "localLearningShadowMode": false,
        "explorationEnabled": true,
        "evaluationEnabled": false
      }
    }
  }
}
```

## Embedding

当前 MVP 实现 `openai_compatible` 和 `ollama` provider。`custom_http`、`embedded_local`
保留为后续 adapter 扩展；本轮如果请求启用这些类型，API 返回
contract-shaped `VALIDATION_ERROR`。Web Settings 开放 OpenAI-compatible 和 Ollama。

Provider endpoint 约定：

- `openai_compatible`：`baseUrl` 填 API root，例如 `https://api.example.com/v1`；服务端会请求
  `${baseUrl}/embeddings`。
- `ollama`：`baseUrl` 填 Ollama root，例如 `http://127.0.0.1:11434`；服务端会请求
  `${baseUrl}/api/embed`。

API key 存储说明：MVP 单用户本地/自托管版本会把 key 保存在本机 SQLite
`embedding_providers.api_key_encrypted`，当前实现只是 `plain:v1` 编码，不是安全加密。
部署者应保护数据库文件和数据卷；后续如需要可引入外部密钥或系统 keychain。

### GET /api/embedding/providers

获取 provider 列表。

响应：

```json
{
  "data": [
    {
      "id": "provider_01",
      "type": "openai_compatible",
      "name": "OpenAI Compatible",
      "baseUrl": "https://api.example.com/v1",
      "model": "text-embedding-3-small",
      "dimension": 1536,
      "enabled": true,
      "qualityTier": "best_quality",
      "hasApiKey": true,
      "lastTestStatus": "success",
      "lastTestError": null,
      "lastTestAt": "2026-05-14T08:00:00.000Z",
      "createdAt": "2026-05-14T08:00:00.000Z",
      "updatedAt": "2026-05-14T08:00:00.000Z"
    }
  ]
}
```

### POST /api/embedding/providers

创建 provider。

请求：

```json
{
  "type": "openai_compatible",
  "name": "My Provider",
  "baseUrl": "https://api.example.com/v1",
  "model": "text-embedding-3-small",
  "dimension": 1536,
  "apiKey": "secret",
  "enabled": true
}
```

约束：

- `type` 必须是 `openai_compatible` 或 `ollama` 才能启用。
- OpenAI-compatible `baseUrl` 应填写 API root，例如 `https://api.example.com/v1`；可以带 `/v1/` 尾斜杠。
- Ollama `baseUrl` 应填写 Ollama root，例如 `http://127.0.0.1:11434`；可以带尾斜杠。
- OpenAI-compatible `baseUrl` 不应填写到 `/embeddings`；Ollama `baseUrl` 不应填写到 `/api/embed`，否则返回 `VALIDATION_ERROR`。
- 创建或更新为 `enabled:true` 时，服务端会事务化停用其他 provider，并为当前模型/维度创建 active index。

响应：

```json
{
  "data": {
    "id": "provider_01"
  }
}
```

### PATCH /api/embedding/providers/:id

更新 provider。

请求：

```json
{
  "name": "OpenAI Compatible",
  "enabled": true
}
```

响应为更新后的 provider，不返回 `apiKey` 明文。

### DELETE /api/embedding/providers/:id

删除 provider。

约束：

- 如果 provider 仍有关联任何 embedding index，返回 `CONFLICT`。
- 无 index 时才物理删除。
- 用户需要停用 provider 时使用 `PATCH enabled=false`。

### POST /api/embedding/providers/:id/test

测试 provider。

响应成功：

```json
{
  "data": {
    "status": "success",
    "dimension": 1536,
    "latencyMs": 320
  }
}
```

响应失败：

```json
{
  "error": {
    "code": "PROVIDER_ERROR",
    "message": "Provider request failed",
    "details": {
      "status": 401
    }
  }
}
```

### GET /api/embedding/indexes

获取 embedding index 列表。

响应：

```json
{
  "data": [
    {
      "id": "index_01",
      "providerId": "provider_01",
      "model": "text-embedding-3-small",
      "dimension": 1536,
      "distanceMetric": "cosine",
      "status": "active",
      "candidateCount": 120,
      "eligibleArticleCount": 120,
      "missingEmbeddingCount": 70,
      "staleEmbeddingCount": 8,
      "coveredArticleCount": 42,
      "embeddingCount": 42,
      "coverageRatio": 0.35,
      "pendingJobs": 2,
      "failedJobs": 1,
      "lastFailedAt": "2026-05-14T08:10:00.000Z",
      "lastError": "Provider request failed",
      "createdAt": "2026-05-14T08:00:00.000Z",
      "updatedAt": "2026-05-14T08:00:00.000Z"
    }
  ]
}
```

新增 coverage 字段与 `/api/recommendation/status.coverage` 定义一致：

- `candidateCount` 表示当前可生成 embedding 的文章数：feed enabled、feed 未删除、article 未删除/未 retention-deleted，并且 title/summary/content_text 至少有一个非空文本。
- `candidateCount` 不排除 hidden/not_interested；它表示 embedding 生成候选，不是推荐列表候选。
- `eligibleArticleCount` 是 D 包新增的 backfill 诊断字段，当前与 `candidateCount` 同义，用于明确 backfill 可观察总量。
- `missingEmbeddingCount` 表示 eligible articles 中当前 index 没有 embedding 的数量。
- `staleEmbeddingCount` 表示 eligible articles 中当前 index 的 embedding `content_hash` 与文章当前 hash 不一致的数量。
- `coveredArticleCount` 表示 eligible articles 中当前 index 已有 embedding 且 `content_hash` 仍匹配的数量。
- `embeddingCount` 表示当前 index 的 embedding authority table 总量，可能包含已删除、已停用来源或不再 eligible 的历史文章，因此可能大于 `candidateCount`。
- `coverageRatio = coveredArticleCount / candidateCount`；`candidateCount = 0` 时为 `0`。
- `failedJobs/lastFailedAt/lastError` 只统计仍对应 missing/stale eligible article 的 actionable failed `embedding_generate` job；已被后续 backfill 修复的历史失败可在 jobs 列表中查看，但不再使推荐状态降级。

`embedding_indexes` 不保存错误字段；具体错误记录在 `jobs.error` 或 provider
`lastTestError`。

### POST /api/embedding/indexes/:id/rebuild

重建 sqlite-vec 索引。该操作只从 `article_embeddings` authority table 重建本地 sqlite-vec 表，不调用 embedding provider，也不重新生成 embedding。

响应：

```json
{
  "data": {
    "jobId": "job_01"
  }
}
```

### POST /api/embedding/indexes/:id/backfill

为 active embedding index 手动补齐缺失或 stale content hash 的文章 embedding。

响应：

```json
{
  "data": {
    "jobIds": ["job_01"],
    "candidateCount": 78,
    "enqueuedArticleCount": 64,
    "dedupedArticleCount": 14
  }
}
```

约束：

- 只允许 `status = "active"` 的 index；retired/failed/building/disabled 返回 `CONFLICT`。
- 只 enqueue missing/stale content hash 候选。
- 只对 queued/running open `embedding_generate` jobs 去重。
- 与 rebuild 语义分离：backfill 可能调用 provider；rebuild 不调用 provider。

### embedding_generate job payload

内部 job payload：

```json
{
  "embeddingIndexId": "index_01",
  "articleIds": ["article_01"]
}
```

约束：

- `articleIds` 长度为 `1..16`；OpenAI-compatible 默认按 16 入队，Ollama 默认按 4 入队。
- payload 运行时严格校验，非法 payload 直接 failed，不重试。
- 只处理未删除文章、未删除且启用的 feed、有可 embedding 文本的文章。
- 当前 index 已有 embedding 且 `content_hash` 未变化时跳过。
- retention-deleted article 即使出现在 payload 中也会被过滤。
- 只对 queued/running open jobs 做去重；历史 succeeded job 不阻止内容变化后的重新 embedding。

## Jobs

### GET /api/jobs

获取只读任务列表。该接口需要认证。

查询参数：

```text
status=queued|running|succeeded|failed|cancelled
type=feed_refresh|content_extract|embedding_generate|profile_event_process|ranking_recalculate|profile_decay|retention_cleanup|vector_index_rebuild
limit
```

默认 `limit = 50`，最大 `limit = 100`。不支持 cursor。

响应：

```json
{
  "data": [
    {
      "id": "job_01",
      "type": "feed_refresh",
      "status": "running",
      "attempts": 1,
      "maxAttempts": 3,
      "runAfter": "2026-05-14T08:00:00.000Z",
      "startedAt": "2026-05-14T08:00:05.000Z",
      "finishedAt": null,
      "error": null,
      "createdAt": "2026-05-14T08:00:00.000Z",
      "updatedAt": "2026-05-14T08:00:05.000Z",
      "payloadSummary": null
    },
    {
      "id": "job_02",
      "type": "embedding_generate",
      "status": "failed",
      "attempts": 3,
      "maxAttempts": 3,
      "runAfter": "2026-05-14T08:00:00.000Z",
      "startedAt": "2026-05-14T08:00:05.000Z",
      "finishedAt": "2026-05-14T08:00:10.000Z",
      "error": "Provider request failed",
      "createdAt": "2026-05-14T08:00:00.000Z",
      "updatedAt": "2026-05-14T08:00:10.000Z",
      "payloadSummary": {
        "embeddingIndexId": "index_01",
        "articleCount": 12
      }
    }
  ]
}
```

脱敏约束：

- 不返回 `payloadJson`。
- 不返回正文、API key、session token 或 embedding vectors。
- `embedding_generate` job 只暴露 `embeddingIndexId` 和 `articleCount`。
- 其他 job 的 `payloadSummary` 当前返回 `null`。

### POST /api/jobs/:id/retry

Planned / not implemented. 当前版本不提供 retry API。

当前请求会命中通用 404：

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found"
  }
}
```

## Recommendation Diagnostics

### GET /api/recommendation/status

获取推荐系统只读诊断状态。该接口需要认证，字段名作为 diagnostics v0 稳定 contract。

Query:

- `includeClusterItems`: optional boolean，默认 `true`。设为 `false` 时仍返回推荐模式、coverage、行为计数、兴趣簇数量、ranking 计数和 warning，但 `clusters.items` 固定为空数组。普通阅读页状态条应使用 `includeClusterItems=false`，避免在用户阅读或点按钮路径中触发重型透明页 cluster 诊断。

响应：

```json
{
  "data": {
    "mode": "embedding",
    "activeProvider": {
      "id": "provider_01",
      "type": "openai_compatible",
      "name": "OpenAI Compatible",
      "model": "text-embedding-3-small",
      "dimension": 1536,
      "lastTestStatus": "success",
      "lastTestAt": "2026-05-14T08:00:00.000Z"
    },
    "activeIndex": {
      "id": "index_01",
      "status": "active",
      "model": "text-embedding-3-small",
      "dimension": 1536
    },
    "activeRankContext": "index_01",
    "coverage": {
      "candidateCount": 120,
      "eligibleArticleCount": 120,
      "missingEmbeddingCount": 78,
      "staleEmbeddingCount": 0,
      "coveredArticleCount": 42,
      "embeddingCount": 42,
      "coverageRatio": 0.35,
      "pendingJobs": 2,
      "failedJobs": 1,
      "lastFailedAt": "2026-05-14T08:10:00.000Z",
      "lastError": "Provider request failed"
    },
    "behaviorCounts": {
      "open": 9,
      "like": 2,
      "favorite": 1,
      "read_later": 1,
      "not_interested": 1
    },
    "clusters": {
      "positive": 2,
      "negative": 1,
      "items": [
        {
          "id": "cluster_01",
          "polarity": "positive",
          "label": "AI Agent / CLI / 本地模型",
          "displayLabel": "AI Agent / CLI / 本地模型",
          "labelSource": "keywords",
          "autoLabel": "AI Agent / CLI / 本地模型",
          "manualLabel": null,
          "confidence": 0.74,
          "evidenceCount": 8,
          "topTerms": ["AI", "Agent", "CLI"],
          "representativeArticles": [
            {
              "articleId": "article_01",
              "title": "AI Agent CLI for local model workflows",
              "feedTitle": "AI Engineering Notes",
              "eventType": "favorite",
              "confidence": 0.95,
              "similarity": 0.98
            }
          ],
          "feedTitles": ["AI Engineering Notes"],
          "labelDiagnostics": {
            "collision": false,
            "collisionGroupSize": 1,
            "lowConfidence": false
          },
          "mergeDiagnostics": {
            "candidateCount": 1,
            "topCandidate": {
              "candidateId": "merge_index_01_cluster_01_cluster_02",
              "otherClusterId": "cluster_02",
              "otherLabel": "AI Agent / 产品",
              "centroidSimilarity": 0.94,
              "labelJaccard": 0.7,
              "evidenceOverlap": 0.4,
              "mergeScore": 0.86,
              "recommendation": "review",
              "status": "open"
            }
          },
          "lastGeneratedAt": "2026-05-14T08:07:00.000Z",
          "displayIndex": 1,
          "weight": 8,
          "sampleCount": 3,
          "diagnostics": {
            "supportArticleCount": 3,
            "supportEventCount": 4,
            "sourceCount": 2,
            "strongSignalCount": 3,
            "strongSignalRatio": 0.75,
            "topSourceShare": 0.5,
            "averageSimilarity": 0.83,
            "maxSimilarity": 0.94,
            "overfitRisk": "low",
            "warnings": []
          },
          "lastMatchedAt": "2026-05-14T08:08:00.000Z",
          "updatedAt": "2026-05-14T08:09:00.000Z"
        }
      ]
    },
    "rankedArticles": {
      "base": 120,
      "active": 96
    },
    "lastProfileUpdate": "2026-05-14T08:09:00.000Z",
    "lastRankingUpdate": "2026-05-14T08:11:00.000Z",
    "warnings": [
      {
        "code": "EMBEDDING_PENDING",
        "message": "Embedding generation is still running or incomplete for the active index."
      }
    ]
  }
}
```

`mode` 可选值：

```text
baseline
personalized
embedding
degraded
```

`clusters.items[].diagnostics` 基于最近一批画像相关行为计算，用于排查兴趣簇是否可能过拟合：

- `supportArticleCount` / `supportEventCount`: 支撑该簇的文章与行为数量。
- `sourceCount`: 支撑文章覆盖的来源数量。
- `strongSignalRatio`: 强行为占比，`like`、`favorite`、`read_later`、`read_complete`、`hide`、`not_interested` 和高完成度 `read_progress` 计为强行为。
- `topSourceShare`: 最大来源在支撑行为中的占比。
- `averageSimilarity` / `maxSimilarity`: 支撑文章与簇中心的相似度。
- `overfitRisk`: `low`、`medium`、`high`。
- `warnings`: 机器码数组，可能包含 `OVERFIT_RISK_HIGH`、`HIGH_WEIGHT_LOW_SUPPORT`、`SINGLE_SOURCE_DOMINANT`、`TOP_SOURCE_DOMINANT`、`WEAK_SIGNAL_HEAVY`、`LOW_INTERNAL_SIMILARITY`。

诊断字段只用于解释与 QA，不直接修改兴趣簇。实际推荐命中仍要求文章与正向簇达到算法文档中的 `positive_interest_match_threshold`。

### Interest Cluster Labels

兴趣簇标签是 explainability metadata only。Cluster label generation is explainability metadata only. It does not change ranking, profile vectors, embedding, or user feedback.

自动标签来源：

- `interest_cluster_evidence` 中的 evidence articles。
- 同 polarity 的 `profile_terms`。
- article title / summary。
- feed title。

自动标签不使用 LLM、reranker、classifier、外部搜索服务或 embedding API。所有标签、关键词、代表文章和来源标题都存 SQLite `interest_cluster_labels`。

展示优先级：

```text
manual_label
> auto_label
> interest_clusters.label
> 兴趣簇 #N
```

`labelSource` 可选值：

```text
manual
keywords
representative_titles
feeds
fallback
```

标签词典：

- 默认词典来自 `apps/server/src/recommendation-label-lexicon.default.json`。
- 用户覆盖项存储在 `app_settings.recommendation.clusterLabelLexicon`。
- effective lexicon = default + add - remove。
- 标签词典更新只会 enqueue `interest_cluster_label_rebuild`；不会触发 ranking、embedding、FTS 或 vector rebuild。
- 如果已存覆盖项损坏或包含非法 regex，服务使用默认词典兜底，并在返回 payload 中暴露 warning；PATCH 新的非法 regex 返回 `400 VALIDATION_ERROR`。

标签质量诊断：

```ts
labelDiagnostics?: {
  collision: boolean
  collisionGroupSize: number
  lowConfidence: boolean
}
```

重复簇诊断摘要：

```ts
mergeDiagnostics?: {
  candidateCount: number
  topCandidate: {
    candidateId: string
    otherClusterId: string
    otherLabel: string
    centroidSimilarity: number
    labelJaccard: number
    evidenceOverlap: number
    mergeScore: number
    recommendation: "auto_merge" | "review" | "ignore"
    status: "open" | "merged" | "ignored" | "dismissed"
  } | null
}
```

### GET /api/recommendation/cluster-label-lexicon

读取默认词典、effective 词典和用户覆盖项。该接口需要认证。

响应：

```json
{
  "data": {
    "defaultVersion": 1,
    "effective": {
      "stopwords": ["article", "affiliation", "https"],
      "protectedTerms": ["AI", "LLM", "API"],
      "badTermPatterns": ["^https?$"]
    },
    "overrides": {
      "stopwordsAdd": [],
      "stopwordsRemove": [],
      "protectedTermsAdd": [],
      "protectedTermsRemove": [],
      "badTermPatternsAdd": [],
      "badTermPatternsRemove": []
    },
    "warnings": []
  }
}
```

### PATCH /api/recommendation/cluster-label-lexicon

局部更新用户覆盖项。该接口需要认证。

请求：

```json
{
  "stopwordsAdd": ["foo", "bar"],
  "stopwordsRemove": ["AI"],
  "protectedTermsAdd": ["邸报"],
  "protectedTermsRemove": [],
  "badTermPatternsAdd": [],
  "badTermPatternsRemove": []
}
```

验证：

- 每个数组最多 500 项。
- 单个普通词长度为 `1..64`。
- regex pattern 长度受限，并在写入前编译验证。
- 非法 regex 返回 `400 VALIDATION_ERROR`，服务不崩溃。

响应包含更新后的词典和 label rebuild job：

```json
{
  "data": {
    "defaultVersion": 1,
    "effective": {
      "stopwords": ["article", "affiliation", "foo"],
      "protectedTerms": ["AI", "LLM", "API", "邸报"],
      "badTermPatterns": ["^https?$"]
    },
    "overrides": {
      "stopwordsAdd": ["foo"],
      "stopwordsRemove": [],
      "protectedTermsAdd": ["邸报"],
      "protectedTermsRemove": [],
      "badTermPatternsAdd": [],
      "badTermPatternsRemove": []
    },
    "warnings": [],
    "rebuildJob": {
      "jobId": "job_01",
      "existing": false
    }
  }
}
```

### PATCH /api/recommendation/clusters/:id/label

手动设置或清除兴趣簇显示名称。该接口需要认证，只写 SQLite 标签表，不触发 embedding、ranking recalculation、cluster merge 或 centroid 更新。

请求：

```json
{
  "manualLabel": "AI 编程代理"
}
```

清除手动名称：

```json
{
  "manualLabel": null
}
```

验证：

- cluster 不存在返回 `404 NOT_FOUND`。
- `manualLabel` trim 后必须为 `1..30` 字符，或为 `null`。
- 空字符串按 `null` 处理，恢复自动标签。

响应：

```json
{
  "data": {
    "ok": true,
    "clusterId": "cluster_01",
    "displayLabel": "AI 编程代理",
    "labelSource": "manual"
  }
}
```

### Interest Cluster Label Quality and Merge Diagnostics

Label rebuild is explainability metadata only.
Merge diagnostics is read-only.
Cluster merge changes user profile and therefore recalculates ranking.

Duplicate-interest diagnostics compare only active embedding index clusters with the same polarity. Different polarity clusters are never merged. Negative cluster recommendations use stricter thresholds than positive clusters.

Candidate rows expose:

```ts
{
  id: string
  embeddingIndexId: string
  leftClusterId: string
  rightClusterId: string
  polarity: "positive" | "negative"
  centroidSimilarity: number
  labelJaccard: number
  evidenceOverlap: number
  representativeOverlap: number
  sourceOverlap: number
  mergeScore: number
  recommendation: "auto_merge" | "review" | "ignore"
  status: "open" | "merged" | "ignored" | "dismissed"
  leftLabel: string
  rightLabel: string
  reasonJson: string | null
  createdAt: number
  updatedAt: number
  decidedAt: number | null
}
```

### POST /api/recommendation/clusters/merge-candidates/rebuild

Enqueue `interest_cluster_merge_diagnostics`。该接口需要认证。Diagnostics job 只写 `interest_cluster_merge_candidates`，不修改 `interest_clusters`，不触发 ranking 或 embedding。

响应：

```json
{
  "data": {
    "jobId": "job_01",
    "existing": false
  }
}
```

### GET /api/recommendation/clusters/merge-candidates

列出重复兴趣簇候选。该接口需要认证。

查询参数：

```text
status=open|merged|ignored|dismissed|all
limit=1..100
```

响应：

```json
{
  "data": {
    "activeIndexId": "index_01",
    "candidates": [
      {
        "id": "merge_index_01_cluster_01_cluster_02",
        "embeddingIndexId": "index_01",
        "leftClusterId": "cluster_01",
        "rightClusterId": "cluster_02",
        "polarity": "positive",
        "centroidSimilarity": 0.94,
        "labelJaccard": 0.7,
        "evidenceOverlap": 0.4,
        "representativeOverlap": 0.2,
        "sourceOverlap": 0.3,
        "mergeScore": 0.86,
        "recommendation": "review",
        "status": "open",
        "leftLabel": "AI Agent / CLI",
        "rightLabel": "AI Agent / 产品",
        "reasonJson": "{}",
        "createdAt": 1770000000000,
        "updatedAt": 1770000000000,
        "decidedAt": null
      }
    ]
  }
}
```

### POST /api/recommendation/clusters/merge-candidates/:id/merge

手动合并一个 `open` candidate。该接口需要认证，可处理 `recommendation = "review"` 或 `"auto_merge"` 的候选。

行为：

- 选择 survivor：manual label 优先，其次更高 weight、sample count、updated_at。
- 合并 weight/sample_count/centroid。
- 迁移 `interest_cluster_evidence` 到 survivor。
- survivor 没有 manual label 且 merged-away 有 manual label 时迁移该 manual label。
- 删除 merged-away cluster，不删除文章，不删除用户行为。
- candidate 标记为 `merged`，`reason_json` 记录 survivor、merged-away 和 metrics。
- enqueue `interest_cluster_label_rebuild` 和 `ranking_recalculate`。

响应：

```json
{
  "data": {
    "ok": true,
    "candidateId": "merge_index_01_cluster_01_cluster_02",
    "survivorClusterId": "cluster_01",
    "mergedAwayClusterId": "cluster_02",
    "labelRebuild": {
      "jobId": "job_label",
      "existing": false
    },
    "rankingRecalculate": {
      "jobId": "job_rank",
      "existing": false
    }
  }
}
```

错误：

- candidate 不存在返回 `404 NOT_FOUND`。
- candidate 非 `open` 返回 `409 MERGE_CANDIDATE_NOT_OPEN`。
- candidate recommendation 不允许合并返回 `409 MERGE_CANDIDATE_NOT_MERGEABLE`。

### POST /api/recommendation/clusters/merge-candidates/:id/ignore

忽略一个 candidate。该接口需要认证。Ignore 只更新 candidate 状态，不修改 `interest_clusters`，不触发 ranking 或 embedding。

响应：

```json
{
  "data": {
    "ok": true,
    "candidateId": "merge_index_01_cluster_01_cluster_02",
    "status": "ignored"
  }
}
```

判定顺序：

- 无 active provider/index：`baseline`。
- active provider/index 存在，且有 failed embedding jobs、provider test failed 或 index failed：`degraded`。
- active provider/index 存在，且 pending jobs > 0 或 `coverageRatio < 1`：`embedding`。
- active provider/index 存在，coverage 已完成且无 provider/index/job 异常：`personalized`。
- profile/behavior 信号仍少时，`mode` 仍可为 `personalized`，并通过 `PROFILE_WARMUP` warning 表示画像仍处于冷启动。

`PROFILE_WARMUP` 表示当前实例的画像信号还在积累中。判定只统计会支撑画像的有效行为：`like`、`favorite`、`read_later`、`hide`、`not_interested`、`unlike`、`read_complete`，以及 `progress >= 0.5` 的 `read_progress`。`open`、`impression`、`progress < 0.5`、`quick_bounce`、`mark_read` / `mark_unread`、取消收藏/取消稍后读、以及批量清理产生的 read state 变化不解除 warmup。当前阈值为：有效画像信号至少 8 个、覆盖至少 5 篇文章、且 active index 下正向兴趣簇至少 2 个；任一不足都会返回 `PROFILE_WARMUP`。

`warnings[].code` 至少可能包含：

```text
NO_PROVIDER
EMBEDDING_PENDING
EMBEDDING_JOB_FAILED
PROVIDER_TEST_FAILED
PROFILE_WARMUP
```

脱敏约束：

- `activeProvider` 不返回 `apiKey`、`apiKeyEncrypted` 或 `hasApiKey`。
- `activeIndex` 不返回 sqlite-vec table name 或 vector 数据。
- 不返回正文、API key、session token、embedding vectors 或原始 job payload。

### GET /api/recommendation/transparency

返回推荐透明页所需的状态摘要。该接口复用 `/api/recommendation/status` 的字段，并额外返回：

```ts
{
  transparency: {
    currentFormula: string
    fallbackReason: string | null
    rankingCore: {
      usesRemoteLlm: false
      usesRemoteReranker: false
      usesExternalSearchService: false
      allowedRemoteDependency: "one embedding provider"
    }
    maintenance: {
      schemaMigration: "009_interest_cluster_merge_candidates"
      backfillState: string
      explanationAuthority: "article_rank_explanations"
      scoreAuthority: "article_rank_scores"
      automaticMaintenanceEnabled: boolean
      settings: {
        maintenanceEnabled: boolean
        recentIntentAutoRebuildEnabled: boolean
        keywordAutoRebuildEnabled: boolean
        duplicateAutoRebuildEnabled: boolean
        clusterLabelAutoRebuildEnabled: boolean
        clusterMergeDiagnosticsEnabled: boolean
        clusterAutoMergeEnabled: boolean
        ftrlAutoTrainEnabled: boolean
        ftrlAutoPromoteEnabled: boolean
        evaluationAutoRunEnabled: boolean
        evaluationAutoRunIntervalDays: number
        embeddingHealthAutoBackfillEnabled: boolean
      } | null
      schedule: Array<{
        taskKey: string
        lastEnqueuedAt: string | null
        lastCompletedAt: string | null
        lastSkippedReason: string | null
        lastJobId: string | null
        updatedAt: string
      }>
    }
    moduleStatus: {
      bm25ProfileTerms: "not_active" | "empty" | "stale" | "active"
      recentIntent: "missing" | "stale" | "active"
      ftrl: "disabled" | "shadow_no_samples" | "insufficient_samples" | "shadow_training" | "ready_to_promote" | "active_low_weight" | "active" | "auto_paused" | "retired" | "failed"
      exploration: "disabled" | "enabled_bonus_only" | "enabled_slots_active"
      evaluation: "unavailable" | "diagnostic_only" | "lightweight_replay_diagnostic" | "strict_replay"
      duplicate: "not_built" | "exact_scaffold" | "near_duplicate_active"
      evidence: "dynamic_fallback" | "reconstructed" | "live_evidence"
      stalePendingEmbeddingJobs: number
      failedRankingJobs: number
    }
    algorithmModules: Array<{
      id: string
      name: string
      status: "normal" | "warning" | "stopped" | "disabled"
      summary: string
    }>
    failureStates: Record<string, boolean>
  }
}
```

透明页必须能解释 fallback/running/failed/disabled 状态，而不是只展示正常态。色卡语义为：绿色 `normal`，黄色 `warning`，红色 `stopped`，灰色 `disabled`。

### Recommendation Maintenance APIs

以下接口均受 session auth 保护。会触发后台或本地维护任务的接口必须去重：如果已有同类 queued/running job，返回已有 job id，不重复入队。

```text
POST /api/recommendation/recalculate
POST /api/recommendation/backfill/fingerprints
POST /api/recommendation/rebuild-duplicates
POST /api/recommendation/rebuild-keywords
POST /api/recommendation/rebuild-recent-intent
POST /api/recommendation/rebuild-cluster-labels
GET /api/recommendation/cluster-label-lexicon
PATCH /api/recommendation/cluster-label-lexicon
POST /api/recommendation/clusters/merge-candidates/rebuild
GET /api/recommendation/clusters/merge-candidates
POST /api/recommendation/clusters/merge-candidates/:id/merge
POST /api/recommendation/clusters/merge-candidates/:id/ignore
POST /api/recommendation/evaluate
POST /api/recommendation/ftrl/reset
POST /api/recommendation/ftrl/promote
```

除 `ftrl/reset` 和 `ftrl/promote` 外的维护接口响应：

```json
{
  "data": {
    "jobId": "job_01",
    "existing": false
  }
}
```

`POST /api/recommendation/rebuild-cluster-labels` enqueue `interest_cluster_label_rebuild`。该 job 遍历 active embedding index 下的兴趣簇，重建 `auto_label`、`label_terms_json`、`representative_articles_json`、`feed_titles_json` 和 `confidence`，并保留已有 `manual_label`。它不调用 provider，不创建 `embedding_generate`，不创建 `ranking_recalculate`，不写 `article_rank_scores`。

`POST /api/recommendation/clusters/merge-candidates/rebuild` enqueue `interest_cluster_merge_diagnostics`。该 job 只写 merge candidate 诊断结果，不修改画像，不触发 ranking 或 embedding。

`POST /api/recommendation/clusters/merge-candidates/:id/merge` 是手动确认合并。它会修改 `interest_clusters` 和 `interest_cluster_evidence`，因此成功后 enqueue `interest_cluster_label_rebuild` 与 `ranking_recalculate`。

`POST /api/recommendation/clusters/merge-candidates/:id/ignore` 只更新 candidate 状态，不修改 cluster，不触发 ranking 或 embedding。

`POST /api/recommendation/ftrl/reset` 响应：

```json
{
  "data": {
    "ok": true
  }
}
```

`POST /api/recommendation/ftrl/promote` 响应：

```json
{
  "data": {
    "ok": true,
    "modelVersionId": "ftrl_schema_2",
    "sampleCount": 120,
    "highQualitySampleCount": 110,
    "blendAlpha": 0.1
  }
}
```

如果高质量样本不足 100，返回 `409` / `INSUFFICIENT_FTRL_SAMPLES`。该接口只切换本地 SQLite 中的模型状态，不调用外部服务，并把 active alpha 限制在安全上限内。

### Recommendation Automatic Maintenance Cycle

自动维护只在 `backgroundJobs=true` 的 server 进程启动，调度器只 enqueue job，不直接执行重任务。所有自动 enqueue 都检查 queued/running 同类 job；存在时返回/记录 existing，不重复创建。

默认设置：

```json
{
  "recommendationMaintenance": {
    "maintenanceEnabled": true,
    "recentIntentAutoRebuildEnabled": true,
    "keywordAutoRebuildEnabled": true,
    "duplicateAutoRebuildEnabled": true,
    "clusterLabelAutoRebuildEnabled": true,
    "clusterMergeDiagnosticsEnabled": true,
    "clusterAutoMergeEnabled": false,
    "ftrlAutoTrainEnabled": true,
    "ftrlAutoPromoteEnabled": false,
    "evaluationAutoRunEnabled": false,
    "evaluationAutoRunIntervalDays": 7,
    "embeddingHealthAutoBackfillEnabled": true
  }
}
```

周期：

- 实时：RSS refresh 后保留 embedding enqueue，并延迟 duplicate rebuild；embedding 完成后保留 profile/ranking；强行为后延迟 recent intent 和 FTRL train。
- 15 分钟：有强行为或未训练样本时 enqueue recent intent / FTRL。
- 每小时：recent intent、duplicate、embedding health；ranking 只在维护输出变脏后 enqueue。
- 每日：keyword profile、duplicate、recent intent、FTRL、cluster_label_daily、cluster_merge_diagnostics、ranking；`cluster_auto_merge` 只有在 `clusterAutoMergeEnabled=true` 时才入队。
- 每周：evaluation diagnostic，默认关闭。

影响排序：

- `recent_intent_rebuild`、`keyword_profile_rebuild`、`duplicate_group_rebuild`、`ftrl_train` 完成后会 enqueue deduped `ranking_recalculate`。
- `interest_cluster_label_rebuild` 是 explainability metadata only，不触发 ranking 或 embedding。
- `interest_cluster_merge_diagnostics` 是 read-only diagnostics，不触发 ranking 或 embedding。
- `interest_cluster_auto_merge` 默认关闭；开启并实际合并后才触发 ranking recalculation。
- `ranking_eval_run` 是 `lightweight_replay_diagnostic`，不触发 ranking/profile/FTRL 更新。
- FTRL active 是低权重渐进校准，alpha 起步 `0.05`，默认上限 `0.20`，不会替代基础公式。
- `view=latest` 不读取推荐分数，仍只按 latest 时间排序。

维护任务只操作本地 SQLite 派生数据，不调用远程 LLM、reranker、classifier 或外部搜索服务。

## System

## Plugins

插件 API 用于管理官方和第三方插件。第三方插件安装后默认不启用；启用时执行兼容性、权限、manifest migrations 和 server entry 预激活检查。服务端插件运行在独立 Node host 子进程中，通过 JSON-RPC Host API 调用核心能力；Web 插件运行在 sandboxed iframe 中。

插件开发文档：

- [插件开发指南](./plugin-development.zh-CN.md)
- [Plugin development guide](./plugin-development.en-US.md)
- [プラグイン開発ガイド](./plugin-development.ja-JP.md)

0.3 API 稳定层级：

- Stable：manifest v1、安装/启停/更新、settings、storage、secrets、deliveries、tasks、基础 hooks、iframe bridge、manifest migrations、network outbound、基础事件目录。
- Beta：`database.defineTable`、ranking、article snapshot/content、full-content extractor、diagnostics/recommendation transparency 类能力。

插件状态：

```text
installed
enabled
disabled
incompatible
failed
```

### GET /api/plugins

返回已发现和已安装插件。

响应：

```json
{
  "data": [
    {
      "id": "dev.example.reader-tools",
      "name": "Reader Tools",
      "version": "0.1.0",
      "publisher": "Example",
      "status": "installed",
      "sourceType": "local_file",
      "sourceUrl": null,
      "updateUrl": "https://example.com/latest.json",
      "official": false,
      "bundled": false,
      "trustLevel": "untrusted",
      "capabilities": ["articles:read"],
      "grantedCapabilities": [],
      "apiStability": {
        "stable": ["iframe.bridge", "lifecycle.installEnableDisableUpdate", "manifest.v1"],
        "beta": ["articles.snapshot"]
      },
      "contributes": {
        "settingsTabs": [],
        "tabs": [],
        "actions": [],
        "hooks": ["settings.afterUpdated"],
        "tasks": []
      },
      "installedAt": "2026-05-31T00:00:00.000Z",
      "updatedAt": "2026-05-31T00:00:00.000Z",
      "enabledAt": null,
      "disabledAt": null,
      "lastError": null
    }
  ]
}
```

### GET /api/plugins/catalog

返回随 Release 分发的官方插件。

### POST /api/plugins/install

从 URL 或插件包 JSON 安装。

请求：

```json
{
  "url": "https://example.com/plugin.dibao-plugin",
  "sha256": "optional"
}
```

或：

```json
{
  "package": "{\"manifest\":{\"manifestVersion\":1}}",
  "sha256": "optional"
}
```

### POST /api/plugins/install/upload

上传 `.dibao-plugin` 文件安装，使用 `multipart/form-data` 或原始 JSON body。

### POST /api/plugins/:id/enable

启用插件。启用时会校验 Dibao 版本兼容性、应用 manifest migrations、写入 capability grants，并预激活 server entry。预激活失败时插件状态变为 `failed`，返回错误。

### POST /api/plugins/:id/disable

停用插件。停用插件不会删除插件数据；会停止运行时贡献点并取消 queued/running 插件任务。

### POST /api/plugins/:id/update

读取插件 `updateUrl`，执行 metadata 检查、checksum 校验和 staged update。失败时保留旧包。

### DELETE /api/plugins/:id

卸载第三方插件。官方插件不能卸载。

查询参数：

- `deleteData=true`: 同时删除 `/data/plugins/data/<plugin-id>`。

### GET/PATCH /api/plugins/:id/settings

读取或更新插件命名空间 settings。PATCH body 必须是 JSON object。

### GET /api/plugins/:id/health

返回插件兼容性、状态、错误、capability 和 task 摘要。

### GET /api/plugins/:id/assets/*

读取插件包内静态资源。第三方 rich UI 通过 sandboxed iframe 加载这里的 asset。HTML asset 会带插件 CSP，禁止直接网络连接和表单提交；插件 UI 必须通过 bridge 访问宿主。

### POST /api/plugins/:id/tasks/:taskId

启动插件任务，返回 core job row。插件任务类型格式：

```text
plugin:<pluginId>:<taskId>
```

如果插件缺失对应 handler，任务会被延后重试，表现为可恢复的 plugin-paused 语义，不作为普通永久失败。

### GET /api/plugins/:id/tasks/:runId

读取插件任务运行状态。

### POST /api/plugins/:id/tasks/:runId/cancel

取消 queued/running 插件任务，状态变为 `cancelled`。

### GET /api/system/health

健康检查。

响应：

```json
{
  "data": {
    "ok": true,
    "database": "ok",
    "fts": "ok",
    "vectorStore": "ok",
    "version": "0.1.0"
  }
}
```

### GET /api/system/info

系统信息。

响应：

```json
{
  "data": {
    "version": "0.1.0",
    "dataDir": "/data",
    "databasePath": "/data/dibao.sqlite",
    "activeEmbeddingProvider": "provider_01",
    "activeEmbeddingIndex": "index_01"
  }
}
```

## API 验收标准

API 实现完成后，至少应通过：

- 未登录访问受保护接口返回 `UNAUTHORIZED`。
- 首次 setup 后不能重复 setup。
- OPML 导入和导出保持分组结构。
- 添加 feed 后创建刷新任务。
- 文章列表支持 recommended 和 latest。
- 文章 action 会同时写行为事件和当前状态。
- 推荐解释在未精排时返回 fallback reason。
- provider test 能明确返回成功或失败细节。
- index rebuild 返回任务 ID。
- 所有列表接口支持 limit 和 cursor。
