# Dibao v0.4.1 Release Notes

Release date: 2026-10-11

[简体中文](#简体中文) · [English](#english) · [日本語](#日本語)

## 简体中文

v0.4.1 首次带来 Windows 和 macOS 独立桌面版：不用部署服务器，安装后就能在本机使用邸报。桌面版沿用现有阅读器、订阅管理和推荐功能，新增托盘后台运行、本地离线阅读、数据备份恢复和桌面更新；首次设置、退出保存和数据恢复体验也得到完善。原有 Docker、网页与 PWA 部署继续保留。

### 新增功能

- **独立桌面版。** 提供 Windows x64 安装程序、Intel Mac 和 Apple Silicon Mac 拖拽安装包，内置运行环境，无需另外安装 Node.js、Docker 或数据库。首次使用仍需创建账号密码，AI 服务按需配置，不捆绑模型。
- **托盘与后台运行。** 关闭窗口后继续抓取订阅源，可从系统托盘或菜单栏重新打开阅读器，选择“退出”才停止应用。“登录系统时在后台启动”默认关闭；启用后静默运行，不自动弹出窗口。
- **桌面本地离线阅读。** 互联网断开时，仍可打开阅读器、阅读本机已保存的文章并记录阅读状态，不需要切换到 PWA 的离线缓存子集。抓取新文章、加载未保存的外部资源和调用 AI 仍需联网。
- **手动备份与恢复。** “设置 → 关于 → 数据备份与恢复”可创建完整备份、按日期选择恢复点，并查看操作结果。备份包括订阅、文章与阅读状态、设置、已有向量、插件数据和密钥，以及登录与客户端状态；确认后重启完成操作。恢复前会另存当前数据，恢复点之后的修改可能回退。
- **桌面更新与升级保护。** 在“设置 → 关于”检查新版本。Windows 支持确认下载后再“重启并更新”；macOS 当前通过下载新 DMG、完全退出后覆盖应用更新。新版本先备份再升级，备份失败不会继续改动数据；普通退出不会自动安装更新，稳定渠道不接收预发布版本，也不会自动降级。

### 改进

- **首次设置更灵活。** 欢迎页可先选择简体中文、日本語或 English，后续设置、插件和阅读器沿用该语言。订阅源可选择“稍后添加”，不必先添加 RSS 或导入 OPML 才能完成设置。
- **安装与数据分离。** 更换安装目录、覆盖安装、重装和默认卸载不会主动删除本机数据；“设置 → 关于”可直接打开数据目录。默认保留最近三份成功的升级前自动备份，手动备份与恢复前快照不自动删除。
- **桌面与自托管界面分开。** 桌面界面不再标注“内测版”。备份恢复、数据目录、登录启动和应用安装等桌面操作只在 Desktop 显示；Docker、网页与 PWA 保留原有阅读和离线功能，不增加桌面专属入口。

### 修复

- **备份与恢复操作没有明确反馈。** 补齐确认、执行中、取消、完成和失败提示；没有可用备份时明确禁用恢复，避免点击后像是没有反应。
- **损坏备份影响正常恢复。** 单个损坏备份不再阻塞其他有效恢复点；恢复中断后会先校验完整性，再替换现有数据，拒绝缺失数据库、路径异常或文件被改动的备份。
- **启动时误判已有数据。** 修复把系统新生成的浏览器配置当作已有数据库的问题。已使用过的数据库缺失或为空时，会停止启动并引导恢复，不再悄悄新建空库；恢复前保留残余文件。
- **Windows 恢复后无法正常启动。** 将冷备份、恢复和版本检查移到浏览器打开数据目录之前，避免目录锁和启动写入干扰恢复；不改变原有登录数据路径。
- **退出与更新时的写入冲突。** 退出前保存待提交的阅读进度，停止后台任务和插件进程，再关闭数据库；有未保存设置或正在进行数据升级时，阻止不安全的备份、恢复与更新操作。
- **安全与运行依赖。** 更新有安全修复的 HTTP 和运行依赖，清理 Docker 镜像中不需要的包管理工具；加固桌面权限调用和插件边界，防止外部页面调用桌面特权操作。Docker 运行镜像不包含 Electron 或桌面运行进程。

### 升级影响与迁移

从 **v0.4.0 到 v0.4.1** 无新增 SQL 迁移，无新增强制派生数据重算，**不会重新计算 Embeddings**。更早版本直接升级时，仍会自动执行尚未应用的历史迁移和必要的数据升级。桌面版的数据备份与版本保护只作用于本机数据，不会自动导入群晖或其他部署的数据。

### 下载与升级

- [Windows x64 EXE 安装程序](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-win-x64.exe)
- [macOS Intel DMG 拖拽安装包](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-x64.dmg)
- [macOS Apple Silicon DMG 拖拽安装包](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-arm64.dmg)
- Docker：`ghcr.io/pls-1q43/dibao:v0.4.1`，支持 `linux/amd64` 和 `linux/arm64`。

桌面数据位于 Windows 的 `%LOCALAPPDATA%\Dibao` 或 macOS 的 `~/Library/Application Support/Dibao`。安装、更新与恢复步骤见[桌面版说明](https://github.com/Pls-1q43/Dibao/blob/v0.4.1/docs/desktop-install.md)。以后正式 Release 同样提供上述三种安装包及 Docker 镜像。

Docker 新安装见 [Compose 示例](https://github.com/Pls-1q43/Dibao/blob/v0.4.1/README.md#快速安装)。升级前先同步各客户端的离线操作，停止旧容器并备份整个 `/data`，不要只复制 SQLite 主文件。保留原数据卷和环境变量，将镜像改为 `v0.4.1` 后运行 `docker compose pull && docker compose up -d`。检查 `/api/system/health` 的 `data.ok: true`、`data.version: "0.4.1"`，并确认登录后的 `/api/system/upgrade/status` 已完成或不需要升级、`blocking: false`。

回滚时停止新版本，在干净目录或新 volume 中恢复完整的升级前备份，再启动旧镜像；不要让旧版直接打开新数据，也不要覆盖仍有新 WAL 文件的目录。

### 已知限制

- 安装包尚未签名，系统可能警告或阻止首次运行。仅使用本 Release 的下载，按系统提示确认，不要关闭系统安全校验。macOS 暂不支持应用内自动安装，未签名登录项也可能注册失败。
- 暂不支持 Windows ARM 原生版、群晖数据迁入、远程实例连接或多端同步。桌面离线阅读使用本机数据库，不是与服务器之间的离线同步。
- 第三方服务端插件仍是可信本地代码，只安装你信任的插件。尚无上游修复的依赖告警及检查范围见[发布审计报告](https://github.com/Pls-1q43/Dibao/blob/main/docs/release-audit-v0.4.1.md)。

## English

v0.4.1 introduces standalone Windows and macOS desktop apps: install Dibao and use it locally without deploying a server. Desktop keeps the existing reader, feeds and recommendations, and adds tray-based background operation, local offline reading, backup and recovery, and desktop updates. First-run setup, shutdown saves and recovery are also improved. Docker, Web and PWA deployments remain available.

### New Features

- **Standalone desktop apps.** Windows x64 EXE, Intel Mac DMG and Apple Silicon Mac DMG installers include the runtime; no separate Node.js, Docker or database installation is needed. Create an account on first use. AI services are optional and no models are bundled.
- **Tray and background operation.** Closing the window keeps feed fetching active. Reopen the reader from the system tray or menu bar; choose Quit to stop the app. Launch at login is off by default and, when enabled, runs silently without opening a window.
- **Local offline reading.** Open the reader, read articles already stored on this computer and record reading state without internet. Desktop does not switch to a PWA cache subset. New feed fetches, unsaved external resources and AI services still need network access.
- **Manual backup and recovery.** Settings → About → Backup and recovery can create a complete backup, select a dated restore point and show operation results. Backups include feeds, articles and reading state, settings, existing vectors, plugin data and keys, and login/client state. Confirm and restart to complete the operation. Recovery saves the current data separately first; changes made after the restore point may be rolled back.
- **Desktop updates and upgrade protection.** Check for updates in Settings → About. On Windows, confirm the download and then Restart and update. On Mac, download the new DMG, quit fully and replace the app. Upgrades back up data first and stop if backup fails. Normal quit does not install updates; stable users do not receive prereleases and automatic downgrade is disabled.

### Improvements

- **More flexible setup.** Choose Simplified Chinese, Japanese or English on the welcome screen; setup, plugins and the reader retain it. Add later skips RSS/OPML setup so a feed is not required to finish onboarding.
- **Data independent of installation.** Moving the installation, replacement installs, reinstalls and normal uninstall do not intentionally delete local data. Open the data folder from Settings → About. The three latest successful pre-upgrade backups are retained; manual backups and pre-restore snapshots are not automatically deleted.
- **Separate desktop and self-hosted controls.** Desktop no longer carries a test-build label. Backup, data-folder, login-startup and app-install controls appear only in Desktop. Docker, Web and PWA keep their reading and offline workflows without desktop-only entries.

### Fixes

- **Unclear backup/recovery feedback.** Added confirmation, working, cancellation, completion and failure states. Restore is explicitly disabled when no valid backup is available, instead of appearing unresponsive.
- **Damaged backups blocking recovery.** One damaged snapshot no longer prevents access to healthy restore points. Interrupted recovery verifies integrity before replacing live data and rejects missing databases, invalid paths or altered files.
- **Incorrect startup data detection.** Newly generated browser preferences are no longer mistaken for an existing database. If a previously used database is missing or empty, startup stops and offers recovery rather than silently creating an empty replacement. Residual files are preserved before recovery.
- **Windows failing to start after recovery.** Cold backup, recovery and version checks now finish before the browser opens its data directory, avoiding directory locks and startup writes during recovery. Existing login-data paths are unchanged.
- **Write conflicts during quit and update.** Pending reading progress is saved, background tasks and plugin processes stop, then the database closes. Unsaved settings or an active data upgrade block unsafe backup, recovery and update actions.
- **Security and runtime dependencies.** Updated HTTP/runtime dependencies with security fixes and removed unused package-manager tools from Docker images. Hardened desktop permission and plugin boundaries so external pages cannot invoke privileged desktop operations. Docker runtime images contain neither Electron nor the desktop service runtime.

### Upgrade Impact And Migrations

From **v0.4.0 to v0.4.1**: no new SQL migrations or mandatory derived-data rebuilds, and **no embedding recomputation**. Direct upgrades from earlier releases still apply pending historical migrations and required data upgrades. Desktop backup/version protection applies to this computer's data; it does not automatically import a NAS or another deployment.

### Downloads And Upgrade

- [Windows x64 EXE installer](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-win-x64.exe)
- [Intel Mac drag-and-drop DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-x64.dmg)
- [Apple Silicon Mac drag-and-drop DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-arm64.dmg)
- Docker: `ghcr.io/pls-1q43/dibao:v0.4.1`, `linux/amd64` and `linux/arm64`.

Desktop data lives in `%LOCALAPPDATA%\Dibao` on Windows or `~/Library/Application Support/Dibao` on Mac. See the [desktop guide](https://github.com/Pls-1q43/Dibao/blob/v0.4.1/docs/desktop-install.md#english) for installation, updates and recovery. Future formal releases will also include all three installers and Docker.

For a new Docker installation, use the [Compose example](https://github.com/Pls-1q43/Dibao/blob/v0.4.1/README.en.md#quick-install). Before upgrading, sync pending client offline actions, stop the old container and back up the entire `/data`, not only SQLite's main file. Keep the existing volume and environment, set the image to `v0.4.1`, then run `docker compose pull && docker compose up -d`. Check `/api/system/health` for `data.ok: true` and `data.version: "0.4.1"`; authenticated `/api/system/upgrade/status` must show completed or not-required upgrades and `blocking: false`.

To roll back, stop the new version, restore the full pre-upgrade backup into a clean directory/new volume, then start the older image. Do not open newer data with an old version or overlay a backup onto newer WAL files.

### Known Limitations

- Packages remain unsigned and your OS may warn about or block first launch. Use only this Release's downloads and follow system confirmation prompts; do not disable security checks. Mac currently needs manual replacement and unsigned login-item registration may fail.
- Native Windows ARM, NAS imports, remote-instance connections and multi-device sync are not supported. Desktop offline reading uses the local database; it is not offline synchronization with a server.
- Third-party server plugins remain trusted local code; install only plugins you trust. Vendor-unfixed dependency findings and the scope of checks are documented in the [release audit](https://github.com/Pls-1q43/Dibao/blob/main/docs/release-audit-v0.4.1.md).

## 日本語

v0.4.1 では Windows と macOS の独立したデスクトップ版を初めて提供します。サーバーを構築せず、インストール後に自分の PC で邸報を使えます。既存のリーダー、フィード管理、推薦機能を引き継ぎ、トレイ常駐、ローカルのオフライン読書、バックアップと復元、デスクトップ更新を追加しました。初回設定、終了時の保存、データ復元も改善し、Docker・Web・PWA は引き続き利用できます。

### 新機能

- **独立したデスクトップ版。** Windows x64 の EXE、Intel Mac と Apple Silicon Mac の DMG を提供します。実行環境を内蔵し、Node.js、Docker、データベースの別途インストールは不要です。初回にアカウントを作成します。AI は任意設定で、モデルは同梱しません。
- **トレイ常駐とバックグラウンド動作。** ウィンドウを閉じてもフィード取得を続け、トレイ／メニューバーからリーダーを開けます。「Quit」でアプリを終了します。ログイン時の起動は初期状態で無効、有効時はウィンドウを表示せずに動作します。
- **ローカルのオフライン読書。** インターネットが切れてもリーダーを開き、この PC に保存済みの記事を読み、閲覧状態を記録できます。PWA の一部キャッシュへ切り替えません。新しい記事の取得、未保存の外部リソース、AI は接続が必要です。
- **手動バックアップと復元。** 「設定 → このインスタンスについて → バックアップと復元」で完全な保存、日時による復元ポイントの選択、結果確認ができます。フィード、記事と閲覧状態、設定、既存ベクトル、プラグインのデータと鍵、ログインとクライアント状態を含み、確認後に再起動して処理します。復元前に現在のデータも別保存しますが、復元日以降の変更は戻る場合があります。
- **更新とデータ保護。** 設定から新バージョンを確認できます。Windows はダウンロード後に確認して再起動・更新します。Mac は新 DMG を取得し、完全終了後にアプリを上書きします。更新前バックアップに失敗した場合、データ移行を続けません。通常の終了時には自動インストールせず、安定版へのプレリリース配信や自動降格も行いません。

### 改善

- **初回設定を柔軟に。** 最初に簡体中国語、日本語、English を選び、その後の設定、プラグイン、リーダーにも反映します。「あとで追加」で RSS／OPML の設定をスキップでき、フィード未登録でも初回設定を完了できます。
- **アプリとデータを別保存。** インストール先の変更、上書き、再インストール、通常のアンインストールではローカルデータを削除しません。設定からデータフォルダーを開けます。成功した更新前バックアップを直近三件保持し、手動保存と復元前スナップショットは自動削除しません。
- **デスクトップと自ホストの操作を分離。** デスクトップ画面からテスト版の表記を除きました。バックアップ、データフォルダー、ログイン時起動、アプリ更新は Desktop だけに表示します。Docker・Web・PWA の読書／オフライン機能は維持し、専用項目は追加しません。

### 修正

- **バックアップ／復元の反応が分かりにくい問題。** 確認、処理中、キャンセル、完了、失敗の表示を追加しました。有効なバックアップがない場合は復元を無効にし、無反応に見える状態を避けます。
- **破損バックアップが正常な復元を妨げる問題。** 一件の破損で正常な復元ポイントまで使えなくならないようにしました。中断した復元は置換前に整合性を確認し、DB 欠落、不正パス、変更されたファイルを拒否します。
- **起動時のデータ誤判定。** 新規生成されたブラウザー設定を既存 DB と誤認しません。使用済み DB が欠落・空の場合は空の DB を黙って作らず、起動を停止して復元を案内します。残存ファイルも復元前に保存します。
- **Windows で復元後に起動できない問題。** ブラウザーがデータフォルダーを開く前にコールドバックアップ、復元、版の確認を完了し、フォルダーロックや起動時の書き込みによる干渉を防ぎます。ログインデータの保存先は変えません。
- **終了／更新時の書き込み競合。** 未送信の閲覧進捗を保存し、バックグラウンドタスクとプラグインを停止してから DB を閉じます。未保存の設定やデータ更新中は、安全に行えない保存・復元・アプリ更新を拒否します。
- **セキュリティと実行依存。** セキュリティ修正のある HTTP／実行依存を更新し、Docker の不要なパッケージ管理ツールを除きました。デスクトップ権限とプラグインの境界を強化し、外部ページから特権操作を呼べないようにします。Docker 実行イメージは Electron とデスクトップ実行プロセスを含みません。

### 更新の影響と移行

**v0.4.0 から v0.4.1** への新規 SQL 移行、強制派生データ再計算はなく、**Embeddings も再計算しません**。過去版から直接更新する場合は、未適用の歴史的移行と必要なデータ更新を実行します。Desktop の保存と版の保護はこの PC のデータだけに適用し、NAS や別の環境から自動インポートはしません。

### ダウンロードと更新

- [Windows x64 EXE](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-win-x64.exe)
- [Intel Mac DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-x64.dmg)
- [Apple Silicon Mac DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-arm64.dmg)
- Docker：`ghcr.io/pls-1q43/dibao:v0.4.1`、`linux/amd64`／`linux/arm64`。

Desktop のデータは Windows の `%LOCALAPPDATA%\Dibao`、Mac の `~/Library/Application Support/Dibao` に保存します。導入、更新、復元は[デスクトップ手順](https://github.com/Pls-1q43/Dibao/blob/v0.4.1/docs/desktop-install.md#日本語)をご覧ください。以後の正式リリースも三種類のインストーラーと Docker を同時提供します。

Docker の新規導入は [README](https://github.com/Pls-1q43/Dibao/blob/v0.4.1/README.ja.md) を参照してください。更新前に各端末の未同期操作を同期し、旧コンテナを停止して `/data` 全体を保存します。SQLite 本体だけのコピーでは不十分です。既存 volume と環境変数を維持し、イメージを `v0.4.1` に変更して `docker compose pull && docker compose up -d` を実行します。`/api/system/health` の `data.ok: true`、`data.version: "0.4.1"` に加え、認証後の `/api/system/upgrade/status` が完了または更新不要で、`blocking: false` であることを確認します。

戻す場合は新版を停止し、完全な更新前バックアップを空のディレクトリ／新 volume に復元してから旧イメージを起動します。旧版で新しいデータを開いたり、新 WAL のある場所にバックアップを重ねたりしないでください。

### 既知の制限

- パッケージは未署名のため、OS が初回起動を警告・拒否する場合があります。本 Release のみを使用し、システムの確認手順に従ってください。安全確認を無効にしないでください。Mac はアプリ内自動インストール未対応で、未署名ログイン項目も登録に失敗する場合があります。
- Windows ARM ネイティブ版、NAS データ移行、遠隔インスタンス接続、多端末同期は未対応です。Desktop のオフライン読書はローカル DB を使い、サーバーとのオフライン同期ではありません。
- サードパーティのサーバープラグインは信頼済みローカルコードとして動作します。信頼するものだけを導入してください。上流未修正の依存警告と検証範囲は[リリース監査](https://github.com/Pls-1q43/Dibao/blob/main/docs/release-audit-v0.4.1.md)に記録しています。
