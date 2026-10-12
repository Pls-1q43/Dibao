// Network-session API test only; no windows, OS proxy changes or persistent user data.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

if (process.versions.electron) {
  const { app, session } = await import("electron");
  const root = process.env.DIBAO_PROXY_SESSION_SMOKE_DATA;
  assert(root);
  await mkdir(join(root, "profile"), { recursive: true });
  app.setPath("userData", root);
  app.setPath("sessionData", join(root, "profile"));
  let failed = false;
  void app.whenReady().then(async () => {
  try {
    const { desktopProxySessionConfig, defaultDesktopProxySettings } = await import(pathToFileURL(resolve("packages/shared/dist/desktop-proxy.js")).href);
    const network = session.fromPartition("dibao-proxy-smoke");
    const settings = { ...defaultDesktopProxySettings, mode: "manual", server: "http://127.0.0.1:7890" };
    const checks = [];
    for (const bypassLocal of [true, false]) {
      await network.setProxy(desktopProxySessionConfig({ ...settings, bypassLocal }));
      await network.closeAllConnections();
      for (const host of ["localhost", "dibao.localhost", "127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "169.254.1.1", "[fe80::1]"]) {
        assert.equal(await network.resolveProxy(`https://${host}`), "DIRECT", `Loopback leaked to proxy: ${host}`);
      }
      for (const host of ["10.0.1.2", "172.20.1.2", "192.168.1.1", "[fd00::1]", "nas", "rss.local"]) {
        assert.equal(await network.resolveProxy(`http://${host}`), bypassLocal ? "DIRECT" : "PROXY 127.0.0.1:7890", `LAN bypass mismatch: ${host}`);
      }
      assert.equal(await network.resolveProxy("https://example.com"), "PROXY 127.0.0.1:7890");
      checks.push({ bypassLocal, loopbackDirect: true, lanMatches: true, publicProxied: true });
    }
    for (const server of ["socks5://127.0.0.1:7891", "https://127.0.0.1:8443"]) {
      await network.setProxy(desktopProxySessionConfig({ ...settings, server }));
      assert.equal(await network.resolveProxy("https://example.com"), server.startsWith("socks5") ? "SOCKS5 127.0.0.1:7891" : "HTTPS 127.0.0.1:8443");
    }
    await network.setProxy({ mode: "direct" });
    assert.equal(await network.resolveProxy("https://example.com"), "DIRECT");
    console.log(JSON.stringify({ passed: true, platform: process.platform, checks }));
  } catch (error) { failed = true; console.error(error); }
  finally { app.exit(failed ? 1 : 0); }
  });
} else {
  const root = await mkdtemp(join(tmpdir(), "dibao-proxy-session-smoke-"));
  const require = createRequire(import.meta.url);
  try {
    await new Promise((accept, reject) => {
      const child = spawn(require("electron"), [resolve("scripts/desktop/proxy-session-smoke.mjs")], { env: { ...process.env, DIBAO_PROXY_SESSION_SMOKE_DATA: root }, stdio: "inherit" });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => {
        clearTimeout(timer);
        if (timedOut) reject(new Error("Electron proxy session test timed out"));
        else if (code === 0) accept();
        else reject(new Error(`Electron proxy session test exited with ${code}`));
      });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
