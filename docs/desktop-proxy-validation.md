# Desktop proxy validation

Status: implemented and functionally validated on `0.4`, not released. The initially locked Mac was later unlocked and the core native settings workflow was exercised against isolated QA data. This record is not a complete native-platform or release acceptance.

## Verified Locally

- Full workspace regression: 683 tests passed; typecheck and Desktop build passed.
- Actual bundled Node 22.23.3: five HTTP/worker proxy integration tests passed. HTTP, HTTPS and SOCKS5 cover Provider requests without local DNS/TUN, pinned feed requests, original Host/TLS SNI, valid and invalid certificates, system-proxy IPC, hot changes and failure without direct fallback.
- Explicit Desktop routing takes precedence over inherited `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`. Loopback reading and SSE remain direct; the private Desktop access token is not forwarded to external services.
- Existing private-network policy, redirect validation, response size and timeout limits passed. Configuration validation, atomic persistence, restart, complete backup/restore and rollback failures have focused tests.
- Actual macOS Electron network session: HTTP/HTTPS/SOCKS5 parsing, IPv6 rules, LAN bypass toggle and mandatory loopback/link-local bypass passed in an isolated, windowless session.
- Actual macOS Desktop UI: default system mode, selecting manual mode, rejection of credential-bearing proxy URLs, saved-configuration feedback and a successful Google HTTPS connection test were verified. A normal application restart retained the account session and the exact manual proxy address.
- Actual macOS Provider UI: a disabled configuration using `clash-provider.example.invalid` successfully tested its embedding endpoint through the fixture HTTP proxy. The proxy recorded the CONNECT request; no local DNS or TUN route could resolve this fixture domain. The test did not activate an index or run an embedding rebuild.
- Actual macOS Desktop UI with an unavailable proxy at port 9: connection failure was reported, the local article list and stored article body opened, and the persisted article body remained intact. A later empty-address draft caused the native unsaved-changes quit confirmation; discarding only that QA draft allowed shutdown.
- Component tests cover all three localized Desktop control renderings and the exact mode-change handler: leaving manual mode with an empty, invalid or credential-bearing draft resets its hidden endpoint to a valid default, while valid endpoints and LAN preferences are retained. These rendering tests do not replace native localized layout acceptance.
- Temporary Docker linux/amd64 image: fresh database and a fixture seeded from the formal v0.4.1 image passed. All 26 migrations remained present. The upgraded fixture retained 65 embeddings with the exact same digest; no Provider calls occurred.
- Docker contains no Electron/Desktop runtime, and its global dispatcher remains unchanged even with invalid Desktop proxy configuration in its environment.
- Actual Docker browser settings: Desktop proxy controls absent; existing PWA offline controls present; no warning/error console entries.
- Temporary Docker runtime/browser Sentry configuration is present, build auth token absent and source maps absent. Local source-map upload was intentionally disabled; the formal debug-ID/release promotion gate was not claimed as passed.

## Additional Acceptance Before Release

- Native localized/narrow-layout checks and a UI-driven mode change from an invalid address are not recorded as passed. Background-window input was unreliable in the native automation tool. The core native workflows above and the component mode-change tests are recorded separately rather than treating that tool limitation as a product pass.
- Windows x64 and macOS Intel native validation. The existing three-platform CI workflow now includes proxy integration and Electron-session tests, but it has not been pushed or run for these changes.

No version, SQL migration, release tag, stable image alias, OS proxy setting, installed Dibao user data or Synology instance was changed by this work.
