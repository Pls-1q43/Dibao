# Desktop internal build validation

Date: 2026-10-11. Desktop version: `0.4.1-beta.1`; bundled service version: `0.4.0`.

Tested source: `0bc9d7085c1f19bb69cdcc6170fdfac85bd2b881` on `0.4`.
[Native CI run](https://github.com/Pls-1q43/Dibao/actions/runs/38105137269): all three jobs completed successfully. No release or tag was published, and Synology and Docker aliases were not changed.

## Native applications

| Target | Internal artifact | Packaged application | Installed upgrade |
| --- | --- | --- | --- |
| Windows x64 | `Dibao-0.4.1-beta.1-win-x64.exe` | Passed | Real NSIS installation and electron-updater upgrade to beta.2 passed |
| macOS Intel | `Dibao-0.4.1-beta.1-mac-x64.dmg` | Passed | Manual application replacement to beta.2 passed |
| macOS Apple Silicon | `Dibao-0.4.1-beta.1-mac-arm64.dmg` | Passed | Manual application replacement to beta.2 passed |

Each smoke test relocates the application outside the source checkout. It verifies private loopback access, account setup and cookies, complete article bodies, Chromium offline mode and reload, absence of Service Workers, SSE, sandbox and untrusted IPC rejection, tray operation, single-instance ownership, resume events, pending reading-progress saves, service writer ownership, restart and complete backup/restore.

Windows update tests use electron-updater against standard builder-generated metadata and complete NSIS installers. Interrupted downloads and invalid checksums are rejected without stopping reading. Unsaved drafts block installation. Confirmed installation, automatic relaunch, forced-exit recovery and data regression passed. The final installation/relaunch/data-ready interval took approximately 3 minutes 47 seconds on the hosted runner, so the test allows five minutes rather than the original ninety seconds. This fixture is test-only, not a shipped update server.

All three upgrade tests compare article content and state, subscriptions, a real sqlite-vec table, settings, the plugin encryption key and persistent client storage. Login survives replacement, internal-port changes and forced restart. Upgrades create verified pre-upgrade backups. The desktop shell adds no database migrations and performs no embedding rebuild.

## Regression And Protection

Workspace typechecking passed. All 608 test cases passed: desktop 19, server 339, web 191, database 33, plugin SDK 4, ranking 11, RSS 8 and shared 3. The web suite was rerun with a thirty-second hook timeout after its browser teardown exceeded the default ten seconds; all cases and teardown then passed.

Protection tests cover backup failures, insufficient space, SQLite WAL, corrupted backups, unfinished upgrades, downgrade rejection, interrupted restore, deferred recovery, three-backup retention, retained recovery snapshots, plugin keys and client state. Shutdown regression tests prevent queued migrations and task drains from starting after storage closes, and verify that plugin subprocesses do not inherit the desktop access capability.

Native resource probes passed with Node `22.23.3`, SQLite `3.53.1` and sqlite-vec `v0.1.9`. All targets report effective server/browser telemetry configuration and no packaged Sentry build token: `hasDsn=true`, `hasOrg=true`, `hasProject=true`, `browserConfigured=true`, `hasBuildToken=false`.

## Explicit Limits

- These are unsigned internal builds. macOS signing, notarization and automatic installation are not claimed or enabled; macOS uses manual replacement.
- Resume handling was exercised through Electron's resume event, not a physical sleep/wake cycle on user hardware. Physical sleep/wake, managed-device security policies and OS quarantine prompts still need real-device acceptance.
- Upgrade tests use two increasing desktop beta versions with the same bundled database schema. Existing server migration coverage remains in place; this is not evidence of a new schema migration or an authorized embedding recomputation.
- GitHub Releases remains the production distribution source. No public beta release was created, and the application contains no publishing credential.
- Offline reading uses the complete local database. Fetching feeds, remote images and AI providers still require their respective network connections.

See [installation and recovery instructions](./desktop-install.md) for Simplified Chinese, Japanese and English, and [development instructions](./desktop-development.md) for build details.
