# Dibao Plugin System Design

Last updated: 2026-08-11

本文定义邸报 `0.3.1` 插件系统的产品和工程设计。目标是让非核心功能、官方可选功能和第三方功能可以在不改动主应用核心代码的情况下接入 UI、业务流程 Hook、前台任务、后台任务和全文抓取器。

相关 issue：

- [#2 Plugin System](https://github.com/Pls-1q43/Dibao/issues/2)
- [#1 Daily Brief](https://github.com/Pls-1q43/Dibao/issues/1)，已作为官方插件进入插件体系

## Goals

- 插件可以在稳定 UI 位置增加按钮、菜单项、Tab、设置页、详情面板和独立页面。
- 插件可以接入核心流程 Hook，例如订阅源刷新、文章入库、文章动作、推荐排序、推荐解释、设置保存、首次设置完成、系统启动和后台维护 tick。
- 插件可以声明前台任务和后台任务。前台任务由用户显式触发并展示进度；后台任务可以按计划运行，也可以由 Hook 或按钮入队。
- 设置页改造为 Tab 化工作台，核心设置本身也通过同一套 tab registry 渲染，插件可以自然注入自己的设置 Tab。
- 用户可以安装、启用、禁用、更新和卸载插件，并能看懂插件请求的权限、来源、版本和兼容性。
- 开发者可以用文档化 manifest、SDK 和打包格式分发插件。
- 官方插件可以随 Dibao release 一起分发，不要求用户额外下载；同时仍走插件权限、配置、启停和更新模型。

## Non-Goals

- `0.3.x` 不把插件系统做成云市场，也不引入官方托管账号体系。
- `0.3.x` 不承诺运行完全不可信的任意第三方代码。第三方插件按自托管管理员主动安装的本地代码处理，安装 UI 必须明确风险。
- 插件不能任意修改 DOM、猴子补丁核心模块或绕过 Dibao API 直接访问用户数据。
- 插件不能要求正式升级时自动重算 embedding、重建向量索引或长时间阻塞主产品 UI，除非用户在专门升级流程里明确批准。

## Core Model

插件由一个 manifest 和一个或多个运行时入口组成。

0.3 的服务端运行时是独立 Node host 子进程。插件仍导出 `activate(ctx)`，但 `ctx` 通过 JSON-RPC 调用主进程白名单 Host API；主进程不向插件暴露 raw DB、`process`、Fastify request/reply 或内部 service。

```text
example.dibao-plugin
  plugin.json
  server/index.mjs
  web/index.js
  web/assets/*
  migrations/*.sql
  locales/*.json
  README.md
  LICENSE
  signature.json
```

插件 ID 使用反向域名或 scope 包名形式：

```text
app.dibao.daily-brief
dev.example.reader-tools
```

manifest 是安装、权限、兼容性和贡献点的唯一权威声明。

```json
{
  "manifestVersion": 1,
  "id": "app.dibao.daily-brief",
  "name": "Daily Brief",
  "version": "0.1.0",
  "publisher": "Dibao",
  "dibao": {
    "minVersion": "0.3.0",
    "maxVersion": "<0.4.0"
  },
  "entry": {
    "server": "server/index.mjs",
    "web": "web/index.js"
  },
  "capabilities": [
    "articles:read",
    "ranking:read",
    "jobs:write",
    "settings:plugin",
    "network:outbound"
  ],
  "contributes": {
    "settingsTabs": [
      {
        "id": "daily-brief",
        "title": "每日简报",
        "slot": "settings.tabs",
        "order": 60,
        "icon": "newspaper"
      }
    ],
    "tabs": [
      {
        "id": "daily-brief-home",
        "title": "每日简报",
        "slot": "app.main.tabs",
        "order": 45,
        "icon": "newspaper"
      }
    ],
    "actions": [
      {
        "id": "generate-brief-now",
        "title": "生成简报",
        "slot": "article.list.toolbar.end",
        "icon": "sparkles",
        "command": "dailyBrief.generateNow"
      }
    ],
    "hooks": [
      "ranking.afterRanked",
      "settings.afterUpdated"
    ],
    "tasks": [
      {
        "id": "dailyBrief.generate",
        "kind": "background",
        "schedule": "daily",
        "defaultEnabled": false
      }
    ]
  }
}
```

## UI Extension Points

插件不通过 CSS selector 或 DOM patch 插入 UI，而是注册到 Dibao 提供的稳定 slot。slot 是产品合约，需要在 API 文档中列出，并带有兼容性说明。

### Slot Naming

slot 使用点分层级：

```text
app.main.nav.items
app.main.tabs
app.global.commandPalette
article.list.toolbar.start
article.list.toolbar.end
article.list.item.actions.end
article.reader.toolbar.end
article.reader.sidePanel.tabs
article.reader.bottomSheet.actions
feed.management.toolbar.end
feed.detail.tabs
settings.tabs
settings.about.links
algorithm.tabs
algorithm.jobs.actions
setup.steps.optional
```

每个 slot 定义允许的 contribution 类型：

- `action`: 一个图标按钮、菜单项或命令入口。
- `tab`: 一个 Tab 和对应 panel。
- `panel`: 嵌入式面板，通常挂在已有 Tab 或侧边栏。
- `route`: 独立插件页面，由核心导航或插件 action 打开。
- `status`: 小型只读状态块，例如 jobs/status board 的一行。

### Rendering Rules

- core UI owns layout, density, focus handling, loading, empty, error and mobile behavior.
- plugin contribution provides label, icon, order, enablement predicate, command id and optional panel route.
- unknown icons fall back to a generic plugin icon; official UI still prefers existing lucide icon mapping.
- article row actions remain icon-only; plugin action must provide accessible label/title.
- mobile bottom navigation remains icon-only; plugin tabs on mobile go into overflow unless marked `primaryMobile`.
- plugin UI must not create marketing hero sections or decorative gradients; it inherits Dibao tokens and density.

### Rich Plugin UI

Third-party rich UI should render in a sandboxed iframe using `postMessage` and a host bridge:

```text
/api/plugins/:pluginId/assets/web/index.html
```

The host bridge exposes typed calls such as `getSettings`, `updatePluginSettings`, `startTask`, `listJobs`, `readArticles`, and `openArticle`. This keeps third-party UI from directly reaching app internals.

Official bundled plugins use the same public bridge and server Host API as third-party plugins. The contribution contract should remain identical so official plugins do not rely on private UI internals.

## Settings Page Tab Refactor

The current settings page is a long form. Plugin tabs require settings to become a two-level workspace:

```text
SettingsWorkspace
  SettingsShell
    SettingsTabNav
    SettingsTabPanel
```

Core settings move into first-party tabs registered through the same registry:

```text
settings.reader
settings.behavior
settings.provider
settings.retention
settings.account
settings.plugins
settings.about
```

The `settings.plugins` tab is the plugin manager. It must ship before third-party plugin install is exposed.

Settings tab contract:

```ts
type SettingsTabContribution = {
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  order?: number;
  badge?: "warning" | "error" | "update" | null;
  panel: PluginPanelDescriptor;
};
```

Validation rules:

- Saving one tab must not submit unrelated tab forms.
- Core tabs keep current settings API semantics.
- Plugin settings are namespaced by plugin ID.
- Plugin tab panels cannot block navigation away unless they have dirty state and ask through the host bridge.
- Mobile settings uses the same tab list as a top segmented/overflow control, not a separate layout model.

## Backend Hook System

Hooks are stable named lifecycle points. Each hook defines whether a plugin can observe, transform, veto, or enqueue follow-up work.

Hook phases:

- `observe`: receives immutable context and cannot change the result.
- `filter`: can narrow or annotate a list through a documented return type.
- `transform`: can return a modified value.
- `veto`: can reject an operation with a user-visible plugin error.
- `effect`: runs after the core transaction commits and is allowed to enqueue plugin jobs.

Default rule: hot user paths use `observe` or post-commit `effect` only. A hook must not synchronously run ranking recalculation, embedding generation, index rebuilds, broad diagnostics, network calls or long plugin work from article open/action/scroll paths. Any plugin feature that touches background jobs, SQLite write paths or diagnostics must also follow the runtime performance rules in [Runtime Performance Guidelines](./runtime-performance.md).

Initial hook catalog:

| Hook | Phase | Use |
| --- | --- | --- |
| `system.started` | effect | plugin startup checks and schedule registration |
| `setup.completed` | effect | create default plugin state after first-run setup |
| `settings.beforeUpdate` | veto | validate plugin-owned or cross-setting constraints |
| `settings.afterUpdated` | effect | enqueue follow-up work after settings save |
| `feed.beforeFetch` | veto/transform | customize request headers or skip a feed |
| `feed.afterFetch` | observe/effect | inspect fetch result or enqueue extraction |
| `article.beforeCreate` | transform | add plugin metadata before article insert |
| `article.afterCreated` | effect | enqueue enrichment tasks |
| `article.actionRecorded` | effect | react to favorite/read/read-later/ignored events after commit |
| `article.list.beforeQuery` | filter | add documented filters only when user chose a plugin view |
| `ranking.afterRanked` | observe/effect | collect ranked winners or enqueue summaries |
| `explanation.afterBuilt` | transform | append plugin explanation rows |
| `jobs.beforeRun` | observe/veto | pause plugin-owned tasks if settings disallow |
| `maintenance.tick` | effect | enqueue scheduled plugin jobs |
| `system.health.read` | observe | add plugin health summary |

Hook execution:

- Hooks run in deterministic order: official core plugins first, then installed plugins by manifest `order`, then plugin ID.
- Every hook has a timeout. Timeout is recorded as plugin error and does not fail the core operation unless the hook is explicitly `veto`.
- Hook payloads are JSON-serializable and versioned.
- Hook errors are isolated per plugin and visible in the plugin manager.
- A plugin can subscribe only to hooks declared in its manifest.

## Tasks

### Foreground Tasks

Foreground tasks are user-triggered and visible:

- started from a button, tab panel or plugin settings page;
- return a task id immediately;
- expose progress, current step, cancellability and final result;
- can create a related background job if work must continue after navigation.

Example:

```text
User clicks "生成简报" -> POST /api/plugins/app.dibao.daily-brief/tasks/generate-now
Response -> { taskId, status: "running" }
UI subscribes/polls -> progress and result
```

### Background Tasks

Background plugin work uses the existing `jobs` table and `JobRunner`, with job type widened from a closed union to a prefixed string:

```text
plugin:app.dibao.daily-brief:dailyBrief.generate
```

Plugin task handlers are registered by the plugin runtime. They must support retry, deferral and permanent failure using the same semantics as core jobs.

Scheduling options:

- `manual`: only user-triggered or hook-triggered.
- `interval`: every N minutes/hours/days.
- `daily`: local-time daily schedule with timezone.
- `weekly`: local-time weekly schedule.
- `cron`: optional later extension; avoid in the first implementation unless needed.

The scheduler stores next run state in plugin tables, not in manifest. Manifest provides defaults only.

## Storage And Schema

Recommended migrations:

```text
plugin_installs
  id TEXT PRIMARY KEY
  version TEXT NOT NULL
  source_type TEXT NOT NULL -- official | local_file | url | github_release | registry
  source_url TEXT
  manifest_json TEXT NOT NULL
  status TEXT NOT NULL -- installed | enabled | disabled | failed
  official INTEGER NOT NULL DEFAULT 0
  bundled INTEGER NOT NULL DEFAULT 0
  trust_level TEXT NOT NULL -- official | trusted | untrusted
  installed_at INTEGER NOT NULL
  updated_at INTEGER NOT NULL
  enabled_at INTEGER
  disabled_at INTEGER
  last_error TEXT

plugin_capability_grants
  plugin_id TEXT NOT NULL
  capability TEXT NOT NULL
  granted_at INTEGER NOT NULL
  PRIMARY KEY (plugin_id, capability)

plugin_settings
  plugin_id TEXT NOT NULL
  key TEXT NOT NULL
  value_json TEXT NOT NULL
  updated_at INTEGER NOT NULL
  PRIMARY KEY (plugin_id, key)

plugin_kv
  plugin_id TEXT NOT NULL
  key TEXT NOT NULL
  value_json TEXT NOT NULL
  updated_at INTEGER NOT NULL
  PRIMARY KEY (plugin_id, key)

plugin_migrations
  plugin_id TEXT NOT NULL
  version TEXT NOT NULL
  name TEXT NOT NULL
  checksum TEXT
  applied_at INTEGER NOT NULL
  PRIMARY KEY (plugin_id, version)

plugin_update_checks
  plugin_id TEXT PRIMARY KEY
  latest_version TEXT
  update_url TEXT
  checked_at INTEGER NOT NULL
  error TEXT
```

Secrets must not be stored in `plugin_settings` or manifest. 0.3 provides `plugin_secrets` and encrypted plugin secret APIs for official and trusted third-party plugins that declare `secrets:plugin`.

Plugin package and data paths:

```text
/app/plugins/official/<plugin-id>        # official plugins bundled in the Docker image
/data/plugins/installed/<plugin-id>      # third-party plugin packages installed by the user
/data/plugins/data/<plugin-id>           # third-party plugin runtime files and large local state
```

This path split is part of the Docker upgrade contract. Official plugins are image assets; third-party plugins are data-volume assets. A user-installed third-party plugin must never be installed only under `/app`, because that directory is replaced whenever the Docker image changes.

## API Surface

Plugin management API:

```text
GET  /api/plugins
GET  /api/plugins/catalog
POST /api/plugins/install
POST /api/plugins/install/upload
POST /api/plugins/:id/enable
POST /api/plugins/:id/disable
POST /api/plugins/:id/update
DELETE /api/plugins/:id
GET  /api/plugins/:id/settings
PATCH /api/plugins/:id/settings
GET  /api/plugins/:id/health
GET  /api/plugins/:id/assets/*
POST /api/plugins/:id/tasks/:taskId
GET  /api/plugins/:id/tasks/:runId
POST /api/plugins/:id/tasks/:runId/cancel
```

Host capability APIs should be narrow and typed. A plugin should not receive the raw database handle by default.

Server SDK sketch:

```ts
export default defineDibaoPlugin({
  async activate(ctx) {
    ctx.hooks.on("ranking.afterRanked", async (event) => {
      await ctx.jobs.enqueue("dailyBrief.generate", {
        rankedAt: event.generatedAt
      });
    });

    ctx.tasks.register("dailyBrief.generate", async (job, task) => {
      task.progress({ step: "selecting", current: 1, total: 4 });
      const articles = await ctx.articles.listRankedWinners({ window: "24h" });
      task.progress({ step: "summarizing", current: 2, total: 4 });
      await ctx.storage.setJson("latestBrief", { articles });
    });
  }
});
```

Web SDK sketch:

```ts
export default defineDibaoWebPlugin({
  activate(host) {
    host.ui.registerAction("generate-brief-now", {
      slot: "article.list.toolbar.end",
      icon: "sparkles",
      label: host.i18n.t("dailyBrief.generate"),
      run: () => host.tasks.start("dailyBrief.generate")
    });

    host.ui.registerSettingsTab("daily-brief", {
      title: host.i18n.t("dailyBrief.settingsTitle"),
      render: () => host.panels.iframe("settings.html")
    });
  }
});
```

## Installation UX

Plugin manager lives in `Settings -> Plugins`.

Sections:

- `Official`: bundled plugins shipped with this Dibao release.
- `Installed`: enabled/disabled local plugins.
- `Install`: upload `.dibao-plugin`, paste manifest/update URL, or install from a GitHub release URL.
- `Updates`: available plugin updates and compatibility warnings.

Install flow:

1. User selects official plugin, uploads a package, or provides URL.
2. Server validates package shape, manifest schema, plugin ID, version, checksums and Dibao version range.
3. UI shows plugin name, publisher, source, version, release notes, requested capabilities and risk level.
4. User grants capabilities and installs. New third-party plugins default to disabled after install.
5. User enables plugin. Activation runs plugin migrations and startup validation.
6. Plugin contributions appear only after enable succeeds.

Disable flow:

- Stop schedules.
- Stop rendering UI contributions.
- Do not delete plugin data.
- Running plugin jobs finish or are marked cancelled depending on task metadata.

Uninstall flow:

- Disable first.
- Ask whether to keep plugin data.
- Remove package files and manifests.
- If deleting data, remove `plugin_settings`, `plugin_kv`, grants and plugin schedules.
- Plugin-created article/feed metadata should use namespaced metadata and survive safely unless user chooses cleanup.

## Docker Upgrade Persistence

Users should not need to reinstall third-party plugins after upgrading Dibao with Docker, as long as the `/data` volume is preserved.

On startup after an official image upgrade:

1. Run core Dibao migrations first.
2. Scan `/app/plugins/official` for bundled official plugins.
3. Scan `/data/plugins/installed` for user-installed third-party plugins.
4. Reconcile each plugin with `plugin_installs` by plugin ID and version.
5. Validate manifest schema, package integrity, Dibao version range and previously granted capabilities.
6. Run pending plugin migrations only for compatible plugins.
7. Reactivate compatible plugins that were enabled before the upgrade.
8. Mark incompatible or invalid plugins as `incompatible` or `failed`, keep their settings/data, and do not load UI contributions, hooks or task handlers.

Pending jobs for incompatible plugins must be paused rather than failed as `No handler registered`. The job runner should treat missing plugin handlers as a plugin lifecycle state, not as an ordinary permanent task failure. Once the user updates or re-enables the plugin, queued plugin jobs can continue if their task schema is still compatible; otherwise the plugin manager should ask the user to cancel or migrate them.

The plugin manager must surface upgrade state clearly:

- compatible and reactivated;
- disabled before upgrade and still disabled;
- incompatible with current Dibao version;
- manifest or package validation failed;
- update available;
- plugin migration failed and rollback/repair is required.

## Developer Distribution

Development artifacts:

- `@dibao/plugin-sdk`: TypeScript types, host API, manifest schema and test helpers.
- `@dibao/plugin-cli`: `create`, `validate`, `build`, `pack`, `sign`, `dev`.
- plugin template with server entry, web iframe panel, locales and README.
- standalone plugin development documentation in Simplified Chinese, English, and Japanese. The plugin docs are part of the broader developer documentation set, but must also exist as independent files so plugin authors can read them without opening the full developer guide.

Distribution options:

- `.dibao-plugin` file download.
- GitHub Releases with attached package and checksum.
- Static manifest/update URL containing latest compatible version.
- Later: simple registry JSON, still self-hosted and no account system.

Recommended developer flow:

```text
npm create dibao-plugin my-plugin
npm run build
npx dibao-plugin validate
npx dibao-plugin pack
```

Package validation must be runnable without network and should fail on:

- missing or invalid manifest;
- unsupported Dibao version range;
- undeclared hook/task/action contribution;
- missing entry files;
- invalid capability names;
- migration checksum mismatch;
- oversized package unless user explicitly allows.

## Official Plugins

Official plugins are built and tested as part of Dibao release. They are stored in the image under:

```text
/app/plugins/official/<plugin-id>
```

In source, use:

```text
plugins/official/<plugin-id>/
```

Official plugins:

- appear in the plugin manager even before user installs anything;
- can be enabled/disabled;
- may be enabled by default only for low-risk behavior that does not call paid providers or external APIs;
- update with Dibao release by default;
- are reconciled from `/app/plugins/official` on every Docker image startup;
- still declare capabilities and settings;
- should use the same public plugin APIs as third-party plugins unless a private API is explicitly documented as internal.

Official plugins in 0.3.1:

- `app.dibao.daily-brief`: scheduled daily brief from top personalized articles in the past 24 hours, diversified by interest cluster.
- `app.dibao.webhook`: event-driven webhook rules, secrets, deliveries, and test delivery flow.
- `app.dibao.full-content-selectors`: selector-based full-content extraction for sites that need custom extraction rules.

Candidate future official plugins:

- `app.dibao.reading-export`: export selected articles/briefs to Markdown or OPML-like bundles.
- `app.dibao.provider-diagnostics`: richer provider/index diagnostics separated from normal reader paths.

`app.dibao.daily-brief` remains the reference official plugin because it exercises UI tabs, settings tab injection, scheduled background work, foreground generation, ranking read access and plugin storage.

## Updates

Update metadata:

```json
{
  "pluginId": "app.dibao.daily-brief",
  "latestVersion": "0.1.1",
  "dibao": { "minVersion": "0.3.0", "maxVersion": "<0.4.0" },
  "packageUrl": "https://example.com/daily-brief-0.1.1.dibao-plugin",
  "sha256": "...",
  "releaseNotes": {
    "zh-CN": "...",
    "ja-JP": "...",
    "en-US": "..."
  }
}
```

Update flow:

1. Check update metadata manually or on a lightweight interval.
2. Compare semver and Dibao compatibility.
3. Download package to a staging directory.
4. Verify checksum/signature.
5. Back up current plugin manifest/package and database.
6. Disable plugin schedules, apply plugin migrations, swap package atomically, then reactivate.
7. If activation fails, roll back package and keep old plugin disabled or re-enable old version when safe.

Official plugin updates:

- If bundled with Dibao, official plugin update normally happens during app upgrade.
- If an official plugin publishes an out-of-band compatible package, the plugin manager may show it as an optional update.
- Official plugin downgrade should be blocked unless the user explicitly imports a compatible older package and accepts migration risk.

## Security And Capability Model

Capabilities are displayed before install and enforced by the host API.

Initial capability names:

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
network:outbound
files:plugin-data
telemetry:emit
```

Default third-party plugin trust rules:

- No direct DB handle.
- No direct access to auth/session cookies.
- No core settings write unless explicitly granted.
- No external network unless `network:outbound` is granted.
- No arbitrary app filesystem access; plugin data is namespaced.
- Hook and task timeouts are mandatory.

Server-side JavaScript plugins are isolated in a child process but are still trusted local code in `0.3.x`. The UI should say this plainly. A stronger future sandbox can use a worker/WASI-style runtime, but the Host API and manifest should be designed so that stronger isolation can replace the implementation later.

## Compatibility And Versioning

- `manifestVersion` versions plugin metadata.
- Each hook payload has a `schemaVersion`.
- Each slot has a stable ID and accepted contribution types.
- Dibao minor versions may add slots/hooks.
- Dibao should not remove or rename a slot/hook within the same minor line.
- Deprecated slots/hooks remain as no-op or compatibility aliases until the next larger version line.
- Plugins must declare `dibao.minVersion` and `dibao.maxVersion` or equivalent semver range.

## Observability

Plugin manager should expose:

- install source, version and compatibility;
- enabled/disabled state;
- granted capabilities;
- last activation error;
- last hook errors;
- open/running/failed plugin jobs;
- next scheduled run;
- update check status.

System health may include a summarized plugin status:

```json
{
  "plugins": {
    "enabled": 2,
    "failed": 0,
    "updatesAvailable": 1
  }
}
```

## Implementation Plan

### Phase 1: Settings Tab Foundation

- Split `SettingsWorkspace` into a tab shell and tab panels.
- Move existing language/account/behavior/reader/retention/provider/about sections into core tabs.
- Add `settings.plugins` tab with read-only placeholder state.
- Keep existing `GET/PATCH /api/settings` behavior unchanged.
- Verify desktop and mobile settings layout against `.tmp/dibao-ui-demo`.

### Phase 2: Plugin Registry And Official Plugin Loader

- Add plugin manifest schema and local registry service.
- Add `plugin_installs`, `plugin_settings`, `plugin_kv`, `plugin_capability_grants`.
- Load bundled official plugin manifests from `/app/plugins/official`.
- Render manifest-declared UI contributions in the settings tab and selected low-risk slots.
- Add plugin manager list/enable/disable APIs.

### Phase 3: Hooks And Tasks

- Widen job type handling to support `plugin:<pluginId>:<taskId>`.
- Add plugin task registration and execution through `JobRunner`.
- Add first hook points: `settings.afterUpdated`, `article.actionRecorded`, `ranking.afterRanked`, `maintenance.tick`.
- Enforce timeouts and error isolation.

### Phase 4: Install, Update And Developer Packaging

- Implement upload/local URL install.
- Add manifest validation, compatibility checks, checksum/signature support.
- Add update metadata check and staged update flow.
- Publish `@dibao/plugin-sdk` and `@dibao/plugin-cli` or keep them as workspace packages until API stabilizes.
- Add the plugin development docs as a child unit of the developer documentation set, with independent Simplified Chinese, English, and Japanese files.

### Phase 5: Daily Brief Official Plugin

- Build `app.dibao.daily-brief` as official bundled plugin.
- Settings tab: schedule, timezone, max articles, diversity by interest cluster, summary provider choice.
- Main tab or reader action: generate today's brief now.
- Background task: select top ranked articles from past 24 hours, diversify by interest cluster, generate/store brief.
- Foreground task: manual generation with progress.
- No embedding recomputation; use existing ranking/profile data only.

## Acceptance Criteria

- A disabled plugin contributes no UI, hooks or jobs.
- Enabling an official plugin adds its settings tab without rebuilding the core settings page.
- A plugin action can start a foreground task and show progress.
- A plugin background task is visible in `/api/jobs` or plugin-specific task UI and follows existing retry/defer/fail semantics.
- A plugin Hook can observe `ranking.afterRanked` and enqueue work without slowing article open/action paths.
- Installing a third-party plugin requires manifest validation and explicit capability approval.
- Updating a plugin is staged, checksum-verified and rollback-safe.
- Official plugins are bundled in Docker release images and can be enabled/disabled by the user.
