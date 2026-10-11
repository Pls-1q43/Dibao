# Dibao v0.4.1

## 简体中文

### 下载与变化

本次同时提供 Docker 和三个可直接安装的桌面版本，桌面界面不再标注“内测版”。后续正式 Release 同样要求各端齐全。

- [Windows x64 安装程序](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-win-x64.exe)
- [macOS Intel 拖拽安装包](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-x64.dmg)
- [macOS Apple Silicon 拖拽安装包](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-arm64.dmg)
- Docker：`ghcr.io/pls-1q43/dibao:v0.4.1`，支持 linux/amd64、linux/arm64。

桌面版内置运行环境，首次选择语言、创建账号，RSS 与 AI 可稍后配置。关闭窗口后驻留托盘；登录时启动默认关闭，开启后在后台静默运行。离线时读取完整本地数据库，不切入网页 PWA 的缓存子集。

“设置 → 关于”现在可创建完整备份、按日期选择恢复点、确认重启并查看结果。备份包含数据库及 WAL、插件数据和密钥、登录与客户端状态；未保存的设置、迁移或其他写入未完成时会阻止操作。修复损坏备份阻塞正常恢复点、恢复中断时替换前校验不足的问题。更新前同样先备份，失败不升级数据，不重算已有 embedding。

安全与回归检查覆盖登录／CSRF、沙箱与 IPC、插件框架、私有回环访问凭证、单实例、退出写入、下载校验和版本保护。更新有安全公告的 HTTP 与构建依赖。Docker 不包含 Electron 或桌面运行进程，网页／PWA 不显示桌面备份、数据目录、登录启动或应用安装操作，原离线和推荐功能继续保留。

### 安装、升级与限制

桌面安装无需 Node.js、Docker 或数据库。Windows 运行 EXE；macOS 打开对应 DMG 并拖入“应用程序”。数据独立存放在 `%LOCALAPPDATA%\Dibao` 或 `~/Library/Application Support/Dibao`，更新、覆盖、重装和默认卸载不主动删除数据。macOS 更新前完全退出，下载新 DMG 覆盖应用。完整步骤见 [安装与恢复说明](./desktop-install.md)。

当前桌面包未签名，系统可能警告或阻止首次运行；仅使用本 Release 下载并按系统提示确认，不要关闭安全校验。macOS 当前不支持应用内自动安装，未签名登录项也可能注册失败。Windows 使用 electron-updater，下载和重启分别由你确认，退出不自动安装。稳定渠道不接收预发布，不自动降级。暂不支持 Windows ARM 原生版、NAS 数据迁入、远程实例连接或多端同步。抓取、外部图片和 AI 仍需联网。

Docker 新安装使用下方 Compose；升级前先同步各浏览器/PWA 的离线操作，然后停止旧容器、备份整个 `/data`，保留插件密钥，不只复制 SQLite 主文件。改为 `v0.4.1` 后运行 `docker compose pull && docker compose up -d`。不要改变已有数据卷。

```yaml
services:
  dibao:
    image: ghcr.io/pls-1q43/dibao:v0.4.1
    restart: unless-stopped
    ports: ["8080:8080"]
    environment:
      DIBAO_HOST: 0.0.0.0
      DIBAO_PORT: "8080"
      DIBAO_DATABASE_PATH: /data/dibao.sqlite
      DIBAO_COOKIE_SECURE: "auto"
    volumes: ["./data:/data"]
```

健康检查：`http://localhost:8080/api/system/health` 应显示 `data.ok: true`、`data.version: "0.4.1"`；登录后 `/api/system/upgrade/status` 应非阻塞，旧版本数据需要的派生升级须完成。HTTP 200 本身不代表升级完成。回滚时停止新容器，将完整升级前备份恢复到干净目录或新卷，再启动旧镜像；不要让旧版本直接打开新数据，也不要覆盖新 WAL 文件。

### 迁移清单

从 v0.4.0 升级：无新增 SQL 迁移，无新增强制派生数据重算，不重算 embedding。跳版本升级仍自动执行全部未应用历史迁移，已发布迁移保持不变。Desktop 的首次正式版启动会按版本创建完整备份。默认保留最近三份成功升级前的自动备份；手动备份与恢复前快照不自动删除。

## 日本語

### ダウンロードと変更

Docker と三種類の直接インストール可能なデスクトップ版を同時提供します。画面からテスト版の表記を除き、以後の正式リリースも全対象が揃うことを条件とします。

- [Windows x64 EXE](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-win-x64.exe)
- [Intel Mac DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-x64.dmg)
- [Apple Silicon Mac DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-arm64.dmg)
- Docker：`ghcr.io/pls-1q43/dibao:v0.4.1`（linux/amd64、linux/arm64）。

実行環境を内蔵し、初回に言語とアカウントを設定します。フィードと AI は後から設定できます。閉じてもトレイで取得を継続します。ログイン時の起動は初期状態で無効、有効時は画面を表示しません。オフラインでは完全なローカルデータベースを読み、PWA の一部キャッシュに切り替えません。

設定のバージョン欄で完全バックアップ作成、日時による復元選択、再起動の確認と結果表示ができます。SQLite と WAL、プラグインの鍵、ログイン、クライアント状態を保存します。未保存の設定や移行中の操作は拒否します。壊れたバックアップが正常な復元点を妨げる問題と、中断復元の置換前検証を修正しました。更新前バックアップに失敗した場合はデータを移行せず、既存 embedding を再計算しません。

認証、CSRF、サンドボックス、IPC、プラグイン、私有ループバック接続、単一起動、終了時の保存、更新チェックサム、バージョン保護を検証します。安全上の修正がある HTTP／ビルド依存を更新しました。Docker は Electron を同梱せず、Web/PWA にデスクトップ専用操作を表示しません。既存のオフライン／推薦機能は保持します。

### 導入、更新、制限

Windows は EXE、Mac は対応 DMG を開いてアプリケーションへドラッグします。Node.js、Docker、DB の別途導入は不要です。データは `%LOCALAPPDATA%\Dibao` または `~/Library/Application Support/Dibao` に保存し、通常の更新、再導入、アンインストールでは削除しません。Mac は完全終了後に新 DMG で上書きします。[導入・復元手順](./desktop-install.md#日本語)。

現在のパッケージは未署名で、OS の警告や実行制限があり得ます。本 Release のみを使用し、システム検証を無効にしないでください。Mac はアプリ内自動インストール未対応、未署名ログイン項目も登録に失敗する場合があります。Windows は electron-updater を使用し、ダウンロードと再起動の確認が必要です。終了時の自動インストールや安定版へのプレリリース配信、自動降格は行いません。Windows ARM、NAS 移行、遠隔接続、同期は未対応です。取得、外部画像、AI はネットワークが必要です。

Docker は上記 Compose の `v0.4.1` を使用します。更新前に PWA の未同期操作を同期し、旧コンテナを停止して `/data` 全体をバックアップします。SQLite 本体だけでなく鍵と WAL も保持します。永続化先を変えずに `docker compose pull && docker compose up -d` を実行します。`/api/system/health` は `ok: true`、`version: "0.4.1"`、認証後の `/api/system/upgrade/status` は非ブロック状態である必要があります。必要な派生データ更新の完了も確認します。

ロールバックは新コンテナを停止し、完全な更新前バックアップを空のディレクトリか新しい volume に復元して旧イメージを起動します。旧版で新しいデータを開いたり、新 WAL に上書きしたりしないでください。

### 移行一覧

v0.4.0 からの新規 SQL 移行、強制派生データ更新、embedding 再計算はありません。過去版からの直接更新は未適用の歴史的移行を全て実行し、既存の移行は変更しません。Desktop は初回正式版起動前にバックアップします。成功した更新前の自動バックアップを直近三件保持し、手動保存と復元前スナップショットは自動削除しません。

## English

### Downloads and changes

This release delivers Docker and all three directly installable desktop targets. Desktop no longer carries a test-build label; future formal releases require every target to pass together.

- [Windows x64 installer](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-win-x64.exe)
- [Intel Mac drag-and-drop DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-x64.dmg)
- [Apple Silicon Mac drag-and-drop DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.1/Dibao-0.4.1-mac-arm64.dmg)
- Docker: `ghcr.io/pls-1q43/dibao:v0.4.1`, linux/amd64 and linux/arm64.

Desktop includes its runtime. Choose a language and create an account; feeds and optional AI can be configured later. Closing the window keeps fetching in the tray. Launch at login is off by default and runs silently when enabled. Offline reading uses the complete local database, not a PWA cache subset.

Settings > About provides full manual backups, dated restore-point selection, restart confirmation and results. Backups preserve SQLite including WAL, plugin keys, login and client state. Unsaved settings, pending migrations and conflicting operations block unsafe actions. Damaged snapshots no longer block healthy restore points; interrupted recovery validates staged data before replacing live directories. Upgrades first back up data and stop on failure, without recomputing existing embeddings.

Release gates cover authentication/CSRF, sandbox/IPC, plugin frames, the private loopback capability, singleton behavior, pending writes, update checksums and version protection. HTTP and build dependencies with security fixes are updated. Docker excludes Electron and the desktop runtime; Web/PWA do not show desktop backup, data-folder, login-startup or app-install actions. Existing offline and recommendation workflows remain available.

### Install, upgrade and limitations

Run the Windows EXE, or open the matching Mac DMG and drag Dibao into Applications. No additional Node.js, Docker or database installation is required. Data stays separately in `%LOCALAPPDATA%\Dibao` or `~/Library/Application Support/Dibao`; normal updates, replacement installs, reinstalls and uninstall do not delete it. On Mac, quit fully and replace the app using the new DMG. See [installation and recovery](./desktop-install.md#english).

Packages remain unsigned. OS warnings or launch restrictions may apply. Only use this Release's downloads; do not disable OS security checks. Mac currently needs manual replacement and unsigned login-item registration may fail. Windows uses electron-updater with separate download/restart confirmation; normal quit does not install automatically. Stable users do not receive prereleases; automatic downgrade is disabled. Native Windows ARM, NAS imports, remote connections and synchronization are not supported. Fetching, remote images and AI still need internet.

For Docker, use the Compose example above. Before upgrading, sync pending browser/PWA operations, stop the old container and back up the entire `/data`, including keys and WAL, not only SQLite's main file. Set the image to `v0.4.1`, preserve the existing volume and run `docker compose pull && docker compose up -d`. Check `/api/system/health` for `data.ok: true` and `data.version: "0.4.1"`; authenticated `/api/system/upgrade/status` must be non-blocking with any required derived upgrade completed. HTTP 200 alone is insufficient.

For rollback, stop the new container, restore the complete pre-upgrade backup into a clean directory/new volume, and start the older image. Do not open newer data directly with an old image or overlay a backup onto newer WAL files.

### Migration list

From v0.4.0: no new SQL migrations, mandatory derived-data rebuilds or embedding recomputation. Cross-version upgrades still apply every pending historical migration; shipped migrations are unchanged. Desktop backs up before its first stable launch. The three latest successful upgrade backups are retained; manual and pre-restore snapshots are not automatically deleted.
