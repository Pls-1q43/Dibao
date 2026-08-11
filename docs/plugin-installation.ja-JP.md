# Dibao プラグインインストールガイド

Last updated: 2026-08-11

この文書はサードパーティプラグインをインストールする Dibao 管理者向けです。0.3 では server plugin は独立 Node host process、Web plugin は sandbox iframe で動作します。ただしサードパーティ server plugin は信頼済みローカルコードです。悪意ある任意コードを安全に実行する sandbox ではありません。信頼できる source だけをインストールしてください。

## インストール前の確認

- Source: developer、release page、version、changelog を確認します。
- Signature: 署名済み package を優先し、key id が trusted public key に対応していることを確認します。
- Capabilities: requested capabilities が機能に見合っているか確認します。
- API stability: Stable API は長期利用向けです。Beta API は 0.3.x で変わる可能性があります。
- Server-code risk: plugin を有効化すると server entry が実行されます。

## 推奨手順: `.dibao-plugin` upload

1. developer release page から `.dibao-plugin` を download します。
2. SHA-256 が提供されている場合は local で検証します。
3. Settings -> Plugins を開きます。
4. plugin file を upload して Install を押します。
5. 新規サードパーティ plugin は無効のままです。有効化前に source、signature trust、capabilities、Stable/Beta API、lastError を確認します。

## Trusted Keys

Dibao は Ed25519 signature を使います。管理者は deployment configuration で trusted public keys を提供します。未知の key で署名された package は拒否され、改ざんされた package は検証に失敗します。private key を chat log や信頼できない page からコピーしないでください。

## Advanced Install: URL または JSON

automation では次の API を使えます。

- [`POST /api/plugins/install`](./api-contract.md#post-apipluginsinstall)
- [`POST /api/plugins/install/upload`](./api-contract.md#post-apipluginsinstallupload)

推奨 update metadata:

```json
{
  "pluginId": "dev.example.reader-tools",
  "latestVersion": "0.1.1",
  "packageUrl": "https://example.com/reader-tools-0.1.1.dibao-plugin",
  "sha256": "..."
}
```

## Docker 永続化

`/data` が正しく mount されていれば、plugin package と data は image upgrade 後も残ります。

- `/data/plugins/installed`
- `/data/plugins/data/<plugin-id>`
- SQLite tables: `plugin_installs`, `plugin_capability_grants`, `plugin_settings`, `plugin_kv`, `plugin_migrations`, `plugin_update_checks`, `plugin_secrets`, `plugin_deliveries`

公式 Daily Brief、Webhook、Full Content Selectors は 0.3.1 image から scan されます。サードパーティ plugin は data volume に残ります。

## Update と Rollback

plugin に `updateUrl` がある場合、Plugins page から update check できます。Dibao は staging に download し、ID/compatibility/checksum を検証してから旧 package を差し替えます。失敗時は旧 package を保持します。

Rollback:

- 古い `.dibao-plugin` を再 upload します。
- 新 version の activation が失敗した場合、plugin は `failed` になり data は保持されます。
- incompatible plugin は `incompatible` になり、plugin または Dibao の update を待ちます。

## Uninstall

サードパーティ plugin の uninstall 時に plugin data を削除するか選択できます。data を残すと再インストールや rollback に便利です。削除すると install records、settings、KV、secrets、deliveries、migration records が削除されます。
