# v0.4.1 release audit

## Scope and source

The release/v0.4.1 line preserves the prior desktop work and freezes Desktop, HTTP, workers, shared packages and Docker at version 0.4.1. The release manifest binds all three native artifacts to one Git revision. Main is updated only after publication. No Synology instance or permanent maintenance data is modified by acceptance tests.

## Findings fixed

- Updated Fastify to 5.12.5, Undici to 7.30.0 and fast-uri to 3.1.8. Production npm audit reports zero known advisories.
- Updated Vitest 4.1.11, brace-expansion 5.0.12 and source-map-js 1.2.2. Standard npm ci succeeds without special peer flags; no high/critical npm advisories remain.
- Docker runtime applies available Debian security updates and removes unused bundled npm/Corepack/Yarn tools. Build stages still retain their package managers; all application/plugin production dependencies are preinstalled. The shipped plugin host launches Node directly and does not install dependencies at runtime.
- Damaged backup manifests previously prevented listing healthy restore points. Each corrupt snapshot is now isolated and left untouched.
- Recovery now rejects empty/missing-database manifests, duplicate paths, traversal, absolute/drive paths, invalid hashes, symlinked files and manifest/journal version mismatch. Staged files are verified before either live directory is moved, including crash-resume cases.
- Empty or incomplete newly created snapshots cannot be published as valid backups. Failures preserve the data version and current live data.
- A smoke test used an asynchronous browser predicate without awaiting it. It now polls the actual saved reading progress, so pending-write acceptance is no longer vacuous.
- Formal asset assembly now verifies every installer, checksum, native source identity and upgrade result before Docker promotion. Both Mac architectures are merged into updater metadata rather than overwriting each other. Three-language notes are required before building a formal version. Partial uploads remain drafts.

## Security and business review

| Area | Protection and acceptance |
| --- | --- |
| Local HTTP | Random private capability, constant-time validation, loopback-only dynamic port; user authentication remains required |
| Renderer | Sandbox, context isolation, no Node integration, primary-frame IPC sender/origin validation; foreign pages cannot call privileged backup/update operations |
| Plugins | Opaque sandboxed frames; credential-free public stylesheet reads only; no private desktop capability inherited by plugin children |
| Session | Secure HttpOnly cookies at a fixed origin; CSRF origin checks; persistent login after restart/internal-port change; account changes and offline session revocation covered |
| Data | Complete cold backups of SQLite/WAL, plugin data/keys and browser profile; validated recovery, pre-restore safety snapshots, version/downgrade protection |
| Writes | Reader progress is flushed before shutdown; unsaved settings/migration/conflicting operations block backup/update; worker stops before HTTP |
| Lifecycle | Singleton and directory lock, writer ownership, forced-exit recovery, background fetching, second-instance and resume tests |
| Updates | electron-updater, explicit download/restart confirmations, checksum/interruption tests on Windows native CI, no automatic quit-time installation or downgrade, stable/prerelease separation |
| Docker isolation | No desktop runtime, Electron or electron-updater in runtime images; Web/PWA have no preload, desktop controls are absent; PWA cache/settings remain usable |
| Secrets | Ignored private Sentry config, sanitized runtime config, no publishing token in the app, production source maps removed after upload; diagnostics expose booleans only |
| Migration | No new SQL from v0.4.0; all historical migrations preserved; embedding bytes/hashes/timestamps compared and provider calls prohibited during upgrade tests |

## Local acceptance

Completed on macOS Apple Silicon on 2026-10-11:

- Full source build and typecheck.
- 651 workspace tests and 18 release-gate tests.
- Historical upgrade fixtures: fresh, v0.1.0, v0.1.1, v0.1.2, v0.1.3, v0.2.0, v0.2.1, v0.3.0, v0.3.1 and v0.4.0; no pending migrations, foreign-key errors or changed embeddings.
- 28 browser/mobile E2E cases, including real offline/cold refresh, session revocation, recommendation scrolling, actions and desktop-control absence.
- Packaged native application: three-language first run, optional RSS setup, plugin stylesheet, login restart, private HTTP, offline reading, SSE, untrusted IPC, tray, singleton, resume and progress flush.
- Real backup/recovery UI: 17 checks, including cold save/restore, dates, cancellation, dirty settings, damaged snapshots, safety copy, article state, keys, client state and narrow layout; zero renderer errors.
- Real background startup: 12 checks, including no window flash, HTTP/worker/background fetch, tray/manual activation and error feedback; zero renderer errors. This does not claim a real OS logout/login test.
- Isolated installed 0.4.1 → synthetic 0.4.2 manual Mac replacement, force-exit recovery and full-data comparison. The synthetic version is never published.

## Publication gates

The complete-release workflow must independently pass all native targets and source/E2E gates at the frozen revision. Docker acceptance pulls exact registry digests for both architectures and tests fresh installation, v0.4.0/v0.3.1/v0.1.0/v0.1.3 upgrades, and disabled-worker variants in network-isolated volumes. Images must have effective browser/runtime Sentry configuration and no desktop runtime. Trivy OS/library reports are retained; fixable high/critical findings block promotion. Native evidence and reports are retained as Actions artifacts; public assets include a source/checksum manifest.

## Explicit limitations

Packages remain unsigned. macOS requires manual DMG replacement; signed automatic installation and reliable unsigned login registration are not claimed. Windows ARM, remote-instance connection, NAS imports and multi-device sync remain unsupported. No finite audit guarantees absence of unknown vulnerabilities.

The full development-dependency audit still reports seven moderate entries from one unpatched sprintf-js advisory through the electron-builder download/logging chain (roarr/global-agent/@electron/get). These are build-time dependencies, not installed production app/runtime dependencies; the shipped updater is unaffected. No user input is supplied as a logger format. Blindly forcing npm's suggested builder downgrade is not accepted as a security fix. Recheck on every release and adopt a compatible upstream fix when available. See [upstream advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

Trivy also flags Debian source-package advisories without a vendor fix. They are retained in full reports, not hidden by a blanket ignore list: util-linux/mount/nsenter issues require privileged mounting/cgroup operations absent from the non-root container; systemd-homed is not installed; gzip LZH/Perl archive/ncurses terminal paths are not used to parse articles; zlib's minizip API is not used; GnuTLS and system OpenSSL DTLS paths are not used by the Node HTTP/TLS service. These findings do not establish a reachable remote Dibao exploit. Do not run the image privileged, add host-device mounts or grant arbitrary plugins root access. Re-evaluate exposure and vendor fixes on every release. Fixable high/critical findings remain blocking.

References: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [Undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-3xpg-4rpp-hhhm), [Fastify advisory](https://github.com/fastify/fastify/security/advisories/GHSA-4mh8-r7rc-xpvc), [desktop installation limits](./desktop-install.md).
