# Dibao Developer Guide

Last updated: 2026-08-11

This is the developer documentation entry point maintained from `0.2.0` onward. Core developer documentation is maintained in Simplified Chinese and English. Plugin development is a sub-unit of this guide and is also maintained as standalone Simplified Chinese, English, and Japanese files.

## Scope

- Core application development: Server, Web, DB, recommendation, migrations, and release validation.
- Plugin development: manifest, capabilities, hooks, tasks, UI extension points, distribution, and updates.
- Self-hosted integration: Docker, persistent volumes, backups, upgrades, and rollback.

## Code Layout

- `apps/server`: Fastify APIs, background jobs, plugin runtime entry points.
- `apps/web`: React frontend, settings workspace, plugin manager UI, plugin UI host bridge.
- `packages/db`: SQLite schema, migrations, repositories.
- `packages/ranking`: recommendation ranking and profile algorithms.
- `docs`: public product, engineering, and developer references.

Local planning notes, execution logs, temporary validation evidence, and machine-specific notes do not belong in `docs/`. Keep them outside the repository or under ignored `local-docs/`.

## Development Flow

`0.3` is the active 0.3.x line. Ordinary documentation updates, UI iteration, recommendation changes, plugin-system work, and 0.3.x fixes should target `0.3`; use `0.2` only when explicitly maintaining the previous stable line.

Recommended validation:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

When Docker release, migrations, or persistence paths are touched, add Docker build smoke and persistent-upgrade smoke checks.

Core database migrations must use the app's default user-visible blocking migration gate. When an existing database starts on a new version, the web service should remain reachable, ordinary business APIs and background jobs should pause, and the frontend should show upgrade progress. Deployment scripts must not directly call `runMigrations()` from temporary code against production or test-instance databases.

The offline CLI is only for repair or manual drills; it is not the normal deployment path. When it is needed, stop the old container, checkpoint SQLite WAL, confirm the backup strategy, and run the new image with:

```bash
DIBAO_ALLOW_BLOCKING_MIGRATION=1 \
DIBAO_DB_BACKUP_CONFIRMED=1 \
DIBAO_DATABASE_PATH=/data/dibao.sqlite \
npm run ops:migrate:core
```

The command blocks until migration completion and prints a backup, migration, and key-count report. Changes that rebuild embeddings, vector indexes, or recommendation profiles still need a dedicated user-visible data-upgrade flow in addition to this Core migration gate.

## Plugin Development

Read:

- [Plugin development guide](./plugin-development.en-US.md)
- [插件开发指南](./plugin-development.zh-CN.md)
- [プラグイン開発ガイド](./plugin-development.ja-JP.md)
- [Plugin system design](./plugin-system-design.md)
- [Runtime performance guidelines](./runtime-performance.md)

Plugin APIs in 0.3 are split into Stable and Beta. Manifest v1, lifecycle, settings/storage/secrets/deliveries/tasks, basic hooks, iframe bridge, manifest migrations, network outbound, and the basic event catalog are Stable. `database.defineTable`, ranking, article snapshot/content, full-content extractors, and diagnostics-style APIs are Beta.

## Compatibility Rules

- Public APIs, manifest v1 fields, capability names, and hook names must evolve through documented compatibility changes.
- Released migrations must not be deleted or rewritten.
- Plugin package directories, plugin data directories, and the user SQLite database must survive Docker rebuilds.
- Core database migrations must default to the app's user-visible blocking migration gate; deployment scripts must not bypass it by running migrations directly.
- Changes that require embedding recomputation, vector-index rebuilds, or recommendation-profile rebuilds must use an explicit data-upgrade flow and must not run implicitly on ordinary request paths.
- Changes that touch background jobs, SQLite write locks, hot request paths, diagnostics, or plugin hooks must follow the [runtime performance guidelines](./runtime-performance.md).
