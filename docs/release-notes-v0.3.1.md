# Dibao v0.3.1 Release Notes

Dibao v0.3.1 is the recommended 0.3 release. It carries the major recommendation-algorithm and recommendation-mechanism update introduced in v0.3.0, then adds post-release hardening for security dependencies, controlled outbound fetches, plugin localization, self-hosted feeds, reader recovery, and article-content cleanup.

Release date: 2026-08-10

## 简体中文

v0.3.1 是当前推荐安装和升级的 0.3 正式版本。本版本的主轴是“推荐算法与机制大更新”：推荐系统从单纯给出列表，进一步走向更稳定的已排序库存、更清楚的 fallback 边界、更可靠的负面主题过滤，以及更低干扰的后台排序机制。v0.3.1 还补齐了 0.3.0 发布后的安全、插件、本地网络订阅源和阅读器恢复体验修复。

### 主要变化

- 推荐 v3 memory 基础：新增用户表示快照、推荐曝光记录和探索尝试记录，为长期兴趣记忆、探索反馈和后续推荐策略迭代打基础。
- 推荐排序与 fallback 隔离：推荐列表更严格使用当前 active rank context，避免旧上下文或 fallback 序列过早混入；当已排序库存不足时，fallback 只用于短批次临时补位，降低大批未排序内容涌入的体感。
- 负面主题簇与主题组修复：负面主题、主题组约束，以及金融/交易日等不想看的主题标记会更可靠地参与过滤和降权。
- 推荐库存状态提示：未读推荐页可以显示当前处于“有已排序库存”“无库存”或“排序中”，帮助判断是否正在消费高质量推荐，还是暂时进入备用序列。
- 阅读路径性能优化：打开文章、滚动和文章操作不再同步触发重排序、重型透明度诊断或大范围写入；这些工作改由后台任务处理。
- 无限加载：可在设置中开启。推荐、最新、收藏、稍后读和搜索结果滚动到底部时会自动加载下一批；失败时暂停自动重试，并保留明确的手动重试入口。
- 文章详情体验：顶部“返回列表”和“原文”按钮布局收口；详情加载失败时提供重新加载入口，已知原文 URL 时仍可打开原文。
- 插件体验补齐：官方插件 manifest 支持本地化字符串，插件 iframe 和 bridge 可感知当前语言；Daily Brief、Webhook 和全文选择器官方插件更新到 `0.1.1`。
- 自托管订阅源兼容：feed 发现和刷新允许访问私有/内网地址，以支持 NAS、家庭网络或自建服务里的 RSS；插件出站请求和全文抓取仍保留受控 fetch 的防护边界。
- 内容清理：更好地清除 Hexo 风格代码块行号/侧栏，保留正文代码内容，减少文章详情中的噪声。
- 安全与发布链路加固：受控 fetch 降低 DNS rebinding / TOCTOU SSRF 风险，跨源重定向会剥离敏感 header；同时升级运行时与构建依赖，发布前生产和完整 `npm audit` 均为 0。

### 升级影响

从 v0.3.0 升级到 v0.3.1 没有新增 core SQLite migration，也不需要重新计算 Embeddings。官方插件会随应用内置资源更新到 `0.1.1`。

从 v0.2.1 直接升级到 v0.3.1 会新增推荐 v3 memory 相关数据库结构。迁移会在应用启动时自动执行；升级前仍建议备份 `/data/dibao.sqlite` 或整个 Docker volume。

本次升级不会要求重新计算 Embeddings。v0.3 会在现有文章、行为事件、兴趣簇和已存在向量的基础上继续工作；新的推荐记忆和曝光数据会在升级后随使用逐步积累。

升级后建议检查：

```text
GET /api/system/health
```

返回 `ok: true` 和 `version: "0.3.1"` 表示基础健康检查通过。进入推荐页后，如果推荐库存状态提示显示正在排序，可以等待后台任务补充排序库存。

### Docker 安装与升级

推荐镜像：

```yaml
image: ghcr.io/pls-1q43/dibao:v0.3.1
```

保留原有 `/data` volume，替换镜像并重启即可。默认入口会启动 HTTP 进程和独立 worker 进程。若你维护自定义 Compose 文件，请继续保留持久化数据目录，并确保环境变量与上一版相比没有遗漏。

升级前建议：

```text
备份 /data/dibao.sqlite 或整个 Docker volume
```

如需回滚，请先停止 v0.3.1 容器，用升级前备份恢复 SQLite 数据库和 `/data` volume，再启动上一版镜像。不要直接用已迁移到 0.3.x 的数据库启动更旧版本。

### Migration List

从 v0.3.0 到 v0.3.1：

- 没有新增 core SQLite migration。

从 v0.2.1 直接升级到 v0.3.1：

- `026_recommendation_v3_memory.sql`：新增 `user_representation_snapshots`、`recommendation_exposures`、`exploration_attempts`，并为 `article_rank_scores` 增加探索相关字段。

### Sentry 发布校验

正式 Docker 镜像使用 BuildKit secret `dibao_sentry_config` 注入私有 Sentry 配置。发布验证只报告 `hasDsn`、`hasOrg`、`hasProject` 等布尔结果，不公开 DSN、org、project 或 token。

### 已知限制

- 推荐 v3 memory 是基础设施更新，不代表所有长期记忆策略都已完成产品化；推荐质量仍会随使用和后台排序逐步稳定。
- 当已排序推荐库存耗尽时，系统仍可能临时使用备用序列，但 v0.3.1 会更明确地限制和提示这一状态。
- 第三方服务端插件仍是可信本地代码，不是任意恶意代码沙箱。

## English

v0.3.1 is the recommended stable 0.3 release. Its central theme is a major recommendation-algorithm and recommendation-mechanism update: Dibao now puts more emphasis on stable sorted inventory, clearer fallback boundaries, more reliable negative-topic filtering, and lower-latency background ranking. v0.3.1 also includes post-v0.3.0 fixes for security, plugins, self-hosted feeds, reader recovery, and article cleanup.

### Highlights

- Recommendation v3 memory foundation: added user representation snapshots, recommendation exposures, and exploration attempts to support long-term interest memory, exploration feedback, and future recommendation strategy work.
- Ranking and fallback isolation: recommended lists now stay closer to the active rank context. When sorted inventory is low, fallback is used only as a small temporary batch instead of letting large unsorted pages dominate the reading experience.
- Negative topic and family fixes: negative clusters, topic-family constraints, and unwanted topics such as finance/trading-day content are applied more reliably.
- Recommendation inventory status: the unread recommendation page can indicate whether sorted inventory is available, empty, or being replenished in the background.
- Faster interaction paths: article opening, scrolling, and article actions no longer synchronously trigger reranking, heavy transparency diagnostics, or broad writes; those tasks move to background work.
- Infinite loading: optional automatic pagination for recommendations, latest articles, favorites, read-later, and search results. When appending fails, automatic retries pause and an explicit manual retry remains available.
- Reader polish: article-detail navigation and original-source actions are aligned; failed detail loads now expose a reload entry, and the original URL remains available when known.
- Plugin improvements: official plugin manifests support localized strings, plugin iframes and bridge APIs can read the current locale, and the Daily Brief, Webhook, and full-content selector plugins are updated to `0.1.1`.
- Self-hosted feed compatibility: feed discovery and refresh can access private/local network feed URLs for NAS, home-network, and self-hosted RSS use cases. Plugin outbound requests and full-content fetches keep the controlled-fetch protection boundary.
- Cleaner article content: Hexo-style code-block line-number gutters are stripped while preserving the actual code body.
- Security and release-chain hardening: controlled fetch reduces DNS rebinding / TOCTOU SSRF risk, cross-origin redirects strip sensitive headers, and runtime/build dependencies are updated so both production and full `npm audit` pass with 0 vulnerabilities.

### Upgrade Impact

Upgrading from v0.3.0 to v0.3.1 adds no new core SQLite migrations and does not require embedding recomputation. Bundled official plugins are updated to `0.1.1`.

Upgrading directly from v0.2.1 to v0.3.1 adds recommendation v3 memory database structures. Core migrations run automatically on startup. Back up `/data/dibao.sqlite` or the whole Docker volume before upgrading.

This upgrade does not require embedding recomputation. v0.3 continues from existing articles, behavior events, interest clusters, and vectors; new recommendation memory and exposure data accumulate after upgrade.

After upgrading, verify:

```text
GET /api/system/health
```

The response should include `ok: true` and `version: "0.3.1"`. If the recommendation inventory indicator says sorting is in progress, wait for background jobs to replenish sorted inventory.

### Docker Install And Upgrade

Recommended image:

```yaml
image: ghcr.io/pls-1q43/dibao:v0.3.1
```

Keep the existing `/data` volume, replace the image, and restart. The default entrypoint starts both the HTTP process and a separate worker process. If you maintain a custom Compose file, keep your persistent data volume and carry forward existing environment settings.

Before upgrading:

```text
Back up /data/dibao.sqlite or the whole Docker volume.
```

To roll back, stop the v0.3.1 container, restore the pre-upgrade SQLite database and `/data` volume backup, then start the previous image. Do not start an older version against a database already migrated to 0.3.x.

### Migration List

From v0.3.0 to v0.3.1:

- No new core SQLite migrations.

For a direct upgrade from v0.2.1 to v0.3.1:

- `026_recommendation_v3_memory.sql`: adds `user_representation_snapshots`, `recommendation_exposures`, `exploration_attempts`, and exploration fields on `article_rank_scores`.

### Sentry Release Verification

The formal Docker image is built with the private Sentry config injected through the BuildKit secret `dibao_sentry_config`. Verification reports only booleans such as `hasDsn`, `hasOrg`, and `hasProject`; it does not expose DSN, org, project, or tokens.

### Known Limitations

- Recommendation v3 memory is a foundation update; not every long-term memory strategy is fully productized yet. Recommendation quality should stabilize as usage and background ranking continue.
- When sorted recommendation inventory is exhausted, Dibao may still temporarily use a fallback sequence, but v0.3.1 limits and communicates that state more clearly.
- Third-party server plugins are trusted local code, not an arbitrary malicious-code sandbox.

## 日本語

v0.3.1 は、現在推奨する 0.3 系の正式リリースです。中心テーマは「推薦アルゴリズムと推薦メカニズムの大幅更新」です。Dibao は、安定した排序済み在庫、より明確な fallback 境界、より確実なネガティブ topic フィルタ、低遅延なバックグラウンド排序を重視する方向に進みました。v0.3.1 ではさらに、v0.3.0 後の security、plugin、自ホスト feed、reader recovery、記事本文 cleanup の修正も含みます。

### 主な変更

- 推薦 v3 memory 基盤: user representation snapshot、推薦 exposure、探索 attempt を追加し、長期的な興味記憶、探索 feedback、今後の推薦戦略の土台を作りました。
- ranking と fallback の分離: 推薦リストは active rank context をより厳密に使います。排序済み在庫が少ない場合も、fallback は小さな一時 batch として使われ、大量の未排序ページが読書体験を覆うことを避けます。
- ネガティブ topic / family 修正: negative cluster、topic family 制約、金融・取引日系など見たくない topic の降格・除外がより確実に働きます。
- 推薦在庫ステータス: 未読推薦ページで、排序済み在庫があるか、空か、バックグラウンドで補充中かを確認できます。
- 操作経路の高速化: 記事を開く、スクロールする、記事アクションを行う経路では、同期的な再排序、重い transparency diagnostics、広範囲の書き込みを避け、バックグラウンド処理に移します。
- 無限ロード: 推薦、最新、收藏、あとで読む、検索結果で任意の自動ページングを利用できます。追加読み込みに失敗した場合、自動 retry を止め、明示的な手動 retry を残します。
- reader 改善: 記事詳細上部の戻る操作と原文操作を整理しました。詳細ロード失敗時には再読み込み導線を表示し、原文 URL が分かる場合は引き続き原文を開けます。
- plugin 改善: 公式 plugin manifest が localized string に対応し、plugin iframe と bridge API から現在 locale を読めます。Daily Brief、Webhook、全文 selector plugin は `0.1.1` に更新されます。
- 自ホスト feed 互換性: feed discovery / refresh は NAS、家庭内ネットワーク、自建 RSS の private/local network URL に対応します。一方、plugin outbound request と全文取得は controlled-fetch の防護境界を維持します。
- 記事本文 cleanup: Hexo 風 code block の行番号 gutter を除去し、実際の code body は保持します。
- security と release chain 強化: controlled fetch は DNS rebinding / TOCTOU SSRF リスクを下げ、cross-origin redirect では sensitive header を削除します。runtime / build dependency も更新し、production と full `npm audit` はどちらも 0 vulnerabilities です。

### アップグレード影響

v0.3.0 から v0.3.1 へのアップグレードでは、新しい core SQLite migration はありません。Embeddings の再計算も不要です。内蔵公式 plugin は `0.1.1` に更新されます。

v0.2.1 から v0.3.1 へ直接アップグレードする場合、推薦 v3 memory 関連の database 構造が追加されます。core migration は起動時に自動実行されます。アップグレード前に `/data/dibao.sqlite` または Docker volume 全体をバックアップしてください。

このアップグレードでは Embeddings の再計算は不要です。既存の記事、行動イベント、興味 cluster、vector を引き継ぎ、新しい推薦 memory と exposure データはアップグレード後の利用に合わせて蓄積されます。

アップグレード後は次を確認してください。

```text
GET /api/system/health
```

レスポンスに `ok: true` と `version: "0.3.1"` が含まれていれば基本確認は通っています。推薦在庫ステータスが排序中を示す場合は、バックグラウンドジョブが排序済み在庫を補充するまで待ってください。

### Docker インストール / アップグレード

推奨 image:

```yaml
image: ghcr.io/pls-1q43/dibao:v0.3.1
```

既存の `/data` volume を維持し、image を差し替えて再起動してください。既定の entrypoint は HTTP プロセスと独立 worker プロセスを起動します。独自 Compose を使っている場合は、永続 data volume と既存の環境変数を引き継いでください。

アップグレード前:

```text
/data/dibao.sqlite または Docker volume 全体をバックアップしてください。
```

ロールバックする場合は v0.3.1 コンテナを停止し、アップグレード前の SQLite database と `/data` volume backup を復元してから前の image を起動してください。0.3.x に migration 済みの database を旧バージョンで直接起動しないでください。

### Migration List

v0.3.0 から v0.3.1:

- 新しい core SQLite migration はありません。

v0.2.1 から v0.3.1 へ直接アップグレードする場合:

- `026_recommendation_v3_memory.sql`: `user_representation_snapshots`、`recommendation_exposures`、`exploration_attempts` を追加し、`article_rank_scores` に探索関連フィールドを追加します。

### Sentry リリース検証

正式 Docker image は BuildKit secret `dibao_sentry_config` で private Sentry 設定を注入してビルドします。検証結果は `hasDsn`、`hasOrg`、`hasProject` などの boolean のみを報告し、DSN、org、project、token は公開しません。

### 既知の制限

- 推薦 v3 memory は基盤更新であり、長期記憶戦略のすべてが完全に製品化されたわけではありません。推薦品質は利用とバックグラウンド排序に合わせて安定していきます。
- 排序済み推薦在庫が尽きた場合、一時的に fallback sequence を使うことがあります。ただし v0.3.1 では、その状態をより制限し、分かりやすく表示します。
- サードパーティのサーバープラグインは信頼済みローカルコードであり、任意の悪意あるコードを隔離する sandbox ではありません。
