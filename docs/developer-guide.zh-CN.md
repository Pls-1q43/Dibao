# 邸报开发者指南

Last updated: 2026-06-16

本文是从 `0.2.0` 开始维护的开发者文档入口。核心开发者文档提供简体中文和英文两个版本；插件开发文档是本指南的一个子单元，并单独维护简体中文、英文和日文版本。

## 适用范围

- 核心应用开发：Server、Web、DB、推荐算法、迁移和发布验证。
- 插件开发：manifest、权限、Hook、任务、UI 扩展点、分发和更新。
- 自托管集成：Docker、持久化目录、备份、升级和回滚。

## 代码结构

- `apps/server`: Fastify API、后台任务、插件运行时入口。
- `apps/web`: React 前端、设置页、插件管理 UI、插件 UI host bridge。
- `packages/db`: SQLite schema、migration、repository。
- `packages/ranking`: 推荐排序与画像算法。
- `docs`: 对外公开的产品、工程和开发者参考文档。

本地计划、执行记录、临时验证证据和机器特定说明不放在 `docs/`，应放在仓库外或已忽略的 `local-docs/`。

## 开发流程

`0.3` 是当前下一大版本功能开发线。普通新功能、UI 改造、推荐算法迭代和插件系统工作默认进入 `0.3`。`0.2` 只用于当前稳定线维护修复。

建议验证顺序：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

触及 Docker 发布、迁移或持久化路径时，还需要补充 Docker build smoke 和升级持久化 smoke。

Core 数据库 migration 必须走应用内默认的用户可见阻塞迁移门。已有库启动新版本时，Web 服务应保持可访问，普通业务 API 和后台任务暂停，前端展示升级进度；migration 完成后自动恢复。部署流程不得在临时脚本里直接调用 `runMigrations()` 修改生产或测试实例数据库。

离线 CLI 只用于修复或人工演练，不是常规部署主路径。需要使用时，必须在旧容器停止、SQLite WAL checkpoint 和备份策略确认后，使用新镜像执行：

```bash
DIBAO_ALLOW_BLOCKING_MIGRATION=1 \
DIBAO_DB_BACKUP_CONFIRMED=1 \
DIBAO_DATABASE_PATH=/data/dibao.sqlite \
npm run ops:migrate:core
```

该命令会同步阻塞到 migration 完成，输出备份、迁移和关键计数报告。需要重建 embedding、向量索引或推荐画像的变更，还必须额外接入对应的用户可见数据升级流程。

## 插件开发

插件开发请阅读：

- [插件开发指南](./plugin-development.zh-CN.md)
- [Plugin development guide](./plugin-development.en-US.md)
- [プラグイン開発ガイド](./plugin-development.ja-JP.md)
- [插件系统设计](./plugin-system-design.md)
- [运行时性能准则](./runtime-performance.md)

插件 API 稳定层级在 0.2 中分为 Stable 和 Beta。manifest v1、生命周期、settings/storage/secrets/deliveries/tasks、基础 hooks、iframe bridge 和 manifest migrations 属于 Stable；`database.defineTable`、ranking、article snapshot/content 和 diagnostics 类能力属于 Beta。

## 兼容性约定

- 公开 API、manifest v1 字段、capability 名称和 Hook 名称必须按文档演进。
- 已发布 migration 不可删除或重写。
- 插件目录、插件数据目录和用户 SQLite 数据库必须在 Docker 重建后保留。
- Core 数据库 migration 必须默认走应用内用户可见阻塞迁移门；部署脚本不能绕过该入口直接执行迁移。
- 会导致 embedding 重算、向量索引重建或推荐画像重建的变更必须走明确的数据升级流程，不能在普通请求路径隐式执行。
- 触及后台任务、SQLite 写锁、热路径请求、诊断接口或插件 Hook 的变更，必须先阅读并遵守 [运行时性能准则](./runtime-performance.md)。
