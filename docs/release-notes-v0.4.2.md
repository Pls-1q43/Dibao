# Dibao v0.4.2 Release Notes

Release date: 2026-10-12

[简体中文](#简体中文) · [日本語](#日本語) · [English](#english)

## 简体中文

v0.4.2 为桌面版新增独立网络代理设置，修复 macOS 安装包资源签名错误，以及部分 Windows 用户遇到的正文抓取与登出后无法重新登录问题。Docker、网页和 PWA 保留原有部署及交互方式。

### 新增功能

- **桌面网络代理。** “设置 → 基础 → 网络代理”可选择跟随系统、不使用代理或手动配置，支持 HTTP、HTTPS 和 SOCKS5。Clash／FlClash 不开启 TUN 时，也可填写实际 HTTP／Mixed 监听地址。保存后立即应用于后台抓取、AI 服务、外部资源和更新请求；可单独测试连接。本机阅读始终直连，代理故障不妨碍阅读已有文章，不会修改系统代理设置。

### 修复与改进

- **macOS 安装包被判为损坏。** 修正修改应用资源后仍保留旧签名的问题，为最终应用及内置运行组件重新生成完整性签名，并验证 DMG 拖拽后的应用和 ZIP 内容。此签名不是 Apple Developer ID 签名，仍未公证，首次启动依然可能被系统拦截，不能承诺免除安全提示。
- **Fake-IP 导致正文抓取失败。** 桌面版收到 `198.18.0.0/15` 网段的 Fake-IP 时，先通过所选网络路线使用 Cloudflare DoH 查询真实公网地址，再抓取正文。不直接放行保留网段；私网地址、危险重定向和无效证书继续被拦截。DoH 只发送域名，不发送文章路径或账号信息；解析失败时不会绕过保护。
- **登出后正确账号密码仍无法登录。** Desktop 不再依赖 PWA 离线缓存和旧的离线登出标记来决定登录状态；缓存受限时也能使用本机账号。统一处理登录与登出 Cookie，并及时写入持久化存储。无需删除数据目录或重新创建账号。
- **升级检查更完整。** 增加上一正式版真实安装包的覆盖升级、连续登出／登录、不可用缓存及安装包签名防篡改测试；缺少任一平台的验证结果都会阻止正式发布。

### 下载、升级与迁移

- [Windows x64 EXE](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-win-x64.exe)
- [macOS Intel DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-mac-x64.dmg)
- [macOS Apple Silicon DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-mac-arm64.dmg)
- Docker：`ghcr.io/pls-1q43/dibao:v0.4.2`，支持 `linux/amd64` 和 `linux/arm64`。

从 **v0.4.1 到 v0.4.2 无新增 SQL 迁移、强制派生数据升级或 Embedding 重算**。更旧版本可直接升级，自动应用未完成的历史迁移。桌面更新保留订阅、文章、阅读状态、设置、向量、插件密钥及登录数据，升级前自动备份。

Windows 可在“设置 → 关于”确认下载后重启更新，或运行 EXE 覆盖安装。macOS 请完全退出 Dibao，用新 DMG 覆盖应用，不删除用户数据目录。系统拦截时可在“系统设置 → 隐私与安全性”查看并确认打开；受管理设备可能仍禁止运行。**不要关闭系统安全校验。** 当前 Mac 不支持应用内自动安装。详见[桌面说明](https://github.com/Pls-1q43/Dibao/blob/v0.4.2/docs/desktop-install.md)。

Docker 升级前同步客户端待处理操作，停止旧容器并备份完整 `/data`，不要只复制 SQLite 主文件。保留数据卷和环境变量，将镜像改为 `v0.4.2`，执行 `docker compose pull && docker compose up -d`。检查 `/api/system/health` 的 `data.ok: true`、`data.version: "0.4.2"`，及登录后的 `/api/system/upgrade/status` 已完成或不需要升级、`blocking: false`。回滚需停止新版，向干净目录或新 volume 恢复完整升级前备份，再启动旧镜像；不要让旧版直接读取新数据。

### 已知限制

Windows 尚无发布者签名，macOS 尚无 Developer ID 签名和公证。代理认证和 SOCKS4 暂不支持。自定义 Fake-IP 网段、无法访问 DoH 的网络需调整代理软件的 DNS 配置，不会自动放开私网策略。桌面版代理不控制系统浏览器；Docker／网页／PWA 不提供该桌面专属设置。检查范围与证据见[发布审计](https://github.com/Pls-1q43/Dibao/blob/main/docs/release-audit-v0.4.2.md)。

## 日本語

v0.4.2 はデスクトップ専用のプロキシ設定を追加し、macOS パッケージのリソース署名の不整合、一部 Windows 環境での本文取得失敗とログアウト後の再ログイン問題を修正します。Docker・Web・PWA の利用方法は変わりません。

### 新機能

- **デスクトップのネットワークプロキシ。** 「設定 → 基本 → ネットワークプロキシ」でシステム、直接接続、手動設定を選べます。HTTP、HTTPS、SOCKS5 に対応し、Clash／FlClash の TUN を使わず実際の HTTP／Mixed アドレスを指定できます。取得処理、AI、外部リソース、更新に即時適用され、接続テストもできます。ローカルの読書は常に直接接続し、OS のプロキシ設定を変更しません。

### 修正と改善

- **Mac でアプリが破損と判定される問題。** リソース変更後に古い署名が残る問題を修正し、最終アプリと内蔵実行コンポーネントに整合性署名を付け直します。DMG からコピーしたアプリと ZIP の内容も検証します。Developer ID 署名や公証ではないため、初回起動は OS に止められる場合があります。
- **Fake-IP による本文取得失敗。** Desktop は `198.18.0.0/15` の Fake-IP を受け取ると、選択した接続経路で Cloudflare DoH に実際の公開 IP を問い合わせます。予約範囲を直接許可せず、プライベート IP、危険なリダイレクト、無効な証明書の拒否を維持します。送信するのはドメイン名だけで、記事パスやアカウント情報は含めません。失敗時も保護を回避しません。
- **ログアウト後に正しい資格情報で再ログインできない問題。** Desktop の認証を PWA キャッシュや以前のオフラインログアウト状態から分離し、保存機能が制限されてもローカルアカウントを利用できます。Cookie の更新と永続化も統一します。データ削除やアカウントの作り直しは不要です。
- **更新検証の拡充。** 前の正式インストーラーからの上書き更新、連続ログアウト／ログイン、使用できないキャッシュ、署名改ざん検出を追加しました。全プラットフォームの検証が揃うまで公開しません。

### ダウンロードと更新

- [Windows x64 EXE](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-win-x64.exe)
- [Intel Mac DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-mac-x64.dmg)
- [Apple Silicon Mac DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-mac-arm64.dmg)
- Docker：`ghcr.io/pls-1q43/dibao:v0.4.2`、`linux/amd64` と `linux/arm64`。

**v0.4.1 → v0.4.2 に新しい SQL 移行、強制派生データ更新、埋め込み再計算はありません。** 古い版からの直接更新では未適用の歴史的移行を実行します。フィード、記事、状態、設定、ベクトル、プラグインの鍵、ログインを保持し、Desktop は更新前に自動バックアップします。

Windows は設定から確認してダウンロード・再起動するか、EXE で上書きします。Mac は完全終了後に DMG からアプリだけを上書きし、データを削除しないでください。OS に止められた場合は「システム設定 → プライバシーとセキュリティ」で確認します。管理対象端末では起動できない場合もあります。**システムの検証を無効にしないでください。** Mac のアプリ内自動インストールは未対応です。[Desktop ガイド](https://github.com/Pls-1q43/Dibao/blob/v0.4.2/docs/desktop-install.md#日本語)をご覧ください。

Docker はクライアントの保留操作を同期し、旧コンテナを停止して `/data` 全体を保存します。データ volume と環境変数を保持し、イメージを `v0.4.2` に変更して `docker compose pull && docker compose up -d` を実行します。`/api/system/health` が `data.ok: true`、`data.version: "0.4.2"`、ログイン後の `/api/system/upgrade/status` が完了または不要、`blocking: false` であることを確認してください。ロールバックは新版を停止し、空のディレクトリか新 volume に更新前の完全なバックアップを復元して旧版を起動します。新しいデータを旧版で直接開かないでください。

### 制限

Windows の発行者署名、Mac の Developer ID 署名・公証は未対応です。プロキシ認証と SOCKS4 は非対応です。独自の Fake-IP 範囲や DoH に接続できない環境ではプロキシ側の DNS 設定を調整してください。プライベートネットワーク保護は自動解除しません。システムブラウザーの接続は制御せず、Docker・Web・PWA にこの Desktop 専用設定は表示しません。[リリース監査](https://github.com/Pls-1q43/Dibao/blob/main/docs/release-audit-v0.4.2.md)。

## English

v0.4.2 adds independent desktop proxy settings and fixes macOS package resource-signature errors, Fake-IP article-fetch failures, and desktop re-login problems reported by some Windows users. Docker, Web and PWA retain their existing deployment and interaction model.

### New Features

- **Desktop network proxy.** Settings > Basic > Network Proxy offers system, direct and manual routes with HTTP, HTTPS and SOCKS5 support. Enter Clash/FlClash's actual HTTP/Mixed listener without enabling TUN. Saving applies immediately to background fetching, AI, external resources and updates, with a separate connection test. Local reading always stays direct, including during proxy failures. Dibao does not change OS proxy settings.

### Fixes And Improvements

- **Mac packages reported as damaged.** Replaced stale signatures left after application resources changed with complete integrity signatures for the final app and bundled runtime components. Verification covers the actual DMG copy and ZIP contents. These are not Developer ID signatures or notarization, so first launch may still be blocked by macOS; this does not promise warning-free distribution.
- **Fake-IP article fetching.** When Desktop receives a Fake-IP in `198.18.0.0/15`, it queries real public addresses through Cloudflare DoH using the selected network route. Reserved ranges are not simply allowed; private addresses, unsafe redirects and invalid certificates remain blocked. Only the domain is sent, not article paths or account information. Lookup failure never bypasses protection.
- **Correct credentials rejected after logout.** Desktop authentication no longer depends on PWA caches or legacy offline-logout markers. Restricted cache storage cannot prevent local sign-in. Cookie changes and persistence are handled consistently. No data-directory deletion or account recreation is needed.
- **Stronger upgrade acceptance.** Added installation upgrades from the previous published installer, repeated logout/login cycles, unavailable-cache checks and signature-tamper rejection. Missing acceptance evidence for any target blocks publication.

### Downloads And Upgrade

- [Windows x64 EXE](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-win-x64.exe)
- [Intel Mac DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-mac-x64.dmg)
- [Apple Silicon Mac DMG](https://github.com/Pls-1q43/Dibao/releases/download/v0.4.2/Dibao-0.4.2-mac-arm64.dmg)
- Docker: `ghcr.io/pls-1q43/dibao:v0.4.2`, supporting `linux/amd64` and `linux/arm64`.

**v0.4.1 to v0.4.2 adds no SQL migrations, mandatory derived-data upgrades or embedding recomputation.** Older versions can upgrade directly and apply pending historical migrations. Desktop backs up before upgrading and retains feeds, articles, reading state, settings, vectors, plugin keys and login data.

Windows can download and restart through Settings > About, or install the EXE over the existing version. On Mac, quit Dibao fully and replace the application using the new DMG without deleting the data directory. Review a blocked launch in System Settings > Privacy & Security; managed-device policies may still prohibit running it. **Do not disable system security checks.** Mac in-app automatic installation remains unsupported. See the [desktop guide](https://github.com/Pls-1q43/Dibao/blob/v0.4.2/docs/desktop-install.md#english).

For Docker, sync pending client operations, stop the old container and back up the entire `/data`, not just SQLite's main file. Preserve the volume and environment, set the image to `v0.4.2`, then run `docker compose pull && docker compose up -d`. Check `/api/system/health` for `data.ok: true` and `data.version: "0.4.2"`, and authenticated `/api/system/upgrade/status` for completed/not-required upgrades with `blocking: false`. Roll back by stopping the new version, restoring a full pre-upgrade backup into a clean directory/new volume, then starting the older image. Never open newer data directly with an old version.

### Known Limitations

Windows publisher signing and macOS Developer ID signing/notarization are unavailable. Proxy authentication and SOCKS4 are unsupported. Custom Fake-IP ranges or networks unable to reach DoH require changes to the proxy client's DNS configuration; private-network protection is not automatically relaxed. Desktop proxy settings do not control the system browser and do not appear in Docker, Web or PWA. See the [release audit](https://github.com/Pls-1q43/Dibao/blob/main/docs/release-audit-v0.4.2.md) for scope and evidence.
