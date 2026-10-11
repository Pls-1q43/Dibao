# Desktop implementation and internal builds

## Architecture

`apps/desktop` is an Electron shell for the existing HTTP application. Electron's sandboxed renderer uses `https://dibao.localhost`; the session protocol handler streams requests to a private loopback Node service. A random process-only capability protects every local HTTP endpoint, in addition to account authentication and CSRF checks. It is never exposed by preload. Foreign origins, navigation and IPC senders cannot use the desktop bridge. External links open in the system browser.

Electron and Node native dependencies are separate. `scripts/desktop/prepare-resources.mjs` installs production workspace dependencies, materializes workspace links, copies shipped migrations and official plugins, and verifies the bundled Node 22 archive. It probes `better-sqlite3` and `sqlite-vec` using that Node executable. Do not rebuild these modules for Electron's ABI. Each target builds on a native runner.

No SQL migrations are added by the desktop shell. Every shipped migration remains in the payload, including cross-version upgrade support.

Only the HTTP process listens, on `127.0.0.1:0`. The worker has no listening socket. Both use the persistent data directory and stop through IPC; parent disconnect also stops them. Desktop shutdown waits for background writes, migration ownership and plugin subprocess exits. A close hides the window, while Quit stops the services. The desktop renderer does not register a PWA service worker or switch to its cache subset.

Before stopping services, the shell awaits the preload's narrowly scoped save-state callbacks. The reader flushes throttled progress and waits for pending writes; a failed flush blocks update installation or exit for retry. Dirty settings/provider/password drafts also block an update. Queued core migrations are cancelled on shutdown instead of starting a new writer after Quit.

Each local Node process records its own lifetime ownership before opening the database. After a forced desktop exit, the next startup waits for orphaned services to finish; it cannot back up or migrate while an old writer is still alive. A service whose parent disconnected before startup exits without opening data.

## Data lifecycle

The stable roots are `%LOCALAPPDATA%\Dibao` and `~/Library/Application Support/Dibao`. `data`, `profile`, `backups`, `runtime` and `logs` are separate. The single-instance lock lives outside the profile; a PID lock protects database ownership. New versions back up the complete database, WAL and persistent profile before starting services or opening their persistent session. Plugin keys and existing vectors are preserved; no embedding rebuild is added.

`desktop-state.json` records the highest opened version and an incomplete-upgrade marker. Older applications are blocked. The existing blocking upgrade screen owns database/derived migrations. A successful status and authenticated article-list read finish the marker and prune old upgrade backups to three. Recovery snapshots are not pruned.

Confirmed recovery records a request and exits. On the next startup, while holding the data lock and before opening Chromium's persistent session, Dibao verifies the chosen backup, saves the current state, stages replacement directories, records a restore journal and replaces the data/profile. An interrupted journal resumes at the next startup and verifies restored hashes before clearing the journal. Never restore an open Chromium profile or copy only a SQLite main file.

## Build and validation

Use Node 22 and a clean dependency install. Runtime and updater versions are pinned in the workspace lockfile. Private telemetry uses the existing ignored Sentry config, never a tracked credential. The resource preparation gate verifies runtime/browser configuration and excludes build auth tokens.

```sh
npm ci
npm run build:desktop
npm run typecheck
npm test
node scripts/desktop/package.mjs
node scripts/desktop/ci-smoke.mjs
node scripts/desktop/upgrade-smoke.mjs
```

The packaged smoke test runs from a temporary directory outside the checkout. It verifies authentication, cookie persistence, article bodies, true Chromium offline emulation, reload, SSE, absence of service workers, sandboxed permissions, tray mode, singleton ownership, resume and recovery. Screenshots and JSON evidence go to `test-results/desktop-PLATFORM-ARCH`.

The installed upgrade test builds the next beta version without changing source versions or tags. On macOS it manually replaces the application in an isolated installation directory. On Windows it first installs NSIS, then uses the real electron-updater against a local fixture serving electron-builder's generated metadata and installer. This test fixture is not a shipped update server or custom update protocol. It exercises interrupted downloads, invalid checksums, explicit installation/restart and recovery after forced exit. It compares article content/state, subscriptions, a real sqlite-vec table, settings, plugin keys and browser state across versions.

Windows installer validation runs only on a disposable GitHub Actions runner, using the real `%LOCALAPPDATA%\Dibao` data root. It refuses to replace an existing directory. This covers shell-launched installer restarts without relying on inherited test environment variables. macOS validation uses an isolated data-root override so local developer data is never touched.

`.github/workflows/build-desktop.yml` builds Windows x64, macOS Intel and macOS Apple Silicon, and uploads installers plus validation evidence. A push to `0.4` creates only CI artifacts. It does not publish a release, tag, Docker image or alter Synology.

## Release boundary

The current desktop package is `0.4.1-beta.1`, distinct from the existing `0.4.0` service line. Formal desktop publication requires separate approval. Upload the generated installer, blockmaps and matching `beta.yml` / `beta-mac.yml` only to an approved prerelease; stable metadata belongs only to stable releases. The application consumes GitHub Releases without a publishing token. Data compatibility is conservative: downgrades require explicit restore.

The updater disables automatic download and quit-time installation. Windows uses NSIS and electron-updater; unsigned macOS uses manual DMG replacement only. Do not enable macOS automatic installation until Developer ID signing and notarization are configured and tested. Keep `com.dibao.desktop`, product identity and data roots unchanged when signing is introduced. Do not bypass signature validation.

Official references: [electron-updater](https://www.electron.build/v26/docs/features/auto-update/), [Electron protocol sessions](https://www.electronjs.org/docs/latest/api/protocol), [GitHub native runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
