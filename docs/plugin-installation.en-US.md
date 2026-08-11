# Dibao Plugin Installation Guide

Last updated: 2026-08-11

This guide is for Dibao administrators installing third-party plugins. In 0.3, server plugins run in isolated Node host processes and web plugins render in sandboxed iframes, but third-party server plugins are still trusted local code. Dibao does not claim hostile-code sandboxing. Install only from sources you trust.

## Before Installing

- Source: verify the developer, release page, version, and changelog.
- Signature: prefer signed packages and make sure the key id maps to a trusted public key.
- Capabilities: confirm requested capabilities match the feature.
- API stability: Stable APIs are suitable for long-term use; Beta APIs may change during 0.3.x.
- Server-code risk: enabling a plugin executes its server entry.

## Recommended Flow: Upload `.dibao-plugin`

1. Download the `.dibao-plugin` file from the developer release page.
2. Verify SHA-256 locally if provided.
3. Open Settings -> Plugins.
4. Upload the plugin file and click Install.
5. Newly installed third-party plugins stay disabled. Review source, signature trust, capabilities, Stable/Beta API usage, and lastError before enabling.

## Trusted Keys

Dibao uses Ed25519 signatures. Administrators provide trusted public keys through deployment configuration. Packages signed by unknown keys are rejected, and tampered packages fail verification. Never copy private keys from chat logs or untrusted pages.

## Advanced Install: URL Or JSON

Automation can use:

- [`POST /api/plugins/install`](./api-contract.md#post-apipluginsinstall)
- [`POST /api/plugins/install/upload`](./api-contract.md#post-apipluginsinstallupload)

Recommended update metadata:

```json
{
  "pluginId": "dev.example.reader-tools",
  "latestVersion": "0.1.1",
  "packageUrl": "https://example.com/reader-tools-0.1.1.dibao-plugin",
  "sha256": "..."
}
```

## Docker Persistence

When `/data` is mounted correctly, plugin packages and data survive image upgrades:

- `/data/plugins/installed`
- `/data/plugins/data/<plugin-id>`
- SQLite tables: `plugin_installs`, `plugin_capability_grants`, `plugin_settings`, `plugin_kv`, `plugin_migrations`, `plugin_update_checks`, `plugin_secrets`, `plugin_deliveries`

Official Daily Brief, Webhook, and Full Content Selectors plugins are scanned from the 0.3.1 image. Third-party plugins remain in the data volume.

## Updates And Rollback

If a plugin has `updateUrl`, the Plugins page can check updates. Dibao downloads into staging, validates ID/compatibility/checksum, then swaps the old package. Failures keep the old package.

Rollback options:

- Upload an older `.dibao-plugin` again.
- If a new version fails activation, the plugin moves to `failed` and data is preserved.
- Incompatible plugins move to `incompatible` until the plugin or Dibao is updated.

## Uninstall

When uninstalling a third-party plugin, choose whether to delete plugin data. Keeping data helps future reinstall or rollback. Deleting data removes install records, settings, KV, secrets, deliveries, and migration records.
