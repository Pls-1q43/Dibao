# Dibao 0.2 プラグイン開発ガイド

Last updated: 2026-06-18

この文書はサードパーティ開発者向けです。Dibao 0.2 のプラグイン system は「管理者が信頼してインストールするエコシステム版」です。プラグインは server task、hook、settings page、Web UI を拡張できますが、信頼済みローカルコードとして扱われます。任意の悪意あるコードを安全に実行できる sandbox ではありません。

## セキュリティモデル

- server plugin は独立した Node host 子プロセスで動作し、JSON-RPC Host API だけを呼び出します。
- main process は `db`、`process`、Fastify `request/reply`、内部 service を plugin に渡しません。
- Web plugin は `sandbox="allow-scripts allow-forms"` iframe で動作し、`allow-same-origin` は付与されません。
- plugin HTML には CSP が付きます。直接 `fetch`、form submit、既定の外部 resource は禁止されます。inline script/style と `/api/plugins/ui.css` は許可されます。
- サードパーティ upload install は残りますが、既定では無効です。有効化前に source、signature trust、capabilities、Stable/Beta API、server code risk を確認してください。

## Manifest v1

`.dibao-plugin` は JSON package です。

```json
{
  "manifest": {
    "manifestVersion": 1,
    "id": "dev.example.reader-tools",
    "name": "Reader Tools",
    "version": "0.1.0",
    "publisher": "Example",
    "dibao": { "minVersion": "0.2.0", "maxVersion": "<0.3.0" },
    "entry": { "server": "server/index.mjs", "web": "web/index.html" },
    "capabilities": ["settings:plugin", "files:plugin-data", "jobs:write"],
    "migrations": [
      { "version": "001", "name": "create_notes", "path": "migrations/001_create_notes.sql" }
    ],
    "contributes": {
      "settingsTabs": [{ "id": "settings", "title": "Reader Tools", "slot": "settings.tabs", "route": "settings" }],
      "hooks": ["maintenance.tick"],
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

`id` は reverse-domain 形式を推奨します。互換範囲は `<0.3.0` のように上限を明示してください。

### プラグインのローカライズ

0.3 以降、manifest のユーザー向け文字列は通常の string のままでも、locale map としても書けます。

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

Dibao は現在の UI locale で manifest string を解決します。fallback は exact locale、language code、`zh-CN`、`zh`、最初の利用可能な値の順です。Web plugin iframe には `?locale=zh-CN|en-US|ja-JP` query parameter が渡され、bridge method `getLocale` でも現在の言語を取得できます。server plugin は起動時 locale を `ctx.locale` で受け取ります。実行中の plugin が言語変更を追跡する場合は `await ctx.i18n.getLocale()` を使ってください。

## Capabilities

0.2 の capabilities:

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

必要最小限だけを宣言してください。`network:outbound` には SSRF protection、size limit、redirect limit、timeout があります。機密 header は `secrets:plugin` と delivery `secretHeaders` で参照してください。

## API 安定性

Stable:

- manifest v1、install/enable/disable/update lifecycle
- `settings`、`storage`、`secrets`
- `tasks`、basic `hooks`、`events.catalog`
- `deliveries`、`network.outbound`
- iframe bridge
- manifest migrations

Beta:

- `database.defineTable`
- `ranking.*`
- `articles.snapshot/openableSummary/countDiscovered`
- `fullContent.extractor`
- diagnostics / recommendation transparency APIs

Beta API は 0.2.x 中に field や semantics が変わる可能性があります。長期運用する plugin は durable schema を manifest migrations で管理してください。

## Server Entry

`activate(ctx)` を export します。entry shape は同じですが、Host API は asynchronous JSON-RPC です。

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

有効化時に server entry は pre-activate されます。失敗すると plugin は `failed` のままです。無効化すると contribution は停止し、未完了 plugin jobs は cancel されます。task handler がない場合は永久失敗ではなく、復旧可能な defer として扱われます。

## Full Content Extractor（Beta）

`contributes.fullContentExtractors` に `id`、`title`、任意の `order` を宣言し、activate 時に同じ ID の handler を登録します。有効な extractor は `order` 昇順で built-in extractor より先に実行されます。形式不正、空、または短すぎる結果は built-in extractor へ安全に fallback します。

```js
ctx.fullContent.register("site-selector", ({ articleUrl, html, contentType }) => {
  if (!contentType.includes("html") || !html.includes("article-body")) return null;
  return { contentHtml: "<p>...</p>", contentText: "...", excerpt: "..." };
});
```

handler に渡されるのはダウンロード済みのページ内容だけです。正規化済みの安全な reader HTML と text を返し、自身で network request を行わず、速やかに完了してください。timeout 時は built-in extractor に fallback します。

## Data、Secrets、Deliveries

- `settings`: user-facing configuration。
- `storage`: plugin KV data。
- `secrets`: 暗号化された secret。plaintext は UI や delivery record に返しません。
- `deliveries`: retryable outbound HTTP delivery。webhook に適しています。
- `network.fetch`: controlled immediate request。connection test 向けで、hot path 大量呼び出しには不向きです。

## Database Migrations

manifest に migrations を宣言してください。Dibao は `plugin_id/version/name/checksum/applied_at` を記録します。既に適用した `version` の `name` または checksum が変わると enable は失敗します。

```json
{
  "capabilities": ["database:plugin"],
  "migrations": [
    { "version": "001", "name": "create_notes", "path": "migrations/001_create_notes.sql" }
  ]
}
```

公開済み migration は書き換えず、変更や cleanup は新しい version として追加してください。

## iframe Bridge

plugin page は Dibao API を直接 `fetch` しません。`postMessage` bridge を使います。

```js
window.parent.postMessage({
  type: "dibao.bridge",
  schemaVersion: 1,
  pluginId,
  requestId,
  method: "pluginApi",
  payload: { method: "GET", path: "state" }
}, "*");
```

主な methods: `pluginApi`、`getAuthSession`、`getSettings`、`updatePluginSettings`、`listPluginSecrets`、`setPluginSecret`、`deletePluginSecret`、`listPluginDeliveries`、`getPluginDelivery`、`startTask`、`readArticles`、`getArticleState`、`recordArticleAction`、`getArticleExplanation`、`openArticle`。

host は iframe source、`pluginId`、`requestId` を検証します。

## CLI

```sh
dibao-plugin create ./my-plugin
dibao-plugin validate ./my-plugin
dibao-plugin pack ./my-plugin --out my-plugin.dibao-plugin
dibao-plugin sign my-plugin.dibao-plugin \
  --private-key private.pem \
  --public-key public.pem \
  --key-id my-key \
  --out my-plugin.signed.dibao-plugin
```

template には `server/`、`web/`、`locales/`、`migrations/`、README、release checklist、signing example、test notes が含まれます。

## Signing と trusted keys

Dibao は Ed25519 signature を使います。signature は manifest、files、updateUrl の stable payload を対象にします。管理者が public key の key id を信頼済みに追加すると検証できます。private key を plugin package に入れないでください。

## Docker 永続化

`/data` を mount すると次が upgrade 後も保持されます。

- `/data/plugins/installed`
- `/data/plugins/data/<plugin-id>`
- SQLite tables: `plugin_installs`, `plugin_capability_grants`, `plugin_settings`, `plugin_kv`, `plugin_migrations`, `plugin_update_checks`, `plugin_secrets`, `plugin_deliveries`

公式 Daily Brief と Webhook は image bundled plugin として scan されます。サードパーティ plugin は data volume に残ります。

## Update と Rollback

推奨 update metadata:

```json
{
  "pluginId": "dev.example.reader-tools",
  "latestVersion": "0.1.1",
  "packageUrl": "https://example.com/reader-tools-0.1.1.dibao-plugin",
  "sha256": "..."
}
```

Dibao は staging に download し、ID/compatibility/checksum を検証してから installed package を差し替えます。失敗時は旧 package に rollback します。古い `.dibao-plugin` を upload して手動 rollback もできます。

## Release Checklist

- `dibao-plugin validate .` が通る。
- server code が宣言済み capability だけを使う。
- Web UI が sandbox iframe で動作し、host call は bridge 経由。
- 公開済み migration を書き換えず、新しい schema change は新 version。
- package が署名済みで、public key/key id が文書化されている。
- README に install、enable、settings、secrets、update、rollback、limitations がある。
- install、enable、disable、tasks、hooks、update、rollback の smoke test を実施。

## Test Checklist

- manifest/signature/tamper rejection。
- activation failure が `failed` になる。
- missing handler が recoverable defer になる。
- secrets plaintext が露出しない。deliveries が flush/retry できる。
- outbound network が blocked private/local target に到達しない。
- iframe sandbox があり、bridge success/error response が動く。
