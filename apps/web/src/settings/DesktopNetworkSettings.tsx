import { useEffect, useState } from "react";
import { defaultDesktopProxySettings, normalizeDesktopProxySettings, type DesktopProxySettings } from "@dibao/shared";
import { desktopBridge } from "../desktop.js";
import { useI18n } from "../i18n.js";
import styles from "../design-system/AppShell/AppShell.module.css";

export const desktopProxyCopy = {
  "zh-CN": { title: "网络代理", mode: "代理模式", system: "跟随系统代理", direct: "不使用代理", manual: "手动配置", server: "代理地址（HTTP / HTTPS / SOCKS5）", bypass: "局域网地址直连", save: "保存代理设置", saving: "正在保存", test: "测试连接", testing: "正在测试", loading: "正在读取代理设置", saved: "代理设置已生效", success: (ms: number) => `连接成功，耗时 ${ms} ms`, failed: "连接失败，请检查代理服务和网络。", invalid: "请输入有效的 HTTP、HTTPS 或 SOCKS5 代理地址，不包含账号、密码或路径。", error: "代理设置未能保存，请稍后重试。", loadError: "代理设置未能读取，请重新打开设置。", testDraft: "请先保存代理设置", local: "本地阅读服务保持直连", endpoint: "连接测试：Google 204" },
  "ja-JP": { title: "ネットワークプロキシ", mode: "プロキシモード", system: "システムのプロキシを使用", direct: "プロキシを使用しない", manual: "手動設定", server: "プロキシアドレス（HTTP / HTTPS / SOCKS5）", bypass: "LAN アドレスは直接接続", save: "プロキシ設定を保存", saving: "保存中", test: "接続をテスト", testing: "テスト中", loading: "プロキシ設定を読み込み中", saved: "プロキシ設定を適用しました", success: (ms: number) => `接続成功：${ms} ms`, failed: "接続に失敗しました。プロキシサービスとネットワークを確認してください。", invalid: "有効な HTTP、HTTPS または SOCKS5 アドレスを入力してください。認証情報やパスは使用できません。", error: "プロキシ設定を保存できませんでした。後で再試行してください。", loadError: "設定を読み込めませんでした。設定画面を開き直してください。", testDraft: "先にプロキシ設定を保存してください", local: "ローカルの読書サービスは直接接続", endpoint: "接続テスト：Google 204" },
  "en-US": { title: "Network Proxy", mode: "Proxy mode", system: "Use system proxy", direct: "No proxy", manual: "Manual configuration", server: "Proxy address (HTTP / HTTPS / SOCKS5)", bypass: "Connect directly to LAN addresses", save: "Save proxy settings", saving: "Saving", test: "Test connection", testing: "Testing", loading: "Loading proxy settings", saved: "Proxy settings applied", success: (ms: number) => `Connected in ${ms} ms`, failed: "Connection failed. Check the proxy service and network.", invalid: "Enter a valid HTTP, HTTPS or SOCKS5 proxy address without credentials or a path.", error: "Proxy settings could not be saved. Try again later.", loadError: "Proxy settings could not be loaded. Reopen Settings.", testDraft: "Save proxy settings first", local: "Local reading service connects directly", endpoint: "Connection test: Google 204" }
};

export function desktopProxyDraftWithMode(draft: DesktopProxySettings, mode: DesktopProxySettings["mode"]): DesktopProxySettings {
  let server = draft.server;
  if (mode !== "manual") {
    try { normalizeDesktopProxySettings(draft); }
    catch { server = defaultDesktopProxySettings.server; }
  }
  return { ...draft, mode, server };
}

export function DesktopNetworkSettings({ hidden, onDirtyChange }: { hidden?: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const bridge = desktopBridge();
  const { locale } = useI18n();
  const t = desktopProxyCopy[locale];
  const [draft, setDraft] = useState<DesktopProxySettings>({ ...defaultDesktopProxySettings });
  const [saved, setSaved] = useState<DesktopProxySettings | null>(null);
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.getProxySettings().then(settings => {
      if (active) { setSaved(settings); setDraft(settings); }
    }).catch(() => { if (active) setError("load"); });
    return () => { active = false; };
  }, [bridge]);
  useEffect(() => { onDirtyChange(dirty || pending !== null); }, [dirty, pending, onDirtyChange]);

  const edit = (patch: Partial<DesktopProxySettings>) => {
    setDraft(previous => ({ ...previous, ...patch })); setError(null); setNotice(null);
  };
  const changeMode = (mode: DesktopProxySettings["mode"]) => edit(desktopProxyDraftWithMode(draft, mode));
  const save = async () => {
    if (!bridge || pending || !saved) return;
    let settings: DesktopProxySettings;
    try { settings = normalizeDesktopProxySettings(draft); }
    catch { setError("invalid"); return; }
    setPending("save"); setError(null); setNotice(null);
    try {
      const applied = await bridge.setProxySettings(settings);
      setSaved(applied); setDraft(applied); setNotice("saved");
    } catch (failure) { setError(String(failure).includes("DIBAO_PROXY_INVALID") ? "invalid" : "save"); }
    finally { setPending(null); }
  };
  const test = async () => {
    if (!bridge || pending || !saved || dirty) return;
    setPending("test"); setError(null); setNotice(null);
    try {
      const result = await bridge.testProxyConnection();
      if (result.ok) setNotice(String(result.elapsedMs)); else setError("test");
    } catch { setError("test"); }
    finally { setPending(null); }
  };
  if (!bridge) return null;
  const errorText = error === "invalid" ? t.invalid : error === "load" ? t.loadError : error === "test" ? t.failed : t.error;
  return <section aria-labelledby="settings-desktop-proxy-title" className={styles.settingsSection} hidden={hidden}>
    <h3 id="settings-desktop-proxy-title">{t.title}</h3>
    {!saved && !error ? <p role="status">{t.loading}</p> : null}
    <div className={styles.settingsGrid}>
      <label className={styles.settingsField} htmlFor="desktop-proxy-mode">
        <span>{t.mode}</span>
        <select id="desktop-proxy-mode" value={draft.mode} disabled={!saved || pending !== null} onChange={event => changeMode(event.target.value as DesktopProxySettings["mode"])}>
          <option value="system">{t.system}</option>
          <option value="direct">{t.direct}</option>
          <option value="manual">{t.manual}</option>
        </select>
      </label>
      {draft.mode === "manual" ? <label className={styles.settingsField} htmlFor="desktop-proxy-server">
        <span>{t.server}</span>
        <input id="desktop-proxy-server" type="text" inputMode="url" autoComplete="off" spellCheck={false} value={draft.server} placeholder="http://127.0.0.1:7890" disabled={!saved || pending !== null} onChange={event => edit({ server: event.target.value })} />
      </label> : null}
    </div>
    <label className={styles.settingsInlineStatus} htmlFor="desktop-proxy-bypass">
      <span>{t.bypass}</span>
      <input id="desktop-proxy-bypass" type="checkbox" checked={draft.bypassLocal} disabled={!saved || pending !== null || draft.mode !== "manual"} onChange={event => edit({ bypassLocal: event.target.checked })} />
    </label>
    <div className={styles.desktopUpdateActions}>
      <button type="button" className={styles.secondaryButton} disabled={!saved || pending !== null || !dirty} onClick={() => void save()}>{pending === "save" ? t.saving : t.save}</button>
      <button type="button" className={styles.secondaryButton} disabled={!saved || pending !== null || dirty} title={dirty ? t.testDraft : t.endpoint} onClick={() => void test()}>{pending === "test" ? t.testing : t.test}</button>
    </div>
    <small className={styles.managementHint}>{t.local}</small>
    {notice ? <p role="status">{notice === "saved" ? t.saved : t.success(Number(notice))}</p> : null}
    {error ? <p role="alert" className={styles.errorText}>{errorText}</p> : null}
  </section>;
}
