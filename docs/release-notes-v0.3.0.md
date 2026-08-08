# Dibao v0.3.0 Release Notes

Dibao v0.3.0 is a larger feature release centered on a major recommendation-algorithm and recommendation-mechanism update. It introduces the recommendation v3 memory foundation, stronger ranking isolation, recommendation inventory visibility, safer fallback behavior, infinite article loading, full-content extraction plugins, and several security and performance hardening changes.

Release date: 2026-08-08

## 简体中文

v0.3.0 是一次围绕“推荐算法与机制大更新”的大版本发布。推荐系统现在更强调稳定的已排序库存、清晰的 fallback 边界、负面主题与主题组约束，以及更低干扰的后台排序机制；阅读器也加入了无限加载、推荐库存状态提示、全文抓取插件与多处交互收口。

### 主要变化

- 推荐 v3 memory 基础：新增用户表示快照、推荐曝光记录和探索尝试记录，为后续更稳定的长期兴趣记忆与探索反馈打基础。
- 推荐排序机制重构：推荐列表更严格使用当前 active rank context，避免旧上下文或 fallback 序列过早混入；fallback 分页被限制在较小批次，降低“突然像未排序列表”的体感。
- 负面主题簇与主题组约束修复：负面主题、金融/交易日等不想看的主题标记更可靠地参与过滤和降权。
- 推荐库存状态提示：未读推荐页新增库存/排序状态提示，帮助判断当前是在消费已排序库存、等待排序，还是临时进入备用序列。
- 推荐相关性能优化：阅读、滚动、文章操作不再同步触发重排序、透明度诊断或重型写入；后台排序与前台交互的耦合进一步降低。
- 无限加载：可在设置中开启，推荐、最新、收藏、稍后读和搜索结果滚动到底部时自动加载下一批；失败时停止自动重试并保留手动重试入口。
- 文章详情体验：顶部“返回列表”和“原文”按钮布局收口，详情加载失败时提供重新加载入口。
- 插件与全文抓取：官方插件系统继续完善，新增全文抓取扩展点与官方全文选择器插件；Webhook 插件支持 secrets、deliveries 和运行状态。
- 出站请求安全加固：受控 fetch 会在真实连接中使用已校验 IP，降低 DNS rebinding / TOCTOU SSRF 风险；跨源重定向会剥离敏感 header，并避免 POST body 被意外转发到跳转目标。
- Docker 与后台任务稳定性：修复跨平台 Docker 构建、后台 worker 保活、SQLite 排序写入与 core migration checksum 流式校验等长期运行问题。

### 升级影响

从 v0.2.1 升级到 v0.3.0 会新增推荐 v3 memory 相关数据库结构。升级会在应用启动时自动运行 core migration；升级前仍建议备份 `/data/dibao.sqlite` 或整个 Docker volume。

本次升级不会要求重新计算 Embeddings。v0.3 会在现有文章、行为事件、兴趣簇和已存在向量的基础上继续工作；新的推荐记忆和曝光数据会在升级后随使用逐步积累。

升级后建议检查：

```text
GET /api/system/health
```

返回 `ok: true` 和 `version: "0.3.0"` 表示基础健康检查通过。进入推荐页后，如果推荐库存状态提示显示正在排序，可以等待后台任务补充排序库存。

### Docker 安装与升级

推荐镜像：

```yaml
image: ghcr.io/pls-1q43/dibao:v0.3.0
```

保留原有 `/data` volume，替换镜像并重启即可。默认入口会启动 HTTP 进程和独立 worker 进程。若你维护自定义 Compose 文件，请继续保留持久化数据目录，并确保环境变量与 0.2.x 相比没有遗漏。

升级前建议：

```text
备份 /data/dibao.sqlite 或整个 Docker volume
```

如需回滚，请先停止 v0.3.0 容器，用升级前备份恢复 SQLite 数据库和 `/data` volume，再启动上一版镜像。不要直接用已迁移到 0.3.0 的数据库启动旧版本。

### Migration List

从 v0.2.1 到 v0.3.0 新增 1 个 core SQLite migration：

- `026_recommendation_v3_memory.sql`：新增 `user_representation_snapshots`、`recommendation_exposures`、`exploration_attempts`，并为 `article_rank_scores` 增加探索相关字段。

### Sentry 发布校验

正式 Docker 镜像使用 BuildKit secret `dibao_sentry_config` 注入私有 Sentry 配置。发布验证只报告 `hasDsn`、`hasOrg`、`hasProject` 等布尔结果，不公开 DSN、org、project 或 token。

### 已知限制

- 推荐 v3 memory 是基础设施更新，不代表所有长期记忆策略都已完成产品化；推荐质量仍会随使用和后台排序逐步稳定。
- 当已排序推荐库存耗尽时，系统仍可能临时使用备用序列，但 v0.3.0 会更明确地限制和提示这一状态。
- 第三方服务端插件仍是可信本地代码，不是任意恶意代码沙箱。

## English

v0.3.0 is a major release focused on a recommendation-algorithm and recommendation-mechanism update. The recommendation system now has a stronger v3 memory foundation, clearer active-ranking isolation, safer fallback behavior, better visibility into recommendation inventory, and a lower-latency interaction path. The reader also gains infinite loading, full-content extraction plugins, and several security and reliability improvements.

### Highlights

- Recommendation v3 memory foundation: added user representation snapshots, recommendation exposures, and exploration attempts to support more stable long-term interest memory and feedback loops.
- Ranking and fallback isolation: recommended lists now stay closer to the active rank context, with fallback pages capped to avoid large unsorted batches taking over the reading experience.
- Negative topic and family filtering fixes: negative clusters and topic groups, including finance/trading-day style topics, are applied more reliably.
- Recommendation inventory status: the unread recommendation view can show whether sorted inventory is available, empty, or currently being replenished.
- Interaction performance improvements: article opening, scrolling, and actions avoid synchronous reranking, heavy transparency diagnostics, and broad writes on the hot path.
- Infinite loading: optional automatic pagination for recommendations, latest articles, favorites, read-later, and search results, with failure pause and manual retry behavior.
- Reader polish: article detail actions were aligned, and failed detail loads now expose an explicit reload entry.
- Plugins and full-content extraction: official plugin infrastructure now includes full-content extractor support and a selector-based official extraction plugin; Webhook support includes secrets, deliveries, and runtime state.
- Safer outbound fetches: controlled fetch now uses the validated IP for the actual connection, reducing DNS rebinding / TOCTOU SSRF risk. Cross-origin redirects strip sensitive headers and avoid forwarding POST bodies unexpectedly.
- Docker and worker stability: improved cross-platform Docker builds, worker keepalive behavior, SQLite ranking writes, and streaming checksum verification for core migrations.

### Upgrade Impact

Upgrading from v0.2.1 to v0.3.0 adds recommendation v3 memory database structures. Core migrations run automatically on startup. Back up `/data/dibao.sqlite` or the whole Docker volume before upgrading.

This upgrade does not require embedding recomputation. v0.3 continues from existing articles, behavior events, interest clusters, and vectors; new recommendation memory and exposure data accumulate after upgrade.

After upgrading, verify:

```text
GET /api/system/health
```

The response should include `ok: true` and `version: "0.3.0"`. If the recommendation inventory indicator says sorting is in progress, wait for background jobs to replenish sorted inventory.

### Docker Install And Upgrade

Recommended image:

```yaml
image: ghcr.io/pls-1q43/dibao:v0.3.0
```

Keep the existing `/data` volume, replace the image, and restart. The default entrypoint starts both the HTTP process and a separate worker process. If you maintain a custom Compose file, keep your persistent data volume and carry forward existing environment settings.

Before upgrading:

```text
Back up /data/dibao.sqlite or the whole Docker volume.
```

To roll back, stop the v0.3.0 container, restore the pre-upgrade SQLite database and `/data` volume backup, then start the previous image. Do not start an older version against a database already migrated to v0.3.0.

### Migration List

From v0.2.1 to v0.3.0, one core SQLite migration is added:

- `026_recommendation_v3_memory.sql`: adds `user_representation_snapshots`, `recommendation_exposures`, `exploration_attempts`, and exploration fields on `article_rank_scores`.

### Sentry Release Verification

The formal Docker image is built with the private Sentry config injected through the BuildKit secret `dibao_sentry_config`. Verification reports only booleans such as `hasDsn`, `hasOrg`, and `hasProject`; it does not expose DSN, org, project, or tokens.

### Known Limitations

- Recommendation v3 memory is a foundation update; not every long-term memory strategy is fully productized yet. Recommendation quality should stabilize as usage and background ranking continue.
- When sorted recommendation inventory is exhausted, Dibao may still temporarily use a fallback sequence, but v0.3.0 limits and communicates that state more clearly.
- Third-party server plugins are trusted local code, not an arbitrary malicious-code sandbox.

## 日本語

v0.3.0 は「推薦アルゴリズムと推薦メカニズムの大幅更新」を中心にしたメジャーリリースです。推薦 v3 memory の基盤、active ranking の分離、fallback の制御、推薦在庫の可視化、低遅延な読書操作を強化しました。リーダーには無限ロード、全文取得プラグイン、セキュリティと安定性の改善も入っています。

### 主な変更

- 推薦 v3 memory 基盤: user representation snapshot、推薦 exposure、探索 attempt を追加し、長期的な興味記憶とフィードバックの土台を作りました。
- ランキングと fallback の分離: 推薦リストは active rank context をより厳密に使い、fallback が大量の未排序リストとして読書体験を覆うことを抑えます。
- ネガティブ topic / family フィルタの修正: 金融・取引日系など、見たくない topic cluster や topic group の降格・除外がより確実に働きます。
- 推薦在庫ステータス: 未読推薦画面で、排序済み在庫があるか、空か、バックグラウンドで排序中かを確認できます。
- 操作パフォーマンス改善: 記事を開く、スクロールする、記事アクションを行う経路では、同期的な再排序、重い診断、広範囲の書き込みを避けます。
- 無限ロード: 推薦、最新、收藏、あとで読む、検索結果で任意の自動ページングを利用できます。失敗時は自動再試行を止め、手動 retry を残します。
- リーダーの改善: 記事詳細の上部ボタン配置を整理し、詳細ロード失敗時に再読み込み導線を追加しました。
- プラグインと全文取得: 公式プラグイン基盤に全文取得 extractor を追加し、selector ベースの公式全文取得プラグインを提供します。Webhook は secrets、deliveries、runtime state に対応しました。
- outbound fetch の安全性強化: controlled fetch は検証済み IP を実際の接続にも使い、DNS rebinding / TOCTOU SSRF リスクを下げます。cross-origin redirect では sensitive header を削除し、POST body の意図しない転送も避けます。
- Docker と worker の安定化: cross-platform Docker build、worker keepalive、SQLite ranking writes、core migration checksum の streaming 検証を改善しました。

### アップグレード影響

v0.2.1 から v0.3.0 へのアップグレードでは、推薦 v3 memory 関連のデータベース構造が追加されます。core migration は起動時に自動実行されます。アップグレード前に `/data/dibao.sqlite` または Docker volume 全体をバックアップしてください。

このアップグレードでは Embeddings の再計算は不要です。既存の記事、行動イベント、興味 cluster、vector を引き継ぎ、新しい推薦 memory と exposure データはアップグレード後の利用に合わせて蓄積されます。

アップグレード後は次を確認してください。

```text
GET /api/system/health
```

レスポンスに `ok: true` と `version: "0.3.0"` が含まれていれば基本確認は通っています。推薦在庫ステータスが排序中を示す場合は、バックグラウンドジョブが排序済み在庫を補充するまで待ってください。

### Docker インストール / アップグレード

推奨 image:

```yaml
image: ghcr.io/pls-1q43/dibao:v0.3.0
```

既存の `/data` volume を維持し、image を差し替えて再起動してください。既定の entrypoint は HTTP プロセスと独立 worker プロセスを起動します。独自 Compose を使っている場合は、永続 data volume と既存の環境変数を引き継いでください。

アップグレード前:

```text
/data/dibao.sqlite または Docker volume 全体をバックアップしてください。
```

ロールバックする場合は v0.3.0 コンテナを停止し、アップグレード前の SQLite database と `/data` volume backup を復元してから前の image を起動してください。v0.3.0 に migration 済みの database を旧バージョンで直接起動しないでください。

### Migration List

v0.2.1 から v0.3.0 では、core SQLite migration が 1 件追加されます。

- `026_recommendation_v3_memory.sql`: `user_representation_snapshots`、`recommendation_exposures`、`exploration_attempts` を追加し、`article_rank_scores` に探索関連フィールドを追加します。

### Sentry リリース検証

正式 Docker image は BuildKit secret `dibao_sentry_config` で private Sentry 設定を注入してビルドします。検証結果は `hasDsn`、`hasOrg`、`hasProject` などの boolean のみを報告し、DSN、org、project、token は公開しません。

### 既知の制限

- 推薦 v3 memory は基盤更新であり、長期記憶戦略のすべてが完全に製品化されたわけではありません。推薦品質は利用とバックグラウンド排序に合わせて安定していきます。
- 排序済み推薦在庫が尽きた場合、一時的に fallback sequence を使うことがあります。ただし v0.3.0 では、その状態をより制限し、分かりやすく表示します。
- サードパーティのサーバープラグインは信頼済みローカルコードであり、任意の悪意あるコードを隔離する sandbox ではありません。
