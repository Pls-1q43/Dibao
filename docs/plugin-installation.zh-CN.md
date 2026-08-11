# 邸报插件安装说明

Last updated: 2026-08-11

本文面向安装第三方插件的邸报管理员。0.3 插件会在独立 Node host 进程中运行，并使用 sandboxed iframe 展示 Web UI；但第三方服务端插件仍是可信本地代码，不是任意恶意代码沙箱。只安装你信任的来源。

## 安装前检查

- 来源：开发者、发布页、版本号和更新记录是否可信。
- 签名：优先安装已签名包，并确认 keyId 对应的公钥已加入 trusted keys。
- capabilities：确认插件请求的能力与功能相符。
- API 稳定层级：Stable API 适合长期依赖；Beta API 可能在 0.3.x 调整。
- 服务端代码风险：插件启用后会执行 server entry。

## 推荐方式：上传 `.dibao-plugin`

1. 从开发者发布页下载 `.dibao-plugin`。
2. 如提供 SHA-256，先在本机校验。
3. 打开「设置」->「插件」。
4. 上传插件文件并点击「安装」。
5. 安装后插件默认保持未启用。启用前检查来源、签名信任、capabilities、Stable/Beta API 和 lastError。

## trusted keys

邸报使用 Ed25519 签名。管理员需要通过环境或部署配置提供 trusted public keys。未被信任的签名包会被拒绝；篡改包会验证失败。不要从聊天记录或不可信网页复制私钥。

## 高级安装：URL 或 JSON

自动化部署可调用：

- [`POST /api/plugins/install`](./api-contract.md#post-apipluginsinstall)
- [`POST /api/plugins/install/upload`](./api-contract.md#post-apipluginsinstallupload)

URL metadata 建议包含：

```json
{
  "pluginId": "dev.example.reader-tools",
  "latestVersion": "0.1.1",
  "packageUrl": "https://example.com/reader-tools-0.1.1.dibao-plugin",
  "sha256": "..."
}
```

## Docker 持久化

只要 Docker/Compose 正确挂载 `/data`，插件包和数据会随升级保留：

- `/data/plugins/installed`
- `/data/plugins/data/<plugin-id>`
- SQLite 表：`plugin_installs`、`plugin_capability_grants`、`plugin_settings`、`plugin_kv`、`plugin_migrations`、`plugin_update_checks`、`plugin_secrets`、`plugin_deliveries`

官方 Daily Brief、Webhook 和 Full Content Selectors 随 0.3.1 镜像扫描；第三方插件保存在数据卷中。

## 更新和回滚

如果插件有 `updateUrl`，插件页可以检查更新。邸报会 staging 下载、校验 ID/兼容范围/checksum，然后替换旧包；失败时保留旧包。

回滚方式：

- 重新上传旧版 `.dibao-plugin`。
- 若新版本启用失败，插件会进入 `failed`，旧数据仍保留。
- 不兼容插件会进入 `incompatible`，等待更新插件或升级邸报。

## 卸载

卸载第三方插件时可选择是否删除插件数据。保留数据便于将来重装或回滚；删除数据会移除插件安装记录、settings、KV、secrets、deliveries 和 migrations 记录。
