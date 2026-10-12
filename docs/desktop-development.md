# Desktop implementation and internal builds

## Architecture

`apps/desktop` is an Electron shell for the existing HTTP application. Electron's sandboxed renderer uses `https://dibao.localhost`; the session protocol handler streams requests to a private loopback Node service. A random process-only capability protects every local HTTP endpoint, in addition to account authentication and CSRF checks. It is never exposed by preload. Foreign origins, navigation and IPC senders cannot use the desktop bridge. External links open in the system browser.

Electron and Node native dependencies are separate. `scripts/desktop/prepare-resources.mjs` installs production workspace dependencies, materializes workspace links, copies shipped migrations and official plugins, and verifies the bundled Node 22 archive. It probes `better-sqlite3` and `sqlite-vec` using that Node executable. Do not rebuild these modules for Electron's ABI. Each target builds on a native runner.

No SQL migrations are added by the desktop shell. Every shipped migration remains in the payload, including cross-version upgrade support.

Only the HTTP process listens, on `127.0.0.1:0`. The worker has no listening socket. Both use the persistent data directory and stop through IPC; parent disconnect also stops them. Desktop shutdown waits for background writes, migration ownership and plugin subprocess exits. A close hides the window, while Quit stops the services. The desktop renderer does not register a PWA service worker or switch to its cache subset.

Login startup is distinct from manual launch. macOS uses `wasOpenedAtLogin` and accessory activation policy; Windows registers and reads the same `--dibao-background` argument. Existing Windows registrations migrate to that argument without re-enabling an OS-disabled startup entry. Login startup loads the reader invisibly and keeps the worker/tray running. Initial launch activation cannot show the window; explicit tray opening, Dock activation or a manual second launch can. Repeated background launches stay hidden. Backup/recovery relaunches explicitly request the foreground so completion feedback remains visible. Blocking data failures retain the recovery prompt. Unsigned macOS login-item registration is not reliable until signing/notarization are configured; never substitute the removed `openAsHidden` API.

Before stopping services, the shell awaits the preload's narrowly scoped save-state callbacks. The reader flushes throttled progress and waits for pending writes; a failed flush blocks update installation or exit for retry. Dirty settings/provider/password drafts also block an update. Queued core migrations are cancelled on shutdown instead of starting a new writer after Quit.

Each local Node process records its own lifetime ownership before opening the database. After a forced desktop exit, the next startup waits for orphaned services to finish; it cannot back up or migrate while an old writer is still alive. A service whose parent disconnected before startup exits without opening data.

## Desktop network proxy

Settings > Basic includes a Desktop-only network proxy section, localized in Chinese, Japanese and English. System mode is the default and uses Electron's OS/PAC resolution for the browser, updater and both standalone Node services. Direct mode bypasses proxies. Manual mode accepts an HTTP, HTTPS or SOCKS5 proxy URL; Clash/FlClash HTTP or Mixed listeners such as `http://127.0.0.1:7890` work without TUN. This is an application setting, not a change to the OS network configuration. Proxy credentials, URL paths and rule injection are rejected. Legacy SOCKS4 system routes are not supported and fail rather than silently going direct.

The loopback reader, `dibao.localhost`, loopback providers and link-local addresses always remain direct, matching Chromium's mandatory bypass. Manual mode additionally offers LAN bypass; system mode follows the system's LAN rules. Saving applies to the persistent browser session, electron-updater's network session and HTTP/worker processes through private, acknowledged IPC. New background requests use the new route; existing requests may finish on their old route. Failed proxy requests do not retry through a direct connection. Saving is blocked during backup, recovery and update installation/download; an unconfirmed rollback stops services through the existing failure workflow.

Provider adapters use the Desktop-only Undici dispatcher. RSS, full-content and plugin host fetches keep their existing privacy checks, redirect checks, body/time limits and DNS pinning; the proxy connects to the checked IP with the original Host and TLS SNI. HTTPS certificate verification remains enabled. No extra embedding calls, migrations, algorithm changes or recalculation are introduced. Docker and standalone Node without the private Desktop capability/parent IPC keep their original dispatcher and fetch path; browser deployments without preload do not render the controls.

`data/desktop-proxy.json` is atomically replaced with user-only file permissions, contains no proxy password and participates in the existing complete backups/restores. Manual saving is independent of the server settings form, but proxy drafts and connection tests participate in the existing unsaved-state protection. The connection test runs the real HTTP background process against Google's HTTPS 204 endpoint, uses the saved configuration, has a timeout and never accepts an arbitrary renderer-supplied URL. Simultaneous tests share a single request. External links remain in the system browser and follow that browser's own proxy settings.

`proxy-runtime.test.ts` runs real private HTTP/worker IPC, HTTP CONNECT, HTTPS CONNECT and SOCKS5 handshakes against isolated fixture servers. It verifies provider requests without local DNS/TUN, feed IP pinning/Host/SNI, certificate rejection, LAN/loopback bypass, local SSE, hot changes, failure without a DIRECT fallback and existing fetch limits. Its temporary CA is only trusted by test child processes, never installed in the OS. Native Desktop CI runs these tests on all three runners; server/shared routing and Docker isolation tests are included as well.

`node scripts/desktop/proxy-session-smoke.mjs` verifies the actual Electron/Chromium proxy parser, including IPv6 CIDRs, mandatory loopback/link-local bypass and HTTP/HTTPS/SOCKS5 routes. It creates no window and uses only a disposable network session; OS settings and the normal Dibao profile are never touched.

## Data lifecycle

The stable roots are `%LOCALAPPDATA%\Dibao` and `~/Library/Application Support/Dibao`. `data`, `profile`, `backups`, `runtime` and `logs` are separate. The single-instance lock lives outside the profile; a PID lock protects database ownership. New versions back up the complete database, WAL and persistent profile before starting services or opening their persistent session. Plugin keys and existing vectors are preserved; no embedding rebuild is added.

`desktop-state.json` records the highest opened version and an incomplete-upgrade marker. Older applications are blocked. The existing blocking upgrade screen owns database/derived migrations. A successful status and authenticated article-list read finish the marker and prune old upgrade backups to three. Recovery snapshots are not pruned.

Confirmed recovery records a request and exits. On the next startup, while holding the data lock and before opening Chromium's persistent session, Dibao verifies the chosen backup, saves the current state, stages replacement directories, records a restore journal and replaces the data/profile. An interrupted journal resumes at the next startup and verifies restored hashes before clearing the journal. Never restore an open Chromium profile or copy only a SQLite main file.

Settings > About now includes manual backup, a dated restore-point selector (reason, version and size), and separate backup status/error feedback. A fresh install has no restore points and disables Restore. Both actions use a parented, localized native confirmation with Cancel as the default. Dirty settings, ongoing upgrades, insufficient space and concurrent operations are blocked before shutdown. The shell flushes pending reader writes and stops its services while retaining the data lock, records a narrowly scoped request, then restarts. Manual backups run on cold startup before the persistent profile or services open; failures preserve current data and produce a durable error result. Recovery verifies the selected snapshot both before shutdown and at startup, saves current data separately, and reopens Settings with completion feedback. Manual and recovery snapshots are never pruned by upgrade retention. Listing backups is read-only with respect to restore journals.

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

The packaged first-run smoke test covers all three languages, choosing a language before account creation, skipping feeds, enabling/declining Daily Brief, retaining settings and login after restart with no feeds, the plugin stylesheet/hidden-dialog contract, narrow layouts and native tray image dimensions. The welcome language is cached locally and saved to `ui.locale` at account creation; skipping feeds is persisted separately as `setup.sources.completed`.

`scripts/desktop/backup-smoke.mjs` exercises the actual settings controls against an isolated temporary profile: empty/disabled restore, dirty-settings feedback, cancel, manual cold backup, selected cold restore, preserved login/article state/content/plugin key/client storage, current-state safety snapshot, corrupt-backup feedback, untrusted IPC and narrow layout. It substitutes only native dialog answers and relaunch dispatch so Playwright owns each process; the real shutdown, persisted requests and cold-start data operations run unchanged. CI runs it for every native target.

`scripts/desktop/startup-smoke.mjs` launches real desktop processes with isolated data to verify hidden login intent without window flashes, live background RSS fetching, both singleton launch intents, explicit activation, normal visible launches and visible backup restarts. The settings IPC is real, but OS login-item calls are stubbed so the developer's login configuration is never changed. This does not replace a signed macOS logout/login acceptance test. CI runs the same packaged smoke on every native target.

Sandboxed plugin frames have opaque request initiators. The desktop protocol shares only GET/HEAD requests for the anonymous `/api/plugins/ui.css` stylesheet with those frames, without user cookies or authorization headers. All other opaque-origin requests remain denied; plugins still use the capability-scoped iframe bridge. The macOS template tray image is resized to 18 points, and the Windows tray image to 16 pixels, before constructing the tray.

The installed upgrade test builds the next beta version without changing source versions or tags. On macOS it manually replaces the application in an isolated installation directory. On Windows it first installs NSIS, then uses the real electron-updater against a local fixture serving electron-builder's generated metadata and installer. This test fixture is not a shipped update server or custom update protocol. It exercises interrupted downloads, invalid checksums, explicit installation/restart and recovery after forced exit. It compares article content/state, subscriptions, a real sqlite-vec table, settings, plugin keys and browser state across versions.

Windows installer validation runs only on a disposable GitHub Actions runner, using the real `%LOCALAPPDATA%\Dibao` data root. It refuses to replace an existing directory. This covers shell-launched installer restarts without relying on inherited test environment variables. macOS validation uses an isolated data-root override so local developer data is never touched.

`.github/workflows/build-desktop.yml` builds Windows x64, macOS Intel and macOS Apple Silicon, and uploads installers plus validation evidence. A push to `0.4` creates only CI artifacts. It does not publish a release, tag, Docker image or alter Synology.

The first complete native acceptance record is [desktop beta.1 validation](./desktop-validation-0.4.1-beta.1.md), including actual installed upgrades and explicit unsigned-build limits.

## Release boundary

Desktop and Docker share one formal version. Every formal release requires native Windows x64, Intel Mac and Apple Silicon installers plus the verified multiarch Docker image from one revision. The complete-release workflow validates all evidence and checksums before promotion, merges both Mac architectures into `latest-mac.yml` and publishes direct installers, blockmaps, checksums and three-language notes. Prerelease channels remain isolated. The application consumes GitHub Releases without a publishing token; downgrades require explicit restore. Certificate-free macOS still uses manual replacement.

The updater disables automatic download and quit-time installation. After the user's separate restart confirmation, Windows uses electron-updater's standard silent NSIS installation and explicit relaunch; unsigned macOS uses manual DMG replacement only. Do not enable macOS automatic installation until Developer ID signing and notarization are configured and tested. Keep `com.dibao.desktop`, product identity and data roots unchanged when signing is introduced. Do not bypass signature validation.

Official references: [electron-updater](https://www.electron.build/v26/docs/features/auto-update/), [Electron protocol sessions](https://www.electronjs.org/docs/latest/api/protocol), [GitHub native runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
