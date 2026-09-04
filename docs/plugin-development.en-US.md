# Dibao 0.3 Plugin Development Guide

Last updated: 2026-08-11

This guide is for third-party plugin developers. Dibao 0.3 is an ecosystem-platform release for trusted administrator-installed plugins. Plugins can extend server tasks, hooks, settings pages, web UI, and full-content extractors, but they are trusted local code. Dibao 0.3 does not claim to safely run arbitrary malicious code.

## Security Model

- Server plugins run in an isolated Node host child process and call Dibao through a JSON-RPC Host API.
- The main process never passes `db`, `process`, Fastify `request/reply`, or internal services to plugins.
- Web plugins run in `sandbox="allow-scripts allow-forms"` iframes without `allow-same-origin`.
- Plugin HTML receives a restrictive CSP: no direct `fetch`, no form submit, no default external resources; inline scripts/styles and `/api/plugins/ui.css` are allowed.
- Third-party upload remains available, but plugins are disabled by default. Review source, signature trust, capabilities, Stable/Beta API usage, and server-code risk before enabling.

## Manifest v1

`.dibao-plugin` packages are JSON:

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

Use reverse-domain IDs and a bounded compatibility range such as `<0.5.0`.

### Plugin Localization

Starting in 0.3, user-facing manifest strings may stay as plain strings or use locale maps:

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

Dibao resolves manifest strings against the current UI locale with this fallback chain: exact locale, language code, `zh-CN`, `zh`, then the first available value. Web plugin iframes receive a `?locale=zh-CN|en-US|ja-JP` query parameter and can also call the bridge method `getLocale`. Server plugins receive the startup locale as `ctx.locale`; use `await ctx.i18n.getLocale()` when an already-running plugin needs to observe language changes.

## Capabilities

Supported capabilities:

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

Declare only what you need. `network:outbound` is protected by SSRF checks, size limits, redirect limits, and timeouts. Sensitive headers should reference plugin secrets through delivery `secretHeaders`.

## API Stability

Stable:

- manifest v1 and install/enable/disable/update lifecycle
- `settings`, `storage`, `secrets`
- `tasks`, basic `hooks`, `events.catalog`
- `deliveries`, `network.outbound`
- iframe bridge
- manifest-declared `migrations`

Beta:

- `database.defineTable`
- `ranking.*`
- `articles.snapshot/openableSummary/countDiscovered`
- `fullContent.extractor`
- diagnostics and recommendation transparency APIs

Beta fields and semantics may change during 0.3.x. Long-lived plugins should use manifest migrations for durable schema changes instead of relying only on `database.defineTable`.

## Server Entry

Export `activate(ctx)`. The entry shape is unchanged, but Host APIs are asynchronous JSON-RPC calls:

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

Dibao pre-activates the server entry when a plugin is enabled. Activation failure keeps the plugin in `failed`. Disabling a plugin stops contributions and cancels open plugin jobs. Missing task handlers defer jobs for recovery instead of marking them as ordinary permanent failures.

## Full Content Extractors (Beta)

Declare `contributes.fullContentExtractors` with an `id`, `title`, and optional `order`, then register the matching handler during activation. Enabled extractors run in ascending order before Dibao's built-in extraction; malformed, empty, or short results fall back safely to the built-in extractor.

```js
ctx.fullContent.register("site-selector", ({ articleUrl, html, contentType }) => {
  if (!contentType.includes("html") || !html.includes("article-body")) return null;
  return { contentHtml: "<p>...</p>", contentText: "...", excerpt: "..." };
});
```

The handler receives downloaded page content only. It must return normalized safe reader HTML and text, must not make network requests, and should complete quickly; a timeout falls back to the built-in extractor.

## Data, Secrets, Deliveries

- `settings`: user-facing plugin configuration.
- `storage`: plugin KV data.
- `secrets`: encrypted sensitive values; plaintext is not returned in UI or delivery records.
- `deliveries`: retryable outbound HTTP delivery, suitable for webhooks.
- `network.fetch`: controlled immediate request, useful for connection tests, not hot-path fan-out.

## Database Migrations

Declare migrations in the manifest. Dibao records `plugin_id/version/name/checksum/applied_at`. If an already-applied version changes name or checksum, enable fails to prevent schema drift.

```json
{
  "capabilities": ["database:plugin"],
  "migrations": [
    { "version": "001", "name": "create_notes", "path": "migrations/001_create_notes.sql" }
  ]
}
```

Never rewrite published migrations. Append a new version for changes or cleanup.

## iframe Bridge

Plugin pages must not call Dibao APIs with direct `fetch`. Use `postMessage`:

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

Common methods: `pluginApi`, `getAuthSession`, `getSettings`, `updatePluginSettings`, `listPluginSecrets`, `setPluginSecret`, `deletePluginSecret`, `listPluginDeliveries`, `getPluginDelivery`, `startTask`, `readArticles`, `getArticleState`, `recordArticleAction`, `getArticleExplanation`, and `openArticle`.

The host validates iframe source, `pluginId`, and `requestId`.

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

The template includes `server/`, `web/`, `locales/`, `migrations/`, README, release checklist, signing example, and test notes.

## Signing And Trusted Keys

Dibao uses Ed25519 signatures over a stable payload containing manifest, files, and updateUrl. Administrators must trust the public key by key id before a signed package verifies. Never ship private keys in plugin packages.

## Docker Persistence

With `/data` mounted, these survive image upgrades:

- `/data/plugins/installed`
- `/data/plugins/data/<plugin-id>`
- SQLite tables: `plugin_installs`, `plugin_capability_grants`, `plugin_settings`, `plugin_kv`, `plugin_migrations`, `plugin_update_checks`, `plugin_secrets`, `plugin_deliveries`

Official Daily Brief, Webhook, and Full Content Selectors plugins are scanned from the bundled 0.3.1 image. Third-party plugins remain in the data volume.

## Updates And Rollback

Recommended update metadata:

```json
{
  "pluginId": "dev.example.reader-tools",
  "latestVersion": "0.1.1",
  "packageUrl": "https://example.com/reader-tools-0.1.1.dibao-plugin",
  "sha256": "..."
}
```

Dibao downloads to staging, validates ID/compatibility/checksum, then swaps the installed package. Failures roll back to the old package. Users can also roll back by uploading an older `.dibao-plugin`.

## Release Checklist

- `dibao-plugin validate .` passes.
- Server code only uses declared capabilities.
- Web UI works in the sandboxed iframe and uses the bridge for host calls.
- Published migrations are immutable; new schema changes append new versions.
- Package is signed and the public key/key id is documented.
- README covers install, enable, settings, secrets, update, rollback, and limitations.
- Manual smoke covers install, enable, disable, tasks, hooks, update, and rollback.

## Test Checklist

- Manifest/signature/tamper rejection.
- Activation failure moves to `failed`.
- Missing handlers defer recoverably.
- Secrets never reveal plaintext; deliveries flush/retry.
- Outbound network cannot reach blocked private/local targets.
- iframe sandbox is present; bridge success and error responses work.
