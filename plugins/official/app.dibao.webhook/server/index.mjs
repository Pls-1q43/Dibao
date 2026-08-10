import { randomUUID } from "node:crypto";

const PLUGIN_ID = "app.dibao.webhook";
const RULES_KEY = "rules";
const EVENTS = [
  "article.created",
  "article.updated",
  "article.actionRecorded",
  "feed.refreshCompleted",
  "ranking.afterRanked",
  "settings.afterUpdated",
  "plugin.taskSucceeded",
  "plugin.taskFailed",
  "dailyBrief.generated"
];
const ARTICLE_ACTIONS = [
  "impression",
  "open",
  "mark_read",
  "mark_unread",
  "favorite",
  "unfavorite",
  "like",
  "unlike",
  "read_later",
  "remove_read_later",
  "hide",
  "not_interested",
  "read_progress"
];
const OPERATORS = new Set(["equals", "contains", "exists"]);
const METHODS = new Set(["GET", "POST"]);

export default {
  activate(ctx) {
    for (const eventName of EVENTS) {
      ctx.hooks.on(eventName, async (event) => {
        await handleEvent(ctx, eventName, event);
      });
    }

    ctx.api.get("/state", () => state(ctx));

    ctx.api.post("/rules", async ({ body }) => {
      const current = await readRules(ctx);
      const rule = normalizeRule(body, { replaceDraftId: true });
      await writeRules(ctx, [rule, ...current]);
      return await state(ctx);
    });

    ctx.api.post("/rules/:id", async ({ params, body }) => {
      const current = await readRules(ctx);
      const existing = current.find((rule) => rule.id === params.id);
      if (!existing) {
        throw httpError(404, "Webhook rule not found");
      }
      const next = normalizeRule({ ...existing, ...objectValue(body), id: existing.id });
      await writeRules(ctx, current.map((rule) => rule.id === existing.id ? next : rule));
      return await state(ctx);
    });

    ctx.api.post("/rules/:id/test", async ({ params, body }) => {
      const rule = (await readRules(ctx)).find((candidate) => candidate.id === params.id);
      if (!rule) {
        throw httpError(404, "Webhook rule not found");
      }
      const input = objectValue(body);
      const eventName = stringValue(input.eventName) || rule.eventName;
      const event = objectValue(input.event);
      const delivery = await dispatchRule(ctx, rule, eventName, {
        ...sampleEvent(eventName),
        ...event,
        test: true
      }, { force: true, test: true });
      const completedDelivery = delivery ? await ctx.deliveries.flush(delivery.id) : delivery;
      return { delivery: completedDelivery, state: await state(ctx) };
    });

    ctx.api.post("/rules/:id/delete", async ({ params }) => {
      await writeRules(ctx, (await readRules(ctx)).filter((rule) => rule.id !== params.id));
      return await state(ctx);
    });

    ctx.api.post("/secrets/:key", async ({ params, body }) => {
      const input = objectValue(body);
      const value = typeof input.value === "string" ? input.value : "";
      if (!value) {
        throw httpError(400, "Secret value is required");
      }
      return {
        secret: await ctx.secrets.set(params.key, value, nullableString(input.hint)),
        state: await state(ctx)
      };
    });

    ctx.api.post("/secrets/:key/delete", async ({ params }) => {
      await ctx.secrets.delete(params.key);
      return await state(ctx);
    });
  }
};

async function handleEvent(ctx, eventName, event) {
  for (const rule of await readRules(ctx)) {
    if (!rule.enabled || rule.eventName !== eventName) {
      continue;
    }
    const context = await buildContext(ctx, rule, eventName, event);
    if (matchesConditions(rule.conditions, context)) {
      await dispatchRuleWithContext(ctx, rule, context, {});
    }
  }
}

async function dispatchRule(ctx, rule, eventName, event, options = {}) {
  const context = await buildContext(ctx, rule, eventName, event, options);
  if (!options.force && !matchesConditions(rule.conditions, context)) {
    return null;
  }
  return await dispatchRuleWithContext(ctx, rule, context, options);
}

async function dispatchRuleWithContext(ctx, rule, context, options = {}) {
  const renderedUrl = renderString(rule.urlTemplate, context);
  if (!renderedUrl) {
    throw httpError(400, "Webhook URL is required");
  }
  const generatedAt = context.generatedAt;
  const basePayload = {
    eventName: context.eventName,
    event: context.event,
    article: context.article,
    generatedAt,
    ruleId: rule.id
  };
  const headers = renderHeaders(rule.headers, context);
  const secretHeaders = normalizeSecretHeaders(rule.secretHeaders);
  const request = {
    method: rule.method,
    url: rule.method === "GET"
      ? mergeQuery(renderedUrl, renderTemplate(rule.queryTemplate, context, { fallback: {} }))
      : renderedUrl,
    headers,
    secretHeaders,
    body: rule.method === "POST"
      ? renderTemplate(rule.bodyTemplate, context, { fallback: basePayload })
      : null,
    maxAttempts: options.test ? 1 : 5
  };
  const idempotencyKey = deliveryIdempotencyKey(rule, context, options);
  if (idempotencyKey) {
    request.idempotencyKey = idempotencyKey;
  }
  return await ctx.deliveries.enqueue(request);
}

async function buildContext(ctx, rule, eventName, event, options = {}) {
  const eventObject = objectValue(event);
  const articleId = stringValue(eventObject.articleId);
  const includeContent = rule.includeContent === true;
  const article = articleId
    ? await ctx.articles.snapshot(articleId, { includeContent })
    : null;
  return {
    pluginId: PLUGIN_ID,
    ruleId: rule.id,
    eventName,
    event: eventObject,
    article,
    feed: article?.feed ?? (eventObject.feedId ? { id: eventObject.feedId } : null),
    generatedAt: await ctx.now(),
    test: options.test === true
  };
}

async function readRules(ctx) {
  const value = await ctx.storage.get(RULES_KEY);
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value.map(normalizeRule).filter((rule) => rule.urlTemplate);
  const deduped = dedupeRules(normalized);
  let repairedDraftId = false;
  const repaired = deduped.map((rule) => {
    if (!rule.id.startsWith("draft_")) {
      return rule;
    }
    repairedDraftId = true;
    return { ...rule, id: `rule_${randomUUID()}` };
  });
  if (repairedDraftId || deduped.length !== normalized.length) {
    await ctx.storage.set(RULES_KEY, repaired.map(normalizeRule));
  }
  return repaired;
}

async function writeRules(ctx, rules) {
  await ctx.storage.set(RULES_KEY, dedupeRules(rules.map(normalizeRule)));
}

async function state(ctx) {
  const available = typeof ctx.events.catalog === "function" ? await ctx.events.catalog() : EVENTS;
  const locale = await currentLocale(ctx);
  const catalog = buildEventCatalog(locale);
  const copy = eventCatalogCopy(locale);
  return {
    pluginId: PLUGIN_ID,
    rules: await readRules(ctx),
    secrets: await ctx.secrets.list(),
    deliveries: await ctx.deliveries.list({ limit: 50 }),
    events: EVENTS
      .filter((eventName) => available.includes(eventName))
      .map((eventName) => catalog[eventName] ?? eventMetadata(eventName, eventName, copy.stableEvent, [], [], copy)),
    generatedAt: await ctx.now()
  };
}

async function currentLocale(ctx) {
  if (ctx?.i18n && typeof ctx.i18n.getLocale === "function") {
    const locale = await ctx.i18n.getLocale();
    if (locale) return locale;
  }
  return typeof ctx?.locale === "string" && ctx.locale ? ctx.locale : "zh-CN";
}

function normalizeRule(input, options = {}) {
  const record = objectValue(input);
  const method = stringValue(record.method).toUpperCase();
  const eventName = stringValue(record.eventName);
  const inputId = stringValue(record.id);
  const id = !inputId || (options.replaceDraftId && inputId.startsWith("draft_")) ? `rule_${randomUUID()}` : inputId;
  return {
    id,
    name: stringValue(record.name) || "Untitled rule",
    enabled: record.enabled !== false,
    eventName: EVENTS.includes(eventName) ? eventName : EVENTS[0],
    conditions: normalizeConditions(record.conditions),
    method: METHODS.has(method) ? method : "POST",
    urlTemplate: stringValue(record.urlTemplate),
    queryTemplate: plainObject(record.queryTemplate),
    bodyTemplate: plainObject(record.bodyTemplate),
    headers: stringRecord(record.headers),
    secretHeaders: normalizeSecretHeaders(record.secretHeaders),
    includeContent: record.includeContent === true,
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now()
  };
}

function dedupeRules(rules) {
  const seen = new Set();
  return rules.filter((rule) => {
    if (!rule?.id || seen.has(rule.id)) {
      return false;
    }
    seen.add(rule.id);
    return true;
  });
}

function normalizeConditions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((condition) => {
      const record = objectValue(condition);
      const path = stringValue(record.path);
      const operator = stringValue(record.operator);
      if (!path || !OPERATORS.has(operator)) {
        return null;
      }
      return {
        path,
        operator,
        value: record.value ?? ""
      };
    })
    .filter(Boolean);
}

function matchesConditions(conditions, context) {
  for (const condition of conditions) {
    const value = getPath(context, condition.path);
    if (condition.operator === "exists") {
      if (value === null || value === undefined || value === "") {
        return false;
      }
      continue;
    }
    if (condition.operator === "equals") {
      if (String(value ?? "") !== String(condition.value ?? "")) {
        return false;
      }
      continue;
    }
    if (condition.operator === "contains") {
      if (Array.isArray(value)) {
        if (!value.map((item) => String(item)).includes(String(condition.value ?? ""))) {
          return false;
        }
      } else if (!String(value ?? "").includes(String(condition.value ?? ""))) {
        return false;
      }
    }
  }
  return true;
}

function renderTemplate(template, context, options = {}) {
  const hasTemplate = template && typeof template === "object" && !Array.isArray(template) && Object.keys(template).length > 0;
  if (!hasTemplate) {
    return options.fallback ?? {};
  }
  return renderValue(template, context);
}

function renderValue(value, context) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/u);
    if (exact) {
      return getPath(context, exact[1]) ?? "";
    }
    return renderString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, context)])
    );
  }
  return value;
}

function renderString(value, context) {
  return String(value ?? "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/gu, (_match, path) => {
    const resolved = getPath(context, path);
    if (resolved === null || resolved === undefined) {
      return "";
    }
    if (typeof resolved === "object") {
      return JSON.stringify(resolved);
    }
    return String(resolved);
  });
}

function renderHeaders(headers, context) {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key, renderString(value, context)])
      .filter(([key]) => key)
  );
}

function mergeQuery(urlText, query) {
  const url = new URL(urlText);
  for (const [key, value] of Object.entries(plainObject(query))) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function getPath(input, path) {
  let value = input;
  for (const part of String(path).split(".")) {
    if (!part) {
      return undefined;
    }
    if (value && typeof value === "object" && Object.hasOwn(value, part)) {
      value = value[part];
    } else {
      return undefined;
    }
  }
  return value;
}

function deliveryIdempotencyKey(rule, context, options) {
  if (options.test) {
    return null;
  }
  const event = context.event;
  const stableId = stringValue(event.id) || stringValue(event.eventId) || stringValue(event.jobId) || stringValue(event.articleId);
  if (!stableId) {
    return null;
  }
  return `${rule.id}:${context.eventName}:${stableId}:${stringValue(event.action)}`;
}

function sampleEvent(eventName) {
  const now = Date.now();
  if (eventName === "article.actionRecorded") {
    return { articleId: "article_recent", feedId: "feed_design", action: "favorite", emittedAt: now };
  }
  if (eventName === "article.created") {
    return { articleId: "article_recent", feedId: "feed_design", createdAt: now };
  }
  if (eventName === "article.updated") {
    return { articleId: "article_recent", feedId: "feed_design", updatedAt: now };
  }
  if (eventName.startsWith("article.")) {
    return { articleId: "article_recommended", feedId: "feed_design", emittedAt: now };
  }
  if (eventName === "feed.refreshCompleted") {
    return { feedId: "feed_design", articleIds: ["article_recent"], articlesSeen: 12, refreshedAt: now };
  }
  if (eventName === "ranking.afterRanked") {
    return { articleIds: ["article_recent"], candidateCount: 120, rankedCount: 30, finishedAt: now };
  }
  if (eventName === "settings.afterUpdated") {
    return { scope: "reader", keys: ["density"], updatedAt: now };
  }
  if (eventName === "plugin.taskSucceeded") {
    return { pluginId: "app.dibao.example", taskId: "task.example", finishedAt: now };
  }
  if (eventName === "plugin.taskFailed") {
    return { pluginId: "app.dibao.example", taskId: "task.example", error: "timeout", finishedAt: now };
  }
  if (eventName === "dailyBrief.generated") {
    return { briefId: "brief_today", articleIds: ["article_recent"], generatedAt: now };
  }
  return { emittedAt: now };
}

function eventCatalogCopy(locale) {
  const catalogs = {
    "zh-CN": {
      stableEvent: "稳定插件事件。",
      articleId: "文章 ID",
      feedId: "订阅源 ID",
      articleTitle: "文章标题",
      articleUrl: "文章原文链接",
      feedTitle: "订阅源标题",
      articleSummary: "文章摘要",
      eventArticleId: "触发事件里的文章 ID",
      eventFeedId: "触发事件里的订阅源 ID",
      articleContentText: "文章正文纯文本。需要勾选发送全文。",
      articleContentHtml: "文章 HTML 正文。需要勾选发送全文。",
      articleCreatedTitle: "文章创建",
      articleCreatedDescription: "有新文章进入邸报时触发，适合把新内容同步到外部系统。",
      createdAt: "创建时间戳",
      articleCreatedAt: "文章创建时间戳",
      articleUpdatedTitle: "文章更新",
      articleUpdatedDescription: "文章元数据或正文更新时触发。",
      updatedAt: "更新时间戳",
      articleUpdatedAt: "文章更新时间戳",
      articleActionTitle: "文章行为",
      articleActionDescription: "用户对文章产生阅读、收藏、点赞、隐藏等行为时触发。",
      actionType: "行为类型",
      readingProgress: "阅读进度，部分行为才有",
      actionTypeExample: "行为类型，例如 favorite、open、hide。",
      readingProgressExample: "阅读进度，read_progress 行为可能提供。",
      feedRefreshTitle: "订阅源刷新完成",
      feedRefreshDescription: "一个订阅源刷新完成后触发，可用于通知外部系统本次刷新结果。",
      articlesSeen: "本次看到的文章数",
      refreshArticleIds: "本次刷新涉及的文章 ID 列表",
      refreshedAt: "刷新完成时间戳",
      feedIdMaybeSnapshot: "订阅源 ID。如果事件绑定文章，也可能来自文章快照。",
      rankingTitle: "推荐排序完成",
      rankingDescription: "推荐排序完成后触发，适合把排序运行状态发送给外部自动化。",
      candidateCount: "候选文章数",
      rankedCount: "排序后文章数",
      rankedArticleIds: "排序文章 ID 列表",
      rankingFinishedAt: "排序完成时间戳",
      settingsTitle: "设置更新",
      settingsDescription: "核心设置被更新后触发。",
      settingsScope: "设置范围",
      settingsKeys: "更新的设置键",
      settingsKeysList: "更新的设置键列表",
      pluginTaskSucceededTitle: "插件任务成功",
      pluginTaskSucceededDescription: "插件后台任务成功结束时触发。",
      pluginTaskFailedTitle: "插件任务失败",
      pluginTaskFailedDescription: "插件后台任务失败时触发。",
      pluginId: "插件 ID",
      taskId: "任务 ID",
      finishedAt: "完成时间戳",
      errorSummary: "错误摘要",
      dailyBriefTitle: "每日简报生成",
      dailyBriefDescription: "每日简报生成完成后触发。",
      briefId: "简报 ID",
      briefArticleIds: "简报文章 ID 列表",
      generatedAt: "生成时间戳",
      eventName: "事件名称",
      webhookGeneratedAt: "Webhook 规则处理时间",
      currentRuleId: "当前规则 ID",
      eventSnapshot: "完整事件对象快照",
      isTestSend: "是否为测试发送"
    },
    "en-US": {
      stableEvent: "Stable plugin event.",
      articleId: "Article ID",
      feedId: "Feed ID",
      articleTitle: "Article title",
      articleUrl: "Original article URL",
      feedTitle: "Feed title",
      articleSummary: "Article summary",
      eventArticleId: "Article ID from the trigger event",
      eventFeedId: "Feed ID from the trigger event",
      articleContentText: "Plain-text article body. Requires Send full content.",
      articleContentHtml: "HTML article body. Requires Send full content.",
      articleCreatedTitle: "Article created",
      articleCreatedDescription: "Triggered when a new article enters Dibao. Useful for syncing new content to external systems.",
      createdAt: "Created timestamp",
      articleCreatedAt: "Article creation timestamp",
      articleUpdatedTitle: "Article updated",
      articleUpdatedDescription: "Triggered when article metadata or content is updated.",
      updatedAt: "Updated timestamp",
      articleUpdatedAt: "Article update timestamp",
      articleActionTitle: "Article action",
      articleActionDescription: "Triggered when the user reads, favorites, likes, hides, or otherwise acts on an article.",
      actionType: "Action type",
      readingProgress: "Reading progress, available for some actions",
      actionTypeExample: "Action type, for example favorite, open, or hide.",
      readingProgressExample: "Reading progress, available for read_progress actions.",
      feedRefreshTitle: "Feed refresh completed",
      feedRefreshDescription: "Triggered after a feed refresh completes. Useful for notifying external systems about the refresh result.",
      articlesSeen: "Articles seen in this refresh",
      refreshArticleIds: "Article IDs touched by this refresh",
      refreshedAt: "Refresh completion timestamp",
      feedIdMaybeSnapshot: "Feed ID. If the event is tied to an article, it may also come from the article snapshot.",
      rankingTitle: "Recommendation ranking completed",
      rankingDescription: "Triggered after recommendation ranking completes. Useful for sending ranking run status to external automation.",
      candidateCount: "Candidate article count",
      rankedCount: "Ranked article count",
      rankedArticleIds: "Ranked article ID list",
      rankingFinishedAt: "Ranking completion timestamp",
      settingsTitle: "Settings updated",
      settingsDescription: "Triggered after core settings are updated.",
      settingsScope: "Settings scope",
      settingsKeys: "Updated setting keys",
      settingsKeysList: "Updated setting key list",
      pluginTaskSucceededTitle: "Plugin task succeeded",
      pluginTaskSucceededDescription: "Triggered when a plugin background task finishes successfully.",
      pluginTaskFailedTitle: "Plugin task failed",
      pluginTaskFailedDescription: "Triggered when a plugin background task fails.",
      pluginId: "Plugin ID",
      taskId: "Task ID",
      finishedAt: "Finished timestamp",
      errorSummary: "Error summary",
      dailyBriefTitle: "Daily Brief generated",
      dailyBriefDescription: "Triggered after a Daily Brief finishes generating.",
      briefId: "Brief ID",
      briefArticleIds: "Brief article ID list",
      generatedAt: "Generated timestamp",
      eventName: "Event name",
      webhookGeneratedAt: "Webhook rule processing time",
      currentRuleId: "Current rule ID",
      eventSnapshot: "Full event object snapshot",
      isTestSend: "Whether this is a test send"
    },
    "ja-JP": {
      stableEvent: "安定したプラグインイベントです。",
      articleId: "記事 ID",
      feedId: "フィード ID",
      articleTitle: "記事タイトル",
      articleUrl: "記事の原文 URL",
      feedTitle: "フィードタイトル",
      articleSummary: "記事概要",
      eventArticleId: "トリガーイベント内の記事 ID",
      eventFeedId: "トリガーイベント内のフィード ID",
      articleContentText: "記事本文のプレーンテキスト。全文送信を有効にする必要があります。",
      articleContentHtml: "記事本文の HTML。全文送信を有効にする必要があります。",
      articleCreatedTitle: "記事作成",
      articleCreatedDescription: "新しい記事が Dibao に入ったときに発火します。外部システムへの新着同期に適しています。",
      createdAt: "作成タイムスタンプ",
      articleCreatedAt: "記事作成タイムスタンプ",
      articleUpdatedTitle: "記事更新",
      articleUpdatedDescription: "記事メタデータまたは本文が更新されたときに発火します。",
      updatedAt: "更新タイムスタンプ",
      articleUpdatedAt: "記事更新タイムスタンプ",
      articleActionTitle: "記事アクション",
      articleActionDescription: "ユーザーが記事を読む、お気に入り、いいね、非表示などの操作をしたときに発火します。",
      actionType: "アクション種別",
      readingProgress: "読書進捗。一部のアクションのみ",
      actionTypeExample: "favorite、open、hide などのアクション種別。",
      readingProgressExample: "read_progress アクションで提供される場合がある読書進捗。",
      feedRefreshTitle: "フィード更新完了",
      feedRefreshDescription: "フィード更新が完了した後に発火します。更新結果を外部システムへ通知する用途に使えます。",
      articlesSeen: "今回確認した記事数",
      refreshArticleIds: "今回の更新に関係する記事 ID リスト",
      refreshedAt: "更新完了タイムスタンプ",
      feedIdMaybeSnapshot: "フィード ID。イベントが記事に紐づく場合は記事スナップショット由来の場合もあります。",
      rankingTitle: "おすすめランキング完了",
      rankingDescription: "おすすめランキング完了後に発火します。ランキング実行状態を外部自動化へ送る用途に適しています。",
      candidateCount: "候補記事数",
      rankedCount: "ランキング済み記事数",
      rankedArticleIds: "ランキング記事 ID リスト",
      rankingFinishedAt: "ランキング完了タイムスタンプ",
      settingsTitle: "設定更新",
      settingsDescription: "コア設定が更新された後に発火します。",
      settingsScope: "設定スコープ",
      settingsKeys: "更新された設定キー",
      settingsKeysList: "更新された設定キーリスト",
      pluginTaskSucceededTitle: "プラグインタスク成功",
      pluginTaskSucceededDescription: "プラグインのバックグラウンドタスクが成功終了したときに発火します。",
      pluginTaskFailedTitle: "プラグインタスク失敗",
      pluginTaskFailedDescription: "プラグインのバックグラウンドタスクが失敗したときに発火します。",
      pluginId: "プラグイン ID",
      taskId: "タスク ID",
      finishedAt: "完了タイムスタンプ",
      errorSummary: "エラー概要",
      dailyBriefTitle: "デイリーブリーフ生成",
      dailyBriefDescription: "デイリーブリーフ生成完了後に発火します。",
      briefId: "ブリーフ ID",
      briefArticleIds: "ブリーフ記事 ID リスト",
      generatedAt: "生成タイムスタンプ",
      eventName: "イベント名",
      webhookGeneratedAt: "Webhook ルール処理時刻",
      currentRuleId: "現在のルール ID",
      eventSnapshot: "完全なイベント object snapshot",
      isTestSend: "テスト送信かどうか"
    }
  };
  if (typeof locale === "string" && catalogs[locale]) {
    return catalogs[locale];
  }
  const language = typeof locale === "string" ? locale.split("-")[0] : "";
  if (language === "en") return catalogs["en-US"];
  if (language === "ja") return catalogs["ja-JP"];
  return catalogs["zh-CN"];
}

function buildEventCatalog(locale = "zh-CN") {
  const copy = eventCatalogCopy(locale);
  const meta = (name, title, description, fields, variables) =>
    eventMetadata(name, title, description, fields, variables, copy);
  const articleFields = [
    field("event.articleId", copy.articleId, "article_recent"),
    field("event.feedId", copy.feedId, "feed_design"),
    field("article.title", copy.articleTitle, "Dense reader interfaces"),
    field("article.url", copy.articleUrl, "https://example.com/article"),
    field("article.feed.title", copy.feedTitle, "Design Systems Weekly"),
    field("article.summary", copy.articleSummary, "Reader density without visual clutter.")
  ];
  const articleVariables = [
    variable("event.articleId", copy.eventArticleId, "article_recent"),
    variable("event.feedId", copy.eventFeedId, "feed_design"),
    variable("article.title", copy.articleTitle, "Dense reader interfaces"),
    variable("article.url", copy.articleUrl, "https://example.com/article"),
    variable("article.feed.title", copy.feedTitle, "Design Systems Weekly"),
    variable("article.summary", copy.articleSummary, "Reader density without visual clutter."),
    variable("article.contentText", copy.articleContentText, "Reader density without visual clutter."),
    variable("article.contentHtml", copy.articleContentHtml, "<p>Reader density...</p>")
  ];
  return Object.fromEntries([
    meta(
      "article.created",
      copy.articleCreatedTitle,
      copy.articleCreatedDescription,
      [...articleFields, field("event.createdAt", copy.createdAt, "1717000000000")],
      [...articleVariables, variable("event.createdAt", copy.articleCreatedAt, "1717000000000")]
    ),
    meta(
      "article.updated",
      copy.articleUpdatedTitle,
      copy.articleUpdatedDescription,
      [...articleFields, field("event.updatedAt", copy.updatedAt, "1717000000000")],
      [...articleVariables, variable("event.updatedAt", copy.articleUpdatedAt, "1717000000000")]
    ),
    meta(
      "article.actionRecorded",
      copy.articleActionTitle,
      copy.articleActionDescription,
      [
        ...articleFields,
        field("event.action", copy.actionType, "favorite", ARTICLE_ACTIONS),
        field("event.progress", copy.readingProgress, "0.6")
      ],
      [
        ...articleVariables,
        variable("event.action", copy.actionTypeExample, "favorite", ARTICLE_ACTIONS),
        variable("event.progress", copy.readingProgressExample, "0.6")
      ]
    ),
    meta(
      "feed.refreshCompleted",
      copy.feedRefreshTitle,
      copy.feedRefreshDescription,
      [
        field("event.feedId", copy.feedId, "feed_design"),
        field("event.articlesSeen", copy.articlesSeen, "12"),
        field("event.articleIds", copy.refreshArticleIds, "article_recent"),
        field("event.refreshedAt", copy.refreshedAt, "1717000000000")
      ],
      [
        variable("event.feedId", copy.feedId, "feed_design"),
        variable("feed.id", copy.feedIdMaybeSnapshot, "feed_design"),
        variable("event.articlesSeen", copy.articlesSeen, "12"),
        variable("event.articleIds", copy.refreshArticleIds, "[\"article_recent\"]"),
        variable("event.refreshedAt", copy.refreshedAt, "1717000000000")
      ]
    ),
    meta(
      "ranking.afterRanked",
      copy.rankingTitle,
      copy.rankingDescription,
      [
        field("event.candidateCount", copy.candidateCount, "120"),
        field("event.rankedCount", copy.rankedCount, "30"),
        field("event.articleIds", copy.rankedArticleIds, "article_recent")
      ],
      [
        variable("event.candidateCount", copy.candidateCount, "120"),
        variable("event.rankedCount", copy.rankedCount, "30"),
        variable("event.articleIds", copy.rankedArticleIds, "[\"article_recent\"]"),
        variable("event.finishedAt", copy.rankingFinishedAt, "1717000000000")
      ]
    ),
    meta(
      "settings.afterUpdated",
      copy.settingsTitle,
      copy.settingsDescription,
      [
        field("event.scope", copy.settingsScope, "reader"),
        field("event.keys", copy.settingsKeys, "density"),
        field("event.updatedAt", copy.updatedAt, "1717000000000")
      ],
      [
        variable("event.scope", copy.settingsScope, "reader"),
        variable("event.keys", copy.settingsKeysList, "[\"density\"]"),
        variable("event.updatedAt", copy.updatedAt, "1717000000000")
      ]
    ),
    meta(
      "plugin.taskSucceeded",
      copy.pluginTaskSucceededTitle,
      copy.pluginTaskSucceededDescription,
      [
        field("event.pluginId", copy.pluginId, "app.dibao.example"),
        field("event.taskId", copy.taskId, "task.example"),
        field("event.finishedAt", copy.finishedAt, "1717000000000")
      ],
      [
        variable("event.pluginId", copy.pluginId, "app.dibao.example"),
        variable("event.taskId", copy.taskId, "task.example"),
        variable("event.finishedAt", copy.finishedAt, "1717000000000")
      ]
    ),
    meta(
      "plugin.taskFailed",
      copy.pluginTaskFailedTitle,
      copy.pluginTaskFailedDescription,
      [
        field("event.pluginId", copy.pluginId, "app.dibao.example"),
        field("event.taskId", copy.taskId, "task.example"),
        field("event.error", copy.errorSummary, "timeout")
      ],
      [
        variable("event.pluginId", copy.pluginId, "app.dibao.example"),
        variable("event.taskId", copy.taskId, "task.example"),
        variable("event.error", copy.errorSummary, "timeout"),
        variable("event.finishedAt", copy.finishedAt, "1717000000000")
      ]
    ),
    meta(
      "dailyBrief.generated",
      copy.dailyBriefTitle,
      copy.dailyBriefDescription,
      [
        field("event.briefId", copy.briefId, "brief_today"),
        field("event.articleIds", copy.briefArticleIds, "article_recent"),
        field("event.generatedAt", copy.generatedAt, "1717000000000")
      ],
      [
        variable("event.briefId", copy.briefId, "brief_today"),
        variable("event.articleIds", copy.briefArticleIds, "[\"article_recent\"]"),
        variable("event.generatedAt", copy.generatedAt, "1717000000000")
      ]
    )
  ].map((metadata) => [metadata.name, metadata]));
}

function eventMetadata(name, title, description, fields, variables, copy = eventCatalogCopy("zh-CN")) {
  const sample = sampleEvent(name);
  const commonVariables = [
    variable("eventName", copy.eventName, name),
    variable("generatedAt", copy.webhookGeneratedAt, "2026-06-06T08:00:00.000Z"),
    variable("ruleId", copy.currentRuleId, "rule_..."),
    variable("event", copy.eventSnapshot, JSON.stringify(sample)),
    variable("test", copy.isTestSend, "false")
  ];
  return {
    name,
    title,
    description,
    fields,
    variables: [...commonVariables, ...variables],
    sample
  };
}

function field(path, description, example, options = undefined) {
  return compactObject({ path, description, example, options });
}

function variable(path, description, example, options = undefined) {
  return compactObject({ path, description, example, options });
}

function compactObject(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function normalizeSecretHeaders(value) {
  const output = {};
  for (const [header, input] of Object.entries(plainObject(value))) {
    const record = objectValue(input);
    const key = stringValue(record.key);
    if (!header || !key) {
      continue;
    }
    output[header] = {
      key,
      prefix: typeof record.prefix === "string" ? record.prefix : ""
    };
  }
  return output;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectValue(value) {
  return plainObject(value);
}

function stringRecord(value) {
  return Object.fromEntries(
    Object.entries(plainObject(value))
      .map(([key, item]) => [stringValue(key), stringValue(item)])
      .filter(([key]) => key)
  );
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value) {
  const next = stringValue(value);
  return next || null;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = statusCode === 404 ? "NOT_FOUND" : "VALIDATION_ERROR";
  return error;
}
