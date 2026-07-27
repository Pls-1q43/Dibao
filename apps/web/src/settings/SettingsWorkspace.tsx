import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { dibaoVersion } from "@dibao/shared";
import { dibaoApi, userMessageForError, type AppSettings, type CreateEmbeddingProviderInput, type EmbeddingIndex, type EmbeddingProvider, type LatestReleaseStatus, type PluginListItem, type UpdateEmbeddingProviderInput, type UpdateSettingsInput } from "../api.js";
import { useI18n, type Dictionary } from "../i18n.js";
import styles from "../design-system/AppShell/AppShell.module.css";
import { NumberSettingField, RangeSettingField } from "../ui/FormFields.js";
import { ActionIcon } from "../reader/ReaderPanels.js";
import { classNames, closestInterestClusterPresetIndex, defaultFavoriteArticleSort, defaultReadLaterArticleSort, draftForEmbeddingProvider, draftForSettings, draftWithProviderType, embeddingCoverageText, interestClusterLimitPresets, interestClusterPresetIndexFromSliderValue, newEmbeddingProviderId, parseEmbeddingProviderDraft, parseSettingsDraft, presetIndexForInterestClusterLimitDraft, presetIndexForInterestClusterLimits, retentionSettingsRequireCleanupConfirmation, shouldLetBrowserHandleLinkClick, urlForAppPage, type EmbeddingProviderDraft, type SettingsDraft } from "../app/shared.js";

type CoreSettingsTabId = "basic" | "algorithm" | "plugins";
type PluginSettingsTabId = `plugin:${string}:${string}`;
type SettingsTabId = CoreSettingsTabId | PluginSettingsTabId;
type PluginSettingsTab = {
  id: PluginSettingsTabId;
  plugin: PluginListItem;
  tab: NonNullable<PluginListItem["contributions"]["settingsTabs"]>[number];
};

const coreSettingsTabs = ["basic", "algorithm", "plugins"] as const;

const settingsTabLabels: Record<CoreSettingsTabId, { zhCN: string; enUS: string; jaJP: string }> = {
  basic: { zhCN: "基础设置", enUS: "Basics", jaJP: "基本設定" },
  algorithm: { zhCN: "算法", enUS: "Algorithm", jaJP: "アルゴリズム" },
  plugins: { zhCN: "插件", enUS: "Plugins", jaJP: "プラグイン" }
};

const pluginInstallDocsUrl: Record<AppSettings["ui"]["locale"], string> = {
  "zh-CN": "https://docs.dibao.app/zh/plugins/installation/",
  "en-US": "https://docs.dibao.app/en/plugins/installation/",
  "ja-JP": "https://docs.dibao.app/ja/plugins/installation/"
};

const pluginCopy = {
  "zh-CN": {
    title: "插件",
    body: "安装、启用和更新官方或第三方插件。第三方插件安装后默认保持未启用。",
    loading: "正在加载插件",
    empty: "尚未安装插件。",
    official: "官方",
    bundled: "随版本分发",
    thirdParty: "第三方",
    capabilities: "能力",
    contributions: "贡献",
    status: "状态",
    lastError: "错误",
    source: "来源",
    trust: "信任",
    stableApi: "Stable API",
    betaApi: "Beta API",
    thirdPartyRisk: "第三方插件会以本地可信代码运行在独立进程中；启用前请确认来源、签名信任和能力范围。",
    installTitle: "安装第三方插件",
    installBody: "上传开发者提供的 .dibao-plugin 文件。URL、JSON 包和校验和等高级安装方式请参考说明。",
    installDocs: "查看插件安装说明",
    chooseFile: "选择 .dibao-plugin",
    install: "安装",
    installing: "安装中",
    refresh: "刷新",
    enable: "启用",
    disable: "停用",
    update: "检查更新",
    uninstall: "卸载",
    runTask: "运行",
    taskStarted: (id: string) => `任务已加入队列：${id}`,
    updated: "插件状态已更新。",
    installed: "插件已安装，启用前请确认来源与权限。",
    installRequired: "请先选择 .dibao-plugin 文件。"
  },
  "en-US": {
    title: "Plugins",
    body: "Install, enable, and update official or third-party plugins. Third-party plugins stay disabled after install.",
    loading: "Loading plugins",
    empty: "No plugins installed yet.",
    official: "Official",
    bundled: "Bundled",
    thirdParty: "Third-party",
    capabilities: "Capabilities",
    contributions: "Contributions",
    status: "Status",
    lastError: "Error",
    source: "Source",
    trust: "Trust",
    stableApi: "Stable API",
    betaApi: "Beta API",
    thirdPartyRisk: "Third-party plugins run as trusted local code in an isolated process. Review source, signature trust, and capabilities before enabling.",
    installTitle: "Install third-party plugin",
    installBody: "Upload the .dibao-plugin file from the plugin developer. See the guide for URL, JSON package, and checksum flows.",
    installDocs: "Read plugin installation guide",
    chooseFile: "Choose .dibao-plugin",
    install: "Install",
    installing: "Installing",
    refresh: "Refresh",
    enable: "Enable",
    disable: "Disable",
    update: "Check update",
    uninstall: "Uninstall",
    runTask: "Run",
    taskStarted: (id: string) => `Task queued: ${id}`,
    updated: "Plugin state updated.",
    installed: "Plugin installed. Review source and capabilities before enabling.",
    installRequired: "Choose a .dibao-plugin file first."
  },
  "ja-JP": {
    title: "プラグイン",
    body: "公式またはサードパーティのプラグインをインストール、 有効化、更新します。サードパーティはインストール後も無効のままです。",
    loading: "プラグインを読み込み中",
    empty: "インストール済みプラグインはありません。",
    official: "公式",
    bundled: "同梱",
    thirdParty: "サードパーティ",
    capabilities: "権限",
    contributions: "追加項目",
    status: "状態",
    lastError: "エラー",
    source: "提供元",
    trust: "信頼",
    stableApi: "Stable API",
    betaApi: "Beta API",
    thirdPartyRisk: "サードパーティプラグインは、独立プロセス内の信頼済みローカルコードとして実行されます。有効化前に提供元、署名の信頼、権限を確認してください。",
    installTitle: "サードパーティプラグインをインストール",
    installBody: "開発者から提供された .dibao-plugin ファイルをアップロードします。URL、JSON パッケージ、チェックサムの手順はガイドを参照してください。",
    installDocs: "プラグインのインストール手順を見る",
    chooseFile: ".dibao-plugin を選択",
    install: "インストール",
    installing: "インストール中",
    refresh: "更新",
    enable: "有効化",
    disable: "無効化",
    update: "更新確認",
    uninstall: "アンインストール",
    runTask: "実行",
    taskStarted: (id: string) => `タスクをキューに追加しました：${id}`,
    updated: "プラグイン状態を更新しました。",
    installed: "プラグインをインストールしました。有効化前に提供元と権限を確認してください。",
    installRequired: ".dibao-plugin ファイルを選択してください。"
  }
};

export function SettingsWorkspace(props: {
  backfillingIndexId: string | null;
  deletingProviderId: string | null;
  embeddingError: string | null;
  embeddingIndexes: EmbeddingIndex[];
  embeddingProviders: EmbeddingProvider[];
  error: string | null;
  isEmbeddingLoading: boolean;
  isLoading: boolean;
  activatingProviderId: string | null;
  isSavingEmbeddingProvider: boolean;
  isSaving: boolean;
  rebuildingIndexId: string | null;
  testingProviderId: string | null;
  onActivateEmbeddingProvider: (providerId: string) => Promise<void>;
  onBackfillEmbeddingIndex: (indexId: string) => Promise<void>;
  onDeleteEmbeddingProvider: (providerId: string) => Promise<void>;
  onOpenAlgorithmTransparency: () => void;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onPreviewSettings: (settings: AppSettings) => void;
  onRebuildEmbeddingIndex: (indexId: string) => Promise<void>;
  onSaveSettings: (input: UpdateSettingsInput) => Promise<void>;
  onSaveEmbeddingProvider: (
    providerId: string | null,
    input: CreateEmbeddingProviderInput | UpdateEmbeddingProviderInput
  ) => Promise<string | null>;
  onTestEmbeddingProvider: (providerId: string) => Promise<void>;
  settings: AppSettings;
}) {
  const { t, formatDate } = useI18n();
  const initialProvider =
    props.embeddingProviders.find((provider) => provider.enabled) ??
    props.embeddingProviders[0] ??
    null;
  const [draft, setDraft] = useState<SettingsDraft>(() => draftForSettings(props.settings));
  const [lastInterestClusterPresetIndex, setLastInterestClusterPresetIndex] = useState(() =>
    presetIndexForInterestClusterLimits(props.settings.ranking) ??
    closestInterestClusterPresetIndex(props.settings.ranking)
  );
  const [providerDraft, setProviderDraft] = useState<EmbeddingProviderDraft>(() =>
    draftForEmbeddingProvider(initialProvider)
  );
  const [activeTab, setActiveTab] = useState<SettingsTabId>("basic");
  const [pendingProviderSelectionId, setPendingProviderSelectionId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [providerLocalError, setProviderLocalError] = useState<string | null>(null);
  const [usageWindow, setUsageWindow] = useState<"24h" | "7d" | "30d">("24h");
  const [passwordDraft, setPasswordDraft] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  });
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [latestRelease, setLatestRelease] = useState<LatestReleaseStatus | null>(null);
  const [latestReleaseError, setLatestReleaseError] = useState<string | null>(null);
  const [isLoadingLatestRelease, setIsLoadingLatestRelease] = useState(false);
  const [isCheckingLatestRelease, setIsCheckingLatestRelease] = useState(false);
  const [pluginSettingsPlugins, setPluginSettingsPlugins] = useState<PluginListItem[]>([]);
  const [pluginSettingsError, setPluginSettingsError] = useState<string | null>(null);
  const savedSettingsRef = useRef(props.settings);
  const hasUnsavedSettingsDraftRef = useRef(false);

  useEffect(() => {
    if (!hasUnsavedSettingsDraftRef.current) {
      savedSettingsRef.current = props.settings;
    }
    const nextDraft = draftForSettings(props.settings);
    setDraft(nextDraft);
    setLastInterestClusterPresetIndex(
      presetIndexForInterestClusterLimits(props.settings.ranking) ??
        closestInterestClusterPresetIndex(props.settings.ranking)
    );
  }, [props.settings]);

  useEffect(() => {
    if (pendingProviderSelectionId) {
      const pendingProvider = props.embeddingProviders.find(
        (provider) => provider.id === pendingProviderSelectionId
      );
      if (pendingProvider) {
        setProviderDraft(draftForEmbeddingProvider(pendingProvider));
        setPendingProviderSelectionId(null);
        setProviderLocalError(null);
        return;
      }
    }

    const selectedProvider = props.embeddingProviders.find(
      (provider) => provider.id === providerDraft.providerId
    );
    if (selectedProvider) {
      setProviderDraft(draftForEmbeddingProvider(selectedProvider));
      setProviderLocalError(null);
      return;
    }

    const activeProvider =
      props.embeddingProviders.find((provider) => provider.enabled) ??
      props.embeddingProviders[0] ??
      null;
    setProviderDraft(draftForEmbeddingProvider(activeProvider));
    setProviderLocalError(null);
  }, [pendingProviderSelectionId, props.embeddingProviders]);

  useEffect(() => {
    let cancelled = false;

    async function loadLatestRelease() {
      setIsLoadingLatestRelease(true);
      setLatestReleaseError(null);

      try {
        const result = await dibaoApi.getLatestRelease();
        if (!cancelled) {
          setLatestRelease(result);
        }
      } catch (error) {
        if (!cancelled) {
          setLatestReleaseError(userMessageForError(error, t.errors.api));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingLatestRelease(false);
        }
      }
    }

    void loadLatestRelease();

    return () => {
      cancelled = true;
    };
  }, [t.errors.api]);

  async function loadPluginSettingsContributions() {
    try {
      const plugins = await dibaoApi.listPluginContributions();
      setPluginSettingsPlugins(
        plugins.filter((plugin) => plugin.contributions.settingsTabs.length > 0)
      );
      setPluginSettingsError(null);
    } catch (error) {
      setPluginSettingsError(userMessageForError(error, t.errors.api));
    }
  }

  useEffect(() => {
    void loadPluginSettingsContributions();
  }, [t.errors.api]);

  function applyDraft(nextDraft: SettingsDraft) {
    hasUnsavedSettingsDraftRef.current = true;
    setDraft(nextDraft);
    setLocalError(null);

    const parsed = parseSettingsDraft(nextDraft, props.settings, t);
    if (parsed.ok) {
      props.onPreviewSettings(parsed.settings);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseSettingsDraft(draft, props.settings, t);

    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }

    if (
      retentionSettingsRequireCleanupConfirmation(
        savedSettingsRef.current.retention,
        parsed.settings.retention
      ) &&
      !window.confirm(t.settings.sections.retention.cleanupConfirm)
    ) {
      return;
    }

    await props.onSaveSettings(parsed.input);
    savedSettingsRef.current = parsed.settings;
    hasUnsavedSettingsDraftRef.current = false;
  }

  async function handleProviderSubmit() {
    const parsed = parseEmbeddingProviderDraft(providerDraft, t);

    if (!parsed.ok) {
      setProviderLocalError(parsed.error);
      return;
    }

    setProviderLocalError(null);
    const savedProviderId = await props.onSaveEmbeddingProvider(
      providerDraft.providerId === newEmbeddingProviderId ? null : providerDraft.providerId,
      parsed.input
    );
    if (savedProviderId) {
      setPendingProviderSelectionId(savedProviderId);
    }
  }

  async function handleChangePassword() {
    if (!passwordDraft.currentPassword.trim()) {
      setPasswordError(t.settings.sections.account.errors.currentRequired);
      return;
    }
    if (!passwordDraft.newPassword.trim()) {
      setPasswordError(t.settings.sections.account.errors.newRequired);
      return;
    }
    if (!passwordDraft.confirmPassword.trim()) {
      setPasswordError(t.settings.sections.account.errors.confirmRequired);
      return;
    }
    if (passwordDraft.newPassword !== passwordDraft.confirmPassword) {
      setPasswordError(t.settings.sections.account.errors.mismatch);
      return;
    }

    setIsChangingPassword(true);
    setPasswordError(null);
    setPasswordNotice(null);
    try {
      await props.onChangePassword(passwordDraft.currentPassword, passwordDraft.newPassword);
      setPasswordDraft({
        currentPassword: "",
        newPassword: "",
        confirmPassword: ""
      });
      setPasswordNotice(t.settings.sections.account.saved);
    } catch (error) {
      setPasswordError(userMessageForError(error, t.errors.api));
    } finally {
      setIsChangingPassword(false);
    }
  }

  async function handleCheckLatestRelease() {
    setIsCheckingLatestRelease(true);
    setLatestReleaseError(null);

    try {
      setLatestRelease(await dibaoApi.checkLatestRelease());
    } catch (error) {
      setLatestReleaseError(userMessageForError(error, t.errors.api));
    } finally {
      setIsCheckingLatestRelease(false);
    }
  }

  const selectedProvider =
    providerDraft.providerId === newEmbeddingProviderId
      ? null
      : props.embeddingProviders.find((provider) => provider.id === providerDraft.providerId) ??
        null;
  const activeProvider = props.embeddingProviders.find((provider) => provider.enabled) ?? null;
  const activeProviderIndex = activeProvider
    ? props.embeddingIndexes.find(
        (index) => index.providerId === activeProvider.id && index.status === "active"
      ) ?? null
    : null;
  const selectedProviderIndexes = selectedProvider
    ? props.embeddingIndexes.filter((index) => index.providerId === selectedProvider.id)
    : [];
  const canActivateSelectedProvider = selectedProvider !== null && !selectedProvider.enabled;
  const isActivatingSelectedProvider =
    selectedProvider !== null && props.activatingProviderId === selectedProvider.id;
  const exactInterestClusterPresetIndex = presetIndexForInterestClusterLimitDraft(draft);
  const interestClusterPresetIndex =
    exactInterestClusterPresetIndex ?? lastInterestClusterPresetIndex;
  const pluginSettingsTabs = pluginSettingsPlugins
    .flatMap((plugin) =>
      plugin.contributions.settingsTabs.map((tab) => ({
        id: pluginSettingsTabId(plugin.id, tab.id),
        plugin,
        tab
      }))
    )
    .sort((left, right) =>
      (left.tab.order ?? 100) - (right.tab.order ?? 100) ||
      left.tab.label.localeCompare(right.tab.label)
    );
  const activePluginSettingsTab = pluginSettingsTabs.find((tab) => tab.id === activeTab) ?? null;

  useEffect(() => {
    if (isPluginSettingsTabId(activeTab) && !pluginSettingsTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab("plugins");
    }
  }, [activeTab, pluginSettingsTabs]);

  const labelForCoreSettingsTab = (tabId: CoreSettingsTabId) => {
    const labels = settingsTabLabels[tabId];
    return props.settings.ui.locale === "en-US"
      ? labels.enUS
      : props.settings.ui.locale === "ja-JP"
        ? labels.jaJP
        : labels.zhCN;
  };
  const labelForSettingsTab = (tabId: SettingsTabId) => {
    if (isPluginSettingsTabId(tabId)) {
      return pluginSettingsTabs.find((tab) => tab.id === tabId)?.tab.label ?? "";
    }
    return labelForCoreSettingsTab(tabId);
  };
  const activeTabLabel = activePluginSettingsTab?.tab.label ?? labelForSettingsTab(activeTab);
  const isCoreSaveVisible = activeTab !== "plugins" && !isPluginSettingsTabId(activeTab);

  return (
    <form
      className={classNames(styles.settingsWorkspace, "settings-board-page")}
      onSubmit={(event) => void handleSubmit(event)}
      aria-labelledby="settings-title"
    >
      <div className={styles.managementTabs} aria-label={t.settings.pageTitle} role="tablist">
        {coreSettingsTabs.map((tabId) => (
          <button
            aria-selected={activeTab === tabId}
            className={activeTab === tabId ? styles.managementTabActive : styles.managementTab}
            key={tabId}
            onClick={() => setActiveTab(tabId)}
            role="tab"
            type="button"
          >
            {labelForCoreSettingsTab(tabId)}
          </button>
        ))}
        {pluginSettingsTabs.map((pluginTab) => (
          <button
            aria-selected={activeTab === pluginTab.id}
            className={activeTab === pluginTab.id ? styles.managementTabActive : styles.managementTab}
            key={pluginTab.id}
            onClick={() => setActiveTab(pluginTab.id)}
            role="tab"
            type="button"
          >
            {pluginTab.tab.label}
          </button>
        ))}
      </div>

      <div className={classNames(styles.settingsHeader, "settings-content-head")}>
        <div>
          <p className={styles.kicker}>{t.navigation.items.settings}</p>
          <h2 id="settings-title">{activeTabLabel}</h2>
        </div>
        <button
          className={styles.primaryButton}
          disabled={props.isSaving}
          hidden={!isCoreSaveVisible}
          type="submit"
        >
          {props.isSaving ? t.settings.actions.saving : t.settings.actions.save}
        </button>
      </div>

      <div className={classNames(styles.settingsContent, "settings-content-board")}>
        {props.isLoading ? <p className={styles.settingsNotice}>{t.settings.loading}</p> : null}
        {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
        {localError ? <p className={styles.errorText}>{localError}</p> : null}
        {pluginSettingsError ? <p className={styles.errorText}>{pluginSettingsError}</p> : null}

        <section className={classNames(styles.settingsSection, "settings-card")} hidden={activeTab !== "basic"} aria-labelledby="settings-language-title">
          <div>
            <h3 id="settings-language-title">{t.settings.sections.language.title}</h3>
            <p>{t.settings.sections.language.body}</p>
          </div>
          <label className={styles.settingsField} htmlFor="settings-locale">
            <span>{t.settings.sections.language.localeLabel}</span>
            <select
              id="settings-locale"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  locale:
                    event.target.value === "en-US" || event.target.value === "ja-JP"
                      ? event.target.value
                      : "zh-CN"
                })
              }
              value={draft.locale}
            >
              <option value="zh-CN">{t.settings.sections.language.zhCN}</option>
              <option value="en-US">{t.settings.sections.language.enUS}</option>
              <option value="ja-JP">{t.settings.sections.language.jaJP}</option>
            </select>
          </label>
          <label className={styles.settingsField} htmlFor="settings-default-home-view">
            <span>{t.settings.sections.language.defaultHomeViewLabel}</span>
            <select
              id="settings-default-home-view"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  defaultHomeView:
                    event.target.value === "latest" ? "latest" : "recommended"
                })
              }
              value={draft.defaultHomeView}
            >
              <option value="recommended">
                {t.settings.sections.language.defaultHomeViewRecommended}
              </option>
              <option value="latest">{t.settings.sections.language.defaultHomeViewLatest}</option>
            </select>
          </label>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card")} hidden={activeTab !== "basic"} aria-labelledby="settings-account-title">
          <div>
            <h3 id="settings-account-title">{t.settings.sections.account.title}</h3>
            <p>{t.settings.sections.account.body}</p>
          </div>
          <div className={styles.settingsGrid}>
            <label className={styles.settingsField} htmlFor="settings-current-password">
              <span>{t.settings.sections.account.currentPasswordLabel}</span>
              <input
                autoComplete="current-password"
                id="settings-current-password"
                onChange={(event) => {
                  setPasswordDraft({ ...passwordDraft, currentPassword: event.target.value });
                  setPasswordError(null);
                  setPasswordNotice(null);
                }}
                placeholder={t.settings.sections.account.currentPasswordPlaceholder}
                type="password"
                value={passwordDraft.currentPassword}
              />
            </label>
            <label className={styles.settingsField} htmlFor="settings-new-password">
              <span>{t.settings.sections.account.newPasswordLabel}</span>
              <input
                autoComplete="new-password"
                id="settings-new-password"
                onChange={(event) => {
                  setPasswordDraft({ ...passwordDraft, newPassword: event.target.value });
                  setPasswordError(null);
                  setPasswordNotice(null);
                }}
                placeholder={t.settings.sections.account.newPasswordPlaceholder}
                type="password"
                value={passwordDraft.newPassword}
              />
            </label>
            <label className={styles.settingsField} htmlFor="settings-confirm-password">
              <span>{t.settings.sections.account.confirmPasswordLabel}</span>
              <input
                autoComplete="new-password"
                id="settings-confirm-password"
                onChange={(event) => {
                  setPasswordDraft({ ...passwordDraft, confirmPassword: event.target.value });
                  setPasswordError(null);
                  setPasswordNotice(null);
                }}
                placeholder={t.settings.sections.account.confirmPasswordPlaceholder}
                type="password"
                value={passwordDraft.confirmPassword}
              />
            </label>
          </div>
          <button
            className={styles.secondaryButton}
            disabled={isChangingPassword}
            onClick={() => void handleChangePassword()}
            type="button"
          >
            {isChangingPassword
              ? t.settings.sections.account.submitting
              : t.settings.sections.account.submit}
          </button>
          {passwordNotice ? <p className={styles.settingsNotice}>{passwordNotice}</p> : null}
          {passwordError ? <p className={styles.errorText}>{passwordError}</p> : null}
        </section>

        <section className={classNames(styles.settingsSection, "settings-card")} hidden={activeTab !== "algorithm"} aria-labelledby="settings-behavior-title">
          <div>
            <h3 id="settings-behavior-title">{t.settings.sections.behavior.title}</h3>
            <p>{t.settings.sections.behavior.body}</p>
            <a
              className={styles.textLink}
              href={urlForAppPage({ type: "algorithm-transparency" })}
              onClick={(event) => {
                if (shouldLetBrowserHandleLinkClick(event)) {
                  return;
                }
                event.preventDefault();
                props.onOpenAlgorithmTransparency();
              }}
            >
              {t.settings.sections.behavior.algorithmTransparencyLink}
            </a>
          </div>
          <label className={styles.managementCheckbox} htmlFor="settings-ignore-scrolled">
            <input
              checked={draft.markScrolledArticlesIgnored}
              id="settings-ignore-scrolled"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  markScrolledArticlesIgnored: event.target.checked
                })
              }
              type="checkbox"
            />
            <span>{t.settings.sections.behavior.markScrolledArticlesIgnored}</span>
          </label>
          <label
            className={styles.managementCheckbox}
            htmlFor="settings-remove-read-later-on-complete"
          >
            <input
              checked={draft.removeReadLaterOnReadComplete}
              id="settings-remove-read-later-on-complete"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  removeReadLaterOnReadComplete: event.target.checked
                })
              }
              type="checkbox"
            />
            <span>{t.settings.sections.behavior.removeReadLaterOnReadComplete}</span>
          </label>
          <RangeSettingField
            id="settings-cocoon-level"
            label={t.settings.sections.behavior.cocoonLevel}
            max={10}
            min={1}
            onChange={(value) => applyDraft({ ...draft, cocoonLevel: value })}
            step={1}
            unit={t.settings.units.level}
            value={draft.cocoonLevel}
          />
          <p className={styles.managementHint}>{t.settings.sections.behavior.cocoonLevelHint}</p>
          <div className={styles.settingsSubsection}>
            <div>
              <h4>{t.settings.sections.behavior.interestClusterLimits.title}</h4>
              <p>{t.settings.sections.behavior.interestClusterLimits.body}</p>
              <p>{t.settings.sections.behavior.interestClusterLimits.embeddingCostHint}</p>
            </div>
            <label className={styles.settingsField} htmlFor="settings-interest-cluster-preset">
              <span>{t.settings.sections.behavior.interestClusterLimits.performancePreset}</span>
              <div className={styles.settingsRangeRow}>
                <input
                  id="settings-interest-cluster-preset"
                  max={2}
                  min={0}
                  onChange={(event) => {
                    const presetIndex = interestClusterPresetIndexFromSliderValue(
                      event.target.value
                    );
                    const preset = interestClusterLimitPresets[presetIndex];
                    setLastInterestClusterPresetIndex(presetIndex);
                    applyDraft({
                      ...draft,
                      maxPositiveInterestClusters: String(preset.maxPositiveInterestClusters),
                      maxNegativeInterestClusters: String(preset.maxNegativeInterestClusters),
                      maxPositiveInterestFamilies: String(preset.maxPositiveInterestFamilies),
                      maxNegativeInterestFamilies: String(preset.maxNegativeInterestFamilies)
                    });
                  }}
                  step={1}
                  type="range"
                  value={interestClusterPresetIndex}
                />
                <strong>
                  {t.settings.sections.behavior.interestClusterLimits.presets[
                    interestClusterPresetIndex
                  ] ?? t.settings.sections.behavior.interestClusterLimits.customPreset}
                </strong>
              </div>
              <div className={styles.settingsPresetScale} aria-hidden="true">
                {t.settings.sections.behavior.interestClusterLimits.presets.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            </label>
            <div className={styles.settingsGrid}>
              <NumberSettingField
                id="settings-max-positive-interest-clusters"
                label={t.settings.sections.behavior.interestClusterLimits.positiveLabel}
                max={192}
                min={8}
                onChange={(value) =>
                  applyDraft({ ...draft, maxPositiveInterestClusters: value })
                }
                step={1}
                value={draft.maxPositiveInterestClusters}
              />
              <NumberSettingField
                id="settings-max-negative-interest-clusters"
                label={t.settings.sections.behavior.interestClusterLimits.negativeLabel}
                max={128}
                min={4}
                onChange={(value) =>
                  applyDraft({ ...draft, maxNegativeInterestClusters: value })
                }
                step={1}
                value={draft.maxNegativeInterestClusters}
              />
              <NumberSettingField
                id="settings-max-positive-interest-families"
                label={t.settings.sections.behavior.interestClusterLimits.positiveFamilyLabel}
                max={64}
                min={2}
                onChange={(value) =>
                  applyDraft({ ...draft, maxPositiveInterestFamilies: value })
                }
                step={1}
                value={draft.maxPositiveInterestFamilies}
              />
              <NumberSettingField
                id="settings-max-negative-interest-families"
                label={t.settings.sections.behavior.interestClusterLimits.negativeFamilyLabel}
                max={48}
                min={1}
                onChange={(value) =>
                  applyDraft({ ...draft, maxNegativeInterestFamilies: value })
                }
                step={1}
                value={draft.maxNegativeInterestFamilies}
              />
            </div>
            <p className={styles.managementHint}>
              {t.settings.sections.behavior.interestClusterLimits.fieldHint}
            </p>
          </div>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card", "reader-settings-card")} hidden={activeTab !== "basic"} aria-labelledby="settings-reader-title">
          <div>
            <h3 id="settings-reader-title">{t.settings.sections.reader.title}</h3>
            <p>{t.settings.sections.reader.body}</p>
          </div>
          <div className={styles.settingsGrid}>
            <NumberSettingField
              id="settings-font-size"
              label={t.settings.sections.reader.fontSize}
              max={24}
              min={16}
              onChange={(value) => applyDraft({ ...draft, fontSize: value })}
              step={1}
              unit={t.settings.units.px}
              value={draft.fontSize}
            />
            <NumberSettingField
              id="settings-line-height"
              label={t.settings.sections.reader.lineHeight}
              max={2.1}
              min={1.45}
              onChange={(value) => applyDraft({ ...draft, lineHeight: value })}
              step={0.05}
              value={draft.lineHeight}
            />
            <NumberSettingField
              id="settings-paragraph-gap"
              label={t.settings.sections.reader.paragraphGap}
              max={1.6}
              min={0.6}
              onChange={(value) => applyDraft({ ...draft, paragraphGap: value })}
              step={0.1}
              value={draft.paragraphGap}
            />
            <NumberSettingField
              id="settings-reader-width"
              label={t.settings.sections.reader.readerWidth}
              max={860}
              min={560}
              onChange={(value) => applyDraft({ ...draft, readerWidth: value })}
              step={40}
              unit={t.settings.units.px}
              value={draft.readerWidth}
            />
          </div>
          <label className={styles.readerSettingsToggle} htmlFor="settings-infinite-article-loading">
            <span>{t.settings.sections.behavior.infiniteArticleLoading}</span>
            <span className={styles.readerSettingsToggleControl}>
              <input
                checked={draft.infiniteArticleLoading}
                id="settings-infinite-article-loading"
                onChange={(event) =>
                  applyDraft({ ...draft, infiniteArticleLoading: event.target.checked })
                }
                type="checkbox"
              />
              <span aria-hidden="true" />
            </span>
          </label>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card", "retention-card")} hidden={activeTab !== "basic"} aria-labelledby="settings-retention-title">
          <div>
            <h3 id="settings-retention-title">{t.settings.sections.retention.title}</h3>
            <p>{t.settings.sections.retention.body}</p>
          </div>
          <NumberSettingField
            id="settings-retention-days"
            label={t.settings.sections.retention.retentionDays}
            max={3650}
            min={0}
            onChange={(value) => applyDraft({ ...draft, retentionDays: value })}
            step={1}
            unit={t.settings.units.days}
            value={draft.retentionDays}
          />
          <label className={styles.settingsInlineStatus} htmlFor="settings-keep-favorites">
            <span>{t.settings.sections.retention.keepFavorites}</span>
            <input
              checked={draft.keepFavorites}
              id="settings-keep-favorites"
              onChange={(event) =>
                applyDraft({ ...draft, keepFavorites: event.target.checked })
              }
              type="checkbox"
            />
          </label>
          <label className={styles.settingsInlineStatus} htmlFor="settings-keep-read-later">
            <span>{t.settings.sections.retention.keepReadLater}</span>
            <input
              checked={draft.keepReadLater}
              id="settings-keep-read-later"
              onChange={(event) =>
                applyDraft({ ...draft, keepReadLater: event.target.checked })
              }
              type="checkbox"
            />
          </label>
          <p className={styles.managementHint}>{t.settings.sections.retention.mappingHint}</p>
        </section>

        <section className={classNames(styles.settingsSection, "settings-card", "provider-settings-card")} hidden={activeTab !== "algorithm"} aria-labelledby="settings-provider-title">
          <div>
            <h3 id="settings-provider-title">{t.settings.sections.provider.title}</h3>
            <p>{t.settings.sections.provider.body}</p>
          </div>
          {props.isEmbeddingLoading ? (
            <p className={styles.settingsNotice}>{t.settings.sections.provider.loading}</p>
          ) : null}
          {props.embeddingError ? <p className={styles.errorText}>{props.embeddingError}</p> : null}
          {providerLocalError ? <p className={styles.errorText}>{providerLocalError}</p> : null}

          <div className={styles.providerActiveStatus}>
            <div>
              <strong>
                {activeProvider
                  ? t.settings.sections.provider.activeTitle
                  : t.settings.sections.provider.activeEmptyTitle}
              </strong>
              <p>
                {activeProvider
                  ? t.settings.sections.provider.activeBody(
                      activeProvider.name,
                      activeProvider.model,
                      activeProvider.dimension
                    )
                  : t.settings.sections.provider.activeEmptyBody}
              </p>
              {activeProviderIndex ? (
                <p>{embeddingCoverageText(activeProviderIndex, t)}</p>
              ) : null}
            </div>
          </div>

          {props.embeddingProviders.length > 0 ? (
            <div
              aria-label={t.settings.sections.provider.profileListLabel}
              className={styles.providerProfileList}
            >
              {props.embeddingProviders.map((provider) => (
                <button
                  className={
                    provider.id === providerDraft.providerId
                      ? styles.providerProfileCardActive
                      : styles.providerProfileCard
                  }
                  key={provider.id}
                  onClick={() => {
                    setProviderDraft(draftForEmbeddingProvider(provider));
                    setProviderLocalError(null);
                  }}
                  type="button"
                >
                  <span>
                    <strong>{provider.name}</strong>
                    <small>
                      {provider.type} · {provider.model} / {provider.dimension}
                    </small>
                  </span>
                  <em>
                    {provider.enabled
                      ? t.settings.sections.provider.currentBadge
                      : t.settings.sections.provider.profileBadge}
                  </em>
                </button>
              ))}
            </div>
          ) : null}

          <div className={styles.settingsGrid}>
            <label className={styles.settingsField} htmlFor="settings-provider-select">
              <span>{t.settings.sections.provider.providerLabel}</span>
              <select
                id="settings-provider-select"
                onChange={(event) => {
                  const provider =
                    props.embeddingProviders.find(
                      (candidate) => candidate.id === event.target.value
                    ) ?? null;
                  setProviderDraft(draftForEmbeddingProvider(provider));
                  setProviderLocalError(null);
                }}
                value={providerDraft.providerId}
              >
                <option value={newEmbeddingProviderId}>
                  {t.settings.sections.provider.newProvider}
                </option>
                {props.embeddingProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.settingsField} htmlFor="settings-provider-type">
              <span>{t.settings.sections.provider.typeLabel}</span>
              <select
                id="settings-provider-type"
                onChange={(event) => {
                  const nextType =
                    event.target.value === "ollama"
                      ? "ollama"
                      : event.target.value === "gemini"
                        ? "gemini"
                        : "openai_compatible";
                  setProviderDraft(draftWithProviderType(providerDraft, nextType));
                  setProviderLocalError(null);
                }}
                value={providerDraft.type}
              >
                <option value="openai_compatible">
                  {t.settings.sections.provider.openaiCompatible}
                </option>
                <option value="gemini">{t.settings.sections.provider.gemini}</option>
                <option value="ollama">{t.settings.sections.provider.ollama}</option>
              </select>
            </label>

            <label className={styles.settingsField} htmlFor="settings-provider-name">
              <span>{t.settings.sections.provider.nameLabel}</span>
              <input
                id="settings-provider-name"
                onChange={(event) =>
                  setProviderDraft({ ...providerDraft, name: event.target.value })
                }
                value={providerDraft.name}
              />
            </label>

            <label className={styles.settingsField} htmlFor="settings-provider-base-url">
              <span>{t.settings.sections.provider.baseUrlLabel}</span>
              <input
                id="settings-provider-base-url"
                inputMode="url"
                onChange={(event) =>
                  setProviderDraft({ ...providerDraft, baseUrl: event.target.value })
                }
                placeholder={
                  providerDraft.type === "ollama"
                    ? t.settings.sections.provider.ollamaBaseUrlPlaceholder
                    : providerDraft.type === "gemini"
                      ? t.settings.sections.provider.geminiBaseUrlPlaceholder
                    : t.settings.sections.provider.baseUrlPlaceholder
                }
                type="url"
                value={providerDraft.baseUrl}
              />
            </label>

            <label className={styles.settingsField} htmlFor="settings-provider-model">
              <span>{t.settings.sections.provider.modelLabel}</span>
              <input
                id="settings-provider-model"
                onChange={(event) =>
                  setProviderDraft({ ...providerDraft, model: event.target.value })
                }
                placeholder={
                  providerDraft.type === "ollama"
                    ? t.settings.sections.provider.ollamaModelPlaceholder
                    : providerDraft.type === "gemini"
                      ? t.settings.sections.provider.geminiModelPlaceholder
                    : t.settings.sections.provider.modelPlaceholder
                }
                value={providerDraft.model}
              />
            </label>

            <NumberSettingField
              id="settings-provider-dimension"
              label={t.settings.sections.provider.dimensionLabel}
              max={20000}
              min={1}
              onChange={(value) => setProviderDraft({ ...providerDraft, dimension: value })}
              step={1}
              value={providerDraft.dimension}
            />

            <NumberSettingField
              id="settings-provider-text-max-chars"
              label={t.settings.sections.provider.textMaxCharsLabel}
              max={200000}
              min={1000}
              onChange={(value) => setProviderDraft({ ...providerDraft, textMaxChars: value })}
              step={500}
              value={providerDraft.textMaxChars}
            />
            {providerDraft.type === "ollama" ? (
              <p className={styles.managementHint}>
                {t.settings.sections.provider.ollamaTextMaxCharsHint}
              </p>
            ) : null}

            <NumberSettingField
              id="settings-provider-qpm"
              label={t.settings.sections.provider.requestsPerMinuteLabel}
              max={1000000}
              min={1}
              onChange={(value) =>
                setProviderDraft({ ...providerDraft, requestsPerMinute: value })
              }
              placeholder={t.settings.sections.provider.unlimitedPlaceholder}
              step={1}
              value={providerDraft.requestsPerMinute}
            />

            <NumberSettingField
              id="settings-provider-qpd"
              label={t.settings.sections.provider.requestsPerDayLabel}
              max={100000000}
              min={1}
              onChange={(value) => setProviderDraft({ ...providerDraft, requestsPerDay: value })}
              placeholder={t.settings.sections.provider.unlimitedPlaceholder}
              step={1}
              value={providerDraft.requestsPerDay}
            />

            {providerDraft.type !== "ollama" ? (
              <label className={styles.settingsField} htmlFor="settings-provider-api-key">
                <span>{t.settings.sections.provider.apiKeyLabel}</span>
                <input
                  autoComplete="off"
                  id="settings-provider-api-key"
                  onChange={(event) =>
                    setProviderDraft({ ...providerDraft, apiKey: event.target.value })
                  }
                  placeholder={
                    selectedProvider?.hasApiKey
                      ? t.settings.sections.provider.apiKeyRetainPlaceholder
                      : t.settings.sections.provider.apiKeyPlaceholder
                  }
                  type="password"
                  value={providerDraft.apiKey}
                />
              </label>
            ) : (
              <p className={styles.managementHint}>
                {t.settings.sections.provider.ollamaApiKeyHint}
              </p>
            )}
            {providerDraft.type === "gemini" ? (
              <p className={styles.managementHint}>
                {t.settings.sections.provider.geminiApiKeyHint}
              </p>
            ) : null}

            <label className={styles.settingsField} htmlFor="settings-provider-quality">
              <span>{t.settings.sections.provider.qualityTierLabel}</span>
              <select
                id="settings-provider-quality"
                onChange={(event) =>
                  setProviderDraft({
                    ...providerDraft,
                    qualityTier: event.target.value as EmbeddingProviderDraft["qualityTier"]
                  })
                }
                value={providerDraft.qualityTier}
              >
                <option value="basic">{t.settings.sections.provider.quality.basic}</option>
                <option value="recommended">
                  {t.settings.sections.provider.quality.recommended}
                </option>
                <option value="best_quality">
                  {t.settings.sections.provider.quality.bestQuality}
                </option>
              </select>
            </label>
          </div>

          <p className={styles.providerWarning}>{t.settings.sections.provider.modelHint}</p>
          <p className={styles.providerWarning}>{t.settings.sections.provider.textMaxCharsHint}</p>
          <p className={styles.managementHint}>{t.settings.sections.provider.rateLimitHint}</p>
          <p className={styles.managementHint}>{t.settings.sections.provider.activateHint}</p>

          {selectedProvider ? (
            <div className={styles.setupStatusBox}>
              <strong>{t.settings.sections.provider.connectionStatusTitle}</strong>
              <p>
                {selectedProvider.enabled
                  ? t.settings.sections.provider.enabledStatus
                  : t.settings.sections.provider.disabledStatus}
                {" · "}
                {selectedProvider.lastTestStatus === "success"
                  ? t.settings.sections.provider.lastTestSuccess(
                      selectedProvider.lastTestAt ?? t.feedManagement.na
                    )
                  : selectedProvider.lastTestStatus === "failed"
                    ? t.settings.sections.provider.lastTestFailed(
                        selectedProvider.lastTestError ?? t.feedManagement.na
                      )
                    : t.settings.sections.provider.lastTestUnknown}
              </p>
            </div>
          ) : null}

          <div className={styles.managementActions}>
            <button
              className={styles.primaryButton}
              disabled={props.isSavingEmbeddingProvider}
              onClick={() => void handleProviderSubmit()}
              type="button"
            >
              {props.isSavingEmbeddingProvider
                ? t.settings.sections.provider.saving
                : t.settings.sections.provider.save}
            </button>
            <button
              className={styles.primaryButton}
              disabled={
                !canActivateSelectedProvider ||
                isActivatingSelectedProvider ||
                props.isSavingEmbeddingProvider
              }
              onClick={() =>
                selectedProvider
                  ? void props.onActivateEmbeddingProvider(selectedProvider.id)
                  : undefined
              }
              type="button"
            >
              {isActivatingSelectedProvider
                ? t.settings.sections.provider.activating
                : selectedProvider?.enabled
                  ? t.settings.sections.provider.activeActionCurrent
                  : t.settings.sections.provider.activate}
            </button>
            <button
              className={styles.secondaryButton}
              disabled={!selectedProvider || props.testingProviderId === selectedProvider.id}
              onClick={() =>
                selectedProvider ? void props.onTestEmbeddingProvider(selectedProvider.id) : undefined
              }
              type="button"
            >
              {selectedProvider && props.testingProviderId === selectedProvider.id
                ? t.settings.sections.provider.testing
                : t.settings.sections.provider.test}
            </button>
            <button
              className={styles.dangerButton}
              disabled={!selectedProvider || props.deletingProviderId === selectedProvider.id}
              onClick={() =>
                selectedProvider
                  ? void props.onDeleteEmbeddingProvider(selectedProvider.id)
                  : undefined
              }
              type="button"
            >
              {selectedProvider && props.deletingProviderId === selectedProvider.id
                ? t.settings.sections.provider.deleting
                : t.settings.sections.provider.delete}
            </button>
          </div>

          <p className={styles.managementHint}>{t.settings.sections.provider.deleteHint}</p>

          <div className={classNames(styles.settingsSection, "settings-card", "index-settings-card")} aria-labelledby="settings-indexes-title">
            <div>
              <h3 id="settings-indexes-title">{t.settings.sections.provider.indexesTitle}</h3>
              <p>{t.settings.sections.provider.indexesBody}</p>
              <div className={styles.segmentedControl} aria-label={t.settings.sections.provider.usageWindowLabel}>
                {(["24h", "7d", "30d"] as const).map((windowKey) => (
                  <button
                    aria-pressed={usageWindow === windowKey}
                    className={
                      usageWindow === windowKey
                        ? styles.segmentedControlActive
                        : styles.segmentedControlButton
                    }
                    key={windowKey}
                    onClick={() => setUsageWindow(windowKey)}
                    type="button"
                  >
                    {t.settings.sections.provider.usageWindows[windowKey]}
                  </button>
                ))}
              </div>
            </div>
            {selectedProviderIndexes.length === 0 ? (
              <div className={styles.setupStatusBox}>
                <strong>{t.settings.sections.provider.noIndexes}</strong>
              </div>
            ) : (
              selectedProviderIndexes.map((index) => (
                <div className={styles.settingsIndexStatus} key={index.id}>
                  <div>
                    <strong>
                      {t.settings.sections.provider.indexStatus(
                        index.model,
                        index.status,
                        index.embeddingCount
                      )}
                    </strong>
                    <p>{embeddingCoverageText(index, t)}</p>
                    <p>{t.settings.sections.provider.indexTotal(index.embeddingCount)}</p>
                    <p>
                      {t.settings.sections.provider.embeddingJobStatusTitle}:{" "}
                      {t.settings.sections.provider.pendingJobs(index.pendingJobs)}
                      {" · "}
                      {t.settings.sections.provider.failedJobs(index.failedJobs)}
                    </p>
                    {index.lastFailedAt ? (
                      <p>
                        {t.settings.sections.provider.lastFailedAt(
                          formatDate(index.lastFailedAt)
                        )}
                      </p>
                    ) : null}
                    {index.lastError ? (
                      <p>{t.settings.sections.provider.lastError(index.lastError)}</p>
                    ) : index.failedJobs > 0 ? null : (
                      <p>{t.settings.sections.provider.noJobFailures}</p>
                    )}
                    <p className={styles.embeddingUsageLine}>
                      <ActionIcon name="sparkle" />
                      {t.settings.sections.provider.usage(
                        index.usage.windows[usageWindow].itemCount,
                        index.usage.windows[usageWindow].requestCount,
                        index.usage.windows[usageWindow].estimatedTokens
                      )}
                    </p>
                  </div>
                  <button
                    className={styles.secondaryButton}
                    disabled={props.backfillingIndexId === index.id || index.status !== "active"}
                    onClick={() => void props.onBackfillEmbeddingIndex(index.id)}
                    type="button"
                  >
                    {props.backfillingIndexId === index.id
                      ? t.settings.sections.provider.backfilling
                      : t.settings.sections.provider.backfill}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    disabled={props.rebuildingIndexId === index.id}
                    onClick={() => void props.onRebuildEmbeddingIndex(index.id)}
                    type="button"
                  >
                    {props.rebuildingIndexId === index.id
                      ? t.settings.sections.provider.rebuilding
                      : t.settings.sections.provider.rebuild}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <PluginManagerSection
          active={activeTab === "plugins"}
          locale={props.settings.ui.locale}
          onPluginsChanged={loadPluginSettingsContributions}
        />

        {pluginSettingsTabs.map((pluginTab) => (
          <PluginSettingsTabPanel
            active={activeTab === pluginTab.id}
            key={pluginTab.id}
            plugin={pluginTab.plugin}
            tab={pluginTab.tab}
          />
        ))}

        <section className={classNames(styles.settingsSection, "settings-card", "about-settings-card")} hidden={activeTab !== "basic"} aria-labelledby="settings-about-title">
          <div>
            <h3 id="settings-about-title">{t.settings.sections.about.title}</h3>
            <p>{t.settings.sections.about.body}</p>
          </div>
          <label className={styles.settingsInlineStatus} htmlFor="settings-telemetry-enabled">
            <span>
              <strong>{t.settings.sections.about.telemetryLabel}</strong>
              <small>{t.settings.sections.about.telemetryBody}</small>
            </span>
            <input
              checked={draft.telemetryEnabled}
              id="settings-telemetry-enabled"
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  telemetryEnabled: event.target.checked
                })
              }
              type="checkbox"
            />
          </label>
          <dl className={styles.aboutList}>
            <div>
              <dt>{t.settings.sections.about.version}</dt>
              <dd>{t.common.version(dibaoVersion)}</dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.latestVersion}</dt>
              <dd>
                <div className={styles.latestReleaseStatus}>
                  <span>
                    {latestReleaseText(
                      latestRelease,
                      isLoadingLatestRelease,
                      latestReleaseError,
                      t
                    )}
                  </span>
                  {latestRelease?.updateAvailable && latestRelease.releaseUrl ? (
                    <a href={latestRelease.releaseUrl} rel="noreferrer" target="_blank">
                      {t.settings.sections.about.releaseLink}
                    </a>
                  ) : null}
                  <button
                    className={styles.secondaryButton}
                    disabled={isCheckingLatestRelease}
                    onClick={() => void handleCheckLatestRelease()}
                    type="button"
                  >
                    {isCheckingLatestRelease
                      ? t.settings.sections.about.checkingRelease
                      : t.settings.sections.about.checkRelease}
                  </button>
                  <small>
                    {latestRelease?.checkedAt
                      ? t.settings.sections.about.latestCheckedAt(
                          formatDate(latestRelease.checkedAt)
                        )
                      : t.settings.sections.about.latestNeverChecked}
                  </small>
                </div>
              </dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.author}</dt>
              <dd>{t.settings.sections.about.authorName}</dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.xAccount}</dt>
              <dd>
                <a href="https://x.com/JeffreyCalm" rel="noreferrer" target="_blank">
                  @JeffreyCalm
                </a>
              </dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.blog}</dt>
              <dd>
                <a href="https://1q43.blog" rel="noreferrer" target="_blank">
                  1q43.blog
                </a>
              </dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.homepage}</dt>
              <dd>
                <a href="https://dibao.app" rel="noreferrer" target="_blank">
                  dibao.app
                </a>
              </dd>
            </div>
            <div>
              <dt>{t.settings.sections.about.github}</dt>
              <dd>
                <a href="https://github.com/Pls-1q43/Dibao" rel="noreferrer" target="_blank">
                  Pls-1q43/Dibao
                </a>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </form>
  );
}

function pluginSettingsTabId(pluginId: string, tabId: string): PluginSettingsTabId {
  return `plugin:${pluginId}:${tabId}`;
}

function isPluginSettingsTabId(tabId: SettingsTabId): tabId is PluginSettingsTabId {
  return tabId.startsWith("plugin:");
}

function PluginSettingsTabPanel(props: {
  active: boolean;
  plugin: PluginListItem;
  tab: PluginSettingsTab["tab"];
}) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const baseUrl =
    props.plugin.webEntryUrl ??
    `/api/plugins/${encodeURIComponent(props.plugin.id)}/assets/web/index.html`;
  const params = new URLSearchParams();
  params.set("route", props.tab.route);
  params.set("panel", "settings");
  params.set("settingsTab", props.tab.id);

  useEffect(() => {
    async function handleMessage(event: MessageEvent) {
      if (!props.active || event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const data = event.data as {
        type?: unknown;
        pluginId?: unknown;
        requestId?: unknown;
        method?: unknown;
        payload?: unknown;
      };
      if (
        data.type !== "dibao.bridge" ||
        data.pluginId !== props.plugin.id ||
        typeof data.requestId !== "string" ||
        data.requestId.length > 128
      ) {
        return;
      }
      try {
        const result = await handlePluginSettingsBridgeRequest(props.plugin, data.method, data.payload);
        (event.source as WindowProxy | null)?.postMessage(
          {
            type: "dibao.bridge.response",
            schemaVersion: 1,
            pluginId: props.plugin.id,
            requestId: data.requestId,
            ok: true,
            result
          },
          "*"
        );
      } catch (error) {
        (event.source as WindowProxy | null)?.postMessage(
          {
            type: "dibao.bridge.response",
            schemaVersion: 1,
            pluginId: props.plugin.id,
            requestId: data.requestId,
            ok: false,
            error: userMessageForError(error, t.errors.api)
          },
          "*"
        );
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [props.active, props.plugin, t.errors.api]);

  return (
    <section
      className={styles.pluginSettingsPanel}
      hidden={!props.active}
      aria-labelledby={`settings-plugin-${props.plugin.id}-${props.tab.id}`}
    >
      {props.active ? (
        <iframe
          className={styles.pluginSettingsFrame}
          ref={frameRef}
          sandbox="allow-scripts allow-forms"
          src={`${baseUrl}?${params.toString()}`}
          title={props.tab.label}
        />
      ) : null}
    </section>
  );
}

async function handlePluginSettingsBridgeRequest(
  plugin: PluginListItem,
  method: unknown,
  payload: unknown
): Promise<unknown> {
  const input = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  switch (method) {
    case "getAuthSession":
      return await dibaoApi.getAuthSession();
    case "getSettings":
      return await dibaoApi.getPluginSettings(plugin.id);
    case "updatePluginSettings":
      return await dibaoApi.updatePluginSettings(
        plugin.id,
        input.settings && typeof input.settings === "object" && !Array.isArray(input.settings)
          ? input.settings as Record<string, unknown>
          : input
      );
    case "listPluginSecrets":
      return await dibaoApi.listPluginSecrets(plugin.id);
    case "setPluginSecret":
      if (typeof input.key !== "string" || typeof input.value !== "string") {
        throw new Error("key and value are required");
      }
      return await dibaoApi.setPluginSecret(plugin.id, input.key, {
        value: input.value,
        hint: typeof input.hint === "string" ? input.hint : null
      });
    case "deletePluginSecret":
      if (typeof input.key !== "string") {
        throw new Error("key is required");
      }
      return await dibaoApi.deletePluginSecret(plugin.id, input.key);
    case "listPluginDeliveries":
      return await dibaoApi.listPluginDeliveries(plugin.id, {
        status: isPluginDeliveryStatus(input.status) ? input.status : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined
      });
    case "getPluginDelivery":
      if (typeof input.deliveryId !== "string") {
        throw new Error("deliveryId is required");
      }
      return await dibaoApi.getPluginDelivery(plugin.id, input.deliveryId);
    case "startTask":
      if (typeof input.taskId !== "string") {
        throw new Error("taskId is required");
      }
      return await dibaoApi.startPluginTask(plugin.id, input.taskId);
    case "pluginApi":
      if (typeof input.path !== "string") {
        throw new Error("path is required");
      }
      return await dibaoApi.callPluginApi(
        plugin.id,
        input.path,
        input.body ?? {},
        input.method === "GET" ? "GET" : "POST"
      );
    case "openArticle":
      return { ok: true };
    default:
      throw new Error("Unsupported plugin bridge method");
  }
}

function PluginManagerSection(props: {
  active: boolean;
  locale: AppSettings["ui"]["locale"];
  onPluginsChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const copy = pluginCopy[props.locale];
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [fileInputResetKey, setFileInputResetKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadPlugins() {
    setIsLoading(true);
    setError(null);
    try {
      setPlugins(await dibaoApi.listPlugins());
    } catch (caught) {
      setError(userMessageForError(caught, t.errors.api));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (props.active) {
      void loadPlugins();
    }
  }, [props.active]);

  async function handleInstallPlugin() {
    if (!packageFile) {
      setError(copy.installRequired);
      return;
    }

    setIsInstalling(true);
    setError(null);
    setNotice(null);
    try {
      const installed = await dibaoApi.uploadPluginPackage(packageFile);
      setPlugins((current) => upsertPlugin(current, installed));
      setPackageFile(null);
      setFileInputResetKey((current) => current + 1);
      await props.onPluginsChanged();
      setNotice(copy.installed);
    } catch (caught) {
      setError(userMessageForError(caught, t.errors.api));
    } finally {
      setIsInstalling(false);
    }
  }

  async function mutatePlugin(
    pluginId: string,
    action: () => Promise<PluginListItem | { ok: true }>
  ) {
    setBusyPluginId(pluginId);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if ("id" in result) {
        setPlugins((current) => upsertPlugin(current, result));
      } else {
        setPlugins((current) => current.filter((plugin) => plugin.id !== pluginId));
      }
      await props.onPluginsChanged();
      setNotice(copy.updated);
    } catch (caught) {
      setError(userMessageForError(caught, t.errors.api));
    } finally {
      setBusyPluginId(null);
    }
  }

  async function handleRunTask(plugin: PluginListItem, taskId: string) {
    setBusyPluginId(plugin.id);
    setError(null);
    setNotice(null);
    try {
      const run = await dibaoApi.startPluginTask(plugin.id, taskId);
      setNotice(copy.taskStarted(run.id));
    } catch (caught) {
      setError(userMessageForError(caught, t.errors.api));
    } finally {
      setBusyPluginId(null);
    }
  }

  return (
    <section
      className={classNames(styles.settingsSection, "settings-card")}
      hidden={!props.active}
      aria-labelledby="settings-plugins-title"
    >
      <div>
        <h3 id="settings-plugins-title">{copy.title}</h3>
        <p>{copy.body}</p>
      </div>

      <div className={styles.settingsSubsection}>
        <div>
          <h4>{copy.installTitle}</h4>
          <p>{copy.installBody}</p>
          <p>{copy.thirdPartyRisk}</p>
          <a
            className={styles.textLink}
            href={pluginInstallDocsUrl[props.locale]}
            rel="noreferrer"
            target="_blank"
          >
            {copy.installDocs}
          </a>
        </div>
        <div className={styles.settingsGrid}>
          <label className={styles.settingsField} htmlFor="settings-plugin-file">
            <span>{copy.chooseFile}</span>
            <input
              accept=".dibao-plugin,application/json"
              id="settings-plugin-file"
              key={fileInputResetKey}
              onChange={(event) => setPackageFile(event.target.files?.[0] ?? null)}
              type="file"
            />
          </label>
        </div>
        <div className={styles.managementActions}>
          <button
            className={styles.primaryButton}
            disabled={isInstalling}
            onClick={() => void handleInstallPlugin()}
            type="button"
          >
            {isInstalling ? copy.installing : copy.install}
          </button>
          <button
            className={styles.secondaryButton}
            disabled={isLoading}
            onClick={() => void loadPlugins()}
            type="button"
          >
            {copy.refresh}
          </button>
        </div>
      </div>

      {isLoading ? <p className={styles.settingsNotice}>{copy.loading}</p> : null}
      {notice ? <p className={styles.settingsNotice}>{notice}</p> : null}
      {error ? <p className={styles.errorText}>{error}</p> : null}
      {plugins.length === 0 && !isLoading ? (
        <p className={styles.settingsNotice}>{copy.empty}</p>
      ) : null}

      {plugins.map((plugin) => (
        <div className={classNames(styles.settingsIndexStatus, styles.pluginStatusCard)} key={plugin.id}>
          <div>
            <strong>
              {plugin.name} {plugin.version}
            </strong>
            <p>
              {plugin.publisher} · {copy.status}: {plugin.status} ·{" "}
              {plugin.official ? copy.official : copy.thirdParty}
              {plugin.bundled ? ` · ${copy.bundled}` : ""}
            </p>
            <p>
              {copy.capabilities}:{" "}
              {plugin.capabilities.length > 0 ? plugin.capabilities.join(", ") : "-"}
            </p>
            <p>
              {copy.source}: {plugin.sourceType}
              {plugin.sourceUrl ? ` · ${plugin.sourceUrl}` : ""} · {copy.trust}: {plugin.trustLevel}
            </p>
            <p>
              {copy.stableApi}: {plugin.apiStability?.stable?.length ? plugin.apiStability.stable.join(", ") : "-"}
            </p>
            <p>
              {copy.betaApi}: {plugin.apiStability?.beta?.length ? plugin.apiStability.beta.join(", ") : "-"}
            </p>
            {!plugin.official ? <p>{copy.thirdPartyRisk}</p> : null}
            <p>
              {copy.contributions}: {pluginContributionText(plugin)}
            </p>
            {plugin.lastError ? (
              <p>
                {copy.lastError}: {plugin.lastError}
              </p>
            ) : null}
            {plugin.contributes.tasks?.length ? (
              <div className={styles.managementActions}>
                {plugin.contributes.tasks.map((task) => (
                  <button
                    className={styles.secondaryButton}
                    disabled={busyPluginId === plugin.id || plugin.status !== "enabled"}
                    key={task.id}
                    onClick={() => void handleRunTask(plugin, task.id)}
                    type="button"
                  >
                    {copy.runTask}: {task.id}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className={styles.pluginCardActions}>
            <button
              className={styles.secondaryButton}
              disabled={busyPluginId === plugin.id}
              onClick={() =>
                void mutatePlugin(plugin.id, () =>
                  plugin.status === "enabled"
                    ? dibaoApi.disablePlugin(plugin.id)
                    : dibaoApi.enablePlugin(plugin.id)
                )
              }
              type="button"
            >
              {plugin.status === "enabled" ? copy.disable : copy.enable}
            </button>
            <button
              className={styles.secondaryButton}
              disabled={busyPluginId === plugin.id || !plugin.updateUrl}
              onClick={() => void mutatePlugin(plugin.id, () => dibaoApi.updatePlugin(plugin.id))}
              type="button"
            >
              {copy.update}
            </button>
            <button
              className={styles.dangerButton}
              disabled={busyPluginId === plugin.id || plugin.official}
              onClick={() =>
                void mutatePlugin(plugin.id, () => dibaoApi.deletePlugin(plugin.id, false))
              }
              type="button"
            >
              {copy.uninstall}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function upsertPlugin(plugins: PluginListItem[], plugin: PluginListItem): PluginListItem[] {
  const existingIndex = plugins.findIndex((candidate) => candidate.id === plugin.id);
  if (existingIndex === -1) {
    return [...plugins, plugin].sort((left, right) => left.name.localeCompare(right.name));
  }
  return plugins.map((candidate) => (candidate.id === plugin.id ? plugin : candidate));
}

function pluginContributionText(plugin: PluginListItem): string {
  const parts = [
    plugin.contributes.settingsTabs?.length
      ? `settingsTabs:${plugin.contributes.settingsTabs.length}`
      : null,
    plugin.contributes.tabs?.length ? `tabs:${plugin.contributes.tabs.length}` : null,
    plugin.contributes.actions?.length ? `actions:${plugin.contributes.actions.length}` : null,
    plugin.contributes.hooks?.length ? `hooks:${plugin.contributes.hooks.length}` : null,
    plugin.contributes.tasks?.length ? `tasks:${plugin.contributes.tasks.length}` : null
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "-";
}

function isPluginDeliveryStatus(value: unknown): value is "queued" | "running" | "succeeded" | "failed" | "cancelled" {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function latestReleaseText(
  latestRelease: LatestReleaseStatus | null,
  isLoading: boolean,
  error: string | null,
  t: Dictionary
): string {
  if (isLoading && latestRelease === null) {
    return t.settings.sections.about.latestLoading;
  }
  if (error) {
    return error;
  }
  if (!latestRelease) {
    return t.settings.sections.about.latestUnknown;
  }
  if (latestRelease.status === "error" && latestRelease.error) {
    return t.settings.sections.about.latestError(latestRelease.error);
  }
  if (!latestRelease.latestVersion) {
    return latestRelease.checkedAt
      ? t.settings.sections.about.latestUnavailable
      : t.settings.sections.about.latestUnknown;
  }
  if (latestRelease.updateAvailable) {
    return t.settings.sections.about.latestUpdateAvailable(latestRelease.latestVersion);
  }
  return t.settings.sections.about.latestCurrent(latestRelease.latestVersion);
}
