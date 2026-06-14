import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  userMessageForError,
  type Feed,
  type FullContentBackfillResponse,
  type FeedDiagnosticItem,
  type FeedDiagnosticsResponse,
  type FeedDiscoveryCandidate,
  type FeedDiscoveryResponse,
  type FeedFolder,
  type OpmlImportResponse,
  type UpdateFeedInput,
  type UpdateFeedFolderInput
} from "./api.js";
import styles from "./design-system/AppShell/AppShell.module.css";
import { useI18n } from "./i18n.js";
import type { PluginActionButton, PluginActionContext } from "./reader/ReaderPanels.js";

const UNGROUPED_FOLDER_VALUE = "__ungrouped__";

type PendingManagementAction =
  | "createFolder"
  | "updateFolder"
  | "deleteFolder"
  | "updateFeed"
  | "deleteFeed"
  | "backfillFullContent";

type FeedDiagnosticsByFeedId = Record<string, FeedDiagnosticItem["diagnostic"]>;
type FeedDiagnosticFilter = "all" | "unhealthy" | "disabled" | "neverFetched";
type FeedManagementTab = "feeds" | "folders";

type FeedDraft = {
  title: string;
  feedUrl: string;
  folderId: string;
  enabled: boolean;
  fullContentMode: Feed["fullContentMode"];
  sourceWeight: string;
};

export type FeedManagementWorkspaceProps = {
  diagnostics: FeedDiagnosticsResponse | null;
  diagnosticsByFeedId: FeedDiagnosticsByFeedId;
  feedError: string | null;
  feedDiscovery: FeedDiscoveryResponse | null;
  feedDiscoveryError: string | null;
  feedUrl: string;
  feedFolders: FeedFolder[];
  feeds: Feed[];
  isAddingFeed: boolean;
  isDiscoveringFeeds: boolean;
  isFeedDiagnosticsLoading: boolean;
  isExportingOpml: boolean;
  isImportingOpml: boolean;
  isLoading: boolean;
  isRefreshingAllFeeds: boolean;
  onAddCandidate: (candidate: FeedDiscoveryCandidate) => void;
  onAddFeed: (event: FormEvent<HTMLFormElement>) => void;
  onPluginAction?: (action: PluginActionButton, context: PluginActionContext) => void;
  onCreateFolder: (title: string) => Promise<void>;
  onDeleteFeed: (feedId: string) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onExportOpml: () => void;
  onImportOpml: (event: ChangeEvent<HTMLInputElement>) => void;
  onRefreshFeed: (feed: Feed) => void;
  onRefreshAllFeeds: () => void;
  onPreviewFullContent: (feedId: string) => void;
  onBackfillCurrentFeedFullContent: (feedId: string) => Promise<FullContentBackfillResponse>;
  onUpdateFeed: (feedId: string, input: UpdateFeedInput) => Promise<void>;
  onUpdateFeedUrl: (value: string) => void;
  onUpdateFolder: (folderId: string, input: UpdateFeedFolderInput) => Promise<void>;
  onViewFeedArticles: (feed: Feed) => void;
  onViewFolderArticles: (folder: FeedFolder) => void;
  opmlSummary: OpmlImportResponse | null;
  pluginToolbarActions?: PluginActionButton[];
  refreshingFeedId: string | null;
};

export function FeedManagementWorkspace(props: FeedManagementWorkspaceProps) {
  const { t, formatDate } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFeedId, setSelectedFeedId] = useState<string | null>(
    props.feeds[0]?.id ?? null
  );
  const selectedFeed = useMemo(
    () => props.feeds.find((feed) => feed.id === selectedFeedId) ?? null,
    [props.feeds, selectedFeedId]
  );
  const selectedFeedIdentity = selectedFeed?.id ?? null;
  const folderById = useMemo(
    () => new Map(props.feedFolders.map((folder) => [folder.id, folder])),
    [props.feedFolders]
  );
  const feedCountByFolder = useMemo(() => countFeedsByFolder(props.feeds), [props.feeds]);
  const [feedDraft, setFeedDraft] = useState<FeedDraft>(() =>
    selectedFeed ? draftForFeed(selectedFeed) : emptyFeedDraft()
  );
  const [newFolderTitle, setNewFolderTitle] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderDraftTitle, setFolderDraftTitle] = useState("");
  const [confirmDeleteFeedId, setConfirmDeleteFeedId] = useState<string | null>(null);
  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingManagementAction | null>(null);
  const [diagnosticFilter, setDiagnosticFilter] = useState<FeedDiagnosticFilter>("all");
  const [isAddFeedDialogOpen, setIsAddFeedDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<FeedManagementTab>("feeds");
  const [error, setError] = useState<string | null>(null);
  const [backfillResult, setBackfillResult] = useState<FullContentBackfillResponse | null>(null);
  const wasAddingFeedRef = useRef(false);
  const visibleFeeds = useMemo(
    () =>
      props.feeds.filter((feed) =>
        matchesDiagnosticFilter(feed, props.diagnosticsByFeedId[feed.id], diagnosticFilter)
      ),
    [diagnosticFilter, props.diagnosticsByFeedId, props.feeds]
  );
  const selectedDiagnostic = selectedFeed
    ? props.diagnosticsByFeedId[selectedFeed.id] ?? null
    : null;

  useEffect(() => {
    if (props.feeds.length === 0) {
      setSelectedFeedId(null);
      return;
    }

    if (!selectedFeed) {
      setSelectedFeedId(props.feeds[0].id);
    }
  }, [props.feeds, selectedFeed]);

  useEffect(() => {
    setFeedDraft(selectedFeed ? draftForFeed(selectedFeed) : emptyFeedDraft());
  }, [selectedFeed]);

  useEffect(() => {
    setConfirmDeleteFeedId(null);
    setBackfillResult(null);
  }, [selectedFeedIdentity]);

  useEffect(() => {
    if (
      isAddFeedDialogOpen &&
      wasAddingFeedRef.current &&
      !props.isAddingFeed &&
      !props.feedError &&
      !props.feedDiscovery
    ) {
      setIsAddFeedDialogOpen(false);
    }
    wasAddingFeedRef.current = props.isAddingFeed;
  }, [isAddFeedDialogOpen, props.feedDiscovery, props.feedError, props.isAddingFeed]);

  async function runManagementAction(action: PendingManagementAction, fn: () => Promise<void>) {
    setPendingAction(action);
    setError(null);

    try {
      await fn();
    } catch (caught) {
      setError(userMessageForError(caught, t.errors.api));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCreateFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newFolderTitle.trim();
    if (!title) {
      setError(t.feedManagement.errors.folderTitleRequired);
      return;
    }

    await runManagementAction("createFolder", async () => {
      await props.onCreateFolder(title);
      setNewFolderTitle("");
    });
  }

  function startEditingFolder(folder: FeedFolder) {
    setEditingFolderId(folder.id);
    setFolderDraftTitle(folder.title);
    setConfirmDeleteFolderId(null);
    setError(null);
  }

  async function handleUpdateFolder(folder: FeedFolder) {
    const title = folderDraftTitle.trim();
    if (!title) {
      setError(t.feedManagement.errors.folderTitleRequired);
      return;
    }

    await runManagementAction("updateFolder", async () => {
      await props.onUpdateFolder(folder.id, { title });
      setEditingFolderId(null);
      setFolderDraftTitle("");
    });
  }

  async function handleDeleteFolder(folder: FeedFolder) {
    if (confirmDeleteFolderId !== folder.id) {
      setConfirmDeleteFolderId(folder.id);
      setError(null);
      return;
    }

    await runManagementAction("deleteFolder", async () => {
      await props.onDeleteFolder(folder.id);
      setConfirmDeleteFolderId(null);
      if (editingFolderId === folder.id) {
        setEditingFolderId(null);
        setFolderDraftTitle("");
      }
    });
  }

  async function handleUpdateFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFeed) {
      return;
    }

    const title = feedDraft.title.trim();
    if (!title) {
      setError(t.feedManagement.errors.feedTitleRequired);
      return;
    }
    const feedUrl = feedDraft.feedUrl.trim();
    if (!feedUrl) {
      setError(t.feeds.feedUrlRequired);
      return;
    }

    const sourceWeight = Number(feedDraft.sourceWeight);
    if (!Number.isFinite(sourceWeight) || sourceWeight < -1 || sourceWeight > 1) {
      setError(t.feedManagement.errors.sourceWeight);
      return;
    }

    await runManagementAction("updateFeed", async () => {
      await props.onUpdateFeed(selectedFeed.id, {
        title,
        feedUrl,
        folderId:
          feedDraft.folderId === UNGROUPED_FOLDER_VALUE ? null : feedDraft.folderId,
        enabled: feedDraft.enabled,
        fullContentMode: feedDraft.fullContentMode,
        sourceWeight
      });
    });
  }

  async function handleBackfillCurrentFeedFullContent() {
    if (!selectedFeed) {
      return;
    }
    const confirmed = window.confirm(t.feedManagement.fullContent.backfillConfirm);
    if (!confirmed) {
      return;
    }
    await runManagementAction("backfillFullContent", async () => {
      const result = await props.onBackfillCurrentFeedFullContent(selectedFeed.id);
      setBackfillResult(result);
    });
  }

  async function handleDeleteFeed(feed: Feed) {
    if (confirmDeleteFeedId !== feed.id) {
      setConfirmDeleteFeedId(feed.id);
      setError(null);
      return;
    }

    await runManagementAction("deleteFeed", async () => {
      await props.onDeleteFeed(feed.id);
      setConfirmDeleteFeedId(null);
    });
  }

  return (
    <div className={styles.managementWorkspace}>
      <div className={styles.managementTabs} role="tablist" aria-label={t.feedManagement.tabs.label}>
        <button
          aria-controls="feed-management-panel"
          aria-selected={activeTab === "feeds"}
          className={activeTab === "feeds" ? styles.managementTabActive : styles.managementTab}
          id="feed-management-tab"
          onClick={() => setActiveTab("feeds")}
          role="tab"
          type="button"
        >
          {t.feedManagement.tabs.feeds}
        </button>
        <button
          aria-controls="folder-management-panel"
          aria-selected={activeTab === "folders"}
          className={activeTab === "folders" ? styles.managementTabActive : styles.managementTab}
          id="folder-management-tab"
          onClick={() => setActiveTab("folders")}
          role="tab"
          type="button"
        >
          {t.feedManagement.tabs.folders}
        </button>
      </div>

      {activeTab === "feeds" ? (
        <section
          aria-labelledby="feed-management-title"
          aria-describedby="feed-management-tab"
          className={`${styles.managementSection} ${styles.feedManagementSection}`}
          id="feed-management-panel"
          role="tabpanel"
        >
          <div className={styles.managementHeader}>
            <div>
              <p className={styles.kicker}>{t.feedManagement.feeds.kicker}</p>
              <h2 id="feed-management-title">{t.feedManagement.feeds.title}</h2>
            </div>
            <div className={styles.managementHeaderActions}>
              <button
                className={styles.primaryButton}
                onClick={() => setIsAddFeedDialogOpen(true)}
                type="button"
              >
                {t.feedManagement.feeds.addFeed}
              </button>
              <span className={styles.count}>{props.feeds.length}</span>
              <input
                accept=".opml,.xml,text/xml,application/xml"
                className={styles.fileInput}
                onChange={props.onImportOpml}
                ref={fileInputRef}
                type="file"
              />
              <div className={styles.opmlActions}>
                <button
                  className={styles.secondaryButton}
                  disabled={props.isImportingOpml}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  {props.isImportingOpml ? t.opml.importing : t.opml.import}
                </button>
                <button
                  className={styles.secondaryButton}
                  disabled={props.isExportingOpml}
                  onClick={props.onExportOpml}
                  type="button"
                >
                  {props.isExportingOpml ? t.opml.exporting : t.opml.export}
                </button>
                <button
                  className={styles.secondaryButton}
                  disabled={props.isRefreshingAllFeeds || !props.feeds.some((feed) => feed.enabled)}
                  onClick={props.onRefreshAllFeeds}
                  type="button"
                >
                  {props.isRefreshingAllFeeds ? t.feeds.refreshingAll : t.feeds.refreshAll}
                </button>
                {(props.pluginToolbarActions ?? []).map((action) => (
                  <button
                    className={styles.secondaryButton}
                    key={`${action.pluginId}:${action.id}`}
                    onClick={() => props.onPluginAction?.(action, { slot: action.slot })}
                    title={`${action.pluginName}: ${action.label}`}
                    type="button"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {isAddFeedDialogOpen ? (
            <div
              className={styles.managementDialogOverlay}
              onClick={() => setIsAddFeedDialogOpen(false)}
              role="presentation"
            >
              <div
                aria-labelledby="add-feed-dialog-title"
                aria-modal="true"
                className={styles.managementDialog}
                onClick={(event) => event.stopPropagation()}
                role="dialog"
              >
                <div className={styles.managementDialogHeader}>
                  <div>
                    <p className={styles.kicker}>{t.feedManagement.feeds.kicker}</p>
                    <h3 id="add-feed-dialog-title">{t.feedManagement.feeds.addFeed}</h3>
                  </div>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setIsAddFeedDialogOpen(false)}
                    type="button"
                  >
                    {t.feedManagement.actions.cancel}
                  </button>
                </div>

                <form className={styles.managementForm} onSubmit={props.onAddFeed}>
                  <label htmlFor="managed-new-feed-url">{t.feeds.inputLabel}</label>
                  <div className={styles.managementInlineForm}>
                    <input
                      id="managed-new-feed-url"
                      inputMode="url"
                      onChange={(event) => props.onUpdateFeedUrl(event.target.value)}
                      placeholder={t.feeds.inputPlaceholder}
                      type="url"
                      value={props.feedUrl}
                    />
                    <button
                      className={styles.primaryButton}
                      disabled={props.isAddingFeed || props.isDiscoveringFeeds}
                      type="submit"
                    >
                      {props.isDiscoveringFeeds ? t.feedDiscovery.checking : t.feedDiscovery.check}
                    </button>
                  </div>
                </form>

                <ManagementFeedDiscoveryPanel
                  discovery={props.feedDiscovery}
                  error={props.feedDiscoveryError}
                  isAddingFeed={props.isAddingFeed}
                  onAddCandidate={props.onAddCandidate}
                />

                {props.feedError ? <p className={styles.errorText}>{props.feedError}</p> : null}
              </div>
            </div>
          ) : null}

          <div className={styles.feedManagementGrid}>
            <div className={styles.feedManagementListPane}>
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
                        {props.opmlSummary.errors.map((summaryError, index) => (
                          <li key={`${summaryError}-${index}`}>{summaryError}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              ) : null}

              <section className={styles.feedListFilters} aria-labelledby="feed-diagnostics-title">
                <div className={styles.feedListFilterHeader}>
                  <div>
                    <h3 id="feed-diagnostics-title">{t.feedDiagnostics.title}</h3>
                    <p>
                      {props.diagnostics
                        ? t.feedDiagnostics.summary(
                            props.diagnostics.summary.total,
                            props.diagnostics.summary.error,
                            props.diagnostics.summary.warning
                          )
                        : props.isFeedDiagnosticsLoading
                          ? t.feedManagement.loading
                          : t.feedManagement.na}
                    </p>
                  </div>
                  <div className={styles.feedDiagnosticSummaryPills}>
                    <span>{t.feedDiagnostics.statuses.healthy}: {props.diagnostics?.summary.healthy ?? 0}</span>
                    <span>{t.feedDiagnostics.statuses.failing}: {props.diagnostics?.summary.error ?? 0}</span>
                    <span>{t.feedDiagnostics.statuses.never_fetched}: {props.diagnostics?.summary.neverFetched ?? 0}</span>
                    <span>{t.feedDiagnostics.statuses.disabled}: {props.diagnostics?.summary.disabled ?? 0}</span>
                  </div>
                </div>
                <div className={styles.feedDiagnosticFilters} aria-label={t.feedDiagnostics.title}>
                  {(["all", "unhealthy", "disabled", "neverFetched"] as const).map((filter) => (
                    <button
                      className={
                        diagnosticFilter === filter
                          ? styles.feedDiagnosticFilterActive
                          : styles.feedDiagnosticFilter
                      }
                      key={filter}
                      onClick={() => setDiagnosticFilter(filter)}
                      type="button"
                    >
                      {t.feedDiagnostics.filters[filter]}
                    </button>
                  ))}
                </div>
              </section>

              <div className={styles.managementList}>
                {props.isLoading ? <SkeletonRows count={6} /> : null}
                {!props.isLoading && props.feeds.length === 0 ? (
                  <ManagementEmptyState
                    title={t.feedManagement.feeds.emptyTitle}
                    body={t.feedManagement.feeds.emptyBody}
                  />
                ) : null}
                {!props.isLoading && props.feeds.length > 0 && visibleFeeds.length === 0 ? (
                  <ManagementEmptyState
                    title={t.feedDiagnostics.noIssues}
                    body={t.feedDiagnostics.noIssues}
                  />
                ) : null}
                {!props.isLoading &&
                  visibleFeeds.map((feed) => {
                    const diagnostic = props.diagnosticsByFeedId[feed.id] ?? null;
                    return (
                      <button
                        className={
                          selectedFeed?.id === feed.id
                            ? styles.managementFeedItemActive
                            : styles.managementFeedItem
                        }
                        key={feed.id}
                        onClick={() => setSelectedFeedId(feed.id)}
                        type="button"
                      >
                        <span className={styles.managementFeedTitle}>
                          {feed.title}
                          {diagnostic ? (
                            <span
                              className={`${styles.feedHealthBadge} ${feedHealthBadgeClass(diagnostic.severity, styles)}`}
                            >
                              {t.feedDiagnostics.statuses[diagnostic.status]}
                            </span>
                          ) : null}
                        </span>
                        <span className={styles.managementFeedUrl}>{feed.feedUrl}</span>
                        <span className={styles.managementFeedMeta}>
                          {folderLabel(feed, folderById, t.feedManagement.feeds.ungrouped)} ·{" "}
                          {feed.enabled
                            ? t.feedManagement.feeds.enabled
                            : t.feedManagement.feeds.disabled}{" "}
                          · {t.feedManagement.feeds.weight(feed.sourceWeight)}
                        </span>
                        <span className={styles.managementFeedMeta}>
                          {t.feedManagement.feeds.lastSuccess(
                            feed.lastSuccessAt ? formatDate(feed.lastSuccessAt) : t.feedManagement.na
                          )}
                        </span>
                        <span className={styles.managementFeedMeta}>
                          {t.feedManagement.feeds.nextRefresh(
                            feed.nextRefreshAt ? formatDate(feed.nextRefreshAt) : t.feedManagement.na
                          )}
                        </span>
                        {feed.lastError ? (
                          <span className={styles.managementFeedError}>{feed.lastError}</span>
                        ) : null}
                      </button>
                    );
                  })}
              </div>
            </div>

            <section className={styles.managementEditor} aria-labelledby="feed-editor-title">
            {selectedFeed ? (
              <>
                <div className={styles.managementHeader}>
                  <div>
                    <p className={styles.kicker}>{t.feedManagement.editor.kicker}</p>
                    <h3 id="feed-editor-title">{selectedFeed.title}</h3>
                  </div>
                  {selectedDiagnostic ? (
                    <span
                      className={`${styles.feedHealthBadge} ${feedHealthBadgeClass(selectedDiagnostic.severity, styles)}`}
                    >
                      {t.feedDiagnostics.statuses[selectedDiagnostic.status]}
                    </span>
                  ) : null}
                </div>
                {error ? <p className={styles.errorText}>{error}</p> : null}
                <form className={styles.managementForm} onSubmit={handleUpdateFeed}>
                  <label htmlFor="managed-feed-title">
                    {t.feedManagement.editor.titleLabel}
                  </label>
                  <input
                    id="managed-feed-title"
                    onChange={(event) =>
                      setFeedDraft((current) => ({
                        ...current,
                        title: event.target.value
                      }))
                    }
                    value={feedDraft.title}
                  />

                  <label htmlFor="managed-feed-url">
                    {t.feedManagement.editor.feedUrlLabel}
                  </label>
                  <input
                    id="managed-feed-url"
                    inputMode="url"
                    onChange={(event) =>
                      setFeedDraft((current) => ({
                        ...current,
                        feedUrl: event.target.value
                      }))
                    }
                    type="url"
                    value={feedDraft.feedUrl}
                  />

                  <label htmlFor="managed-feed-folder">
                    {t.feedManagement.editor.folderLabel}
                  </label>
                  <select
                    id="managed-feed-folder"
                    onChange={(event) =>
                      setFeedDraft((current) => ({
                        ...current,
                        folderId: event.target.value
                      }))
                    }
                    value={feedDraft.folderId}
                  >
                    <option value={UNGROUPED_FOLDER_VALUE}>
                      {t.feedManagement.feeds.ungrouped}
                    </option>
                    {props.feedFolders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.title}
                      </option>
                    ))}
                  </select>

                  <label className={styles.managementCheckbox} htmlFor="managed-feed-enabled">
                    <input
                      checked={feedDraft.enabled}
                      id="managed-feed-enabled"
                      onChange={(event) =>
                        setFeedDraft((current) => ({
                          ...current,
                          enabled: event.target.checked
                        }))
                      }
                      type="checkbox"
                    />
                    <span>{t.feedManagement.editor.enabledLabel}</span>
                  </label>

                  <label htmlFor="managed-feed-full-content-mode">
                    {t.feedManagement.fullContent.label}
                  </label>
                  <select
                    id="managed-feed-full-content-mode"
                    onChange={(event) =>
                      setFeedDraft((current) => ({
                        ...current,
                        fullContentMode: event.target.value as Feed["fullContentMode"]
                      }))
                    }
                    value={feedDraft.fullContentMode}
                  >
                    <option value="feed_only">
                      {t.feedManagement.fullContent.modes.feed_only}
                    </option>
                    <option value="fetch_full_content">
                      {t.feedManagement.fullContent.modes.fetch_full_content}
                    </option>
                  </select>
                  <p className={styles.managementHint}>
                    {feedDraft.fullContentMode === "fetch_full_content"
                      ? t.feedManagement.fullContent.fetchHint
                      : t.feedManagement.fullContent.feedOnlyHint}
                  </p>

                  <label htmlFor="managed-feed-source-weight">
                    {t.feedManagement.editor.sourceWeightLabel}
                  </label>
                  <input
                    id="managed-feed-source-weight"
                    max={1}
                    min={-1}
                    onChange={(event) =>
                      setFeedDraft((current) => ({
                        ...current,
                        sourceWeight: event.target.value
                      }))
                    }
                    step={0.1}
                    type="number"
                    value={feedDraft.sourceWeight}
                  />

                  <dl className={styles.managementStatusRows}>
                    {selectedDiagnostic ? (
                      <div>
                        <dt>{t.feedDiagnostics.title}</dt>
                        <dd>{feedDiagnosticMessage(selectedDiagnostic, t.feedDiagnostics.messages)}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>{t.feedManagement.editor.lastFetchedAt}</dt>
                      <dd>
                        {selectedFeed.lastFetchedAt
                          ? formatDate(selectedFeed.lastFetchedAt)
                          : t.feedManagement.na}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.feedManagement.editor.lastSuccessAt}</dt>
                      <dd>
                        {selectedFeed.lastSuccessAt
                          ? formatDate(selectedFeed.lastSuccessAt)
                          : t.feedManagement.na}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.feedManagement.editor.nextRefreshAt}</dt>
                      <dd>
                        {selectedFeed.nextRefreshAt
                          ? formatDate(selectedFeed.nextRefreshAt)
                          : t.feedManagement.na}
                      </dd>
                    </div>
                    <div>
                      <dt>{t.feedManagement.editor.lastError}</dt>
                      <dd>{selectedFeed.lastError ?? t.feedManagement.na}</dd>
                    </div>
                  </dl>

                  <div className={styles.managementActions}>
                    <button
                      className={styles.secondaryButton}
                      onClick={() => props.onViewFeedArticles(selectedFeed)}
                      type="button"
                    >
                      {t.feedManagement.actions.viewArticles}
                    </button>
                    <button
                      className={styles.primaryButton}
                      disabled={pendingAction === "updateFeed"}
                      type="submit"
                    >
                      {pendingAction === "updateFeed"
                        ? t.feedManagement.actions.saving
                        : t.feedManagement.actions.save}
                    </button>
                    {selectedDiagnostic &&
                    (selectedDiagnostic.status === "failing" ||
                      selectedDiagnostic.status === "stale") ? (
                      <button
                        className={styles.secondaryButton}
                        disabled={props.refreshingFeedId === selectedFeed.id}
                        onClick={() => props.onRefreshFeed(selectedFeed)}
                        type="button"
                      >
                        {props.refreshingFeedId === selectedFeed.id
                          ? t.feeds.refreshing
                          : t.feedDiagnostics.retry}
                      </button>
                    ) : null}
                    <button
                      className={styles.secondaryButton}
                      onClick={() => props.onPreviewFullContent(selectedFeed.id)}
                      type="button"
                    >
                      {t.feedManagement.fullContent.preview}
                    </button>
                    {selectedFeed.fullContentMode === "fetch_full_content" ? (
                      <button
                        className={styles.secondaryButton}
                        disabled={pendingAction === "backfillFullContent"}
                        onClick={() => void handleBackfillCurrentFeedFullContent()}
                        type="button"
                      >
                        {pendingAction === "backfillFullContent"
                          ? t.feedManagement.fullContent.backfilling
                          : t.feedManagement.fullContent.backfill}
                      </button>
                    ) : null}
                    <button
                      className={styles.dangerButton}
                      disabled={pendingAction === "deleteFeed"}
                      onClick={() => void handleDeleteFeed(selectedFeed)}
                      type="button"
                    >
                      {confirmDeleteFeedId === selectedFeed.id
                        ? t.feedManagement.feeds.confirmDelete
                        : t.feedManagement.actions.delete}
                    </button>
                  </div>
                  {confirmDeleteFeedId === selectedFeed.id ? (
                    <p className={styles.managementHint}>
                      {t.feedManagement.feeds.deleteHint}
                    </p>
                  ) : null}
                  {backfillResult ? (
                    <dl className={styles.managementStatusRows} aria-live="polite">
                      <div>
                        <dt>{t.feedManagement.fullContent.stats.articlesSeen}</dt>
                        <dd>{backfillResult.articlesSeen}</dd>
                      </div>
                      <div>
                        <dt>{t.feedManagement.fullContent.stats.attempted}</dt>
                        <dd>{backfillResult.attempted}</dd>
                      </div>
                      <div>
                        <dt>{t.feedManagement.fullContent.stats.succeeded}</dt>
                        <dd>{backfillResult.succeeded}</dd>
                      </div>
                      <div>
                        <dt>{t.feedManagement.fullContent.stats.failed}</dt>
                        <dd>{backfillResult.failed}</dd>
                      </div>
                      <div>
                        <dt>{t.feedManagement.fullContent.stats.skipped}</dt>
                        <dd>{backfillResult.skipped}</dd>
                      </div>
                      <div>
                        <dt>{t.feedManagement.fullContent.stats.changed}</dt>
                        <dd>{backfillResult.effectiveContentChangedArticleIds.length}</dd>
                      </div>
                      <div>
                        <dt>{t.feedManagement.fullContent.stats.limited}</dt>
                        <dd>
                          {backfillResult.limited
                            ? t.feedManagement.fullContent.limited
                            : t.feedManagement.fullContent.notLimited}
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                </form>
              </>
            ) : (
              <ManagementEmptyState
                title={t.feedManagement.editor.emptyTitle}
                body={t.feedManagement.editor.emptyBody}
              />
            )}
            </section>
          </div>
        </section>
      ) : (
        <section
          aria-labelledby="folder-management-title"
          aria-describedby="folder-management-tab"
          className={`${styles.managementSection} ${styles.folderManagementSection}`}
          id="folder-management-panel"
          role="tabpanel"
        >
          <div className={styles.managementHeader}>
            <div>
              <p className={styles.kicker}>{t.feedManagement.folders.kicker}</p>
              <h2 id="folder-management-title">{t.feedManagement.folders.title}</h2>
            </div>
            <span className={styles.count}>{props.feedFolders.length}</span>
          </div>

          <div className={styles.folderManagementLayout}>
            <form className={styles.managementForm} onSubmit={handleCreateFolder}>
              <label htmlFor="new-folder-title">{t.feedManagement.folders.newLabel}</label>
              <div className={styles.managementInlineForm}>
                <input
                  id="new-folder-title"
                  onChange={(event) => setNewFolderTitle(event.target.value)}
                  placeholder={t.feedManagement.folders.newPlaceholder}
                  value={newFolderTitle}
                />
                <button
                  className={styles.primaryButton}
                  disabled={pendingAction === "createFolder"}
                  type="submit"
                >
                  {pendingAction === "createFolder"
                    ? t.feedManagement.actions.saving
                    : t.feedManagement.folders.create}
                </button>
              </div>
              <p className={styles.managementHint}>{t.feedManagement.folders.managementHint}</p>
            </form>

            {error ? <p className={styles.errorText}>{error}</p> : null}

            <div className={styles.managementList}>
              {props.isLoading ? <SkeletonRows count={4} /> : null}
              {!props.isLoading && props.feedFolders.length === 0 ? (
                <ManagementEmptyState
                  title={t.feedManagement.folders.emptyTitle}
                  body={t.feedManagement.folders.emptyBody}
                />
              ) : null}
              {!props.isLoading &&
                props.feedFolders.map((folder) => (
                  <div className={styles.managementFolderRow} key={folder.id}>
                    {editingFolderId === folder.id ? (
                      <input
                        aria-label={t.feedManagement.folders.renameLabel(folder.title)}
                        onChange={(event) => setFolderDraftTitle(event.target.value)}
                        value={folderDraftTitle}
                      />
                    ) : (
                      <div>
                        <strong>{folder.title}</strong>
                        <small>
                          {t.folders.feedCount(feedCountByFolder.get(folder.id) ?? 0)}
                        </small>
                      </div>
                    )}
                    <div className={styles.managementActions}>
                      <button
                        className={styles.secondaryButton}
                        onClick={() => props.onViewFolderArticles(folder)}
                        type="button"
                      >
                        {t.feedManagement.actions.viewArticles}
                      </button>
                      {editingFolderId === folder.id ? (
                        <>
                          <button
                            className={styles.primaryButton}
                            disabled={pendingAction === "updateFolder"}
                            onClick={() => void handleUpdateFolder(folder)}
                            type="button"
                          >
                            {pendingAction === "updateFolder"
                              ? t.feedManagement.actions.saving
                              : t.feedManagement.actions.save}
                          </button>
                          <button
                            className={styles.secondaryButton}
                            onClick={() => setEditingFolderId(null)}
                            type="button"
                          >
                            {t.feedManagement.actions.cancel}
                          </button>
                        </>
                      ) : (
                        <button
                          className={styles.secondaryButton}
                          onClick={() => startEditingFolder(folder)}
                          type="button"
                        >
                          {t.feedManagement.actions.rename}
                        </button>
                      )}
                      <button
                        className={styles.dangerButton}
                        disabled={pendingAction === "deleteFolder"}
                        onClick={() => void handleDeleteFolder(folder)}
                        type="button"
                      >
                        {confirmDeleteFolderId === folder.id
                          ? t.feedManagement.folders.confirmDelete
                          : t.feedManagement.actions.delete}
                      </button>
                    </div>
                    {confirmDeleteFolderId === folder.id ? (
                      <p className={styles.managementHint}>
                        {t.feedManagement.folders.deleteHint}
                      </p>
                    ) : null}
                  </div>
                ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function draftForFeed(feed: Feed): FeedDraft {
  return {
    title: feed.title,
    feedUrl: feed.feedUrl,
    folderId: feed.folderId ?? UNGROUPED_FOLDER_VALUE,
    enabled: feed.enabled,
    fullContentMode: feed.fullContentMode,
    sourceWeight: String(feed.sourceWeight)
  };
}

function ManagementFeedDiscoveryPanel(props: {
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
                      className={`${styles.feedHealthBadge} ${
                        candidate.status === "valid"
                          ? styles.feedHealthBadgeOk
                          : candidate.status === "duplicate"
                            ? styles.feedHealthBadgeInfo
                            : styles.feedHealthBadgeError
                      }`}
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
                            <small>{item.publishedAt ? formatDate(item.publishedAt) : ""}</small>
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

function emptyFeedDraft(): FeedDraft {
  return {
    title: "",
    feedUrl: "",
    folderId: UNGROUPED_FOLDER_VALUE,
    enabled: true,
    fullContentMode: "feed_only",
    sourceWeight: "0"
  };
}

function countFeedsByFolder(feeds: Feed[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const feed of feeds) {
    if (feed.folderId) {
      counts.set(feed.folderId, (counts.get(feed.folderId) ?? 0) + 1);
    }
  }
  return counts;
}

function folderLabel(
  feed: Feed,
  folderById: Map<string, FeedFolder>,
  ungroupedLabel: string
): string {
  return feed.folderId ? folderById.get(feed.folderId)?.title ?? ungroupedLabel : ungroupedLabel;
}

function matchesDiagnosticFilter(
  feed: Feed,
  diagnostic: FeedDiagnosticItem["diagnostic"] | null | undefined,
  filter: FeedDiagnosticFilter
): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "disabled") {
    return diagnostic?.status === "disabled" || !feed.enabled;
  }
  if (filter === "neverFetched") {
    return diagnostic?.status === "never_fetched" || feed.lastSuccessAt === null;
  }
  return (
    diagnostic?.severity === "error" ||
    diagnostic?.severity === "warning" ||
    diagnostic?.status === "due" ||
    diagnostic?.status === "never_fetched"
  );
}

function feedHealthBadgeClass(
  severity: FeedDiagnosticItem["diagnostic"]["severity"],
  styleMap: typeof styles
): string {
  if (severity === "error") {
    return styleMap.feedHealthBadgeError;
  }
  if (severity === "warning") {
    return styleMap.feedHealthBadgeWarning;
  }
  if (severity === "disabled") {
    return styleMap.feedHealthBadgeDisabled;
  }
  if (severity === "info") {
    return styleMap.feedHealthBadgeInfo;
  }
  return styleMap.feedHealthBadgeOk;
}

function feedDiagnosticMessage(
  diagnostic: FeedDiagnosticItem["diagnostic"],
  messages: Record<string, string>
): string {
  return messages[diagnostic.code] ?? diagnostic.message;
}

function ManagementEmptyState(props: { title: string; body: string }) {
  return (
    <div className={styles.emptyState}>
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </div>
  );
}

function SkeletonRows(props: { count: number }) {
  return (
    <div className={styles.skeletonStack} aria-hidden="true">
      {Array.from({ length: props.count }).map((_, index) => (
        <span className={styles.skeletonRow} key={index} />
      ))}
    </div>
  );
}
