# Dibao desktop installation

## 简体中文

### 安装与首次使用

- Windows x64：运行 `Dibao-版本-win-x64.exe`，安装到当前用户目录，无需安装 Node.js、Docker 或数据库。
- macOS：根据芯片选择 `arm64` 或 `x64` DMG，将 Dibao 拖入“应用程序”，然后打开。首次使用仍需创建账号密码。
- 从 [GitHub Releases](https://github.com/Pls-1q43/Dibao/releases/latest) 直接下载 EXE 或 DMG，无需下载 Actions 的外层 ZIP。首次欢迎页可先选简体中文、日本語或 English；后续设置、插件和阅读器使用同一语言。订阅源可以选择“稍后添加”，不必在首次流程里添加 RSS 或导入 OPML。
- 当前 Windows 安装包没有发布者签名；macOS 自 v0.4.2 起校验完整性签名，但没有 Developer ID 签名和 Apple 公证，仍可能阻止首次打开。只使用本仓库 Release 产物；macOS 可在“系统设置 → 隐私与安全性”中查看并确认打开。不要关闭系统安全校验或删除隔离属性，组织管理策略仍可能禁止运行。
- AI 服务可以稍后配置，不需要先安装模型。关闭窗口后继续在托盘／菜单栏抓取，选择“退出”才停止。“设置 → 关于 → 登录系统时在后台启动”默认关闭；开启后登录系统只在后台运行，不弹出阅读器，通过托盘／菜单栏的“Open Dibao”打开。手动启动应用仍显示窗口，备份或恢复后主动重启也会显示操作结果。
- 未签名 macOS 安装包的系统登录项注册可能无法生效，可靠支持仍需签名和公证。见 [Electron 官方说明](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings)。

### 更新与数据

- 更新使用 electron-updater，通过 GitHub Releases 检查。下载和重启安装分别需要确认，普通退出不会自动安装。
- 当前 macOS 版本使用手动覆盖：退出 Dibao，下载新 DMG，覆盖应用。保留原用户数据目录，首次启动新版本会先备份再迁移。
- Windows 数据：`%LOCALAPPDATA%\Dibao`；macOS 数据：`~/Library/Application Support/Dibao`。安装目录与数据独立，“设置 → 关于”可打开数据目录。
- `data` 保存数据库、插件数据及密钥；`profile` 保存登录和客户端状态；`backups` 保存升级前备份。不要只复制 SQLite 主文件；完全退出后复制整个数据根目录。
- 默认保留最近三份完成升级的自动备份。更新、覆盖安装、重装和默认卸载不主动删除数据。不要手工删除密钥或移动正在使用的数据目录。
- “设置 → 关于 → 数据备份与恢复”可手动创建备份、按时间选择恢复点，并查看结果。首次安装没有备份时恢复按钮不可用。创建和恢复都需要确认后重启，以完整保存数据库、插件密钥、登录及客户端状态。备份只保存在本机；手动备份和恢复前快照不会自动删除，注意可用空间。
- 升级失败会提示重试或恢复备份。恢复前另存当前数据；恢复点之后的修改会回退。直接安装旧版本会受到数据版本保护，须先明确恢复对应旧备份。

### 支持范围

支持 Windows x64、Intel Mac 和 Apple Silicon Mac。Windows ARM 原生版、跨部署导入和多端同步暂未提供。macOS 签名、公证及应用内自动安装在取得证书后单独验收。互联网断开仍可读取本地文章，但抓取、外部图片和 AI 服务需要联网。正式发布不会自动接收内测渠道。

### 网络代理（v0.4.2 起）

Desktop 的“设置 → 基础 → 网络代理”支持跟随系统代理、不使用代理和手动配置。Clash／FlClash 未开启 TUN 时，可选择手动配置并填写实际 HTTP／Mixed 监听地址，例如 `http://127.0.0.1:7890`；也支持 HTTPS 和 `socks5://127.0.0.1:7891`。端口以代理软件配置为准，地址不能包含账号、密码或路径。

保存后立即应用于后台 Provider、抓取、页面外部资源和更新请求；“测试连接”检测的是后台进程对 Google HTTPS 204 的连接，不是 Provider 本身，Provider 仍可在其设置中单独测试。本地阅读服务始终直连，代理不可用也不妨碍读取本地文章。手动模式可选择局域网直连；系统模式遵循系统规则。不会修改系统代理，也不需要 TUN。系统浏览器打开的链接仍遵循系统浏览器自己的配置。

代理配置保存在数据目录，更新和备份恢复都会保留。不接受代理认证信息或 SOCKS4；连接失败不会自动绕过代理。此功能只在 Desktop 中显示，不影响 Docker／网页／PWA。

如果 DNS 返回默认 `198.18.0.0/15` Fake-IP，Desktop 会沿所选网络路线向 Cloudflare DoH 查询真实公网地址，只发送域名，不发送文章路径或账号信息。私网保护和证书校验保持启用。自定义 Fake-IP 网段或 DoH 不可达时，请调整代理软件 DNS 配置，不要放开私网抓取限制。

## 日本語

### インストール

Windows x64 は EXE インストーラーを実行します。macOS は Intel 用 `x64`、Apple Silicon 用 `arm64` の DMG を開き、Dibao を「アプリケーション」にコピーします。Node.js、Docker、データベースの別途インストールは不要です。初回にアカウントを作成します。AI の設定は後で行えます。

[GitHub Releases](https://github.com/Pls-1q43/Dibao/releases/latest) から EXE または DMG を直接取得してください。Actions の外側 ZIP は不要です。最初の歓迎画面で言語を選び、その後の設定とリーダーにも同じ言語が適用されます。フィード追加は「あとで追加」でスキップできます。

Windows は発行者未署名です。Mac は v0.4.2 から整合性署名を検証しますが、Developer ID 署名・公証はなく、初回起動は OS に止められる場合があります。本リポジトリーの Release だけを使用し、macOS では「システム設定 → プライバシーとセキュリティ」で起動を確認してください。システム検証を無効にしたり、隔離属性を削除したりしないでください。管理ポリシーで実行できない場合もあります。ウィンドウを閉じても取得処理は続き、トレイ／メニューバーの「Quit」で終了します。ログイン時の起動は初期状態で無効です。

「設定 → このインスタンスについて → ログイン時にバックグラウンドで起動」を有効にすると、ログイン時はリーダーを表示せず取得処理を続けます。トレイ／メニューバーの「Open Dibao」で開けます。手動起動、バックアップや復元後の再起動ではウィンドウを表示します。未署名 macOS 版ではログイン項目の登録が反映されない場合があります。確実な対応には署名と公証が必要です。[Electron の説明](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings)。

### 更新、データ、復元

electron-updater が GitHub Releases の更新を確認します。ダウンロードと再起動にはそれぞれ確認が必要です。未署名 macOS 版は終了後に新しい DMG でアプリを上書きします。

Windows のデータは `%LOCALAPPDATA%\Dibao`、macOS は `~/Library/Application Support/Dibao` に保存されます。「設定 → このインスタンスについて」からフォルダーを開けます。`data`、`profile`、`backups` を含むルート全体を完全終了後にコピーしてください。プラグインの鍵も保存が必要です。

新しいバージョンはデータを開く前にバックアップを作成し、移行します。完了した更新前バックアップを直近三件保持します。更新、再インストール、通常のアンインストールではデータを削除しません。失敗時は再試行またはバックアップ復元を選べます。復元前に現状を別保存しますが、復元日以降の変更は戻ります。古いアプリで新しいデータを直接開くことは禁止されます。

「設定 → このインスタンスについて → バックアップと復元」で手動保存、日時による復元ポイント選択、結果確認ができます。初回はバックアップがないため復元は無効です。作成と復元は確認後に再起動し、データベース、プラグインの鍵、ログインとクライアント状態を一緒に保存します。ローカル保存のみで、手動保存と復元前スナップショットは自動削除しません。空き容量に注意してください。

Windows ARM、NAS からの移行、同期は対象外です。macOS の署名、公証、自動インストールは後日検証します。オフラインでもローカル記事を読めますが、取得、外部画像、AI はネットワークを必要とします。

### ネットワークプロキシ（v0.4.2 以降）

Desktop の「設定 → 基本 → ネットワークプロキシ」でシステム、直接接続、手動設定を選べます。Clash／FlClash の TUN を使わない場合は、実際の HTTP／Mixed アドレス（例：`http://127.0.0.1:7890`）を入力します。HTTPS と SOCKS5 も対応します。ポートはプロキシ側の設定に合わせてください。認証情報、パス、SOCKS4 は使用できません。

保存後、Provider、取得処理、外部リソース、更新の接続に適用されます。接続テストはバックグラウンドから Google HTTPS 204 に接続します。Provider 自体のテストは Provider 設定で行います。ローカルの読書は常に直接接続し、手動モードでは LAN の直接接続も選べます。システム設定を変更せず、TUN は不要です。システムブラウザーで開くリンクはそのブラウザーの設定を使用します。失敗時に直接接続へ自動切り替えしません。設定はデータとバックアップに保存され、Docker／Web／PWA には表示されません。

DNS が標準の `198.18.0.0/15` Fake-IP を返す場合、Desktop は選択した経路で Cloudflare DoH に公開 IP を問い合わせます。ドメイン名だけを送信し、記事パスやアカウント情報は含めません。プライベートネットワークと証明書の検証は維持します。独自の範囲や DoH に接続できない環境では、保護を無効にせずプロキシ側の DNS 設定を調整してください。

## English

### Install and run

Run the Windows x64 EXE installer, or open the macOS DMG for your chip (`x64` for Intel, `arm64` for Apple Silicon) and copy Dibao into Applications. Node.js, Docker and a separate database installation are not required. Create an account on first use; AI configuration is optional.

Download EXE or DMG installers directly from [GitHub Releases](https://github.com/Pls-1q43/Dibao/releases/latest), not the outer Actions ZIP. Choose the interface language on the welcome screen before creating your account; setup, plugins and the reader retain it. Use Add later to skip RSS/OPML during first-run setup.

Windows packages remain publisher-unsigned. Since v0.4.2, Mac application integrity signatures are verified, but Developer ID signing and notarization are absent; macOS may still block first launch. Only use this repository's Release assets. Review a blocked Mac launch in System Settings > Privacy & Security; do not disable security checks or remove quarantine attributes. Managed-device policies may still prohibit it. Closing the window keeps fetching active; use Quit in the tray/menu bar to stop. Launch at login is off by default.

Enable Settings > About > Start in the background at login to fetch without showing the reader after login. Open Dibao in the tray/menu bar opens the window. Manual launches and backup/recovery restarts still show it. Unsigned macOS builds may fail to register login items; reliable registration requires signing and notarization. See [Electron's documentation](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings).

### Update and recover

electron-updater checks GitHub Releases. Downloading and restarting to install each require confirmation. A normal quit does not install an update automatically. Unsigned macOS builds use manual replacement: quit Dibao, download the new DMG and replace the application.

Data lives in `%LOCALAPPDATA%\Dibao` on Windows and `~/Library/Application Support/Dibao` on macOS. Open it from Settings > About. Keep the complete root, including `data`, `profile` and `backups`, rather than only the SQLite main file. Quit fully before copying it; plugin encryption keys must be preserved.

On the first launch of a new version, Dibao backs up persistent data before opening it for migration. It retains the three most recent completed upgrade backups. Updates, replacement installs, reinstalls and normal uninstall do not intentionally remove user data. A failed upgrade offers retry or restore. Restore saves the current data separately first, but changes made after the restored backup's date will be rolled back. Older applications cannot directly open newer data.

Settings > About > Backup and recovery offers manual backup, dated restore-point selection and operation results. Restore is disabled until a backup exists. Both actions require confirmation and a restart to save the database, plugin keys, login and client state together. Backups stay on this computer; manual backups and pre-restore snapshots are not automatically deleted, so keep sufficient disk space available.

Native Windows ARM, NAS imports and synchronization are not supported. macOS signing, notarization and automatic installation require separate validation after credentials are available. Local articles remain readable without internet; feed fetching, remote images and AI services still need their respective network connections. Docker, Web and PWA do not display desktop-only controls.

### Network proxy (since v0.4.2)

Desktop Settings > Basic > Network Proxy offers system, direct and manual modes. For Clash/FlClash without TUN, enter its actual HTTP/Mixed listener, for example `http://127.0.0.1:7890`. HTTPS and SOCKS5 listeners are also supported. Use the port configured in your proxy client; credentials, URL paths and SOCKS4 are not supported.

Saving applies the route to Provider requests, feed fetching, external resources and update requests. Test connection checks Google HTTPS 204 from the background process, not the Provider; use the Provider's own test separately. Local reading always stays direct even if the proxy fails. Manual mode optionally bypasses LAN addresses; system mode follows OS rules. Dibao does not change OS proxy settings or require TUN. Links opened in the system browser follow that browser's own settings. Failed proxy requests never fall back silently to direct access. Configuration is preserved with your data and backups; these controls do not appear in Docker, Web or PWA.

When DNS returns default `198.18.0.0/15` Fake-IP addresses, Desktop queries real public addresses through Cloudflare DoH on the selected route. Only domains are sent, not article paths or account information. Private-network and certificate checks remain enabled. Custom ranges or unreachable DoH require changes to the proxy client's DNS configuration, not disabling fetch protections.
