# 邸报 0.3 插件开发指南

Last updated: 2026-08-11

本文面向第三方插件开发者。邸报 0.3 的插件系统定位是“可信管理员安装的生态平台版”：插件可以扩展服务端任务、Hook、设置页、Web UI 和全文抓取器，但仍是可信本地代码，不承诺能安全运行任意恶意代码。

## 安全模型

- 服务端插件运行在独立 Node host 子进程中，通过 JSON-RPC 调用邸报白名单 Host API。
- 主进程不会把 `db`、`process`、Fastify `request/reply` 或内部 service 对象传给插件。
- Web 插件运行在 `sandbox="allow-scripts allow-forms"` iframe 中，不含 `allow-same-origin`。插件页面必须通过 `postMessage` bridge 访问宿主能力。
- 插件资产 HTML 带 CSP：禁止直接 `fetch`、表单提交和默认外部资源；允许内联脚本/样式和 `/api/plugins/ui.css`。
- 第三方上传安装仍可用，但默认不启用。管理员启用前应检查来源、签名信任、capabilities、Stable/Beta API 使用和服务端代码风险。

## Manifest v1

`.dibao-plugin` 当前是 JSON 包：

```json
{
  "manifest": {
    "manifestVersion": 1,
    "id": "dev.example.reader-tools",
    "name": "Reader Tools",
    "version": "0.1.0",
    "publisher": "Example",
    "dibao": { "minVersion": "0.3.0", "maxVersion": "<0.5.0" },
    "entry": { "server": "server/index.mjs", "web": "web/index.html" },
    "capabilities": ["settings:plugin", "files:plugin-data", "jobs:write"],
    "migrations": [
      {
        "version": "001",
        "name": "create_notes",
        "path": "migrations/001_create_notes.sql",
        "checksum": "可选 sha256"
      }
    ],
    "contributes": {
      "settingsTabs": [{ "id": "settings", "title": "Reader Tools", "slot": "settings.tabs", "route": "settings" }],
      "tabs": [],
      "routes": [],
      "actions": [],
      "hooks": ["maintenance.tick"],
      "events": [],
      "tasks": [{ "id": "readerTools.refresh", "kind": "background", "schedule": "manual" }]
    }
  },
  "files": {
    "server/index.mjs": "export default { async activate(ctx) {} }",
    "web/index.html": "<!doctype html><html></html>"
  },
  "updateUrl": "https://example.com/plugins/reader-tools/latest.json"
}
```

`id` 建议使用反向域名；`dibao.maxVersion` 建议写成 `<0.5.0`，避免未来 breaking API 自动启用。

### 插件本地化

从 0.3 起，manifest 中面向用户的字符串可以继续写普通字符串，也可以写成 locale map：

```json
{
  "name": { "zh-CN": "阅读工具", "en-US": "Reader Tools", "ja-JP": "リーダーツール" },
  "publisher": { "zh-CN": "示例", "en-US": "Example", "ja-JP": "Example" },
  "contributes": {
    "settingsTabs": [
      {
        "id": "settings",
        "title": { "zh-CN": "阅读工具", "en-US": "Reader Tools", "ja-JP": "リーダーツール" },
        "slot": "settings.tabs",
        "route": "settings"
      }
    ]
  }
}
```

邸报按当前语言解析 manifest 字符串，fallback 顺序为完整 locale、语言代码、`zh-CN`、`zh`、第一个可用值。Web 插件 iframe 会收到 `?locale=zh-CN|en-US|ja-JP` 参数，并可通过 bridge 方法 `getLocale` 读取当前语言。服务端插件启动时可读 `ctx.locale`；如果插件需要跟随运行中的语言切换，使用 `await ctx.i18n.getLocale()`。

## Capabilities

0.3 支持：

```text
articles:read
articles:write
feeds:read
feeds:write
ranking:read
ranking:write
settings:plugin
settings:core:read
settings:core:write
jobs:read
jobs:write
database:plugin
network:outbound
secrets:plugin
deliveries:read
deliveries:write
files:plugin-data
telemetry:emit
```

只声明实际需要的能力。`network:outbound` 受 SSRF 防护、大小限制、重定向限制和超时限制；敏感 header 应通过 `secrets:plugin` + deliveries secret headers 引用。

## API 稳定层级

Stable：

- manifest v1、安装/启用/禁用/更新生命周期
- `settings`、`storage`、`secrets`
- `tasks`、基础 `hooks`、`events.catalog`
- `deliveries`、`network.outbound`
- iframe bridge
- manifest 声明式 `migrations`

Beta：

- `database.defineTable` 便捷 API
- `ranking.*`
- `articles.snapshot/openableSummary/countDiscovered`
- `fullContent.extractor`
- diagnostics / recommendation transparency 类能力

Beta API 可在 0.3.x 中调整字段或语义。长期插件应把持久 schema 写成 manifest migrations，而不是只依赖 `database.defineTable`。

## 服务端入口

服务端入口导出 `activate(ctx)`。入口形式保持不变，但 Host API 是异步 JSON-RPC：

```js
export default {
  async activate(ctx) {
    ctx.hooks.on("maintenance.tick", async () => {
      await ctx.storage.set("lastTickAt", await ctx.now());
    });

    ctx.tasks.register("readerTools.refresh", async () => {
      await ctx.storage.set("lastRefreshAt", await ctx.now());
    });

    ctx.api.get("/state", async () => ({
      settings: await ctx.settings.list(),
      lastRefreshAt: await ctx.storage.get("lastRefreshAt")
    }));
  }
};
```

启用插件时邸报会预激活 server entry。激活失败会让插件保持 `failed`；禁用插件会停止贡献点并取消该插件未完成任务。缺失 task handler 的插件任务会延后重试，表现为可恢复的 plugin-paused 语义，而不是普通永久失败。

## 全文抓取器（Beta）

在 `contributes.fullContentExtractors` 声明 `id`、`title` 和可选 `order`，并在激活时注册同名 handler。已启用抓取器按 `order` 升序先于内置提取运行；返回格式错误、为空或正文过短时，会安全回退到内置提取器。

```js
ctx.fullContent.register("site-selector", ({ articleUrl, html, contentType }) => {
  if (!contentType.includes("html") || !html.includes("article-body")) return null;
  return { contentHtml: "<p>...</p>", contentText: "...", excerpt: "..." };
});
```

handler 只会收到已下载的页面内容；应返回已规范化的安全阅读 HTML 与文本，不应自行发起网络请求，并须尽快完成。超时会自动回退到内置提取器。

## 数据、Secrets 和 Deliveries

- `settings`：面向用户可配置项。
- `storage`：插件 KV 数据。
- `secrets`：加密保存敏感值，UI 和 delivery 记录不回显明文。
- `deliveries`：可重试的出站 HTTP 投递，适合 webhook。
- `network.fetch`：受控即时请求，适合测试连接，不适合热路径大量调用。

## 数据库迁移

推荐在 manifest 中声明 migrations。邸报记录 `plugin_id/version/name/checksum/applied_at`。同一 `version` 已应用后，如果 `name` 或 checksum 改变，启用会失败以避免历史 schema 漂移。

```json
{
  "capabilities": ["database:plugin"],
  "migrations": [
    { "version": "001", "name": "create_notes", "path": "migrations/001_create_notes.sql" }
  ]
}
```

已发布 migration 不要改写；新增版本继续追加。需要废弃 schema 时发布新的 cleanup migration。

## iframe Bridge

插件页面不能直接 `fetch("/api/...")`。使用 `postMessage`：

```js
function bridge(method, payload) {
  const requestId = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
  window.parent.postMessage({ type: "dibao.bridge", schemaVersion: 1, pluginId, requestId, method, payload }, "*");
}
```

常用方法：

- `pluginApi`: `{ method: "GET" | "POST", path, body }`
- `getAuthSession`
- `getSettings` / `updatePluginSettings`
- `listPluginSecrets` / `setPluginSecret` / `deletePluginSecret`
- `listPluginDeliveries` / `getPluginDelivery`
- `startTask`
- 阅读类 UI 可使用 `readArticles`、`getArticleState`、`recordArticleAction`、`getArticleExplanation`、`openArticle`

宿主会校验 iframe source、`pluginId` 和 `requestId`。

## CLI 流程

```sh
npm create dibao-plugin ./my-plugin
dibao-plugin validate ./my-plugin
dibao-plugin pack ./my-plugin --out my-plugin.dibao-plugin
dibao-plugin sign my-plugin.dibao-plugin \
  --private-key private.pem \
  --public-key public.pem \
  --key-id my-key \
  --out my-plugin.signed.dibao-plugin
```

模板包含 `server/`、`web/`、`locales/`、`migrations/`、README、release checklist、签名脚本示例和测试说明。

## 签名与 trusted keys

邸报使用 Ed25519 签名。签名覆盖 manifest、files 和 updateUrl 的稳定序列化 payload。管理员需要把公钥加入 trusted keys 后，签名包才会通过信任校验。不要在插件包中放私钥。

## Docker 持久化

挂载 `/data` 后，下列内容会随升级保留：

- `/data/plugins/installed`
- `/data/plugins/data/<plugin-id>`
- SQLite 表：`plugin_installs`、`plugin_capability_grants`、`plugin_settings`、`plugin_kv`、`plugin_migrations`、`plugin_update_checks`、`plugin_secrets`、`plugin_deliveries`

官方 Daily Brief、Webhook 和 Full Content Selectors 插件随 0.3.1 镜像扫描；第三方插件保留在数据卷中。

## 更新与回滚

`updateUrl` metadata 建议包含：

```json
{
  "pluginId": "dev.example.reader-tools",
  "latestVersion": "0.1.1",
  "packageUrl": "https://example.com/reader-tools-0.1.1.dibao-plugin",
  "sha256": "..."
}
```

邸报更新时会下载到 staging、校验 ID/兼容范围/checksum、替换安装目录；失败会回滚旧包。用户可以通过重新上传旧 `.dibao-plugin` 回滚。

## 发布 Checklist

- `dibao-plugin validate .` 通过。
- 服务端代码只使用已声明 capability。
- Web UI 在 sandbox iframe 中工作，所有宿主访问走 bridge。
- 已发布 migration 未被改写，新 schema 使用新 version。
- 包已签名，公钥和 keyId 可供管理员信任。
- README 写明安装、启用、设置、secrets、更新、回滚和限制。
- 手动测试安装、启用、禁用、任务、Hook、更新回滚。

## 测试 Checklist

- manifest/签名/篡改包拒绝。
- 启用预激活失败进入 `failed`。
- 缺 handler 任务可恢复延后。
- secrets 不回显明文；deliveries 可 flush 和重试。
- 出站网络不能访问私网/本机受限目标。
- iframe `sandbox` 存在，bridge 正常/异常请求都有响应。
