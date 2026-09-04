import type { ChangeEvent, FormEvent } from "react";
import { useRef, useState } from "react";
import type { DerivedDataUpgradeStatus, FeedDiscoveryCandidate, FeedDiscoveryResponse, OpmlImportResponse, PluginListItem } from "../api.js";
import { useI18n } from "../i18n.js";
import styles from "../design-system/AppShell/AppShell.module.css";
import { classNames, type AuthMode } from "../app/shared.js";
import type { OfflineModePromptReason } from "../offline/offlineReading.js";

export function PwaStatusBanner(props: {
  offlinePrompt: { reason: OfflineModePromptReason; availableCount: number } | null;
  isEnteringOfflineMode: boolean;
  onApplyUpdate: (() => void) | null;
  onDismissUpdate: () => void;
  onDismissOfflinePrompt: () => void;
  onEnterOfflineMode: () => void;
}) {
  const { t } = useI18n();

  if (!props.offlinePrompt && !props.onApplyUpdate) {
    return null;
  }

  return (
    <div className={styles.pwaStatusStack} aria-live="polite">
      {props.offlinePrompt ? (
        <div className={styles.pwaStatusBanner} role="status">
          <span>
            {props.offlinePrompt.reason === "server-unavailable"
              ? t.pwa.offlinePrompt.serverUnavailable(props.offlinePrompt.availableCount)
              : t.pwa.offlinePrompt.networkOffline(props.offlinePrompt.availableCount)}
          </span>
          <div className={styles.pwaStatusActions}>
            <button
              className={styles.pwaStatusButton}
              disabled={props.isEnteringOfflineMode}
              onClick={props.onEnterOfflineMode}
              type="button"
            >
              {props.isEnteringOfflineMode
                ? t.pwa.offlinePrompt.entering
                : t.pwa.offlinePrompt.enter}
            </button>
            <button
              className={styles.pwaStatusButtonSecondary}
              disabled={props.isEnteringOfflineMode}
              onClick={props.onDismissOfflinePrompt}
              type="button"
            >
              {t.pwa.offlinePrompt.dismiss}
            </button>
          </div>
        </div>
      ) : null}
      {props.onApplyUpdate ? (
        <div className={styles.pwaStatusBanner} role="status">
          <span>{t.pwa.updateAvailable}</span>
          <div className={styles.pwaStatusActions}>
            <button
              className={styles.pwaStatusButton}
              onClick={props.onApplyUpdate}
              type="button"
            >
              {t.pwa.updateNow}
            </button>
            <button
              className={styles.pwaStatusButtonSecondary}
              onClick={props.onDismissUpdate}
              type="button"
            >
              {t.pwa.dismiss}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SetupWelcomePanel(props: { onStart: () => void }) {
  const { t } = useI18n();

  return (
    <section className={styles.authPanel} aria-labelledby="setup-welcome-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.setup.kicker}</p>
        <h1 id="setup-welcome-title">{t.setup.welcome.title}</h1>
        <p>{t.setup.welcome.body}</p>
      </div>
      <button className={styles.primaryButton} onClick={props.onStart} type="button">
        {t.setup.welcome.start}
      </button>
    </section>
  );
}

export function AuthGatePanel(props: {
  error?: string | null;
  isSubmitting: boolean;
  loadingLabel?: string;
  mode: AuthMode | "loading";
  onRetryLoading?: () => void;
  onTelemetryEnabledChange?: (enabled: boolean) => void;
  onSubmit?: (mode: AuthMode, username: string, password: string) => void;
  retryLoadingLabel?: string;
  telemetryEnabled?: boolean;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  if (props.mode === "loading") {
    return (
      <section className={styles.authPanel} aria-live="polite">
        <div className={styles.brand}>
          <img alt="" className={styles.brandMark} src="/logo-64.png" />
          <span>
            <strong>{t.common.brandName}</strong>
            <small>{t.common.brandSubtitle}</small>
          </span>
        </div>
        <p>{props.loadingLabel ?? t.auth.loading}</p>
        {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
        {props.error && props.onRetryLoading ? (
          <button className={styles.secondaryButton} onClick={props.onRetryLoading} type="button">
            {props.retryLoadingLabel ?? t.auth.retry}
          </button>
        ) : null}
      </section>
    );
  }

  const title = props.mode === "setup" ? t.auth.setupTitle : t.auth.loginTitle;
  const body = props.mode === "setup" ? t.auth.setupBody : t.auth.loginBody;
  const submitLabel = props.mode === "setup" ? t.auth.setupSubmit : t.auth.loginSubmit;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onSubmit?.(props.mode as AuthMode, username, password);
  }

  return (
    <section className={styles.authPanel} aria-labelledby="auth-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.shell.kicker}</p>
        <h1 id="auth-title">{title}</h1>
        <p>{body}</p>
      </div>

      <form className={styles.authForm} onSubmit={handleSubmit}>
        <label htmlFor="auth-username">{t.auth.usernameLabel}</label>
        <input
          autoComplete="username"
          id="auth-username"
          onChange={(event) => setUsername(event.target.value)}
          placeholder={t.auth.usernamePlaceholder}
          type="text"
          value={username}
        />
        <label htmlFor="auth-password">{t.auth.passwordLabel}</label>
        <input
          autoComplete={props.mode === "setup" ? "new-password" : "current-password"}
          id="auth-password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder={t.auth.passwordPlaceholder}
          type="password"
          value={password}
        />
        {props.mode === "setup" ? (
          <label className={styles.telemetrySwitch} htmlFor="auth-telemetry-enabled">
            <input
              checked={props.telemetryEnabled ?? true}
              id="auth-telemetry-enabled"
              onChange={(event) => props.onTelemetryEnabledChange?.(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>{t.auth.telemetryLabel}</strong>
              <small>{t.auth.telemetryBody}</small>
            </span>
          </label>
        ) : null}
        <button className={styles.primaryButton} disabled={props.isSubmitting} type="submit">
          {props.isSubmitting ? t.auth.submitting : submitLabel}
        </button>
      </form>

      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
    </section>
  );
}

export function DerivedDataUpgradePanel(props: {
  error: string | null;
  isRetrying: boolean;
  onRetry: () => void;
  status: DerivedDataUpgradeStatus | null;
}) {
  const { t } = useI18n();
  const progress = props.status?.progress;
  const percent = progress ? Math.max(0, Math.min(100, Math.round(progress.percent * 100))) : 0;
  const step = props.status?.step ?? "detecting";
  const isFailed = props.status?.state === "failed";
  const workTotal = progress?.total ?? 0;
  const workCurrent = progress?.current ?? 0;

  return (
    <section className={styles.authPanel} aria-labelledby="derived-data-upgrade-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.upgrade.kicker}</p>
        <h1 id="derived-data-upgrade-title">{t.upgrade.title}</h1>
        <p>{isFailed ? t.upgrade.failedBody : t.upgrade.body}</p>
      </div>
      <div className={styles.setupStatusBox} aria-live="polite">
        <strong>{t.upgrade.steps[step]}</strong>
        <p>{t.upgrade.progress(workCurrent, workTotal, percent)}</p>
        <p>{t.upgrade.costNote}</p>
        <progress
          aria-label={t.upgrade.progressLabel}
          className={styles.upgradeProgress}
          max={100}
          value={percent}
        />
      </div>
      {props.status?.error ? <p className={styles.errorText}>{props.status.error}</p> : null}
      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
      {isFailed ? (
        <button
          className={styles.primaryButton}
          disabled={props.isRetrying}
          onClick={props.onRetry}
          type="button"
        >
          {props.isRetrying ? t.upgrade.retrying : t.upgrade.retry}
        </button>
      ) : null}
    </section>
  );
}

export function SetupOptionalPluginsPanel(props: {
  busyPluginId: string | null;
  error?: string | null;
  onDecision: (pluginId: string, enabled: boolean) => void;
  plugins: PluginListItem[];
}) {
  const primaryPlugin = props.plugins[0] ?? null;
  const setupStep = primaryPlugin?.contributions.setupSteps[0] ?? null;

  return (
    <section className={styles.authPanel} aria-labelledby="setup-plugin-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>邸报</strong>
          <small>Dibao</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>Official Plugin</p>
        <h1 id="setup-plugin-title">{setupStep?.title ?? primaryPlugin?.name ?? "插件"}</h1>
        <p>{setupStep?.body ?? "可以现在启用，也可以稍后在设置中管理。"}</p>
      </div>
      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
      {primaryPlugin ? (
        <div className={styles.setupActions}>
          <button
            className={styles.primaryButton}
            disabled={props.busyPluginId !== null}
            onClick={() => props.onDecision(primaryPlugin.id, true)}
            type="button"
          >
            {props.busyPluginId === primaryPlugin.id
              ? "处理中"
              : setupStep?.enableLabel ?? "启用"}
          </button>
          <button
            className={styles.secondaryButton}
            disabled={props.busyPluginId !== null}
            onClick={() => props.onDecision(primaryPlugin.id, false)}
            type="button"
          >
            {setupStep?.skipLabel ?? "暂不启用"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function SetupSourcesPanel(props: {
  discovery: FeedDiscoveryResponse | null;
  discoveryError: string | null;
  error: string | null;
  feedUrl: string;
  isAddingFeed: boolean;
  isDiscoveringFeeds: boolean;
  isImportingOpml: boolean;
  onAddCandidate: (candidate: FeedDiscoveryCandidate) => void;
  onAddFeed: (event: FormEvent<HTMLFormElement>) => void;
  onImportOpml: (event: ChangeEvent<HTMLInputElement>) => void;
  onUpdateFeedUrl: (value: string) => void;
  opmlSummary: OpmlImportResponse | null;
}) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <section className={styles.authPanel} aria-labelledby="setup-sources-title">
      <div className={styles.brand}>
        <img alt="" className={styles.brandMark} src="/logo-64.png" />
        <span>
          <strong>{t.common.brandName}</strong>
          <small>{t.common.brandSubtitle}</small>
        </span>
      </div>
      <div>
        <p className={styles.kicker}>{t.setup.kicker}</p>
        <h1 id="setup-sources-title">{t.setup.sources.title}</h1>
        <p>{t.setup.sources.body}</p>
      </div>

      <div className={styles.setupSourceActions}>
        <input
          accept=".opml,.xml,text/xml,application/xml"
          className={styles.fileInput}
          onChange={props.onImportOpml}
          ref={fileInputRef}
          type="file"
        />
        <button
          className={styles.secondaryButton}
          disabled={props.isImportingOpml || props.isAddingFeed}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          {props.isImportingOpml ? t.opml.importing : t.setup.sources.importOpml}
        </button>
      </div>

      <form className={styles.authForm} onSubmit={props.onAddFeed}>
        <label htmlFor="setup-feed-url">{t.feeds.inputLabel}</label>
        <input
          id="setup-feed-url"
          inputMode="url"
          onChange={(event) => props.onUpdateFeedUrl(event.target.value)}
          placeholder={t.feeds.inputPlaceholder}
          type="url"
          value={props.feedUrl}
        />
        <button
          className={styles.primaryButton}
          disabled={props.isAddingFeed || props.isDiscoveringFeeds || props.isImportingOpml}
          type="submit"
        >
          {props.isDiscoveringFeeds ? t.feedDiscovery.checking : t.feedDiscovery.check}
        </button>
      </form>

      <FeedDiscoveryPanel
        discovery={props.discovery}
        error={props.discoveryError}
        isAddingFeed={props.isAddingFeed}
        onAddCandidate={props.onAddCandidate}
      />

      {props.opmlSummary ? (
        <div className={styles.opmlSummary}>
          <p>
            {t.opml.importSummary(
              props.opmlSummary.feedsCreated,
              props.opmlSummary.feedsSkipped,
              props.opmlSummary.foldersCreated
            )}
          </p>
          {props.opmlSummary.errors.length > 0 ? (
            <>
              <p>{t.opml.importErrors(props.opmlSummary.errors.length)}</p>
              <ul>
                {props.opmlSummary.errors.map((error, index) => (
                  <li key={`${error}-${index}`}>{error}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
    </section>
  );
}

export function FeedDiscoveryPanel(props: {
  discovery: FeedDiscoveryResponse | null;
  error: string | null;
  isAddingFeed: boolean;
  onAddCandidate: (candidate: FeedDiscoveryCandidate) => void;
}) {
  const { t, formatDate } = useI18n();

  if (!props.discovery && !props.error) {
    return null;
  }

  return (
    <section className={styles.feedDiscoveryPanel} aria-live="polite">
      {props.error ? <p className={styles.errorText}>{props.error}</p> : null}
      {props.discovery ? (
        <>
          <div className={styles.feedDiscoveryHeader}>
            <strong>
              {props.discovery.candidates.length > 0
                ? t.feedDiscovery.candidatesTitle
                : t.feedDiscovery.noCandidatesTitle}
            </strong>
            <small>{props.discovery.normalizedUrl}</small>
          </div>
          {props.discovery.warnings.length > 0 ? (
            <div className={styles.feedDiscoveryWarnings}>
              <strong>{t.feedDiscovery.warningsTitle}</strong>
              <ul>
                {props.discovery.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {props.discovery.candidates.length === 0 ? (
            <p className={styles.feedDiscoveryEmpty}>{t.feedDiscovery.noCandidatesBody}</p>
          ) : (
            <div className={styles.feedDiscoveryCandidates}>
              {props.discovery.candidates.map((candidate) => (
                <article className={styles.feedDiscoveryCandidate} key={candidate.feedUrl}>
                  <div className={styles.feedDiscoveryCandidateHeader}>
                    <div>
                      <h3>{candidate.title ?? candidate.feedUrl}</h3>
                      <p>{candidate.description ?? candidate.siteUrl ?? candidate.feedUrl}</p>
                    </div>
                    <span
                      className={classNames(
                        styles.feedHealthBadge,
                        candidate.status === "valid"
                          ? styles.feedHealthBadgeOk
                          : candidate.status === "duplicate"
                            ? styles.feedHealthBadgeInfo
                            : styles.feedHealthBadgeError
                      )}
                    >
                      {t.feedDiscovery.statuses[candidate.status]}
                    </span>
                  </div>
                  <dl className={styles.feedDiscoveryMeta}>
                    <div>
                      <dt>URL</dt>
                      <dd>{candidate.feedUrl}</dd>
                    </div>
                    <div>
                      <dt>{candidate.format.toUpperCase()}</dt>
                      <dd>{t.feedDiscovery.itemCount(candidate.itemCount)}</dd>
                    </div>
                  </dl>
                  {candidate.recentItems.length > 0 ? (
                    <div className={styles.feedDiscoveryRecent}>
                      <strong>{t.feedDiscovery.recentItems}</strong>
                      <ul>
                        {candidate.recentItems.map((item, index) => (
                          <li key={`${candidate.feedUrl}-${item.url ?? item.title}-${index}`}>
                            <span>{item.title}</span>
                            <small>
                              {item.publishedAt ? formatDate(item.publishedAt) : candidate.siteUrl}
                            </small>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {candidate.error ? (
                    <p className={styles.feedDiscoveryError}>{candidate.error}</p>
                  ) : null}
                  <button
                    className={styles.primaryButton}
                    disabled={candidate.status !== "valid" || props.isAddingFeed}
                    onClick={() => props.onAddCandidate(candidate)}
                    type="button"
                  >
                    {props.isAddingFeed
                      ? t.feedDiscovery.addingCandidate
                      : candidate.status === "duplicate"
                        ? t.feedDiscovery.duplicate
                        : t.feedDiscovery.addCandidate}
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
