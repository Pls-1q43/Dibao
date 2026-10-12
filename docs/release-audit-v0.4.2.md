# v0.4.2 Release Audit

## Scope

Three reported desktop problems plus the previously validated desktop proxy feature. Work is frozen on release/v0.4.2, not directly committed to main. All targets must use one commit and version. The user explicitly authorized the full release and continuing certificate-free distribution, with OS restrictions disclosed. Synology is not part of this release's deployment scope.

## Findings And Repairs

- The downloaded v0.4.1 Apple Silicon DMG matches its GitHub SHA-256, but its application fails strict deep codesign verification: resources changed without regenerating the application seal. v0.4.2 explicitly ad-hoc signs the final app and nested binaries with hardened runtime retained. Only Electron/Node JIT and ad-hoc library-validation entitlements are granted. Developer ID and notarization are still absent; valid integrity signatures do not establish publisher trust.
- The reported content error contains a 198.18.0.18 DNS answer. This matches the default Clash/Mihomo Fake-IP pool. Desktop resolves only recognized all-Fake-IP DNS answers through TLS-validated Cloudflare DoH, then enforces public-address validation and DNS pinning. The DoH bootstrap uses a fixed public address and original TLS server name. Arbitrary article URLs cannot select the resolver. Responses, TTL, cache count and duration are bounded; failure is closed. Docker keeps its ordinary resolver.
- Desktop unnecessarily shared PWA revocation/cache guards. Authentication now uses the local HTTP service and its persistent cookie, not PWA caches. Old cache tombstones cannot veto explicit local sign-in. Cookie changes are committed before returning and are not applied a second time by Chromium. Web/PWA revocation behavior remains in place. A storage getter denied by the browser is treated as unsupported, rather than throwing during authentication.

## Security Checks

- Loopback-only dynamic service; private process capability remains required in addition to account authentication. External pages and plugin frames do not receive desktop privileges or the capability.
- No proxy credentials, URL paths or generic IPC exposed through the renderer. Proxy saves are transactional across the browser, updater, HTTP and worker; rollback failures stop the service. Failed manual proxies do not silently switch to direct.
- Fake-IP literals, localhost, local-domain names, metadata names, ordinary private answers, mixed private/Fake-IP answers, unsafe redirects and invalid certificates remain denied by strict full-content policy. Explicit existing LAN-feed policy is preserved.
- A missing signature report, failed native upgrade, wrong revision, corrupt installer or missing target prevents promotion. A resource-tampering negative test must fail signature verification.
- Upgrades and reinstalls preserve data; no new SQL migration or mandatory derived-data/embedding rebuild is introduced. Tests compare articles, saved states, vectors, settings, client storage and plugin keys across actual installer replacement. Existing historical upgrade fixtures separately compare all persisted embedding bytes and metadata.
- Private Sentry build authorization is not packaged. Formal image acceptance requires runtime/browser configuration and debug IDs, with sanitized reports only. Docker must exclude Electron and the desktop runtime, and browser E2E must keep desktop controls absent.

## Acceptance Evidence

Local source validation: 694 workspace tests, 32 release-gate tests, typecheck and production builds passed; npm production audit reported zero vulnerabilities. Real background Node tests cover HTTP/HTTPS/SOCKS5, TLS/SNI, Fake-IP public-address pinning and private-answer rejection. Historical upgrades include v0.4.1 through the oldest supported public release and detect embedding changes.

Native and published-image acceptance is mandatory in [Publish Complete Release](https://github.com/Pls-1q43/Dibao/actions/workflows/publish-docker-image.yml). Validation-only runs do not promote version/stable/latest tags. Windows x64, Intel Mac and Apple Silicon runs retain first-run, login cycles, backup/recovery, startup, actual previous-release upgrade and installer evidence. Both exact image digests undergo fresh, historical and worker-disabled upgrade tests, browser/mobile E2E, Sentry/isolation checks and Trivy scanning. Fixable high/critical runtime findings block promotion; vendor-unfixed findings remain in the retained image-security reports and require exposure review. No local source test alone constitutes release completion.

## Limitations

No Developer ID certificate or notarization is available. Gatekeeper acceptance is not claimed; organizational policy may block the app. macOS updates remain manual and unsigned login-item registration may be unreliable. Windows packages remain publisher-unsigned. DoH fallback supports the default IPv4 Fake-IP benchmark range, not arbitrary private ranges or custom IPv6 pools. Domain queries go to Cloudflare only for this desktop compatibility path. No data clearing, embedding provider call or OS-security bypass is part of a repair.

References: [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [electron-builder ad-hoc signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/), [Mihomo DNS](https://wiki.metacubex.one/en/config/dns/), [Cloudflare DoH JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/).
