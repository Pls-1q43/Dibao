# Dibao v0.4.0 Release Notes

Release date: 2026-09-07

[简体中文](#简体中文) · [English](#english) · [日本語](#日本語)

## 简体中文

v0.4.0 让邸报可以带着一份文章副本离线阅读，也让读完一篇之后的下一步更自然：查看相关文章，或在点赞后发现更符合兴趣的内容。推荐列表翻页、断网恢复、插件权限和版本升级流程也得到加固。

### 离线阅读，由你决定何时切换

- **默认关闭，按客户端启用。** 在设置中打开离线阅读后，邸报会在联网时准备缓存。开关和数量目标只保存在当前浏览器或已安装的 PWA，不会通过账户同步到其他设备；在电脑上开启不会替手机开启。
- 自动保存已排序的未读推荐，**默认目标为 200 篇，可在 50–1,000 篇之间按 50 篇调整**。同时保留最多 200 篇稍后读副本、20 篇最近阅读副本。**200 篇仅是稍后读离线副本的上限，不是服务器稍后读列表的上限。** 这些集合会去重；实际可用数量受正文是否已取得、可用推荐及浏览器空间影响，目标不是下载保证。
- 网络中断或服务器不可达时，有缓存会提示你是否切换，而不是悄悄把在线列表换成缓存。进入后，离线横幅明确标识当前模式；状态灯可展开查看可用文章、快照时间、待同步或失败操作。联网后可从状态面板选择“退出离线模式”，完成连接检查和同步后恢复在线内容；网络恢复本身不会强制切换。重新打开应用会恢复此前选择的离线模式。
- 离线时可阅读已缓存正文，并记录收藏、喜欢、稍后读、已读和阅读进度等操作，重新连接后同步。同步失败可以重试；会话过期时需用同一账户重新登录以继续同步。关闭离线阅读、清除缓存或退出登录前，请先同步待处理操作，并留意丢失未同步操作的确认提示。
- PWA 更新会更完整地保留运行所需资源；跨标签退出登录及清理缓存时，旧的请求不能重新写回已撤销的图片缓存。

### 阅读器与推荐列表

- 正文下方可查看最多 **5 篇相关文章**，排除当前文章、与它同组的重复内容，以及已隐藏或标记为不感兴趣的文章。成功点赞后，还可看到结合个人推荐和当前文章主题的下一篇建议。
- “更多”会进入相关文章搜索，可分页并按文章状态筛选。默认从最多 500 个近邻结果中选取**相似度严格大于 0.35** 的内容，界面每页 50 篇。这个阈值只用于“更多”搜索，不能套用于下方 5 条预览；两处结果不一定完全相同。需要现有的活跃向量索引和当前文章向量；缺少条件时会提示不可用，不会为打开这个面板临时重算向量。离线模式不提供这些在线发现查询。
- 推荐翻页使用固定会话序列，减少后台重排序期间重复或漏过文章；离线翻页也不再因本地文章状态变化而跳过后续内容。已保存或打开的文章不会因滚动经过而被误当作“忽略”。
- 修复订阅源刷新可能停滞的问题，并降低升级时反复查询候选文章和全文检索的开销。升级耗时仍取决于数据规模与设备性能，不承诺固定完成时间。
- “设置 → 阅读”可控制滚动经过文章后是否自动忽略。相关文章不排除已读或已喜欢文章；个性化的“你可能还喜欢”会排除已读、已收藏和已喜欢文章。

### Sentry 诊断

错误与性能遥测默认开启，可在首次设置或设置页关闭。正式镜像包含服务端和浏览器 Sentry 配置，并在构建时上传浏览器 source maps、移除公开镜像中的 `.map` 文件。配置通过私有构建 secret 注入，不把访问 token 打包进运行镜像。发布验收检查上报与关闭后的抑制行为，只输出布尔结果和接收状态，不公开私有配置。

### 安全与使用限制

- 加固鉴权与写请求来源检查、静态资源/API 路径边界、插件桥接请求路径，以及受控出站请求的地址检查。停用插件不再提供其资源；HTML、SVG/XML 等插件资源统一受沙箱策略约束。
- 插件前端隔离不等于服务端插件沙箱。第三方服务端插件仍是可信本地代码，只安装你信任的插件。
- **除 localhost/回环地址外，可靠的 PWA 离线启动需要 HTTPS 安全上下文。** 直接通过 NAS 的 HTTP 局域网 IP 访问，不等同于具备离线 PWA 能力；请配置 HTTPS，并在准备好缓存后实际断网试读。
- 手机系统可能暂停后台页面、终止下载或回收浏览器存储，持久存储授权也不保证成功。准备缓存和同步时尽量保持应用在前台；出门前检查实际可用数量。图片尽力缓存，不保证全部图片、外链、视频或未取得的正文离线可用。首次安装尚未缓存时，不能凭空离线打开文章。
- 本机离线副本不是备份或跨设备云同步。清除站点数据、卸载 PWA 或系统回收空间都可能丢失缓存及未同步操作。

### 升级影响与迁移

从 **v0.3.1 到 v0.4.0** 新增一项 core SQLite migration：

- `027_recommendation_sessions.sql`：新增 `recommendation_sessions`、`recommendation_session_items` 及相关索引，用于保存稳定的推荐翻页序列。更早版本直接升级时，也会自动补齐此前尚未执行的迁移。

数据库迁移自动执行。对需要更新推荐数据的现有数据库，应用随后自动进入**阻塞式数据升级页面**，重放已有行为、重建兴趣画像与相关派生数据、重算符合条件的推荐文章，全部成功后清理旧推荐上下文并恢复正常界面。期间普通功能暂不可用；失败时保留错误状态，可从升级页面重试。不要删除升级标记来绕过这一步。

**本次升级不会重新计算 Embeddings，不需要为已有文章重新调用嵌入服务。** 派生数据升级复用已有向量；正常运行后新增文章的向量生成仍遵循你的 provider 设置。

### Docker 安装、备份与回滚

版本镜像：`ghcr.io/pls-1q43/dibao:v0.4.0`。新安装可使用 [中文 README 的 Compose 示例](../README.md#快速安装)。保留 `/data` 持久化挂载（例如 `./data:/data`）以及数据库路径 `/data/dibao.sqlite`，不要把数据留在容器可写层。

现有 Compose 安装先同步各客户端的离线操作，停止服务并备份整个数据目录，然后将 Compose 的 `image` 改为上述版本。以下命令适用于 `./data:/data`；使用命名 volume 或不同路径时，按实际挂载备份。

```bash
docker compose stop
tar czf "dibao-data-before-v0.4.0-$(date +%Y%m%d-%H%M%S).tgz" -C data .
# 将 compose.yaml 中的 image 改为 ghcr.io/pls-1q43/dibao:v0.4.0
docker compose pull
docker compose up -d
docker compose ps
```

不要在 SQLite 正在写入时只复制主 `.sqlite` 文件；停服后备份整个 `/data`，或使用 SQLite 一致性备份。默认 Docker 入口同时管理 HTTP 与 worker，沿用原有环境变量和挂载即可。

升级后必须分别验证：

1. `GET /api/system/health` 返回 `data.ok: true`、`data.version: "0.4.0"`。这只证明基本健康，**不证明数据升级完成**。
2. 登录后查看 `GET /api/system/upgrade/status`。现有数据的派生升级应最终返回 `data.id: "recommendation-contract"`、`data.state: "completed"`、`data.blocking: false`。全新空数据库可返回 `not_required` 且 `blocking: false`。数据库迁移期间此接口可能先返回 core migration 状态，请继续等到派生升级状态；确认升级页面退出且可正常阅读。

回滚时先停止 v0.4.0，保留失败现场，在干净的数据目录或新 volume 中恢复**升级前的完整备份**，再以原挂载路径启动之前的镜像（如 `ghcr.io/pls-1q43/dibao:v0.3.1`）。不要把旧备份覆盖到仍留有新 WAL 文件的目录，也不要直接让旧版本读取已升级的数据库。回滚会失去备份之后的新数据；服务器备份不包含各浏览器尚未同步的操作。

## English

v0.4.0 adds a local reading copy you can take offline, plus better ways to find the next article: related stories below the reader and personalized suggestions after a like. It also makes recommendation pagination, connection recovery, plugin boundaries, and version upgrades more reliable.

### Offline Reading, On Your Terms

- **Off by default, enabled per client.** Turn on offline reading in Settings while connected to prepare the cache. The switch and article target belong to the current browser or installed PWA, not your server account. Enabling it on a desktop does not enable it on your phone.
- Dibao saves ranked unread recommendations, with a **default target of 200 articles, adjustable from 50 to 1,000 in steps of 50**. It also keeps up to 200 read-later copies and 20 recently opened articles. **The 200-article limit applies only to offline read-later copies, not your server-side read-later list.** Overlapping articles are deduplicated. Available bodies, recommendation inventory, and browser storage determine the actual count; the target is not a download guarantee.
- When the network or server becomes unavailable, Dibao offers an explicit switch if cached articles are available. It does not silently replace online results with a cache. An offline banner identifies the mode; the status light opens details about cached articles, the snapshot, and pending or failed actions. Once connected, choose “Exit offline mode” in that panel to check the connection and sync before returning online. Connectivity alone does not force a switch. Reopening the app restores your previously selected offline mode.
- Read cached bodies and queue favorites, likes, read-later changes, read status, and reading progress for synchronization. Failed syncs can be retried; an expired session requires signing back into the same account. Sync pending actions before disabling offline reading, clearing the cache, or signing out, and heed the warning about losing unsynced actions.
- PWA updates retain the resources needed to reopen the app more reliably. Cross-tab sign-out and cache cleanup also prevent old requests from repopulating revoked image caches.

### Reader And Recommendations

- The reader offers up to **5 related articles**, excluding the current article, duplicates in its groups, hidden articles, and articles marked not interested. A successful like can also reveal next-read suggestions that combine your personal recommendations with the current article's topic.
- “More” opens a paginated related-article search with article-state filters. By default it considers up to 500 nearest neighbors and retains results with **similarity strictly greater than 0.35**, shown 50 per page. This threshold applies to expanded search, not the five-item preview, so the two lists need not match exactly. Discovery requires an existing active embedding index and a vector for the current article; unavailable prerequisites are reported rather than triggering on-demand embedding recomputation. These online discovery queries are unavailable in offline mode.
- Recommendation pages use a fixed session sequence to reduce duplicates and omissions when background ranking changes. Offline pagination also keeps its place as local article states change. Scrolling past a saved or opened article no longer incorrectly treats it as ignored.
- Feed refresh is less likely to stall, and upgrades avoid repeated expensive candidate and full-text queries. Upgrade duration still depends on your dataset and hardware; there is no fixed completion-time guarantee.
- Settings → Reading controls whether scrolling past an untouched article marks it ignored. Related articles may include read or liked items; personalized next-read suggestions exclude read, favorited, and liked items.

### Sentry Diagnostics

Error and performance telemetry is enabled by default and can be disabled during setup or in Settings. Release images include server and browser Sentry configuration. Browser source maps are uploaded during the build and `.map` files are removed from the public image. Configuration comes from a private build secret; the authorization token is not included in the runtime image. Release checks verify reporting and opt-out suppression, exposing only booleans and acceptance status rather than private settings.

### Security And Limits

- Hardened authentication and write-request origin checks, static/API path boundaries, plugin bridge paths, and address validation for controlled outbound requests. Disabled plugins no longer serve assets; plugin documents, including HTML and SVG/XML, receive sandbox protection.
- Frontend plugin isolation is not a server-side plugin sandbox. Third-party server plugins remain trusted local code; install only plugins you trust.
- **Outside localhost/loopback, reliable PWA offline startup requires an HTTPS secure context.** Opening a NAS through a plain HTTP LAN address is not equivalent to having an offline-capable PWA. Configure HTTPS, prepare the cache, and test with the network disconnected.
- Mobile operating systems can suspend background pages, interrupt downloads, or reclaim browser storage. Persistent-storage permission may not be granted. Keep the app in the foreground while preparing or syncing and check the available article count before leaving. Images are cached on a best-effort basis; external links, videos, every image, and bodies not yet fetched are not guaranteed offline. A fresh installation without a prepared cache cannot open uncached articles offline.
- Local copies are neither a backup nor cross-device cloud sync. Clearing site data, uninstalling the PWA, or storage eviction can remove cached content and unsynced actions.

### Upgrade Impact And Migrations

There is one new core SQLite migration from **v0.3.1 to v0.4.0**:

- `027_recommendation_sessions.sql` adds `recommendation_sessions`, `recommendation_session_items`, and indexes for stable recommendation pagination. Direct upgrades from older releases also apply any earlier pending migrations automatically.

Database migrations run automatically. Existing databases that need updated recommendation data then enter an **automatic blocking data-upgrade screen**. Dibao replays existing behavior, rebuilds interest profiles and related derived data, recalculates eligible recommendations, and removes superseded recommendation contexts only after success. Normal features remain unavailable until this completes. Failures remain visible and can be retried from the upgrade screen; do not delete upgrade markers to bypass the process.

**This upgrade does not recompute embeddings or require new embedding-service calls for existing articles.** It reuses stored vectors. After normal operation resumes, embedding generation for new articles still follows your provider settings.

### Docker Installation, Backup, And Rollback

Version image: `ghcr.io/pls-1q43/dibao:v0.4.0`. For a new installation, use the [English README Compose example](../README.en.md#quick-install). Persist `/data`, for example with `./data:/data`, and keep the database at `/data/dibao.sqlite`; do not store your only copy in the container's writable layer.

For an existing Compose installation, sync offline actions on each client, stop the service, back up the whole data directory, and update the Compose image tag. These commands assume `./data:/data`; adapt the backup for a named volume or another path.

```bash
docker compose stop
tar czf "dibao-data-before-v0.4.0-$(date +%Y%m%d-%H%M%S).tgz" -C data .
# Set compose.yaml image to ghcr.io/pls-1q43/dibao:v0.4.0
docker compose pull
docker compose up -d
docker compose ps
```

Do not copy only the main `.sqlite` file while SQLite is writing. Stop the service and back up all of `/data`, or use a consistent SQLite backup. The default Docker entrypoint manages both HTTP and worker processes; retain existing environment settings and mounts.

Verify both conditions after upgrading:

1. `GET /api/system/health` returns `data.ok: true` and `data.version: "0.4.0"`. This proves basic health, **not completion of the data upgrade**.
2. While signed in, check `GET /api/system/upgrade/status`. An existing-data upgrade should finish with `data.id: "recommendation-contract"`, `data.state: "completed"`, and `data.blocking: false`. A fresh empty database may report `not_required` with `blocking: false`. During schema migration, this endpoint may first report core migration status; continue until it reports the derived-data result. Confirm the upgrade screen closes and normal reading works.

To roll back, stop v0.4.0, preserve the failed installation for diagnosis, restore the **complete pre-upgrade backup** into a clean directory or new volume, and start the previous image, such as `ghcr.io/pls-1q43/dibao:v0.3.1`, with that restored mount. Do not overlay an old backup onto a directory containing newer WAL files, or run an older image against the upgraded database. Rollback loses changes made after the backup; server backups do not contain unsynced browser actions.

## 日本語

v0.4.0 では、記事を端末に保存してオフラインで読めるようになりました。本文の下から関連記事を探したり、「いいね」の後に興味に合った次の記事を見つけたりできます。おすすめ一覧のページ送り、接続の復旧、プラグインの権限境界、バージョンアップ時の処理も改善しました。

### オフラインへの切り替えは自分で選べます

- **初期設定は無効で、端末ごとに有効にします。** オンラインの状態で設定からオフライン閲覧を有効にすると、記事の保存が始まります。スイッチと保存目標数は現在のブラウザまたはインストール済み PWA に保存され、アカウント経由では同期されません。パソコンで有効にしても、スマートフォンでは別途設定が必要です。
- 順位付け済みの未読のおすすめ記事を、**初期目標 200 件、50〜1,000 件の範囲で 50 件刻み**に保存できます。「あとで読む」は最大 200 件、最近開いた記事は最大 20 件を別途保存します。**200 件という制限は「あとで読む」のオフラインコピーだけに適用され、サーバー側の一覧の上限ではありません。** 重複する記事はまとめられます。実際の保存数は取得済みの本文、おすすめ記事の数、ブラウザの空き容量によって変わります。
- ネットワークやサーバーに接続できないときは、保存済みの記事があれば切り替えを確認します。オンライン一覧を無断でキャッシュに置き換えることはありません。切り替え後はバナーでオフラインであることを示し、ステータス表示から保存件数、保存日時、未同期・同期失敗の操作を確認できます。接続が戻ったら、同じパネルの「オフラインモードを終了」から接続確認と同期を行ってオンラインに戻ります。回線が戻っただけでは強制的に切り替わりません。アプリを開き直した場合も、前回選んだオフラインモードを引き継ぎます。
- 保存済みの本文を読み、お気に入り、いいね、あとで読む、既読状態、読書の進み具合などを記録して、再接続後に同期できます。失敗した同期は再試行でき、セッションの期限が切れた場合は同じアカウントで再ログインして続行します。オフライン閲覧の無効化、キャッシュの削除、ログアウトの前に同期を済ませ、未同期の操作が失われる旨の確認に注意してください。
- PWA 更新時のアプリ資源の保持を改善しました。別タブでのログアウトやキャッシュ削除後に、古いリクエストが無効になった画像キャッシュを書き戻すことも防ぎます。

### 読書画面とおすすめ一覧

- 本文の下に最大 **5 件の関連記事**を表示できます。現在の記事、それと同じグループの重複記事、非表示の記事、「興味なし」にした記事は除外します。「いいね」が成功した後には、個人のおすすめと今読んでいる記事の話題を組み合わせた候補も表示できます。
- 「もっと見る」から関連記事検索に進み、ページ送りや記事の状態による絞り込みができます。初期設定では最大 500 件の近傍候補から、**類似度が 0.35 を超える**記事を選び、1 ページ 50 件で表示します。このしきい値は検索側のもので、本文下の 5 件のプレビューには適用されません。両方の結果が必ず一致するわけではありません。有効な埋め込み索引と現在の記事のベクトルが必要です。条件がそろっていない場合は利用できないことを表示し、その場でベクトルを再計算することはありません。オフラインモードではこれらのオンライン検索は利用できません。
- おすすめのページ送りに固定されたセッション内の順序を使い、バックグラウンドで順位が変わったときの重複や読み飛ばしを減らしました。オフラインでも記事の状態変更によって次のページが飛ぶ問題を修正しています。保存済み・閲覧済みの記事をスクロールで通過しても、誤って「無視した」と扱わなくなりました。
- フィード更新が止まる問題を修正し、アップグレード中に候補記事や全文検索を何度も重く処理する負担を減らしました。所要時間は記事数や端末性能によって変わるため、一定時間での完了を保証するものではありません。
- 「設定 → 読書」から、未操作の記事をスクロールで通過した際に無視扱いにするかを選べます。関連記事には既読や「いいね」済みの記事も含まれますが、個人向けの次の記事候補からは既読・お気に入り・「いいね」済みの記事を除外します。

### Sentry による診断

エラーと性能のテレメトリーは初期設定で有効ですが、初回設定または設定画面で無効にできます。正式イメージにはサーバーとブラウザの Sentry 設定を含めます。ブラウザのソースマップはビルド時にアップロードし、公開イメージから `.map` ファイルを除去します。設定は非公開のビルド secret から渡し、認証 token は実行用イメージに含めません。リリース検証では送信と無効化後の抑止を確認し、非公開の設定値ではなく真偽値と受信結果だけを報告します。

### セキュリティと制限

- 認証、書き込みリクエストの送信元確認、静的ファイルと API のパス境界、プラグイン経由のリクエスト、外部取得先のアドレス検証を強化しました。無効化したプラグインの資源は配信されず、HTML や SVG/XML を含むプラグイン資源にはサンドボックス制約が適用されます。
- フロントエンドの隔離は、サーバー側プラグインのサンドボックスを意味しません。サードパーティのサーバープラグインは信頼済みのローカルコードとして動くため、信頼できるものだけを導入してください。
- **localhost・ループバック以外で PWA を確実にオフライン起動するには、HTTPS の安全なコンテキストが必要です。** NAS の LAN IP に HTTP でアクセスできるだけでは、オフライン PWA が使えるとは限りません。HTTPS を設定し、保存完了後に実際に回線を切って確認してください。
- スマートフォンでは、OS がバックグラウンドのページを停止したり、ダウンロードを中断したり、保存領域を回収したりすることがあります。永続保存の許可が得られない場合もあります。保存・同期中はできるだけアプリを前面に置き、外出前に利用可能な件数を確認してください。画像は可能な範囲で保存しますが、すべての画像、外部リンク、動画、未取得の本文のオフライン利用は保証しません。新規インストール直後で保存が済んでいなければ、未保存の記事をオフラインで開くことはできません。
- 端末内のコピーはバックアップや端末間クラウド同期ではありません。サイトデータの削除、PWA のアンインストール、OS による領域回収で、保存内容や未同期の操作が失われる場合があります。

### アップグレードとデータ移行

**v0.3.1 から v0.4.0** への新しい SQLite マイグレーションは 1 件です。

- `027_recommendation_sessions.sql`：安定したおすすめのページ送りのため、`recommendation_sessions`、`recommendation_session_items` と索引を追加します。古いバージョンから直接更新する場合は、それ以前の未適用のマイグレーションも自動で実行します。

データベース移行は自動で実行されます。おすすめ用データの更新が必要な既存データベースでは、続いて**専用のデータ更新画面**が開き、通常機能を一時的に停止します。既存の行動履歴を再処理し、興味のプロフィールと関連する派生データを再構築して、対象記事の順位を計算します。すべて成功してから古い推薦コンテキストを整理し、通常画面に戻ります。失敗した場合はエラーが残り、画面から再試行できます。更新状態を削除して処理を回避しないでください。

**このアップグレードで埋め込みベクトルを再計算することはなく、既存記事のために埋め込みサービスを呼び直す必要はありません。** 保存済みのベクトルを再利用します。通常動作に戻った後の新着記事のベクトル生成は、従来どおり設定に従います。

### Docker の導入・バックアップ・ロールバック

バージョン指定イメージは `ghcr.io/pls-1q43/dibao:v0.4.0` です。新規導入には [日本語 README の Compose 例](../README.ja.md#クイックインストール)を使えます。`./data:/data` などで `/data` を永続化し、データベースを `/data/dibao.sqlite` に保持してください。コンテナ内だけにデータを保存しないでください。

既存の Compose 環境では、各端末の未同期操作を同期してからサービスを停止し、データディレクトリ全体をバックアップして、イメージのタグを変更します。以下は `./data:/data` の例です。名前付き volume や別のパスを使っている場合は、実際の保存先に合わせてください。

```bash
docker compose stop
tar czf "dibao-data-before-v0.4.0-$(date +%Y%m%d-%H%M%S).tgz" -C data .
# compose.yaml の image を ghcr.io/pls-1q43/dibao:v0.4.0 に変更
docker compose pull
docker compose up -d
docker compose ps
```

SQLite が書き込み中の状態で、主 `.sqlite` ファイルだけをコピーしないでください。停止後に `/data` 全体を保存するか、SQLite の整合性が保たれるバックアップ方法を使います。標準の Docker 起動処理は HTTP と worker の両プロセスを管理します。既存の環境変数とマウント設定は引き継いでください。

更新後は、次の両方を確認します。

1. `GET /api/system/health` が `data.ok: true` と `data.version: "0.4.0"` を返すこと。これは基本的な稼働確認であり、**データ更新の完了確認ではありません**。
2. ログインした状態で `GET /api/system/upgrade/status` を確認します。既存データの更新では、最終的に `data.id: "recommendation-contract"`、`data.state: "completed"`、`data.blocking: false` になる必要があります。新規の空データベースでは `not_required` と `blocking: false` でも正常です。スキーマ移行中は先に core migration の状態が返る場合があるため、派生データ更新の結果まで確認してください。更新画面が閉じ、通常の読書ができることも確認します。

戻す場合は v0.4.0 を停止して障害時のデータを別途保管し、空のディレクトリまたは新しい volume に**更新前の完全なバックアップ**を復元します。その保存先をマウントして、以前のイメージ（例：`ghcr.io/pls-1q43/dibao:v0.3.1`）を起動してください。新しい WAL ファイルが残る場所に古いバックアップを重ねたり、移行済みデータベースを旧バージョンで直接開いたりしないでください。バックアップ後の変更は失われます。サーバーのバックアップには、各ブラウザの未同期操作は含まれません。
