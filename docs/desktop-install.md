# Dibao desktop test builds

## 简体中文

### 安装与首次使用

- Windows x64：运行 `Dibao-版本-win-x64.exe`，安装到当前用户目录，无需安装 Node.js、Docker 或数据库。
- macOS：根据芯片选择 `arm64` 或 `x64` DMG，将 Dibao 拖入“应用程序”，然后打开。首次使用仍需创建账号密码。
- 内测包尚未签名，Windows 可能显示未知发布者提示，macOS 可能阻止首次打开。只使用本仓库构建产物；macOS 可在“系统设置 → 隐私与安全性”中确认打开。组织管理策略仍可能禁止运行。
- AI 服务可以稍后配置，不需要先安装模型。关闭窗口后继续在托盘／菜单栏抓取，选择“退出”才停止。开机启动默认关闭，可在“设置 → 关于”中开启。

### 更新与数据

- 更新使用 electron-updater，通过 GitHub Releases 检查。下载和重启安装分别需要确认，普通退出不会自动安装。
- 此未签名 macOS 内测版使用手动覆盖：退出 Dibao，下载新 DMG，覆盖应用。保留原用户数据目录，首次启动新版本会先备份再迁移。
- Windows 数据：`%LOCALAPPDATA%\Dibao`；macOS 数据：`~/Library/Application Support/Dibao`。安装目录与数据独立，“设置 → 关于”可打开数据目录。
- `data` 保存数据库、插件数据及密钥；`profile` 保存登录和客户端状态；`backups` 保存升级前备份。不要只复制 SQLite 主文件；完全退出后复制整个数据根目录。
- 默认保留最近三份完成升级的自动备份。更新、覆盖安装、重装和默认卸载不主动删除数据。不要手工删除密钥或移动正在使用的数据目录。
- 升级失败会提示重试或恢复备份。恢复前另存当前数据；恢复点之后的修改会回退。直接安装旧版本会受到数据版本保护，须先明确恢复对应旧备份。

### 内测边界

支持 Windows x64、Intel Mac 和 Apple Silicon Mac。Windows ARM 原生版、跨部署导入和多端同步暂未提供。macOS 签名、公证及应用内自动安装在取得证书后单独验收。互联网断开仍可读取本地文章，但抓取、外部图片和 AI 服务需要联网。正式发布不会自动接收内测渠道。

## 日本語

### インストール

Windows x64 は EXE インストーラーを実行します。macOS は Intel 用 `x64`、Apple Silicon 用 `arm64` の DMG を開き、Dibao を「アプリケーション」にコピーします。Node.js、Docker、データベースの別途インストールは不要です。初回にアカウントを作成します。AI の設定は後で行えます。

テスト版は未署名です。OS が初回起動を止めることがあります。本リポジトリーのビルドだけを使用し、macOS では「システム設定 → プライバシーとセキュリティ」で起動を確認してください。組織の管理ポリシーによっては実行できません。ウィンドウを閉じても取得処理は継続します。トレイ／メニューバーの「Quit」で終了します。ログイン時の起動は初期状態で無効です。

### 更新、データ、復元

electron-updater が GitHub Releases の更新を確認します。ダウンロードと再起動にはそれぞれ確認が必要です。未署名 macOS 版は終了後に新しい DMG でアプリを上書きします。

Windows のデータは `%LOCALAPPDATA%\Dibao`、macOS は `~/Library/Application Support/Dibao` に保存されます。「設定 → このインスタンスについて」からフォルダーを開けます。`data`、`profile`、`backups` を含むルート全体を完全終了後にコピーしてください。プラグインの鍵も保存が必要です。

新しいバージョンはデータを開く前にバックアップを作成し、移行します。完了した更新前バックアップを直近三件保持します。更新、再インストール、通常のアンインストールではデータを削除しません。失敗時は再試行またはバックアップ復元を選べます。復元前に現状を別保存しますが、復元日以降の変更は戻ります。古いアプリで新しいデータを直接開くことは禁止されます。

Windows ARM、NAS からの移行、同期は対象外です。macOS の署名、公証、自動インストールは後日検証します。オフラインでもローカル記事を読めますが、取得、外部画像、AI はネットワークを必要とします。

## English

### Install and run

Run the Windows x64 EXE installer, or open the macOS DMG for your chip (`x64` for Intel, `arm64` for Apple Silicon) and copy Dibao into Applications. Node.js, Docker and a separate database installation are not required. Create an account on first use; AI configuration is optional.

Test builds are unsigned. Your OS may warn about or block the first launch. Only use artifacts built from this repository. On macOS, review the launch in System Settings > Privacy & Security. Managed-device policies may still prohibit it. Closing the window keeps feed fetching active; use Quit in the tray/menu bar to stop the app. Launch at login is off by default.

### Update and recover

electron-updater checks GitHub Releases. Downloading and restarting to install each require confirmation. A normal quit does not install an update automatically. Unsigned macOS builds use manual replacement: quit Dibao, download the new DMG and replace the application.

Data lives in `%LOCALAPPDATA%\Dibao` on Windows and `~/Library/Application Support/Dibao` on macOS. Open it from Settings > About. Keep the complete root, including `data`, `profile` and `backups`, rather than only the SQLite main file. Quit fully before copying it; plugin encryption keys must be preserved.

On the first launch of a new version, Dibao backs up persistent data before opening it for migration. It retains the three most recent completed upgrade backups. Updates, replacement installs, reinstalls and normal uninstall do not intentionally remove user data. A failed upgrade offers retry or restore. Restore saves the current data separately first, but changes made after the restored backup's date will be rolled back. Older applications cannot directly open newer data.

Native Windows ARM, NAS imports and synchronization are outside this test release. macOS signing, notarization and automatic installation require separate validation after credentials are available. Local articles remain readable without internet; feed fetching, remote images and AI services still need their respective network connections.
