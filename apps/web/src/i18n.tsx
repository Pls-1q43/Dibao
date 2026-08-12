import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

export const defaultLocale = "zh-CN";
export const supportedLocales = ["zh-CN", "en-US", "ja-JP"] as const;

export type Locale = (typeof supportedLocales)[number];

export const zhCN = {
  common: {
    brandMark: "邸",
    brandName: "邸报",
    brandSubtitle: "Dibao",
    close: "关闭",
    version: (version: string) => `v${version}`
  },
  navigation: {
    ariaLabel: "主导航",
    utilityMenuLabel: "更多",
    items: {
      latest: "最新",
      recommended: "推荐",
      favorites: "收藏",
      read_later: "稍后读",
      search: "搜索",
      feeds: "订阅源",
      settings: "设置"
    }
  },
  shell: {
    kicker: "RSS Ingestion",
    pageTitle: "最新文章",
    pageTitles: {
      latest: "最新文章",
      recommended: "推荐文章",
      favorites: "收藏文章",
      read_later: "稍后读"
    },
    pageKickers: {
      latest: "Latest",
      recommended: "For You",
      favorites: "Favorites",
      read_later: "Read Later"
    },
    loadingArticles: "正在加载文章",
    latestView: "最新视图",
    viewStatus: {
      latest: "最新视图",
      recommended: "推荐视图",
      favorites: "收藏视图",
      read_later: "稍后读视图"
    }
  },
  search: {
    kicker: "Search",
    pageTitle: "搜索",
    title: "搜索文章",
    body: "默认搜索标题和摘要；需要时可以启用全文搜索。",
    inputLabel: "关键词",
    inputPlaceholder: "搜索标题和摘要",
    relatedPrefix: "与此相关：",
    fullTextLabel: "搜索全文",
    submit: "搜索",
    submitting: "搜索中",
    sortLabel: "排序",
    sorts: {
      relevance: "相关性",
      recommended: "推荐优先",
      latest: "最新"
    },
    recommendedSortHint: "仅在搜索结果中按你的推荐模型排序。",
    relatedThresholdFooter: (threshold: string) =>
      `相关文章搜索仅筛选相似阈值>${threshold}的文章。`,
    stateLabel: "状态",
    advancedSearch: "高级搜索",
    hideAdvancedSearch: "收起高级搜索",
    sourceLabel: "来源",
    folderLabel: "分组",
    feedLabel: "订阅源",
    allSources: "全部来源",
    allFolders: "全部分组",
    allFeeds: "全部订阅源",
    dateFromLabel: "开始日期",
    dateToLabel: "结束日期",
    states: {
      all: "全部",
      unread: "未读",
      read: "已读",
      favorites: "收藏",
      read_later: "稍后读"
    },
    emptyTitle: "没有找到文章",
    emptyBody: "可以换一个关键词，或放宽来源、状态和时间筛选。",
    initialTitle: "搜索你的 RSS 文章库",
    initialBody: "输入关键词后，可以在标题、摘要和正文中查找。",
    resultsCount: (count: number) => `${count} 条结果`,
    loadMore: "加载更多"
  },
  auth: {
    loading: "正在检查登录状态",
    setupStatusLoading: "正在读取实例状态",
    retry: "重新检查",
    setupTitle: "设置用户名和访问密码",
    setupBody: "这是单用户自托管实例。设置用户名和访问密码后即可进入阅读器。",
    loginTitle: "登录邸报",
    loginBody: "输入用户名和访问密码继续。",
    usernameLabel: "用户名",
    usernamePlaceholder: "输入用户名",
    passwordLabel: "访问密码",
    passwordPlaceholder: "至少 8 个字符",
    setupSubmit: "完成设置",
    loginSubmit: "登录",
    submitting: "处理中",
    telemetryLabel: "反馈数据以帮助开发者更好地优化邸报",
    telemetryBody: "默认开启，仅用于错误诊断、性能分析和体验改进，可在设置中关闭。",
    logout: "退出",
    logoutTitle: "退出登录",
    usernameRequired: "请输入用户名。",
    passwordRequired: "请输入访问密码。",
    errors: {
      session: "无法读取登录状态。",
      setupStatus: "无法读取实例状态。",
      logout: "退出登录失败。"
    }
  },
  upgrade: {
    kicker: "版本升级",
    title: "正在重建推荐画像",
    body: "邸报正在修复旧版本产生的兴趣簇数据。完成前会暂停阅读界面，避免旧画像继续影响推荐。",
    failedBody: "推荐画像重建未完成。请重试，或查看服务日志后再继续。",
    progressLabel: "升级进度",
    costNote: "本次迁移只重建兴趣簇、主题组、标签和排序等派生数据；不会重建 Embedding，也不会产生额外 Embedding API 费用。",
    progress: (current: number, total: number, percent: number) =>
      total > 0 ? `${current} / ${total} 篇文章 · ${percent}%` : "正在准备数据",
    retry: "重试重建",
    retrying: "重试中",
    steps: {
      detecting: "检查需要修复的数据",
      schemaMigration: "更新数据库结构",
      reset: "清理旧的兴趣簇与家族",
      replay: "回放历史阅读信号",
      labels: "重建兴趣簇标签",
      families: "重建兴趣家族",
      ranking: "重算推荐排序",
      completed: "重建完成",
      failed: "重建失败",
      skipped: "无需重建"
    }
  },
  setup: {
    kicker: "首次设置",
    welcome: {
      title: "欢迎使用邸报",
      body: "一个自托管的个人 RSS 推荐阅读器。先完成几个必要步骤，再进入阅读界面。",
      start: "开始设置"
    },
    sources: {
      title: "添加订阅源",
      body: "导入 OPML 文件，或手动添加一个 RSS / Atom 源。至少需要一个订阅源才能继续。",
      importOpml: "导入 OPML 文件",
      addFeed: "添加订阅源",
      noFeedsAfterImport: "导入完成，但没有创建新的订阅源。请检查 OPML 文件或手动添加 RSS / Atom 地址。",
      noFeedsAfterAdd: "订阅源尚未创建成功，请重试。"
    },
    provider: {
      title: "推荐能力",
      body: "配置 embedding provider 后，邸报会用文章语义和你的阅读行为生成更贴近个人的信息流。",
      recommendationLink: "查看这里选择合适的（免费）Provider。",
      currentTitle: "跳过也是可选项",
      currentBody: "暂不配置时，邸报仍可阅读、收藏、稍后读，并使用基础排序。",
      saveAndTest: "保存配置并测试连接",
      enableAndContinue: "启用 Provider 并继续",
      useProviderAndContinue: "继续使用此 Provider",
      saving: "保存中",
      testRequired: "请先保存配置并通过连接测试，再启用 Provider。",
      testStale: "配置已修改，请重新测试连接后再启用。",
      continue: "跳过，使用基础排序"
    }
  },
  feeds: {
    kicker: "订阅源",
    title: "Feeds",
    inputLabel: "网站或 RSS / Atom URL",
    inputPlaceholder: "https://example.com 或 https://example.com/feed.xml",
    add: "添加",
    adding: "添加中",
    allFeeds: "全部订阅源",
    sourceCount: (count: number) => `${count} 个来源`,
    feedUrlRequired: "请输入网站或 RSS / Atom 地址。",
    successAt: (date: string) => `成功：${date}`,
    nextRefreshAt: (date: string) => `下次抓取：${date}`,
    refresh: "刷新",
    refreshing: "…",
    refreshAll: "刷新全部",
    refreshingAll: "加入队列中",
    openSources: "来源",
    openSourcesLabel: "打开来源",
    closeSources: "关闭来源",
    refreshTitle: (feedTitle: string) => `刷新 ${feedTitle}`
  },
  feedDiscovery: {
    inputLabel: "网站或 RSS / Atom URL",
    inputPlaceholder: "https://example.com 或 https://example.com/feed.xml",
    check: "检查",
    checking: "检查中",
    candidatesTitle: "发现的订阅源",
    noCandidatesTitle: "没有发现可用订阅源",
    noCandidatesBody: "可以尝试直接输入 RSS / Atom 地址，或确认网站是否声明了 feed。",
    addCandidate: "添加此源",
    addingCandidate: "添加中",
    duplicate: "已订阅",
    invalid: "不可用",
    valid: "可添加",
    statuses: {
      valid: "可添加",
      duplicate: "已订阅",
      invalid: "不可用"
    },
    recentItems: "最近文章",
    itemCount: (count: number) => `${count} 篇文章`,
    warningsTitle: "提示",
    errors: {
      urlRequired: "请输入网站或 RSS / Atom 地址。",
      discoverFailed: "订阅源检查失败，请稍后重试。"
    }
  },
  feedDiagnostics: {
    title: "订阅源健康",
    summary: (total: number, error: number, warning: number) =>
      `${total} 个订阅源 · ${error} 个异常 · ${warning} 个需要关注`,
    filters: {
      all: "全部",
      unhealthy: "只看异常",
      disabled: "已停用",
      neverFetched: "从未成功"
    },
    statuses: {
      healthy: "正常",
      never_fetched: "从未抓取",
      due: "待抓取",
      stale: "长时间未成功",
      failing: "抓取失败",
      disabled: "已停用"
    },
    fields: {
      lastFetchedAt: "最近抓取",
      lastSuccessAt: "最近成功",
      nextRefreshAt: "下次抓取",
      lastError: "最近错误"
    },
    messages: {
      OK: "订阅源抓取正常。",
      DISABLED: "订阅源已停用。",
      NEVER_FETCHED: "订阅源尚未抓取。",
      DUE: "订阅源已到抓取时间。",
      STALE: "订阅源超过 7 天没有成功抓取。",
      FETCH_FAILED: "最近抓取失败。"
    },
    retry: "重试刷新",
    noIssues: "没有异常订阅源。"
  },
  folders: {
    title: "分组",
    feedCount: (count: number) => `${count} 个订阅源`
  },
  feedManagement: {
    kicker: "Feed Management",
    pageTitle: "订阅源管理",
    loading: "正在加载订阅源",
    status: (feedCount: number, folderCount: number) =>
      `${feedCount} 个订阅源 · ${folderCount} 个分组`,
    na: "暂无",
    tabs: {
      label: "订阅源管理视图",
      feeds: "订阅源管理",
      folders: "订阅源分组管理"
    },
    folders: {
      kicker: "Folders",
      title: "分组",
      newLabel: "新建分组",
      newPlaceholder: "例如：科技",
      create: "创建",
      emptyTitle: "还没有分组",
      emptyBody: "创建分组后，可以把订阅源整理到一起。",
      managementHint: "在这里维护分组名称，或直接查看某个分组下的文章。",
      renameLabel: (title: string) => `重命名 ${title}`,
      confirmDelete: "确认删除",
      deleteHint: "删除分组不会删除订阅源，订阅源会移动到未分组。"
    },
    operations: {
      kicker: "Operations",
      title: "导入、导出与刷新"
    },
    feeds: {
      kicker: "Feeds",
      title: "订阅源",
      addFeed: "添加订阅源",
      emptyTitle: "还没有订阅源",
      emptyBody: "可以在阅读器侧栏添加 RSS / Atom 源，或导入 OPML。",
      ungrouped: "未分组",
      enabled: "已启用",
      disabled: "已禁用",
      weight: (value: number) => `权重 ${value}`,
      lastSuccess: (value: string) => `最近成功：${value}`,
      nextRefresh: (value: string) => `下次抓取：${value}`,
      confirmDelete: "确认删除",
      deleteHint: "删除订阅源不会物理删除历史文章，但它们不会继续出现在文章列表中。"
    },
    editor: {
      kicker: "Edit feed",
      titleLabel: "标题",
      feedUrlLabel: "Feed URL",
      folderLabel: "分组",
      enabledLabel: "启用订阅源",
      sourceWeightLabel: "来源权重",
      lastFetchedAt: "最近抓取",
      lastSuccessAt: "最近成功",
      nextRefreshAt: "下次抓取",
      lastError: "最近错误",
      emptyTitle: "选择一个订阅源",
      emptyBody: "选择后可以编辑标题、分组、启用状态和来源权重。"
    },
    fullContent: {
      label: "正文来源",
      modes: {
        feed_only: "使用 Feed 内容（默认）",
        fetch_full_content: "抓取网页全文"
      },
      feedOnlyHint: "适合大多数全文 RSS，速度快、稳定。",
      fetchHint: "适合只输出摘要的 RSS。可能失败，不会绕过付费墙。",
      preview: "预览全文抓取",
      backfill: "抓取当前 Feed 文章全文",
      backfilling: "抓取中",
      backfillConfirm:
        "将重新读取当前 RSS，并只对当前 RSS 中仍出现的文章尝试抓取网页全文。不会扫描这个订阅源的所有历史文章。",
      stats: {
        articlesSeen: "当前 RSS 文章数",
        attempted: "尝试",
        succeeded: "成功",
        failed: "失败",
        skipped: "跳过",
        changed: "内容发生变化",
        limited: "50 篇限制"
      },
      limited: "已限制为前 50 篇",
      notLimited: "未触发"
    },
    actions: {
      save: "保存",
      saving: "保存中",
      cancel: "取消",
      rename: "重命名",
      viewArticles: "查看文章",
      delete: "删除"
    },
    errors: {
      folderTitleRequired: "请输入分组名称。",
      feedTitleRequired: "请输入订阅源标题。",
      sourceWeight: "来源权重必须是 -1 到 1 之间的数字。"
    }
  },
  settings: {
    kicker: "Settings",
    pageTitle: "设置",
    loading: "正在加载设置",
    status: "设置已就绪",
    sections: {
      language: {
        title: "语言",
        body: "选择界面语言。设置保存后刷新页面仍会生效。",
        localeLabel: "界面语言",
        zhCN: "简体中文",
        enUS: "English",
        jaJP: "日本語",
        defaultHomeViewLabel: "首页默认打开",
        defaultHomeViewRecommended: "推荐",
        defaultHomeViewLatest: "最新"
      },
      account: {
        title: "账户安全",
        body: "修改当前访问密码。为了确认是本人操作，需要先输入当前密码。",
        currentPasswordLabel: "当前密码",
        newPasswordLabel: "新密码",
        confirmPasswordLabel: "确认新密码",
        currentPasswordPlaceholder: "输入当前访问密码",
        newPasswordPlaceholder: "至少 8 个字符",
        confirmPasswordPlaceholder: "再次输入新密码",
        submit: "修改密码",
        submitting: "修改中",
        saved: "访问密码已更新。",
        errors: {
          currentRequired: "请输入当前密码。",
          newRequired: "请输入新密码。",
          confirmRequired: "请再次输入新密码。",
          mismatch: "两次输入的新密码不一致。"
        }
      },
      behavior: {
        title: "行为记录",
        body: "控制列表浏览和稍后读队列中的自动行为记录。",
        algorithmTransparencyLink: "查看算法透明说明",
        markScrolledArticlesIgnored: "滚过未打开文章后，将其标记为已忽略并移出未读",
        removeReadLaterOnReadComplete: "稍后读中的文章读完后，自动移出稍后读",
        infiniteArticleLoading: "无限加载：滚动到列表底部时自动加载下一批文章",
        cocoonLevel: "信息茧房水平",
        cocoonLevelHint: "1 表示更开放、更分散、更探索；10 表示更贴合、更稳定、更少扰动。所有级别都只在订阅源内排序，并始终尊重去重和明确负反馈。",
        interestClusterLimits: {
          title: "兴趣簇上限",
          body: "兴趣簇并非越高越好。对于每日 Inbox 入站文章较少、订阅源比较集中的用户，更少的兴趣簇可能会带来更稳定的推荐效果。",
          embeddingCostHint:
            "提高兴趣簇上限主要增加本地排序和向量相似度计算开销，不会按比例增加外部 Embedding 调用。",
          performancePreset: "性能档",
          presets: [
            "低配 VPS：24 / 16 · 8 / 6",
            "中配 NAS：48 / 32 · 16 / 12",
            "高性能服务器或本地计算机：96 / 64 · 28 / 20"
          ],
          customPreset: "自定义",
          positiveLabel: "正向兴趣簇",
          negativeLabel: "负向兴趣簇",
          positiveFamilyLabel: "正向主题组",
          negativeFamilyLabel: "负向主题组",
          fieldHint:
            "兴趣簇用于精确匹配文章，主题组用于解释和多样性。主题组上限只限制成熟主题组，不会强行把零散簇塞进同一组。"
        }
      },
      telemetry: {
        title: "反馈遥测",
        body: "控制是否向开发者发送用于优化邸报的错误、性能和体验反馈数据。",
        enabledLabel: "反馈数据以帮助开发者更好地优化邸报",
        enabledBody: "默认开启。关闭后，前端和服务端会停止发送新的 Sentry 遥测事件。"
      },
      reader: {
        title: "阅读",
        body: "调整文章详情的阅读密度。修改会立即应用到当前阅读区域。",
        fontSize: "字号",
        lineHeight: "行高",
        paragraphGap: "段距",
        readerWidth: "阅读宽度"
      },
      retention: {
        title: "文章保留",
        body: "超过保留天数的文章会由后台清理；填 0 表示永久保留。收藏和稍后读可单独选择是否始终保留。",
        retentionDays: "保留天数",
        keepFavorites: "保留收藏文章",
        keepReadLater: "保留稍后读文章",
        enabled: "已开启",
        disabled: "已关闭",
        cleanupConfirm:
          "会删除超过期限的历史文章，且无法恢复。清理会进入后台队列，不会在保存设置时同步执行。确定继续吗？",
        mappingHint: "API 字段 retention.retentionDays 会保存到 storage key retention.articleDays。"
      },
      about: {
        title: "关于",
        body: "版本、作者与项目链接。",
        version: "当前版本",
        latestVersion: "最新版本",
        latestLoading: "正在检查最新版本",
        latestUnknown: "尚未检查",
        latestUnavailable: "GitHub 暂无 Release",
        latestCurrent: (version: string) => `已是最新：${version}`,
        latestUpdateAvailable: (version: string) => `发现新版本：${version}`,
        latestError: (message: string) => `检查失败：${message}`,
        latestCheckedAt: (value: string) => `上次检查：${value}`,
        latestNeverChecked: "尚无检查记录",
        checkRelease: "检查更新",
        checkingRelease: "检查中",
        releaseLink: "查看 Release",
        author: "作者",
        authorName: "评论尸",
        telemetryLabel: "反馈数据",
        telemetryBody: "控制是否向开发者发送用于优化邸报的错误、性能和体验反馈数据。",
        xAccount: "X 账号",
        blog: "作者博客",
        homepage: "项目主页",
        github: "项目 GitHub"
      },
      provider: {
        title: "智能能力",
        body: "配置 OpenAI-compatible、Gemini AI Studio 或 Ollama embedding provider。未配置或停用时，系统继续使用基础排序。",
        loading: "正在加载智能能力设置",
        providerLabel: "Provider",
        newProvider: "新建 embedding provider",
        typeLabel: "类型",
        openaiCompatible: "OpenAI-compatible",
        gemini: "Gemini AI Studio",
        ollama: "Ollama",
        nameLabel: "名称",
        baseUrlLabel: "Base URL",
        baseUrlPlaceholder: "https://api.example.com/v1",
        geminiBaseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta",
        ollamaBaseUrlPlaceholder: "http://127.0.0.1:11434",
        modelLabel: "模型",
        modelPlaceholder: "text-embedding-3-small",
        geminiModelPlaceholder: "gemini-embedding-001",
        ollamaModelPlaceholder: "nomic-embed-text",
        dimensionLabel: "维度",
        textMaxCharsLabel: "切片长度（字符）",
        requestsPerMinuteLabel: "QPM（每分钟 batch 请求）",
        requestsPerDayLabel: "QPD（每日 batch 请求）",
        unlimitedPlaceholder: "留空不限",
        apiKeyLabel: "API Key",
        apiKeyPlaceholder: "可选，按 endpoint 要求填写",
        apiKeyRetainPlaceholder: "留空则保留已保存密钥",
        ollamaApiKeyHint: "Ollama 本地 API 默认不需要 API key。",
        geminiApiKeyHint: "Gemini AI Studio 使用 x-goog-api-key 调用 Gemini embedding API。",
        modelHint: "警示：切换到不同模型族、维度或切片长度会创建新的向量空间，已有向量不会复用，新 index 需要重新生成向量后推荐语义能力才会恢复。",
        textMaxCharsHint: "警示：修改切片长度会让已有向量与新策略不一致；保存并设为当前 Provider 后会创建新的 active index，请重新索引/补齐向量。",
        ollamaTextMaxCharsHint: "中文内容建议不超过 4000 字符；如果 bge-m3 等模型仍提示超出上下文，请降到 3000。",
        rateLimitHint: "QPM/QPD 按 batch 请求计数；达到 QPM 会延后到下一分钟，达到 QPD 会暂停到本地时间第二天继续队列。留空表示不限制。",
        activateHint: "保存只会保存配置档；只有点击“设为当前 Provider”才会切换 embedding 生成、active index 和推荐使用的 Provider。",
        activeTitle: "当前生效 Provider",
        activeEmptyTitle: "当前未启用 Provider",
        activeBody: (name: string, model: string, dimension: number) =>
          `${name} · ${model} / ${dimension}`,
        activeEmptyBody: "系统会继续使用基础排序。请先保存配置档，再设为当前 Provider。",
        profileListLabel: "Provider 配置档",
        currentBadge: "当前",
        profileBadge: "配置档",
        qualityTierLabel: "质量档位",
        quality: {
          basic: "基础",
          recommended: "推荐",
          bestQuality: "高质量"
        },
        enabledStatus: "已启用",
        disabledStatus: "已停用",
        disabled: "暂未配置",
        lastTestSuccess: (value: string) => `连接测试成功：${value}`,
        lastTestFailed: (value: string) => `连接测试失败：${value}`,
        lastTestUnknown: "尚未测试连接。",
        save: "保存配置档",
        saving: "保存中",
        activate: "设为当前 Provider",
        activating: "切换中",
        activeActionCurrent: "已是当前 Provider",
        test: "测试连接",
        testing: "测试中",
        delete: "删除",
        deleting: "删除中",
        deleteHint: "已有 embedding index 的 provider 不能删除；不想继续使用时，请切换到另一个兼容 Provider。",
        indexesTitle: "Embedding indexes",
        connectionStatusTitle: "连接测试状态",
        embeddingJobStatusTitle: "Embedding job 状态",
        indexesBody: "Index 展示 coverage、队列和最近失败；连接测试与 embedding job 状态分开判断。",
        usageWindowLabel: "Embedding 用量窗口",
        usageWindows: {
          "24h": "24H",
          "7d": "7Days",
          "30d": "30Days"
        },
        usage: (itemCount: number, requestCount: number, estimatedTokens: number) =>
          `本地估算用量：${itemCount} 篇/input · ${requestCount} 次 batch 请求 · ${estimatedTokens} tokens`,
        noIndexes: "设为当前 Provider 后会创建 active index。",
        indexStatus: (model: string, status: string, count: number) =>
          `${model} · ${status} · ${count} 条 embedding`,
        coverage: (embeddingCount: number, candidateCount: number, ratio: string) =>
          `${embeddingCount} / ${candidateCount} · ${ratio}`,
        indexTotal: (count: number) => `索引总量：${count} 条 embedding`,
        coverageUnavailable: "Coverage 暂不可用",
        pendingJobs: (count: number) => `待处理 ${count}`,
        failedJobs: (count: number) => `失败 ${count}`,
        lastFailedAt: (value: string) => `最近失败：${value}`,
        lastError: (value: string) => `错误：${value}`,
        noJobFailures: "暂无 embedding job 失败。",
        rebuild: "重建向量索引",
        rebuilding: "已加入",
        backfill: "补齐缺失向量",
        backfilling: "已加入",
        notices: {
          saved: "Embedding provider 已保存。",
          activated: "当前 embedding provider 已切换。",
          tested: "连接测试成功。",
          deleted: "Embedding provider 已删除。",
          rebuildQueued: "Embedding index 重建已加入队列。",
          backfillQueued: "Embedding backfill 已加入队列。"
        },
        errors: {
          nameRequired: "请输入 provider 名称。",
          baseUrlRequired: "请输入 Base URL。",
          modelRequired: "请输入模型名称。",
          dimension: "维度必须是 1 到 20000 的整数。",
          textMaxChars: "切片长度必须是 1000 到 200000 的整数。",
          requestsPerMinute: "QPM 必须留空或填写正整数。",
          requestsPerDay: "QPD 必须留空或填写正整数。"
        }
      }
    },
    actions: {
      save: "保存设置",
      saving: "保存中"
    },
    notices: {
      saved: "设置已保存。"
    },
    errors: {
      invalidNumber: "请输入有效数字。",
      fontSize: "字号必须是 16 到 24。",
      lineHeight: "行高必须是 1.45 到 2.1。",
      paragraphGap: "段距必须是 0.6 到 1.6。",
      readerWidth: "阅读宽度必须是 560 到 860。",
      retentionDays: "保留天数必须是 0 到 3650 的整数，0 表示永久。",
      cocoonLevel: "信息茧房水平必须是 1 到 10 的整数。",
      maxPositiveInterestClusters: "正向兴趣簇上限必须是 8 到 192 之间的整数。",
      maxNegativeInterestClusters: "负向兴趣簇上限必须是 4 到 128 之间的整数。",
      maxPositiveInterestFamilies: "正向主题组上限必须是 2 到 64 之间的整数。",
      maxNegativeInterestFamilies: "负向主题组上限必须是 1 到 48 之间的整数。"
    },
    units: {
      px: "px",
      days: "天",
      level: "级"
    }
  },
  opml: {
    import: "导入 OPML",
    importing: "导入中",
    export: "导出 OPML",
    exporting: "导出中",
    importSummary: (feedsCreated: number, feedsSkipped: number, foldersCreated: number) =>
      `已导入 ${feedsCreated} 个订阅源，跳过 ${feedsSkipped} 个，新增 ${foldersCreated} 个分组。`,
    importErrors: (count: number) => `${count} 条导入项未完成。`
  },
  articles: {
    allSources: "全部来源",
    title: "Latest",
    views: {
      latest: "最新",
      recommended: "推荐",
      favorites: "收藏",
      read_later: "稍后读"
    },
    sort: {
      label: "排序",
      favorited_desc: "最近收藏",
      favorited_asc: "最早收藏",
      ranked: "个性化排序",
      read_later_desc: "最近加入",
      read_later_asc: "最早加入",
      published_desc: "最新发布",
      published_asc: "最早发布"
    },
    loadMore: "加载更多",
    loadingMore: "加载中",
    retryLoadMore: "重试加载",
    loadingSlow: "加载似乎比预期时间更长，邸报仍在继续读取。",
    emptyNoFeedsTitle: "还没有订阅源",
    emptyNoFeedsBody: "添加一个 RSS / Atom 源后，文章会出现在这里。",
    emptyNoArticlesTitle: "暂时没有文章",
    emptyNoArticlesBody: "可以刷新订阅源，或切换到全部来源查看。",
    emptyNoUnreadTitle: "暂时没有未读文章",
    emptyNoUnreadBody: "关闭只看未读，可以查看已读或已忽略文章。",
    unreadOnly: "只看未读",
    filters: {
      label: "文章筛选",
      timeWindowTitle: "选择文章时间范围",
      timeWindows: {
        all: "全部",
        "24h": "24H",
        "7d": "7 Days",
        "30d": "30 Days"
      },
      unreadTitle: "只看未读文章"
    },
    itemMeta: (date: string, feedTitle: string) => `${date} · ${feedTitle}`,
    state: {
      unseen: "新文章",
      ignored: "已忽略",
      opened: "已点进",
      reading: "阅读中",
      read: "读完",
      unread: "未读",
      favorited: "已收藏",
      liked: "已点赞",
      readLater: "稍后读"
    }
  },
  readerCommands: {
    markScopeRead: {
      unreadWithCount: (count: number) => `未读 ${count}`,
      toggleUnread: "只看未读",
      clear: "清账",
      clearForWindow: (window: string): string =>
        window === "all"
          ? "清账"
          : window === "24h"
            ? "清 24H 前"
            : window === "7d"
              ? "清 7Days 前"
              : "清 30Days 前",
      clearShort: "✓",
      clearTitle: "标记当前范围为已读",
      clearTitleForWindow: (window: string): string =>
        window === "all"
          ? "标记全部未读为已读"
          : `标记 ${
              window === "24h" ? "24H" : window === "7d" ? "7Days" : "30Days"
            } 前未读为已读`,
      confirmTitle: "清理未读",
      confirmBody: (count: number) => `将当前范围内 ${count} 篇未读文章标记为已读？`,
      confirmBodyForWindow: (count: number, window: string): string =>
        window === "all"
          ? `将全部 ${count} 篇未读文章标记为已读？`
          : `将 ${
              window === "24h" ? "24H" : window === "7d" ? "7Days" : "30Days"
            } 前的 ${count} 篇未读文章标记为已读？`,
      confirmBodyLoading: "正在计算当前清账范围内的未读文章数量…",
      confirmBodyUnknown: "将当前清账范围内的未读文章标记为已读？",
      confirmHint: "这不会清除收藏或稍后读，也不会作为推荐正反馈。",
      cancel: "取消",
      confirm: "标记已读",
      clearing: "清账中",
      cleared: (count: number) => `已将当前范围内 ${count} 篇文章标记为已读。`,
      nothingToClear: "当前范围没有未读文章。",
      error: "批量标记已读失败，请稍后重试。"
    }
  },
  algorithmTransparency: {
    kicker: "Personalization Details",
    pageTitle: "算法透明说明",
    status: "算法说明已就绪",
    backToSettings: "返回设置",
    noWarnings: "暂无警告",
    sections: {
      currentStatus: "当前推荐状态",
      currentClusters: "当前兴趣簇",
      topicFamilies: "主题组概览",
      maintenance: "算法状态维护",
      mergeCandidates: "可能重复的兴趣簇",
      labelLexicon: "标签词典",
      algorithmExplanation: "算法解释",
      terms: "先解释几个词",
      scoreTable: "行为积分表",
      rankingFlow: "排序流程图",
      channelRules: "频道排序规则",
      dataAndFallback: "本地数据与 fallback"
    },
    statusTones: {
      normal: "正常",
      warning: "警告",
      stopped: "停摆",
      disabled: "未启用"
    },
    statusTable: {
      module: "模块",
      status: "状态",
      summary: "说明"
    },
    fields: {
      provider: "Provider",
      index: "Index",
      coverage: "Coverage",
      behaviorCounts: "行为计数",
      clusters: "兴趣簇",
      lastUpdates: "最近更新",
      warnings: "Warnings",
      cocoon: "信息茧房水平",
      exploration: "探索",
      formula: "当前公式",
      automaticMaintenance: "自动维护",
      failureStates: "Fallback / 任务状态"
    },
    clusters: {
      empty: "还没有形成兴趣簇。继续点赞、收藏、稍后读或读完文章后，系统会自动生成。",
      generated:
        "兴趣簇不是系统预设的，而是根据你的行为自动生成和更新。标签来自本地关键词、代表文章和来源标题，也可以手动重命名。",
      positive: "正向",
      negative: "负向",
      positiveGroupTitle: "正向兴趣簇",
      negativeGroupTitle: "负向兴趣簇",
      fallbackName: (index: number) => `兴趣簇 #${index}`,
      sourceLabel: "来源",
      source: {
        manual: "用户命名",
        keywords: "关键词自动生成",
        representative_titles: "代表文章自动推断",
        feeds: "来源标题自动推断",
        fallback: "自动 fallback"
      },
      confidenceLabel: "置信度",
      confidence: {
        high: "高",
        medium: "中",
        low: "低"
      },
      lowConfidence: "自动推断，可能不准",
      lowConfidenceAdvice: "自动标签置信度低，建议手动重命名。",
      collisionResolved: "该标签已自动加上区分词，以避免与其他兴趣簇重名。",
      possibleDuplicate: (label: string, similarity: string) =>
        `可能重复：与「${label}」相似度 ${similarity}`,
      autoInference: (label: string) => `自动推断：${label}`,
      evidence: (count: number) => `证据：${count} 篇文章`,
      generatedAt: (value: string) => `生成：${value}`,
      topTerms: "关键词",
      representativeArticles: "代表文章",
      feedTitles: "来源",
      rename: "重命名",
      renameLabel: "兴趣簇显示名称",
      renamePlaceholder: "例如：AI 编程代理",
      saveLabel: "保存名称",
      clearManualLabel: "恢复自动标签",
      cancelRename: "取消",
      details: (weight: string, sampleCount: number, updatedAt: string) =>
        `权重 ${weight} · 样本 ${sampleCount} · 更新 ${updatedAt}`,
      diagnostics: (
        supportArticleCount: number,
        sourceCount: number,
        strongSignalRatio: string,
        topSourceShare: string,
        averageSimilarity: string
      ) =>
        `诊断：支撑文章 ${supportArticleCount} · 来源 ${sourceCount} · 强信号 ${strongSignalRatio} · 最大来源占比 ${topSourceShare} · 平均相似度 ${averageSimilarity}`,
      risk: {
        low: "过拟合风险低",
        medium: "过拟合风险中",
        high: "过拟合风险高"
      },
      matched: (name: string, similarity: string, weight: string, sampleCount: number) =>
        `与你的兴趣簇「${name}」相似，相似度 ${similarity}，簇权重 ${weight}，样本 ${sampleCount}。`,
      openAll: "查看全部兴趣簇",
      allTitle: "全部兴趣簇",
      allSummary: (count: number) => `完整显示 ${count} 个兴趣簇，按权重从高到低排序。`,
      back: "返回算法透明说明"
    },
    families: {
      empty: "还没有生成主题组；下一次推荐维护会自动补齐。",
      summary: (positive: number, negative: number, risk: string) =>
        `正向主题组 ${positive} 个 · 负向主题组 ${negative} 个 · 集中度风险 ${risk}`,
      rowMeta: (
        clusterCount: number,
        supportArticleCount: number,
        sourceCount: number,
        dominance: string,
        maturity: string
      ) =>
        `${clusterCount} 个簇 · ${supportArticleCount} 篇文章 · ${sourceCount} 个来源 · 占比 ${dominance} · 成熟度 ${maturity}`,
      clusterFamily: "所属主题",
      clusterCount: (count: number) => `${count} 个簇`,
      positiveFallback: "正向主题",
      negativeFallback: "负向主题",
      ungroupedFallback: "未归入主题组",
      rename: "重命名",
      renameLabel: "主题组显示名称",
      renamePlaceholder: "例如：AI 产品与开发",
      saveLabel: "保存名称",
      cancelRename: "取消",
      clearManualLabel: "恢复自动名称",
      risk: {
        low: "低",
        medium: "中",
        high: "高"
      }
    },
    mergeCandidates: {
      title: "可能重复的兴趣簇",
      body: "诊断只比较同一 polarity 的 active index 兴趣簇；合并会改变画像，因此默认需要手动确认。",
      empty: "当前没有打开状态的重复兴趣簇候选。",
      left: "左簇",
      right: "右簇",
      metrics: "指标",
      recommendation: "建议",
      actions: "操作",
      merge: "合并",
      ignore: "忽略",
      metricSummary: (centroid: string, label: string, evidence: string, score: string) =>
        `centroid ${centroid} · label ${label} · evidence ${evidence} · score ${score}`,
      recommendations: {
        auto_merge: "高置信",
        review: "需复核",
        ignore: "忽略"
      }
    },
    lexicon: {
      title: "标签词典",
      body: "噪声词、保护词和过滤规则只影响解释标签，不参与排序，也不会触发 embedding。",
      stopwordsAdd: "自定义噪声词",
      protectedTermsAdd: "自定义保护词",
      stopwordPlaceholder: "article / affiliation / URL 残留",
      addStopword: "添加噪声词",
      noStopwords: "尚未添加自定义噪声词。",
      saveAndRebuild: "保存并重建兴趣簇标签"
    },
    maintenance: {
      disclosureHint: "如系统运行正常，无需手动执行以下操作。",
      body:
        "这些任务只维护本地推荐状态。会请求 provider 的任务已单独标注；不确定时优先运行重算排序或近期意图重建。",
      run: "手动触发",
      running: "加入中",
      remoteUse: "外部请求",
      lastState: "最近状态",
      neverRun: "暂无记录",
      skipped: "跳过",
      notice: (label: string, existing: boolean) =>
        existing ? `${label} 已有任务在队列中。` : `${label} 已加入维护队列。`,
      tasks: {
        ranking_recalculate: {
          label: "重算排序",
          description: "重新计算推荐、稍后读等列表的本地排序分，不重新请求 embedding。",
          remoteUse: "不会调用 provider"
        },
        fingerprint_backfill: {
          label: "补齐文章指纹",
          description: "为缺少指纹的文章补齐标题/摘要指纹，供重复检测使用。",
          remoteUse: "不会调用 provider"
        },
        duplicate_rebuild: {
          label: "重建重复检测",
          description: "根据文章指纹重建重复组，减少相同主题或近重复文章挤占列表。",
          remoteUse: "不会调用 provider"
        },
        keyword_rebuild: {
          label: "重建关键词画像",
          description: "从本地行为和文章文本重建关键词画像，文章已清理时尽量使用快照。",
          remoteUse: "不会调用 provider"
        },
        cluster_label_rebuild: {
          label: "重建兴趣簇标签",
          description: "用本地证据文章、画像关键词和来源标题刷新兴趣簇显示标签。",
          remoteUse: "不会调用 provider"
        },
        cluster_merge_diagnostics: {
          label: "重建兴趣簇重复诊断",
          description: "只生成可能重复的兴趣簇候选，不修改画像和排序。",
          remoteUse: "不会调用 provider"
        },
        interest_family_rebuild: {
          label: "重建主题组",
          description: "把相近兴趣簇自动归入内部主题组，用于推荐多样性和诊断。",
          remoteUse: "不会调用 provider"
        },
        cluster_auto_merge: {
          label: "自动合并高置信重复簇",
          description: "仅在设置开启时合并高置信候选；合并会改变画像并触发排序重算。",
          remoteUse: "不会调用 provider"
        },
        recent_intent_rebuild: {
          label: "重建近期意图",
          description: "根据最近阅读行为刷新短期兴趣，用于近期推荐微调。",
          remoteUse: "不会调用 provider"
        },
        ftrl_train: {
          label: "训练本地排序模型",
          description: "用本地行为样本训练轻量排序模型，默认不自动提升为 active。",
          remoteUse: "不会调用 provider"
        },
        evaluation: {
          label: "运行排序评估",
          description: "用本地回放样本生成诊断指标，帮助判断推荐链路是否健康。",
          remoteUse: "不会调用 provider"
        },
        ftrl_promote: {
          label: "提升本地模型",
          description: "当样本质量足够时，把 shadow 模型以受限权重加入 active 排序。",
          remoteUse: "不会调用 provider"
        },
        ftrl_reset: {
          label: "重置本地模型",
          description: "清空 FTRL 训练权重和样本，仅用于模型状态明显异常时。",
          remoteUse: "不会调用 provider"
        }
      }
    },
    terms: [
      {
        term: "Embedding",
        description:
          "Embedding 是文章内容的向量表示。邸报用它比较文章和兴趣簇的语义距离；provider 只负责生成向量，不决定最终排序。"
      },
      {
        term: "用户模型卡",
        description:
          "邸报不会为每篇文章写一张静态卡片，而是把你的行为沉淀成一组正向/负向兴趣簇、来源偏好和文章状态。推荐排序时会拿候选文章向量与这些兴趣簇比较。"
      },
      {
        term: "兴趣簇",
        description:
          "兴趣簇是由相似文章向量合并出来的主题中心。点赞、收藏、稍后读、读完会增强正向兴趣簇；不感兴趣、隐藏会形成负向兴趣簇。"
      },
      {
        term: "Coverage",
        description:
          "Coverage 表示当前可排序文章中有多少已经生成 embedding。Coverage 不足时，新文章仍会进入列表，但会更多依赖新鲜度、来源和状态。"
      },
      {
        term: "基础排序",
        description:
          "没有 provider、没有 embedding 或画像还不足时，系统使用基础排序：主要看发布时间、来源权重和显式状态，不做语义相似度匹配。"
      },
      {
        term: "MMR",
        description:
          "MMR 用来在相似文章之间做轻量分散，避免同一主题连续占满推荐列表；信息茧房水平会影响它的分散强度。"
      }
    ],
    algorithmExplanation: [
      {
        name: "候选收集",
        role: "根据当前频道、来源、分组、未读/今日筛选和分页产生候选池。"
      },
      {
        name: "可见性过滤",
        role: "隐藏、不感兴趣、已删除文章会从普通列表中移除；收藏和稍后读频道保留各自队列语义。"
      },
      {
        name: "语义匹配",
        role: "有 active embedding index 时，计算候选文章与正向/负向兴趣簇的相似度。"
      },
      {
        name: "来源与新鲜度",
        role: "叠加手动来源权重、feed_stats 来源偏好和发布时间衰减，保证 RSS 时间线仍可解释。"
      },
      {
        name: "状态与负反馈",
        role: "收藏、点赞、稍后读、阅读进度提升短期排序；不感兴趣会清除其他状态并压低相似主题。"
      },
      {
        name: "去重与 MMR",
        role: "近重复、曝光和多样性惩罚会在最后阶段修正排序，减少重复主题挤占列表。"
      },
      {
        name: "Fallback",
        role: "当 provider、index、coverage 或画像不足时，系统退回基础排序，但阅读与列表仍可用。"
      }
    ],
    scoreTable: {
      columns: {
        behavior: "行为",
        modelCard: "用户模型卡积分",
        source: "来源偏好",
        ranking: "短期排序影响",
        notes: "说明"
      },
      rows: [
        {
          behavior: "滚过未打开 / 忽略",
          modelCard: "0",
          source: "-0.05",
          ranking: "-0.025，状态 -0.08",
          notes: "弱负反馈；表示这篇文章标题没有吸引你，不会单独创建负向兴趣簇。"
        },
        {
          behavior: "点进文章",
          modelCard: "0",
          source: "+0.02",
          ranking: "+0.005，状态 +0.015 到 +0.02",
          notes: "轻微正反馈；点进不等于读完，主要用于把已忽略文章恢复为已点进。"
        },
        {
          behavior: "阅读 25%",
          modelCard: "+1.2",
          source: "0",
          ranking: "+0.01",
          notes: "非常轻的兴趣信号，只记录最高档位的增量。"
        },
        {
          behavior: "阅读 50%",
          modelCard: "+2.0",
          source: "0",
          ranking: "+0.04",
          notes: "开始进入有效阅读信号。"
        },
        {
          behavior: "阅读 75%",
          modelCard: "+3.0",
          source: "0",
          ranking: "+0.06",
          notes: "强阅读信号。"
        },
        {
          behavior: "读完 / 90%",
          modelCard: "+4.0",
          source: "+1.0",
          ranking: "+0.10，已读状态 -0.08",
          notes: "说明主题有价值，但已读文章在当前推荐中会略降权，避免反复出现。"
        },
        {
          behavior: "加入稍后读",
          modelCard: "+3.0",
          source: "+1.0",
          ranking: "+0.08，状态 +0.08",
          notes: "稍后读是待读队列，列表内仍使用个性化排序。"
        },
        {
          behavior: "收藏",
          modelCard: "+6.0",
          source: "+2.0",
          ranking: "+0.12，状态 +0.04",
          notes: "收藏是资料库/书签信号；收藏频道默认不使用个性化排序。"
        },
        {
          behavior: "点赞",
          modelCard: "+8.0",
          source: "+3.0",
          ranking: "+0.16，状态 +0.10",
          notes: "最强正反馈，用来明确告诉系统你想看更多相似主题。"
        },
        {
          behavior: "取消点赞",
          modelCard: "-1.0",
          source: "-0.4",
          ranking: "-0.04",
          notes: "弱纠正信号；默认不创建新的强负向兴趣簇。"
        },
        {
          behavior: "不感兴趣",
          modelCard: "-6.0",
          source: "-2.5",
          ranking: "当前文章过滤，相似主题最多 -0.45",
          notes: "强负反馈，会创建负向兴趣簇并压低相似候选。"
        }
      ]
    },
    rankingFlowDiagram: [
      {
        phase: "候选",
        title: "收集候选",
        description: "频道、来源、分组、未读开关和分页共同决定候选池。"
      },
      {
        phase: "过滤",
        title: "移除不可见项",
        description: "隐藏、不感兴趣、已删除文章退出普通列表。"
      },
      {
        phase: "状态",
        title: "读取文章状态",
        description: "收藏、点赞、稍后读、阅读深度、忽略和点进进入 state score。"
      },
      {
        phase: "来源",
        title: "计算来源偏好",
        description: "手动来源权重与 feed_stats 合成 source score。"
      },
      {
        phase: "时间",
        title: "计算新鲜度",
        description: "用发布时间或发现时间计算 freshness score，半衰期约 36 小时。"
      },
      {
        phase: "模型",
        title: "匹配用户模型卡",
        description: "有 active embedding index 时，文章向量会匹配正/负兴趣簇。"
      },
      {
        phase: "合成",
        title: "融合排序分",
        description: "兴趣、来源、新鲜度、状态与负向惩罚合成 active rank score。"
      },
      {
        phase: "输出",
        title: "按频道输出",
        description: "最新按时间；推荐和稍后读按个性化分；收藏默认按收藏时间。"
      }
    ],
    channelRules: [
      "最新：默认按时间倒序。只看未读开关只过滤派生未读状态，不改变排序语义。",
      "推荐：使用个性化排序。没有模型卡或 embedding 时自动 fallback 到基础排序。",
      "稍后读：只显示稍后读文章，但仍使用个性化排序，适合当待读队列。",
      "收藏：是资料库/书签。默认按收藏时间倒序，可切换收藏时间或发布时间排序，不使用个性化排序。"
    ],
    copy: {
      localData:
        "本地保存原始行为事件、文章状态、阅读进度、来源偏好、兴趣簇、embedding provider 配置和索引状态。API key 当前按本地自托管策略保存在 SQLite 中。",
      fallback:
        "当 provider 未配置、索引 coverage 不足、provider 请求失败、文章缺少 embedding、或诊断状态不可用时，系统会 fallback 到基础排序。fallback 不会阻塞阅读。"
    }
  },
  recommendationStatus: {
    title: "推荐状态",
    loading: "正在读取推荐状态",
    fallback: "推荐状态暂不可用，当前列表仍可阅读。",
    warmupNotice:
      "当前用户行为正在积累中，推荐可能不准确，建议在“最新”视图中当做普通 RSS 阅读器正常使用。",
    modes: {
      baseline: "基础排序中",
      personalized: "个性化推荐中",
      embedding: "Embedding 生成中",
      degraded: "Provider 异常，已 fallback"
    },
    metrics: {
      behaviorCount: (count: number) => `行为 ${count}`,
      coverage: (ratio: string) => `Coverage ${ratio}`,
      clusters: (positive: number, negative: number) => `兴趣簇 +${positive} / -${negative}`,
      lastUpdate: (ranking: string, profile: string) => `排序 ${ranking} · 画像 ${profile}`,
      unknown: "暂无"
    }
  },
  recommendationInventory: {
    eyebrow: "推荐库存",
    close: "关闭推荐库存",
    connectionError: "推荐库存状态暂时断开，稍后会自动重连。",
    emptyNotice:
      "已排序库存已经读完。继续加载时会使用备用序列，相关性可能不佳；也可以等待后端排序任务完成。",
    rankingNotice:
      "后端正在排序。若已排序库存耗尽，继续加载会临时使用备用序列；等待排序完成后库存会自动更新。",
    systemTitle: "系统摘要",
    open: (status: string) => `查看推荐库存：${status}`,
    statuses: {
      available: "有库存",
      empty: "无库存",
      ranking: "排序中",
      loading: "读取中",
      unavailable: "未知"
    },
    summaries: {
      available: (remaining: number, total: number) =>
        `当前推荐序列还有 ${remaining} 条已排序库存，总已排序 ${total} 条。`,
      empty: (fallback: number) =>
        `当前推荐序列没有剩余已排序库存；备用序列约 ${fallback} 条，相关性可能不佳。`,
      ranking: (remaining: number, running: number, queued: number) =>
        `后端排序任务运行 ${running} 个、排队 ${queued} 个；当前剩余已排序库存 ${remaining} 条。`,
      loading: "正在读取推荐库存。",
      unavailable: "推荐库存状态暂不可用。"
    },
    metrics: {
      remainingSorted: "剩余已排序",
      sortedTotal: "已排序总量",
      latestActive: "最新排序",
      staleActive: "旧排序",
      loaded: "已加载",
      fallback: "备用序列",
      unrankedFallback: "未排序备用",
      rankingJobs: "排序任务",
      rankContext: "排序上下文",
      lastRankedAt: "最近排序",
      updatedAt: "状态更新",
      rankingJobValue: (running: number, queued: number) => `运行 ${running} · 排队 ${queued}`
    }
  },
  reader: {
    originalLink: "原文",
    backToList: "返回列表",
    reload: "重新加载",
    selectArticleTitle: "选择一篇文章",
    selectArticleBody: "文章详情会在这里打开。",
    feedOnlyNotice: "当前仅有订阅源摘要。",
    contentSource: {
      success: "正文来自网页全文抓取。",
      feed_only: "正文来自 RSS / Atom Feed。",
      failed: "网页全文抓取失败，当前显示 Feed 内容。",
      failedWithError: (error: string) => `网页全文抓取失败，当前显示 Feed 内容。${error}`,
      skipped: "未使用网页全文抓取，当前显示 Feed 内容。",
      pending: "正文正在等待处理，当前显示 Feed 内容或摘要。",
      noContent: "没有可用正文。"
    },
    discovery: {
      relatedTitle: "相关文章",
      relatedPrompt: "想继续了解这个话题？",
      relatedIntro: "寻找与你刚刚阅读的内容相近的文章",
      relatedButton: "查找相关文章",
      relatedLoading: "正在查找相关文章...",
      relatedEmpty: "暂时没有找到合适的相关文章。",
      relatedError: "相关文章加载失败。",
      more: "更多",
      personalizedTitle: "你可能还喜欢",
      personalizedLoading: "正在为你挑选...",
      personalizedEmpty: "暂时没有找到合适的继续阅读推荐。",
      personalizedError: "继续阅读推荐加载失败。",
      retry: "重试",
      unavailable: {
        no_active_embedding: "这篇文章暂时没有可用的语义索引。",
        article_embedding_missing: "这篇文章暂时没有可用的语义索引。",
        insufficient_candidates: "暂时没有足够的候选文章。"
      }
    },
    noContent: "这篇文章暂无正文内容。",
    meta: (feedTitle: string, date?: string, author?: string | null) =>
      [feedTitle, date, author].filter(Boolean).join(" · ")
  },
  fullContentPreview: {
    pageTitle: "全文抓取预览",
    status: "预览不会写入数据库",
    kicker: "Content preview",
    back: "返回订阅源管理",
    reload: "重新预览",
    loading: "正在预览",
    articleUrl: "文章 URL",
    resultStatus: "状态",
    extractedTitle: "抽取标题",
    statuses: {
      success: "成功",
      failed: "失败",
      skipped: "跳过"
    },
    noPreview: "没有可用预览。",
    noDbWrite: "这不会影响现有 Feed 内容。"
  },
  explanation: {
    title: "为什么推荐",
    entryTitle: "推荐解释",
    open: "查看完整理由",
    teaser: "只展示可理解的理由，不暴露内部原始分数。",
    lazy: "阅读过半后显示推荐解释。",
    sortLabel: "当前排序说明",
    sortTitle: "当前视图排序",
    loading: "正在生成推荐解释",
    empty: "当前没有明确的推荐信号。",
    generatedAt: (date: string) => `生成于 ${date}`,
    sorting: {
      latest: "当前视图正按照发布时间排序。",
      recommended: "推荐视图会综合用户模型卡、来源偏好、新鲜度和文章状态排序。",
      favorites: "收藏视图默认按收藏时间排序，不使用个性化推荐分。",
      read_later: "稍后读视图仍使用个性化排序，帮助你优先处理更可能值得阅读的文章。"
    },
    types: {
      interest: "兴趣匹配",
      source: "来源",
      freshness: "新鲜度",
      state: "状态",
      fallback: "基础排序",
      negative: "负向",
      penalty: "过滤",
      exploration: "破茧"
    },
    reasons: {
      interest: "与你近期的正向兴趣相似，因此排序更靠前。",
      interestCluster: (summary: string) => `与你近期的正向兴趣相似，因此排序更靠前。${summary}`,
      interestFamily: (label: string) => `与你的兴趣主题「${label}」相近，因此排序更靠前。`,
      recentIntent: "与你近期的阅读趋势相近，因此排序更靠前。",
      sourcePositive: (label: string) => `来源 ${label} 对排序有正向影响。`,
      sourceNegative: (label: string) => `来源 ${label} 当前权重偏低。`,
      freshness: "文章较新，获得新鲜度加分。",
      statePositive: "收藏、稍后读或阅读进度提高了排序。",
      stateNegative: "忽略、读完等状态降低了排序优先级。",
      fallback: "当前使用基础排序，暂时没有更强的推荐信号。",
      negative: "近期负向行为降低了排序。",
      penalty: "隐藏或不感兴趣会显著降低排序。",
      exploration: "本文由破茧算法打捞，你可在设置页调整算法信息茧房水平。"
    }
  },
  actions: {
    favorite: "收藏",
    unfavorite: "取消收藏",
    like: "点赞",
    unlike: "取消点赞",
    readLater: "稍后读",
    removeReadLater: "移出稍后读",
    markRead: "标记已读",
    markUnread: "标记未读",
    notInterested: "不感兴趣",
    notInterestedActive: "已不感兴趣",
    saving: "处理中",
    aria: {
      favorite: "收藏这篇文章",
      unfavorite: "取消收藏这篇文章",
      like: "点赞这篇文章",
      unlike: "取消点赞这篇文章",
      readLater: "稍后读这篇文章",
      removeReadLater: "移出稍后读",
      markRead: "标记这篇文章为已读",
      markUnread: "标记这篇文章为未读",
      notInterested: "不再推荐类似文章",
      notInterestedActive: "已标记不感兴趣",
      group: "文章操作"
    },
    errors: {
      favorite: "收藏失败。",
      like: "点赞更新失败。",
      readLater: "稍后读更新失败。",
      readStatus: "已读状态更新失败。",
      notInterested: "不感兴趣操作失败。",
      open: "记录打开行为失败。",
      generic: "操作失败，请重试。"
    }
  },
  notices: {
    feedAddedAndRefreshed: (feedTitle: string) => `已添加并刷新：${feedTitle}`,
    feedRefreshed: (feedTitle: string) => `已刷新：${feedTitle}`,
    allFeedsRefreshQueued: (count: number) =>
      count > 0 ? `已加入刷新队列：${count} 个订阅源。` : "没有启用的订阅源需要刷新。",
    opmlImported: (feedsCreated: number, feedsSkipped: number, foldersCreated: number) =>
      `OPML 导入完成：新增 ${feedsCreated} 个订阅源，跳过 ${feedsSkipped} 个，新增 ${foldersCreated} 个分组。`,
    opmlExported: "OPML 已导出。"
  },
  pwa: {
    offline: "当前离线。已缓存的应用壳仍可打开，但文章数据需要网络连接。",
    updateAvailable: "邸报有新版本可用。",
    updateNow: "刷新更新",
    dismiss: "稍后"
  },
  errors: {
    api: {
      requestFailed: "请求失败，请稍后重试。",
      requestTimeout: "请求超时。系统可能正在处理后台维护，请稍后重试。",
      databaseBusy: "系统正在处理后台维护，请稍后重试。",
      httpError: (status: number) => `请求失败（HTTP ${status}）。`
    }
  }
} as const;

type WidenDictionary<T> = T extends (...args: infer Args) => infer Return
  ? (...args: Args) => Return
  : T extends string
    ? string
    : T extends object
      ? { readonly [Key in keyof T]: WidenDictionary<T[Key]> }
      : T;

export type Dictionary = WidenDictionary<typeof zhCN>;
export type NavigationItemKey = keyof Dictionary["navigation"]["items"];

export const enUS = {
  common: {
    brandMark: "D",
    brandName: "Dibao",
    brandSubtitle: "Reader",
    close: "Close",
    version: (version: string) => `v${version}`
  },
  navigation: {
    ariaLabel: "Primary navigation",
    utilityMenuLabel: "More",
    items: {
      latest: "Latest",
      recommended: "For You",
      favorites: "Favorites",
      read_later: "Read Later",
      search: "Search",
      feeds: "Feeds",
      settings: "Settings"
    }
  },
  shell: {
    kicker: "RSS feeds",
    pageTitle: "Latest",
    pageTitles: {
      latest: "Latest",
      recommended: "For You",
      favorites: "Favorites",
      read_later: "Read Later"
    },
    pageKickers: {
      latest: "Latest",
      recommended: "For You",
      favorites: "Favorites",
      read_later: "Read Later"
    },
    loadingArticles: "Loading articles",
    latestView: "Latest",
    viewStatus: {
      latest: "Latest",
      recommended: "For You",
      favorites: "Favorites",
      read_later: "Read Later"
    }
  },
  search: {
    kicker: "Search",
    pageTitle: "Search",
    title: "Search Articles",
    body: "Search titles and summaries by default. Enable full-text search when needed.",
    inputLabel: "Keyword",
    inputPlaceholder: "Search titles and summaries",
    relatedPrefix: "Related to:",
    fullTextLabel: "Search full text",
    submit: "Search",
    submitting: "Searching",
    sortLabel: "Sort",
    sorts: {
      relevance: "Relevance",
      recommended: "For You",
      latest: "Latest"
    },
    recommendedSortHint: "Reorders only the matched results using your personalization model.",
    relatedThresholdFooter: (threshold: string) =>
      `Related article search only includes articles with similarity > ${threshold}.`,
    stateLabel: "State",
    advancedSearch: "Advanced search",
    hideAdvancedSearch: "Hide advanced search",
    sourceLabel: "Source",
    folderLabel: "Folder",
    feedLabel: "Feed",
    allSources: "All sources",
    allFolders: "All folders",
    allFeeds: "All feeds",
    dateFromLabel: "From",
    dateToLabel: "To",
    states: {
      all: "All",
      unread: "Unread",
      read: "Read",
      favorites: "Favorites",
      read_later: "Read later"
    },
    emptyTitle: "No articles found",
    emptyBody: "Try another keyword or loosen the source, state, and date filters.",
    initialTitle: "Search your RSS article library",
    initialBody: "Enter a keyword to search titles, summaries, and full text.",
    resultsCount: (count: number) => `${count} results`,
    loadMore: "Load more"
  },
  auth: {
    loading: "Checking your session",
    setupStatusLoading: "Checking instance status",
    retry: "Retry check",
    setupTitle: "Create your account",
    setupBody: "This self-hosted instance has one user. Create a username and password to protect it.",
    loginTitle: "Log in to Dibao",
    loginBody: "Enter your username and password to continue.",
    usernameLabel: "Username",
    usernamePlaceholder: "Username",
    passwordLabel: "Password",
    passwordPlaceholder: "At least 8 characters",
    setupSubmit: "Finish setup",
    loginSubmit: "Log in",
    submitting: "Please wait",
    telemetryLabel: "Share feedback data to help improve Dibao",
    telemetryBody: "On by default. Used for error diagnostics, performance analysis, and product quality improvements. You can turn it off in Settings.",
    logout: "Log out",
    logoutTitle: "Log out",
    usernameRequired: "Enter your username.",
    passwordRequired: "Enter your password.",
    errors: {
      session: "Could not check your session.",
      setupStatus: "Could not read instance status.",
      logout: "Log out failed."
    }
  },
  upgrade: {
    kicker: "Version upgrade",
    title: "Rebuilding your recommendation profile",
    body: "Dibao is repairing interest-cluster data created by an older version. The reader is paused until the rebuild finishes so stale profile data cannot affect recommendations.",
    failedBody: "The recommendation profile rebuild did not finish. Retry after checking the server log if needed.",
    progressLabel: "Upgrade progress",
    costNote: "This migration only rebuilds derived profile data such as clusters, topic families, labels, and ranking rows. It does not rebuild embeddings or create additional embedding API charges.",
    progress: (current: number, total: number, percent: number) =>
      total > 0 ? `${current} / ${total} articles · ${percent}%` : "Preparing data",
    retry: "Retry rebuild",
    retrying: "Retrying",
    steps: {
      detecting: "Checking profile data",
      schemaMigration: "Updating database schema",
      reset: "Clearing old clusters and families",
      replay: "Replaying reading signals",
      labels: "Rebuilding cluster labels",
      families: "Rebuilding interest families",
      ranking: "Recalculating recommendations",
      completed: "Rebuild complete",
      failed: "Rebuild failed",
      skipped: "No rebuild needed"
    }
  },
  setup: {
    kicker: "First-run setup",
    welcome: {
      title: "Welcome to Dibao",
      body: "A self-hosted RSS reader with a private For You feed. Finish the required setup before opening the reader.",
      start: "Start setup"
    },
    sources: {
      title: "Add feeds",
      body: "Import an OPML file or manually add an RSS / Atom feed. At least one feed is required to continue.",
      importOpml: "Import OPML file",
      addFeed: "Add feed",
      noFeedsAfterImport: "Import finished, but no feeds were created. Check the OPML file or add an RSS / Atom URL manually.",
      noFeedsAfterAdd: "The feed was not created. Please try again."
    },
    provider: {
      title: "Personalization",
      body: "Set up an embedding provider so Dibao can use article semantics and your reading signals for a more personal feed.",
      recommendationLink: "See this guide to choose a suitable free provider.",
      currentTitle: "Skipping is still available",
      currentBody: "If you skip this step, Dibao remains usable for reading, favorites, read-later, and baseline ranking.",
      saveAndTest: "Save profile and test connection",
      enableAndContinue: "Enable provider and continue",
      useProviderAndContinue: "Continue with this provider",
      saving: "Saving",
      testRequired: "Save the profile and pass the connection test before enabling the provider.",
      testStale: "The profile has changed. Test the connection again before enabling.",
      continue: "Skip and use baseline ranking"
    }
  },
  feeds: {
    kicker: "Feeds",
    title: "Feeds",
    inputLabel: "Website or RSS / Atom URL",
    inputPlaceholder: "https://example.com or https://example.com/feed.xml",
    add: "Add",
    adding: "Adding",
    allFeeds: "All feeds",
    sourceCount: (count: number) => `${count} ${count === 1 ? "source" : "sources"}`,
    feedUrlRequired: "Enter a website or RSS / Atom URL.",
    successAt: (date: string) => `Success: ${date}`,
    nextRefreshAt: (date: string) => `Next fetch: ${date}`,
    refresh: "Refresh",
    refreshing: "…",
    refreshAll: "Refresh all",
    refreshingAll: "Queuing",
    openSources: "Sources",
    openSourcesLabel: "Open sources",
    closeSources: "Close sources",
    refreshTitle: (feedTitle: string) => `Refresh ${feedTitle}`
  },
  feedDiscovery: {
    inputLabel: "Website or RSS / Atom URL",
    inputPlaceholder: "https://example.com or https://example.com/feed.xml",
    check: "Check",
    checking: "Checking",
    candidatesTitle: "Discovered feeds",
    noCandidatesTitle: "No usable feed found",
    noCandidatesBody: "Try a direct RSS / Atom URL, or check whether the site declares a feed.",
    addCandidate: "Add this feed",
    addingCandidate: "Adding",
    duplicate: "Already subscribed",
    invalid: "Unavailable",
    valid: "Can add",
    statuses: {
      valid: "Can add",
      duplicate: "Already subscribed",
      invalid: "Unavailable"
    },
    recentItems: "Recent articles",
    itemCount: (count: number) => `${count} ${count === 1 ? "article" : "articles"}`,
    warningsTitle: "Notes",
    errors: {
      urlRequired: "Enter a website or RSS / Atom URL.",
      discoverFailed: "Feed check failed. Please try again later."
    }
  },
  feedDiagnostics: {
    title: "Feed health",
    summary: (total: number, error: number, warning: number) =>
      `${total} ${total === 1 ? "feed" : "feeds"} · ${error} failing · ${warning} need attention`,
    filters: {
      all: "All",
      unhealthy: "Issues only",
      disabled: "Disabled",
      neverFetched: "Never successful"
    },
    statuses: {
      healthy: "Healthy",
      never_fetched: "Never fetched",
      due: "Due",
      stale: "Stale",
      failing: "Fetch failed",
      disabled: "Disabled"
    },
    fields: {
      lastFetchedAt: "Last fetched",
      lastSuccessAt: "Last success",
      nextRefreshAt: "Next fetch",
      lastError: "Last error"
    },
    messages: {
      OK: "Feed fetches are healthy.",
      DISABLED: "The feed is disabled.",
      NEVER_FETCHED: "The feed has not been fetched yet.",
      DUE: "The feed is due for refresh.",
      STALE: "The feed has not fetched successfully for more than 7 days.",
      FETCH_FAILED: "The latest feed fetch failed."
    },
    retry: "Retry refresh",
    noIssues: "No feed issues."
  },
  folders: {
    title: "Folders",
    feedCount: (count: number) => `${count} ${count === 1 ? "feed" : "feeds"}`
  },
  feedManagement: {
    kicker: "Feed Management",
    pageTitle: "Feed Management",
    loading: "Loading feeds",
    status: (feedCount: number, folderCount: number) =>
      `${feedCount} ${feedCount === 1 ? "feed" : "feeds"} · ${folderCount} ${folderCount === 1 ? "folder" : "folders"}`,
    na: "None",
    tabs: {
      label: "Feed management views",
      feeds: "Feed management",
      folders: "Feed folder management"
    },
    folders: {
      kicker: "Folders",
      title: "Folders",
      newLabel: "New folder",
      newPlaceholder: "For example: Tech",
      create: "Create",
      emptyTitle: "No folders yet",
      emptyBody: "Create folders to organize feeds together.",
      managementHint: "Manage folder names here, or open articles from a folder directly.",
      renameLabel: (title: string) => `Rename ${title}`,
      confirmDelete: "Confirm delete",
      deleteHint: "Deleting a folder does not delete feeds. Its feeds move to Ungrouped."
    },
    operations: {
      kicker: "Operations",
      title: "Import, export, and refresh"
    },
    feeds: {
      kicker: "Feeds",
      title: "Feeds",
      addFeed: "Add feed",
      emptyTitle: "No feeds yet",
      emptyBody: "Add an RSS / Atom feed in the reader sidebar, or import OPML.",
      ungrouped: "Ungrouped",
      enabled: "Enabled",
      disabled: "Disabled",
      weight: (value: number) => `Weight ${value}`,
      lastSuccess: (value: string) => `Last success: ${value}`,
      nextRefresh: (value: string) => `Next fetch: ${value}`,
      confirmDelete: "Confirm delete",
      deleteHint: "Deleting a feed does not physically delete historical articles, but they stop appearing in article lists."
    },
    editor: {
      kicker: "Edit feed",
      titleLabel: "Title",
      feedUrlLabel: "Feed URL",
      folderLabel: "Folder",
      enabledLabel: "Enable feed",
      sourceWeightLabel: "Source weight",
      lastFetchedAt: "Last fetched",
      lastSuccessAt: "Last success",
      nextRefreshAt: "Next fetch",
      lastError: "Last error",
      emptyTitle: "Select a feed",
      emptyBody: "Select a feed to edit its title, folder, enabled state, and source weight."
    },
    fullContent: {
      label: "Content source",
      modes: {
        feed_only: "Use feed content (default)",
        fetch_full_content: "Fetch full web article"
      },
      feedOnlyHint: "Best for most full-text RSS feeds. Fast and stable.",
      fetchHint:
        "Useful for summary-only RSS feeds. It can fail and will not bypass paywalls.",
      preview: "Preview full content fetch",
      backfill: "Fetch current feed articles",
      backfilling: "Fetching",
      backfillConfirm:
        "Dibao will read the current RSS response again and fetch full web content only for articles still present there. It will not scan all historical articles from this feed.",
      stats: {
        articlesSeen: "Current RSS articles",
        attempted: "Attempted",
        succeeded: "Succeeded",
        failed: "Failed",
        skipped: "Skipped",
        changed: "Content changed",
        limited: "50 item limit"
      },
      limited: "Limited to first 50",
      notLimited: "Not triggered"
    },
    actions: {
      save: "Save",
      saving: "Saving",
      cancel: "Cancel",
      rename: "Rename",
      viewArticles: "View articles",
      delete: "Delete"
    },
    errors: {
      folderTitleRequired: "Enter a folder name.",
      feedTitleRequired: "Enter a feed title.",
      sourceWeight: "Source weight must be a number between -1 and 1."
    }
  },
  settings: {
    kicker: "Settings",
    pageTitle: "Settings",
    loading: "Loading settings",
    status: "Settings ready",
    sections: {
      language: {
        title: "Language",
        body: "Choose the interface language. Saved settings remain after refresh.",
        localeLabel: "Interface language",
        zhCN: "简体中文",
        enUS: "English",
        jaJP: "日本語",
        defaultHomeViewLabel: "Start page",
        defaultHomeViewRecommended: "For You",
        defaultHomeViewLatest: "Latest"
      },
      account: {
        title: "Account security",
        body: "Change your password. Enter your current password first to confirm it is you.",
        currentPasswordLabel: "Current password",
        newPasswordLabel: "New password",
        confirmPasswordLabel: "Confirm new password",
        currentPasswordPlaceholder: "Current password",
        newPasswordPlaceholder: "At least 8 characters",
        confirmPasswordPlaceholder: "Enter the new password again",
        submit: "Change password",
        submitting: "Changing",
        saved: "Access password updated.",
        errors: {
          currentRequired: "Enter the current password.",
          newRequired: "Enter the new password.",
          confirmRequired: "Enter the new password again.",
          mismatch: "The new passwords do not match."
        }
      },
      behavior: {
        title: "Behavior tracking",
        body: "Control automatic behavior capture in article lists and the Read Later queue.",
        algorithmTransparencyLink: "View personalization details",
        markScrolledArticlesIgnored: "Mark unopened articles you scroll past as ignored and remove them from unread",
        removeReadLaterOnReadComplete: "Remove Read Later articles after you finish them",
        infiniteArticleLoading: "Infinite loading: automatically load more articles when you reach the end of a list",
        cocoonLevel: "Cocoon level",
        cocoonLevelHint: "1 is broader and more exploratory; 10 stays closer to your established interests. Every level only ranks articles from your subscribed feeds and still respects deduping and explicit negative feedback.",
        interestClusterLimits: {
          title: "Interest cluster limits",
          body: "More interest clusters are not always better. If your Inbox has fewer daily articles or focused feeds, fewer clusters can make recommendations steadier.",
          embeddingCostHint:
            "Raising this limit mainly increases local ranking and vector-similarity work. It does not increase external embedding calls proportionally.",
          performancePreset: "Performance tier",
          presets: [
            "Low-end VPS: 24 / 16 · 8 / 6",
            "Mid-range NAS: 48 / 32 · 16 / 12",
            "Fast server or local machine: 96 / 64 · 28 / 20"
          ],
          customPreset: "Custom",
          positiveLabel: "Positive interest clusters",
          negativeLabel: "Negative interest clusters",
          positiveFamilyLabel: "Positive topic families",
          negativeFamilyLabel: "Negative topic families",
          fieldHint:
            "Clusters drive precise article matching; topic families support explanations and diversity. Family limits only cap mature families and do not force leftovers together."
        }
      },
      telemetry: {
        title: "Feedback telemetry",
        body: "Control whether Dibao sends error, performance, and experience feedback data to help developers improve the app.",
        enabledLabel: "Share feedback data to help improve Dibao",
        enabledBody: "On by default. Turning this off stops new Sentry telemetry events from the browser and server."
      },
      reader: {
        title: "Reading",
        body: "Adjust article detail reading density. Changes apply immediately to the reader.",
        fontSize: "Font size",
        lineHeight: "Line height",
        paragraphGap: "Paragraph gap",
        readerWidth: "Reader width"
      },
      retention: {
        title: "Article retention",
        body: "Background cleanup removes articles older than the retention window. Use 0 to keep articles forever. Favorites and Read Later items can be kept independently.",
        retentionDays: "Retention days",
        keepFavorites: "Keep favorited articles",
        keepReadLater: "Keep Read Later articles",
        enabled: "On",
        disabled: "Off",
        cleanupConfirm:
          "Historical articles older than the retention window will be deleted and cannot be restored. Cleanup will be queued in the background and will not run synchronously while saving settings. Continue?",
        mappingHint: "API field retention.retentionDays is stored as storage key retention.articleDays."
      },
      about: {
        title: "About",
        body: "Version, author, and project links.",
        version: "Current version",
        latestVersion: "Latest version",
        latestLoading: "Checking latest version",
        latestUnknown: "Not checked yet",
        latestUnavailable: "No GitHub Release found",
        latestCurrent: (version: string) => `Up to date: ${version}`,
        latestUpdateAvailable: (version: string) => `New version available: ${version}`,
        latestError: (message: string) => `Check failed: ${message}`,
        latestCheckedAt: (value: string) => `Last checked: ${value}`,
        latestNeverChecked: "No check recorded yet",
        checkRelease: "Check for updates",
        checkingRelease: "Checking",
        releaseLink: "View Release",
        author: "Author",
        authorName: "Pls",
        telemetryLabel: "Feedback data",
        telemetryBody:
          "Control whether Dibao sends error, performance, and experience feedback data to help developers improve the app.",
        xAccount: "X account",
        blog: "Author blog",
        homepage: "Project homepage",
        github: "Project GitHub"
      },
      provider: {
        title: "Intelligence",
        body: "Set up an OpenAI-compatible, Gemini AI Studio, or Ollama embedding provider. Without an enabled provider, Dibao keeps using baseline ranking.",
        loading: "Loading intelligence settings",
        providerLabel: "Provider",
        newProvider: "New embedding provider",
        typeLabel: "Type",
        openaiCompatible: "OpenAI-compatible",
        gemini: "Gemini AI Studio",
        ollama: "Ollama",
        nameLabel: "Name",
        baseUrlLabel: "Base URL",
        baseUrlPlaceholder: "https://api.example.com/v1",
        geminiBaseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta",
        ollamaBaseUrlPlaceholder: "http://127.0.0.1:11434",
        modelLabel: "Model",
        modelPlaceholder: "text-embedding-3-small",
        geminiModelPlaceholder: "gemini-embedding-001",
        ollamaModelPlaceholder: "nomic-embed-text",
        dimensionLabel: "Dimension",
        textMaxCharsLabel: "Text slice length (chars)",
        requestsPerMinuteLabel: "QPM (batch requests/min)",
        requestsPerDayLabel: "QPD (batch requests/day)",
        unlimitedPlaceholder: "Blank for unlimited",
        apiKeyLabel: "API Key",
        apiKeyPlaceholder: "Optional, depending on the endpoint",
        apiKeyRetainPlaceholder: "Leave blank to keep the saved key",
        ollamaApiKeyHint: "The local Ollama API does not require an API key by default.",
        geminiApiKeyHint: "Gemini AI Studio uses x-goog-api-key when calling the Gemini embedding API.",
        modelHint: "Warning: switching to a different model family, dimension, or text slice length creates a new vector space. Existing vectors are not reused; semantic ranking resumes after the new index is generated.",
        textMaxCharsHint: "Warning: changing the text slice length makes existing vectors inconsistent with the new strategy. Saving and setting the provider current creates a new active index; regenerate/backfill vectors afterwards.",
        ollamaTextMaxCharsHint: "For Chinese content, keep Ollama slices at 4000 chars or lower; if models such as bge-m3 still report context length errors, try 3000.",
        rateLimitHint: "QPM/QPD count batch requests. QPM pauses jobs until the next minute; QPD pauses them until the next local day. Leave blank for no limit.",
        activateHint: "Saving only updates the provider profile. Use “Set as current provider” to switch embedding generation, the active index, and personalized ranking to this provider.",
        activeTitle: "Current provider",
        activeEmptyTitle: "No current provider",
        activeBody: (name: string, model: string, dimension: number) =>
          `${name} · ${model} / ${dimension}`,
        activeEmptyBody: "Dibao keeps using baseline ranking. Save a provider profile first, then set it as current.",
        profileListLabel: "Provider profiles",
        currentBadge: "Current",
        profileBadge: "Profile",
        qualityTierLabel: "Quality tier",
        quality: {
          basic: "Basic",
          recommended: "Balanced",
          bestQuality: "Best quality"
        },
        enabledStatus: "Enabled",
        disabledStatus: "Disabled",
        disabled: "Not configured",
        lastTestSuccess: (value: string) => `Connection test succeeded: ${value}`,
        lastTestFailed: (value: string) => `Connection test failed: ${value}`,
        lastTestUnknown: "Connection has not been tested.",
        save: "Save profile",
        saving: "Saving",
        activate: "Set as current provider",
        activating: "Switching",
        activeActionCurrent: "Already current",
        test: "Test connection",
        testing: "Testing",
        delete: "Delete",
        deleting: "Deleting",
        deleteHint: "Providers with embedding indexes cannot be deleted. Switch to another compatible provider when you no longer want to use this one.",
        indexesTitle: "Embedding indexes",
        connectionStatusTitle: "Connection test status",
        embeddingJobStatusTitle: "Embedding job status",
        indexesBody: "Indexes show coverage, queue state, and recent failures. Connection tests and embedding jobs are reported separately.",
        usageWindowLabel: "Embedding usage window",
        usageWindows: {
          "24h": "24H",
          "7d": "7Days",
          "30d": "30Days"
        },
        usage: (itemCount: number, requestCount: number, estimatedTokens: number) =>
          `Local estimate: ${itemCount} inputs · ${requestCount} batch requests · ${estimatedTokens} tokens`,
        noIndexes: "Setting the provider as current creates an active index.",
        indexStatus: (model: string, status: string, count: number) =>
          `${model} · ${status} · ${count} ${count === 1 ? "embedding" : "embeddings"}`,
        coverage: (embeddingCount: number, candidateCount: number, ratio: string) =>
          `${embeddingCount} / ${candidateCount} · ${ratio}`,
        indexTotal: (count: number) => `Index total: ${count} ${count === 1 ? "embedding" : "embeddings"}`,
        coverageUnavailable: "Coverage unavailable",
        pendingJobs: (count: number) => `${count} pending`,
        failedJobs: (count: number) => `${count} failed`,
        lastFailedAt: (value: string) => `Last failed: ${value}`,
        lastError: (value: string) => `Error: ${value}`,
        noJobFailures: "No embedding job failures.",
        rebuild: "Rebuild vector index",
        rebuilding: "Queued",
        backfill: "Backfill missing vectors",
        backfilling: "Queued",
        notices: {
          saved: "Embedding provider saved.",
          activated: "Current embedding provider switched.",
          tested: "Connection test succeeded.",
          deleted: "Embedding provider deleted.",
          rebuildQueued: "Embedding index rebuild queued.",
          backfillQueued: "Embedding backfill queued."
        },
        errors: {
          nameRequired: "Enter a provider name.",
          baseUrlRequired: "Enter the Base URL.",
          modelRequired: "Enter a model name.",
          dimension: "Dimension must be an integer from 1 to 20000.",
          textMaxChars: "Text slice length must be an integer from 1000 to 200000.",
          requestsPerMinute: "QPM must be blank or a positive integer.",
          requestsPerDay: "QPD must be blank or a positive integer."
        }
      }
    },
    actions: {
      save: "Save settings",
      saving: "Saving"
    },
    notices: {
      saved: "Settings saved."
    },
    errors: {
      invalidNumber: "Enter a valid number.",
      fontSize: "Font size must be between 16 and 24.",
      lineHeight: "Line height must be between 1.45 and 2.1.",
      paragraphGap: "Paragraph gap must be between 0.6 and 1.6.",
      readerWidth: "Reader width must be between 560 and 860.",
      retentionDays: "Retention days must be an integer between 0 and 3650; 0 means forever.",
      cocoonLevel: "Cocoon level must be an integer from 1 to 10.",
      maxPositiveInterestClusters:
        "Positive interest cluster limit must be an integer from 8 to 192.",
      maxNegativeInterestClusters:
        "Negative interest cluster limit must be an integer from 4 to 128.",
      maxPositiveInterestFamilies:
        "Positive topic family limit must be an integer from 2 to 64.",
      maxNegativeInterestFamilies:
        "Negative topic family limit must be an integer from 1 to 48."
    },
    units: {
      px: "px",
      days: "days",
      level: "level"
    }
  },
  opml: {
    import: "Import OPML",
    importing: "Importing",
    export: "Export OPML",
    exporting: "Exporting",
    importSummary: (feedsCreated: number, feedsSkipped: number, foldersCreated: number) =>
      `Imported ${feedsCreated} ${feedsCreated === 1 ? "feed" : "feeds"}, skipped ${feedsSkipped}, added ${foldersCreated} ${foldersCreated === 1 ? "folder" : "folders"}.`,
    importErrors: (count: number) => `${count} ${count === 1 ? "item" : "items"} could not be imported.`
  },
  articles: {
    allSources: "All sources",
    title: "Latest",
    views: {
      latest: "Latest",
      recommended: "For You",
      favorites: "Favorites",
      read_later: "Read Later"
    },
    sort: {
      label: "Sort",
      favorited_desc: "Recently favorited",
      favorited_asc: "Oldest favorited",
      ranked: "Personalized",
      read_later_desc: "Recently added",
      read_later_asc: "Oldest added",
      published_desc: "Newest published",
      published_asc: "Oldest published"
    },
    loadMore: "Load more",
    loadingMore: "Loading",
    retryLoadMore: "Retry loading",
    loadingSlow: "Loading is taking longer than expected. Dibao is still reading.",
    emptyNoFeedsTitle: "No feeds yet",
    emptyNoFeedsBody: "Add an RSS / Atom feed and articles will appear here.",
    emptyNoArticlesTitle: "No articles yet",
    emptyNoArticlesBody: "Refresh a feed or switch back to all sources.",
    emptyNoUnreadTitle: "No unread articles",
    emptyNoUnreadBody: "Turn off Only unread to see read or ignored articles.",
    unreadOnly: "Only unread",
    filters: {
      label: "Article filters",
      timeWindowTitle: "Choose article time range",
      timeWindows: {
        all: "All",
        "24h": "24H",
        "7d": "7 Days",
        "30d": "30 Days"
      },
      unreadTitle: "Only unread articles"
    },
    itemMeta: (date: string, feedTitle: string) => `${date} · ${feedTitle}`,
    state: {
      unseen: "New",
      ignored: "Ignored",
      opened: "Opened",
      reading: "Reading",
      read: "Finished",
      unread: "Unread",
      favorited: "Favorited",
      liked: "Liked",
      readLater: "Read later"
    }
  },
  readerCommands: {
    markScopeRead: {
      unreadWithCount: (count: number) => `Unread ${count}`,
      toggleUnread: "Only unread",
      clear: "Clear",
      clearForWindow: (window: string) =>
        window === "all" ? "Clear" : window === "24h" ? "Clear >24h" : `Clear >${window}`,
      clearShort: "✓",
      clearTitle: "Mark current scope as read",
      clearTitleForWindow: (window: string) =>
        window === "all" ? "Mark all unread as read" : `Mark unread older than ${window} as read`,
      confirmTitle: "Clear unread",
      confirmBody: (count: number) => `Mark ${count} unread articles in the current scope as read?`,
      confirmBodyForWindow: (count: number, window: string) =>
        window === "all"
          ? `Mark all ${count} unread articles as read?`
          : `Mark ${count} unread articles older than ${window} as read?`,
      confirmBodyLoading: "Counting unread articles in the clear scope…",
      confirmBodyUnknown: "Mark unread articles in this clear scope as read?",
      confirmHint:
        "This will not clear favorites or Read Later items, and it will not count as positive personalization feedback.",
      cancel: "Cancel",
      confirm: "Mark read",
      clearing: "Clearing",
      cleared: (count: number) => `Marked ${count} articles in the current scope as read.`,
      nothingToClear: "There are no unread articles in the current scope.",
      error: "Bulk mark read failed. Please try again."
    }
  },
  algorithmTransparency: {
    kicker: "Personalization Details",
    pageTitle: "Personalization Details",
    status: "Personalization details ready",
    backToSettings: "Back to settings",
    noWarnings: "No warnings",
    sections: {
      currentStatus: "Current personalization status",
      currentClusters: "Current interest clusters",
      topicFamilies: "Topic group overview",
      maintenance: "Algorithm maintenance",
      mergeCandidates: "Possible duplicate clusters",
      labelLexicon: "Label lexicon",
      algorithmExplanation: "How ranking works",
      terms: "Terms",
      scoreTable: "Behavior score table",
      rankingFlow: "Ranking flow",
      channelRules: "Channel rules",
      dataAndFallback: "Local data and fallback"
    },
    statusTones: {
      normal: "Normal",
      warning: "Warning",
      stopped: "Stopped",
      disabled: "Disabled"
    },
    statusTable: {
      module: "Module",
      status: "Status",
      summary: "Summary"
    },
    fields: {
      provider: "Provider",
      index: "Index",
      coverage: "Coverage",
      behaviorCounts: "Behavior counts",
      clusters: "Clusters",
      lastUpdates: "Last updates",
      warnings: "Warnings",
      cocoon: "Cocoon level",
      exploration: "Exploration",
      formula: "Current formula",
      automaticMaintenance: "Automatic maintenance",
      failureStates: "Fallback / task states"
    },
    clusters: {
      empty: "No interest clusters have formed yet. Likes, favorites, Read Later saves, and completed reads will generate them automatically.",
      generated:
        "Interest clusters are not preset by the system. Labels come from local keywords, representative articles, and feed titles, and can be renamed manually.",
      positive: "Positive",
      negative: "Negative",
      positiveGroupTitle: "Positive interest clusters",
      negativeGroupTitle: "Negative interest clusters",
      fallbackName: (index: number) => `Interest cluster #${index}`,
      sourceLabel: "Source",
      source: {
        manual: "User named",
        keywords: "Keyword inference",
        representative_titles: "Representative-title inference",
        feeds: "Feed-title inference",
        fallback: "Automatic fallback"
      },
      confidenceLabel: "Confidence",
      confidence: {
        high: "High",
        medium: "Medium",
        low: "Low"
      },
      lowConfidence: "Automatic inference, may be inaccurate",
      lowConfidenceAdvice: "Automatic label confidence is low; consider renaming manually.",
      collisionResolved: "This label was automatically disambiguated to avoid duplicate cluster names.",
      possibleDuplicate: (label: string, similarity: string) =>
        `Possible duplicate: similar to "${label}" at ${similarity}`,
      autoInference: (label: string) => `Auto inference: ${label}`,
      evidence: (count: number) => `Evidence: ${count} articles`,
      generatedAt: (value: string) => `Generated: ${value}`,
      topTerms: "Keywords",
      representativeArticles: "Representative articles",
      feedTitles: "Feeds",
      rename: "Rename",
      renameLabel: "Cluster display name",
      renamePlaceholder: "For example: AI coding agents",
      saveLabel: "Save name",
      clearManualLabel: "Restore automatic label",
      cancelRename: "Cancel",
      details: (weight: string, sampleCount: number, updatedAt: string) =>
        `Weight ${weight} · samples ${sampleCount} · updated ${updatedAt}`,
      diagnostics: (
        supportArticleCount: number,
        sourceCount: number,
        strongSignalRatio: string,
        topSourceShare: string,
        averageSimilarity: string
      ) =>
        `Diagnostics: support articles ${supportArticleCount} · sources ${sourceCount} · strong signals ${strongSignalRatio} · top-source share ${topSourceShare} · average similarity ${averageSimilarity}`,
      risk: {
        low: "Low overfit risk",
        medium: "Medium overfit risk",
        high: "High overfit risk"
      },
      matched: (name: string, similarity: string, weight: string, sampleCount: number) =>
        `Similar to your interest cluster "${name}", similarity ${similarity}, cluster weight ${weight}, samples ${sampleCount}.`,
      openAll: "View all interest clusters",
      allTitle: "All interest clusters",
      allSummary: (count: number) => `Showing all ${count} interest clusters, sorted by weight.`,
      back: "Back to transparency"
    },
    families: {
      empty: "No topic groups have been generated yet; the next recommendation maintenance run will fill this in.",
      summary: (positive: number, negative: number, risk: string) =>
        `${positive} positive topic groups · ${negative} negative topic groups · concentration risk ${risk}`,
      rowMeta: (
        clusterCount: number,
        supportArticleCount: number,
        sourceCount: number,
        dominance: string,
        maturity: string
      ) =>
        `${clusterCount} clusters · ${supportArticleCount} articles · ${sourceCount} sources · share ${dominance} · maturity ${maturity}`,
      clusterFamily: "Topic group",
      clusterCount: (count: number) => `${count} clusters`,
      positiveFallback: "Positive topic",
      negativeFallback: "Negative topic",
      ungroupedFallback: "No topic group",
      rename: "Rename",
      renameLabel: "Topic group display name",
      renamePlaceholder: "Example: AI products and development",
      saveLabel: "Save name",
      cancelRename: "Cancel",
      clearManualLabel: "Restore automatic name",
      risk: {
        low: "Low",
        medium: "Medium",
        high: "High"
      }
    },
    mergeCandidates: {
      title: "Possible duplicate clusters",
      body: "Diagnostics only compare same-polarity clusters in the active index. Merge changes the profile, so it requires confirmation by default.",
      empty: "No open duplicate-cluster candidates.",
      left: "Left cluster",
      right: "Right cluster",
      metrics: "Metrics",
      recommendation: "Suggested action",
      actions: "Actions",
      merge: "Merge",
      ignore: "Ignore",
      metricSummary: (centroid: string, label: string, evidence: string, score: string) =>
        `centroid ${centroid} · label ${label} · evidence ${evidence} · score ${score}`,
      recommendations: {
        auto_merge: "High confidence",
        review: "Review",
        ignore: "Ignore"
      }
    },
    lexicon: {
      title: "Label lexicon",
      body: "Stopwords, protected terms, and filters affect explainability labels only; they do not affect ranking or request embeddings.",
      stopwordsAdd: "Custom stopwords",
      protectedTermsAdd: "Custom protected terms",
      stopwordPlaceholder: "article / affiliation / URL residue",
      addStopword: "Add stopword",
      noStopwords: "No custom stopwords yet.",
      saveAndRebuild: "Save and rebuild cluster labels"
    },
    maintenance: {
      disclosureHint: "If the system is running normally, you do not need to run these manually.",
      body:
        "These tasks maintain local personalization state. Tasks that might call the provider are called out separately; when unsure, start with ranking recalculation or recent intent rebuild.",
      run: "Run",
      running: "Queuing",
      remoteUse: "Remote use",
      lastState: "Last state",
      neverRun: "No record",
      skipped: "Skipped",
      notice: (label: string, existing: boolean) =>
        existing ? `${label} already has an open job.` : `${label} was queued.`,
      tasks: {
        ranking_recalculate: {
          label: "Recalculate ranking",
          description: "Recomputes local ranking scores for For You and Read Later without requesting embeddings.",
          remoteUse: "Does not call provider"
        },
        fingerprint_backfill: {
          label: "Backfill fingerprints",
          description: "Adds missing title and summary fingerprints used by duplicate detection.",
          remoteUse: "Does not call provider"
        },
        duplicate_rebuild: {
          label: "Rebuild duplicates",
          description: "Rebuilds duplicate groups from article fingerprints to reduce repeated topics.",
          remoteUse: "Does not call provider"
        },
        keyword_rebuild: {
          label: "Rebuild keyword profile",
          description: "Rebuilds the keyword profile from local behavior and article text, using snapshots when articles were cleaned up.",
          remoteUse: "Does not call provider"
        },
        cluster_label_rebuild: {
          label: "Rebuild cluster labels",
          description: "Refreshes cluster display labels from local evidence articles, profile keywords, and feed titles.",
          remoteUse: "Does not call provider"
        },
        cluster_merge_diagnostics: {
          label: "Rebuild cluster merge diagnostics",
          description: "Generates possible duplicate-cluster candidates without changing the profile or ranking.",
          remoteUse: "Does not call provider"
        },
        interest_family_rebuild: {
          label: "Rebuild topic groups",
          description: "Groups nearby interest clusters into internal topic groups for diversity and diagnostics.",
          remoteUse: "Does not call provider"
        },
        cluster_auto_merge: {
          label: "Auto-merge high-confidence clusters",
          description: "Only runs when enabled; merging changes the profile and triggers ranking recalculation.",
          remoteUse: "Does not call provider"
        },
        recent_intent_rebuild: {
          label: "Rebuild recent intent",
          description: "Refreshes short-term interests from recent reading behavior.",
          remoteUse: "Does not call provider"
        },
        ftrl_train: {
          label: "Train local ranker",
          description: "Trains the lightweight local ranking model from behavior samples without automatically promoting it.",
          remoteUse: "Does not call provider"
        },
        evaluation: {
          label: "Run ranking evaluation",
          description: "Runs local replay diagnostics to check whether personalization is working.",
          remoteUse: "Does not call provider"
        },
        ftrl_promote: {
          label: "Promote local model",
          description: "Adds the shadow model to active ranking with capped weight when sample quality is sufficient.",
          remoteUse: "Does not call provider"
        },
        ftrl_reset: {
          label: "Reset local model",
          description: "Clears FTRL weights and samples; use only when model state is clearly wrong.",
          remoteUse: "Does not call provider"
        }
      }
    },
    terms: [
      {
        term: "Embedding",
        description:
          "An embedding is the vector representation of article content. Dibao uses it to compare articles with interest clusters; the provider generates vectors but does not decide the final ranking."
      },
      {
        term: "User profile card",
        description:
          "Dibao does not write one static card per article. It turns your behavior into positive and negative interest clusters, source preferences, and article state. Ranking compares candidate article vectors with those clusters."
      },
      {
        term: "Interest cluster",
        description:
          "An interest cluster is a topic centroid merged from similar article vectors. Likes, favorites, Read Later saves, and completed reads strengthen positive clusters; not-interested and hidden actions create negative clusters."
      },
      {
        term: "Coverage",
        description:
          "Coverage means how many rankable articles already have embeddings. When coverage is low, new articles can still appear, but Dibao relies more on freshness, source, and state."
      },
      {
        term: "Baseline ranking",
        description:
          "When there is no provider, no embedding, or not enough profile signal, Dibao uses baseline ranking: time, source weight, and explicit article state, without semantic similarity matching."
      },
      {
        term: "MMR",
        description:
          "MMR lightly diversifies similar articles so one topic does not fill the list. Cocoon level changes how much diversity is applied."
      }
    ],
    algorithmExplanation: [
      {
        name: "Candidate collection",
        role: "Builds the candidate pool from channel, source, folder, unread/today filters, and pagination."
      },
      {
        name: "Visibility filter",
        role: "Hidden, not-interested, and deleted articles leave normal lists while favorites and Read Later keep their queue semantics."
      },
      {
        name: "Semantic matching",
        role: "When an active embedding index exists, compares candidate articles with positive and negative interest clusters."
      },
      {
        name: "Source and freshness",
        role: "Combines manual source weight, feed_stats source preference, and time decay so the RSS timeline remains explainable."
      },
      {
        name: "State and negative feedback",
        role: "Favorites, likes, Read Later saves, and reading progress boost ranking; not interested clears other states and lowers similar topics."
      },
      {
        name: "Dedupe and MMR",
        role: "Near-duplicate, exposure, and diversity corrections are applied near the end to reduce repeated topics."
      },
      {
        name: "Fallback",
        role: "If provider, index, coverage, or profile data is insufficient, Dibao falls back to baseline ranking while reading remains available."
      }
    ],
    scoreTable: {
      columns: {
        behavior: "Behavior",
        modelCard: "Profile score",
        source: "Source preference",
        ranking: "Short-term ranking",
        notes: "Notes"
      },
      rows: [
        {
          behavior: "Scrolled past unopened / ignored",
          modelCard: "0",
          source: "-0.05",
          ranking: "-0.025, state -0.08",
          notes: "Weak negative signal. It means the title did not attract you; it does not create a negative cluster by itself."
        },
        {
          behavior: "Opened article",
          modelCard: "0",
          source: "+0.02",
          ranking: "+0.005, state +0.015 to +0.02",
          notes: "Very light positive signal. Opening is not the same as reading; it mainly restores an ignored article to opened."
        },
        {
          behavior: "Read 25%",
          modelCard: "+1.2",
          source: "0",
          ranking: "+0.01",
          notes: "Very light interest signal. Dibao only applies the highest progress-tier delta."
        },
        {
          behavior: "Read 50%",
          modelCard: "+2.0",
          source: "0",
          ranking: "+0.04",
          notes: "Starts to count as meaningful reading."
        },
        {
          behavior: "Read 75%",
          modelCard: "+3.0",
          source: "0",
          ranking: "+0.06",
          notes: "Strong reading signal."
        },
        {
          behavior: "Completed / 90%",
          modelCard: "+4.0",
          source: "+1.0",
          ranking: "+0.10, read state -0.08",
          notes: "Shows the topic was valuable, but finished articles are slightly lowered so they do not keep resurfacing."
        },
        {
          behavior: "Save for later",
          modelCard: "+3.0",
          source: "+1.0",
          ranking: "+0.08, state +0.08",
          notes: "Read later is a to-read queue, and the page still uses personalized ranking."
        },
        {
          behavior: "Favorite",
          modelCard: "+6.0",
          source: "+2.0",
          ranking: "+0.12, state +0.04",
          notes: "Favorites are library/bookmark signals. The favorites channel does not use personalized sorting by default."
        },
        {
          behavior: "Like",
          modelCard: "+8.0",
          source: "+3.0",
          ranking: "+0.16, state +0.10",
          notes: "The strongest positive signal. It explicitly asks for more similar topics."
        },
        {
          behavior: "Unlike",
          modelCard: "-1.0",
          source: "-0.4",
          ranking: "-0.04",
          notes: "Weak correction. It does not create a new strong negative cluster by default."
        },
        {
          behavior: "Not interested",
          modelCard: "-6.0",
          source: "-2.5",
          ranking: "Current article filtered, similar topics up to -0.45",
          notes: "Strong negative feedback. It creates a negative cluster and lowers similar candidates."
        }
      ]
    },
    rankingFlowDiagram: [
      {
        phase: "Candidates",
        title: "Collect candidates",
        description: "Channel, source, folder, unread filter, and cursor form the candidate pool."
      },
      {
        phase: "Filter",
        title: "Remove invisible items",
        description: "Hidden, not-interested, and deleted articles leave normal lists."
      },
      {
        phase: "State",
        title: "Read article state",
        description: "Favorite, like, read later, depth, ignored, and opened feed into state score."
      },
      {
        phase: "Source",
        title: "Calculate source preference",
        description: "Manual source weight and feed_stats are combined into source score."
      },
      {
        phase: "Time",
        title: "Calculate freshness",
        description: "Published or discovered time drives freshness score with a roughly 36-hour half-life."
      },
      {
        phase: "Profile",
        title: "Match the profile card",
        description: "With an active embedding index, vectors match positive and negative interest clusters."
      },
      {
        phase: "Blend",
        title: "Blend ranking score",
        description: "Interest, source, freshness, state, and negative penalty form the active rank score."
      },
      {
        phase: "Output",
        title: "Return by channel",
        description: "Latest uses time; For You and Read Later use personalization; Favorites uses saved time."
      }
    ],
    channelRules: [
      "Latest: time-descending by default. Only unread filters derived unread state without changing the sort meaning.",
      "For You: personalized ranking. If the profile card or embeddings are missing, Dibao falls back to baseline ranking.",
      "Read Later: shows only saved-for-later articles, but still uses personalized ranking as a to-read queue.",
      "Favorites: library/bookmark mode. It sorts by favorited time by default and can switch between favorited time and published time; it does not use personalized ranking."
    ],
    copy: {
      localData:
        "Dibao stores raw behavior events, article state, reading progress, source preference, interest clusters, embedding provider configuration, and index status locally. API keys currently use the MVP local SQLite storage strategy.",
      fallback:
        "Dibao falls back to baseline ranking when a provider is not configured, index coverage is low, provider requests fail, an article has no embedding, or diagnostics are unavailable. Fallback never blocks reading."
    }
  },
  recommendationStatus: {
    title: "Personalization status",
    loading: "Loading personalization status",
    fallback: "Personalization status is unavailable; the list is still readable.",
    warmupNotice:
      "Your reading behavior is still accumulating, so recommendations may be inaccurate. Use Latest as a regular RSS reader for now.",
    modes: {
      baseline: "Baseline ranking",
      personalized: "Personalized ranking is on",
      embedding: "Generating embeddings",
      degraded: "Provider issue, fallback active"
    },
    metrics: {
      behaviorCount: (count: number) => `${count} behaviors`,
      coverage: (ratio: string) => `Coverage ${ratio}`,
      clusters: (positive: number, negative: number) => `Clusters +${positive} / -${negative}`,
      lastUpdate: (ranking: string, profile: string) => `Rank ${ranking} · Profile ${profile}`,
      unknown: "Unavailable"
    }
  },
  recommendationInventory: {
    eyebrow: "Ranked stock",
    close: "Close recommendation inventory",
    connectionError: "Recommendation inventory is disconnected for now; Dibao will reconnect.",
    emptyNotice:
      "The ranked inventory has been exhausted. Loading more will use the fallback sequence, which may be less relevant; you can wait for backend ranking to finish.",
    rankingNotice:
      "Backend ranking is running. If ranked inventory runs out, loading more will temporarily use the fallback sequence; the stock updates automatically when ranking finishes.",
    systemTitle: "System summary",
    open: (status: string) => `View recommendation inventory: ${status}`,
    statuses: {
      available: "In stock",
      empty: "No stock",
      ranking: "Ranking",
      loading: "Loading",
      unavailable: "Unknown"
    },
    summaries: {
      available: (remaining: number, total: number) =>
        `This recommendation sequence has ${remaining} ranked articles remaining out of ${total} ranked articles.`,
      empty: (fallback: number) =>
        `No ranked articles remain in this sequence. About ${fallback} fallback articles are available and may be less relevant.`,
      ranking: (remaining: number, running: number, queued: number) =>
        `Backend ranking has ${running} running and ${queued} queued jobs; ${remaining} ranked articles remain.`,
      loading: "Loading recommendation inventory.",
      unavailable: "Recommendation inventory is unavailable."
    },
    metrics: {
      remainingSorted: "Ranked remaining",
      sortedTotal: "Ranked total",
      latestActive: "Latest ranked",
      staleActive: "Older ranked",
      loaded: "Loaded",
      fallback: "Fallback",
      unrankedFallback: "Unranked fallback",
      rankingJobs: "Ranking jobs",
      rankContext: "Rank context",
      lastRankedAt: "Last ranked",
      updatedAt: "Updated",
      rankingJobValue: (running: number, queued: number) => `${running} running · ${queued} queued`
    }
  },
  reader: {
    originalLink: "Original",
    backToList: "Back to list",
    reload: "Reload",
    selectArticleTitle: "Select an article",
    selectArticleBody: "Article details will open here.",
    feedOnlyNotice: "Only the feed summary is available.",
    contentSource: {
      success: "Body content comes from full web article fetching.",
      feed_only: "Body content comes from the RSS / Atom feed.",
      failed: "Full web article fetching failed; current content is from the feed.",
      failedWithError: (error: string) =>
        `Full web article fetching failed; current content is from the feed. ${error}`,
      skipped: "Full web article content was not used; current content is from the feed.",
      pending: "Body processing is pending; current content is feed content or summary.",
      noContent: "No body content is available."
    },
    discovery: {
      relatedTitle: "Related Articles",
      relatedPrompt: "Want to keep exploring this topic?",
      relatedIntro: "Find articles close to what you just read",
      relatedButton: "Find Related Articles",
      relatedLoading: "Finding related articles...",
      relatedEmpty: "No suitable related articles found yet.",
      relatedError: "Related articles failed to load.",
      more: "More",
      personalizedTitle: "You Might Also Like",
      personalizedLoading: "Picking articles for you...",
      personalizedEmpty: "No suitable continue-reading picks found yet.",
      personalizedError: "Continue-reading picks failed to load.",
      retry: "Retry",
      unavailable: {
        no_active_embedding: "This article does not have an available semantic index yet.",
        article_embedding_missing: "This article does not have an available semantic index yet.",
        insufficient_candidates: "There are not enough candidate articles yet."
      }
    },
    noContent: "This article has no body content yet.",
    meta: (feedTitle: string, date?: string, author?: string | null) =>
      [feedTitle, date, author].filter(Boolean).join(" · ")
  },
  fullContentPreview: {
    pageTitle: "Full Content Preview",
    status: "Preview does not write to the database",
    kicker: "Content preview",
    back: "Back to feed management",
    reload: "Preview again",
    loading: "Previewing",
    articleUrl: "Article URL",
    resultStatus: "Status",
    extractedTitle: "Extracted title",
    statuses: {
      success: "Success",
      failed: "Failed",
      skipped: "Skipped"
    },
    noPreview: "No preview is available.",
    noDbWrite: "This does not affect existing feed content."
  },
  explanation: {
    title: "Why this article",
    entryTitle: "Why this article",
    open: "View reasons",
    teaser: "Shows the main signals without exposing raw internal scores.",
    lazy: "Reasons appear after you pass the halfway point.",
    sortLabel: "Sorting note",
    sortTitle: "How this view is sorted",
    loading: "Loading reasons",
    empty: "No clear ranking signal yet.",
    generatedAt: (date: string) => `Generated ${date}`,
    sorting: {
      latest: "This view is currently sorted by published time.",
      recommended: "For You combines your profile card, source preference, freshness, and article state.",
      favorites: "Favorites are sorted by saved time by default and do not use personalized ranking.",
      read_later: "Read later still uses personalized ranking so likely useful items can rise first."
    },
    types: {
      interest: "Interest",
      source: "Source",
      freshness: "Freshness",
      state: "State",
      fallback: "Baseline",
      negative: "Negative",
      penalty: "Filter",
      exploration: "Discovery"
    },
    reasons: {
      interest: "This is similar to recent positive interests, so it ranks higher.",
      interestCluster: (summary: string) =>
        `This is similar to recent positive interests, so it ranks higher. ${summary}`,
      interestFamily: (label: string) =>
        `This is close to your interest topic "${label}", so it ranks higher.`,
      recentIntent: "This matches your recent reading direction, so it ranks higher.",
      sourcePositive: (label: string) => `Source ${label} is helping this rank higher.`,
      sourceNegative: (label: string) => `Source ${label} currently has a lower weight.`,
      freshness: "The article is recent and receives a freshness boost.",
      statePositive: "Favorite, read later, or reading progress raised the rank.",
      stateNegative: "Ignored, finished, and similar states lowered its priority.",
      fallback: "Baseline ranking is active and no stronger signal is available yet.",
      negative: "Recent negative behavior lowered the rank.",
      penalty: "Hidden or not interested state strongly lowers the rank.",
      exploration:
        "This article was surfaced to broaden your feed. You can adjust the algorithm cocoon level in Settings."
    }
  },
  actions: {
    favorite: "Favorite",
    unfavorite: "Unfavorite",
    like: "Like",
    unlike: "Unlike",
    readLater: "Read later",
    removeReadLater: "Remove later",
    markRead: "Mark read",
    markUnread: "Mark unread",
    notInterested: "Not interested",
    notInterestedActive: "Not interested",
    saving: "Saving",
    aria: {
      favorite: "Favorite this article",
      unfavorite: "Unfavorite this article",
      like: "Like this article",
      unlike: "Unlike this article",
      readLater: "Save this article for later",
      removeReadLater: "Remove this article from Read Later",
      markRead: "Mark this article as read",
      markUnread: "Mark this article as unread",
      notInterested: "Show me fewer articles like this",
      notInterestedActive: "Already marked not interested",
      group: "Article actions"
    },
    errors: {
      favorite: "Favorite failed.",
      like: "Like update failed.",
      readLater: "Read later update failed.",
      readStatus: "Read status update failed.",
      notInterested: "Not interested action failed.",
      open: "Failed to record article open.",
      generic: "Action failed. Please try again."
    }
  },
  notices: {
    feedAddedAndRefreshed: (feedTitle: string) => `Added and refreshed: ${feedTitle}`,
    feedRefreshed: (feedTitle: string) => `Refreshed: ${feedTitle}`,
    allFeedsRefreshQueued: (count: number) =>
      count > 0
        ? `Queued refresh for ${count} ${count === 1 ? "feed" : "feeds"}.`
        : "No enabled feeds need refresh.",
    opmlImported: (feedsCreated: number, feedsSkipped: number, foldersCreated: number) =>
      `OPML imported: added ${feedsCreated} ${feedsCreated === 1 ? "feed" : "feeds"}, skipped ${feedsSkipped}, added ${foldersCreated} ${foldersCreated === 1 ? "folder" : "folders"}.`,
    opmlExported: "OPML exported."
  },
  pwa: {
    offline:
      "You are offline. The cached app shell can still open, but article data requires a network connection.",
    updateAvailable: "A new Dibao version is available.",
    updateNow: "Refresh to update",
    dismiss: "Later"
  },
  errors: {
    api: {
      requestFailed: "Request failed. Please try again.",
      requestTimeout: "Request timed out. Dibao may be busy with background maintenance.",
      databaseBusy: "Dibao is busy with background maintenance. Please try again shortly.",
      httpError: (status: number) => `Request failed (HTTP ${status}).`
    }
  }
} as const satisfies Dictionary;

export const jaJP = {
  common: {
    brandMark: "邸",
    brandName: "邸報",
    brandSubtitle: "Dibao",
    close: "閉じる",
    version: (version: string) => `v${version}`
  },
  navigation: {
    ariaLabel: "メインナビゲーション",
    utilityMenuLabel: "その他",
    items: {
      latest: "最新",
      recommended: "おすすめ",
      favorites: "お気に入り",
      read_later: "あとで読む",
      search: "検索",
      feeds: "フィード",
      settings: "設定"
    }
  },
  shell: {
    kicker: "RSS Ingestion",
    pageTitle: "最新記事",
    pageTitles: {
      latest: "最新記事",
      recommended: "おすすめ記事",
      favorites: "お気に入り記事",
      read_later: "あとで読む"
    },
    pageKickers: {
      latest: "Latest",
      recommended: "For You",
      favorites: "Favorites",
      read_later: "Read Later"
    },
    loadingArticles: "記事を読み込んでいます",
    latestView: "最新ビュー",
    viewStatus: {
      latest: "最新ビュー",
      recommended: "おすすめビュー",
      favorites: "お気に入りビュー",
      read_later: "あとで読むビュー"
    }
  },
  search: {
    kicker: "Search",
    pageTitle: "検索",
    title: "記事を検索",
    body: "既定ではタイトルと要約を検索します。必要な場合は全文検索を有効にできます。",
    inputLabel: "キーワード",
    inputPlaceholder: "タイトルと要約を検索",
    relatedPrefix: "関連元：",
    fullTextLabel: "全文検索",
    submit: "検索",
    submitting: "検索中",
    sortLabel: "並び順",
    sorts: {
      relevance: "関連度",
      recommended: "おすすめ優先",
      latest: "新しい順"
    },
    recommendedSortHint: "検索結果の中だけを、あなたのおすすめモデルで並び替えます。",
    relatedThresholdFooter: (threshold: string) =>
      `関連記事検索は類似しきい値>${threshold}の記事のみを表示します。`,
    stateLabel: "状態",
    advancedSearch: "詳細検索",
    hideAdvancedSearch: "詳細検索を閉じる",
    sourceLabel: "ソース",
    folderLabel: "フォルダー",
    feedLabel: "フィード",
    allSources: "すべてのソース",
    allFolders: "すべてのフォルダー",
    allFeeds: "すべてのフィード",
    dateFromLabel: "開始日",
    dateToLabel: "終了日",
    states: {
      all: "すべて",
      unread: "未読",
      read: "既読",
      favorites: "お気に入り",
      read_later: "あとで読む"
    },
    emptyTitle: "記事が見つかりません",
    emptyBody: "別のキーワードを試すか、ソース、状態、期間の条件を広げてください。",
    initialTitle: "RSS 記事ライブラリを検索",
    initialBody: "キーワードを入力すると、タイトル、要約、本文から検索できます。",
    resultsCount: (count: number) => `${count} 件の結果`,
    loadMore: "さらに読み込む"
  },
  auth: {
    loading: "ログイン状態を確認しています",
    setupStatusLoading: "インスタンス状態を確認しています",
    retry: "再確認",
    setupTitle: "ユーザー名とアクセスパスワードを設定",
    setupBody: "これは単一ユーザー向けのセルフホスト環境です。ユーザー名とアクセスパスワードを設定すると、リーダーを開けます。",
    loginTitle: "邸報にログイン",
    loginBody: "ユーザー名とアクセスパスワードを入力してください。",
    usernameLabel: "ユーザー名",
    usernamePlaceholder: "ユーザー名を入力",
    passwordLabel: "アクセスパスワード",
    passwordPlaceholder: "8 文字以上",
    setupSubmit: "設定を完了",
    loginSubmit: "ログイン",
    submitting: "処理中",
    telemetryLabel: "邸報の改善に役立つフィードバックデータを共有する",
    telemetryBody: "既定でオンです。エラー診断、パフォーマンス分析、使い勝手の改善に使われます。設定でいつでもオフにできます。",
    logout: "ログアウト",
    logoutTitle: "ログアウト",
    usernameRequired: "ユーザー名を入力してください。",
    passwordRequired: "アクセスパスワードを入力してください。",
    errors: {
      session: "ログイン状態を取得できませんでした。",
      setupStatus: "インスタンス状態を取得できませんでした。",
      logout: "ログアウトに失敗しました。"
    }
  },
  upgrade: {
    kicker: "バージョンアップ",
    title: "おすすめプロファイルを再構築しています",
    body: "旧バージョンで作成された興味クラスターデータを修復しています。古いプロファイルが推薦に影響しないよう、完了までリーダーを一時停止します。",
    failedBody: "おすすめプロファイルの再構築が完了しませんでした。必要に応じてサーバーログを確認し、もう一度お試しください。",
    progressLabel: "アップグレード進捗",
    costNote: "この移行では、クラスター、トピックファミリー、ラベル、並び替えなどの派生データだけを再構築します。Embedding は再生成せず、追加の Embedding API 費用は発生しません。",
    progress: (current: number, total: number, percent: number) =>
      total > 0 ? `${current} / ${total} 件の記事 · ${percent}%` : "データを準備しています",
    retry: "再構築を再試行",
    retrying: "再試行中",
    steps: {
      detecting: "修復対象のデータを確認",
      schemaMigration: "データベース構造を更新",
      reset: "古いクラスターとファミリーを削除",
      replay: "読書シグナルを再生",
      labels: "クラスターラベルを再構築",
      families: "興味ファミリーを再構築",
      ranking: "おすすめ順を再計算",
      completed: "再構築が完了",
      failed: "再構築に失敗",
      skipped: "再構築は不要"
    }
  },
  setup: {
    kicker: "初期設定",
    welcome: {
      title: "邸報へようこそ",
      body: "セルフホストできる個人用 RSS おすすめリーダーです。必要な設定を済ませてから、リーダーを開きます。",
      start: "設定を始める"
    },
    sources: {
      title: "フィードを追加",
      body: "OPML ファイルをインポートするか、RSS / Atom フィードを手動で追加します。続行するには少なくとも 1 つのフィードが必要です。",
      importOpml: "OPML ファイルをインポート",
      addFeed: "フィードを追加",
      noFeedsAfterImport: "インポートは完了しましたが、新しいフィードは作成されませんでした。OPML ファイルを確認するか、RSS / Atom URL を手動で追加してください。",
      noFeedsAfterAdd: "フィードを作成できませんでした。もう一度お試しください。"
    },
    provider: {
      title: "おすすめ機能",
      body: "Embedding provider を設定すると、記事の意味と読書行動を使って、より自分向けのフィードを作れます。",
      recommendationLink: "こちらを見て、適した無料 Provider を選んでください。",
      currentTitle: "スキップも選べます",
      currentBody: "ここで設定しなくても、閲覧、お気に入り、あとで読む、基本の並び替えは利用できます。",
      saveAndTest: "プロファイルを保存して接続テスト",
      enableAndContinue: "Provider を有効化して続行",
      useProviderAndContinue: "この Provider で続行",
      saving: "保存中",
      testRequired: "Provider を有効化する前に、プロファイルを保存して接続テストを成功させてください。",
      testStale: "プロファイルが変更されています。有効化する前に接続テストをやり直してください。",
      continue: "スキップして基本の並び替えを使う"
    }
  },
  feeds: {
    kicker: "フィード",
    title: "フィード",
    inputLabel: "Web サイトまたは RSS / Atom URL",
    inputPlaceholder: "https://example.com または https://example.com/feed.xml",
    add: "追加",
    adding: "追加中",
    allFeeds: "すべてのフィード",
    sourceCount: (count: number) => `${count} 件のソース`,
    feedUrlRequired: "Web サイトまたは RSS / Atom URL を入力してください。",
    successAt: (date: string) => `成功：${date}`,
    nextRefreshAt: (date: string) => `次回取得：${date}`,
    refresh: "更新",
    refreshing: "…",
    refreshAll: "すべて更新",
    refreshingAll: "キューに追加中",
    openSources: "ソース",
    openSourcesLabel: "ソースを開く",
    closeSources: "ソースを閉じる",
    refreshTitle: (feedTitle: string) => `${feedTitle} を更新`
  },
  feedDiscovery: {
    inputLabel: "Web サイトまたは RSS / Atom URL",
    inputPlaceholder: "https://example.com または https://example.com/feed.xml",
    check: "確認",
    checking: "確認中",
    candidatesTitle: "見つかったフィード",
    noCandidatesTitle: "利用できるフィードが見つかりません",
    noCandidatesBody: "RSS / Atom URL を直接入力するか、サイトがフィードを公開しているか確認してください。",
    addCandidate: "このフィードを追加",
    addingCandidate: "追加中",
    duplicate: "購読済み",
    invalid: "利用不可",
    valid: "追加できます",
    statuses: {
      valid: "追加できます",
      duplicate: "購読済み",
      invalid: "利用不可"
    },
    recentItems: "最近の記事",
    itemCount: (count: number) => `${count} 件の記事`,
    warningsTitle: "メモ",
    errors: {
      urlRequired: "Web サイトまたは RSS / Atom URL を入力してください。",
      discoverFailed: "フィードの確認に失敗しました。しばらくしてからもう一度お試しください。"
    }
  },
  feedDiagnostics: {
    title: "フィードの状態",
    summary: (total: number, error: number, warning: number) =>
      `${total} 件のフィード · ${error} 件のエラー · ${warning} 件は確認が必要`,
    filters: {
      all: "すべて",
      unhealthy: "問題のみ",
      disabled: "無効",
      neverFetched: "成功履歴なし"
    },
    statuses: {
      healthy: "正常",
      never_fetched: "未取得",
      due: "取得待ち",
      stale: "長期間成功なし",
      failing: "取得失敗",
      disabled: "無効"
    },
    fields: {
      lastFetchedAt: "最終取得",
      lastSuccessAt: "最終成功",
      nextRefreshAt: "次回取得",
      lastError: "最新エラー"
    },
    messages: {
      OK: "フィード取得は正常です。",
      DISABLED: "このフィードは無効です。",
      NEVER_FETCHED: "このフィードはまだ取得されていません。",
      DUE: "このフィードは取得時刻を過ぎています。",
      STALE: "7 日以上、取得に成功していません。",
      FETCH_FAILED: "直近のフィード取得に失敗しました。"
    },
    retry: "再取得",
    noIssues: "問題のあるフィードはありません。"
  },
  folders: {
    title: "フォルダー",
    feedCount: (count: number) => `${count} 件のフィード`
  },
  feedManagement: {
    kicker: "Feed Management",
    pageTitle: "フィード管理",
    loading: "フィードを読み込んでいます",
    status: (feedCount: number, folderCount: number) =>
      `${feedCount} 件のフィード · ${folderCount} 件のフォルダー`,
    na: "なし",
    tabs: {
      label: "フィード管理ビュー",
      feeds: "フィード管理",
      folders: "フィードフォルダー管理"
    },
    folders: {
      kicker: "Folders",
      title: "フォルダー",
      newLabel: "新しいフォルダー",
      newPlaceholder: "例：テクノロジー",
      create: "作成",
      emptyTitle: "フォルダーはまだありません",
      emptyBody: "フォルダーを作成すると、フィードをまとめて整理できます。",
      managementHint: "ここでフォルダー名を管理し、フォルダー内の記事も直接開けます。",
      renameLabel: (title: string) => `${title} の名前を変更`,
      confirmDelete: "削除を確認",
      deleteHint: "フォルダーを削除してもフィードは削除されません。フィードは未分類へ移動します。"
    },
    operations: {
      kicker: "Operations",
      title: "インポート、エクスポート、更新"
    },
    feeds: {
      kicker: "Feeds",
      title: "フィード",
      addFeed: "フィードを追加",
      emptyTitle: "フィードはまだありません",
      emptyBody: "リーダーのサイドバーから RSS / Atom フィードを追加するか、OPML をインポートしてください。",
      ungrouped: "未分類",
      enabled: "有効",
      disabled: "無効",
      weight: (value: number) => `重み ${value}`,
      lastSuccess: (value: string) => `最終成功：${value}`,
      nextRefresh: (value: string) => `次回取得：${value}`,
      confirmDelete: "削除を確認",
      deleteHint: "フィードを削除しても過去の記事は物理削除されませんが、記事一覧には表示されなくなります。"
    },
    editor: {
      kicker: "Edit feed",
      titleLabel: "タイトル",
      feedUrlLabel: "Feed URL",
      folderLabel: "フォルダー",
      enabledLabel: "フィードを有効にする",
      sourceWeightLabel: "ソースの重み",
      lastFetchedAt: "最終取得",
      lastSuccessAt: "最終成功",
      nextRefreshAt: "次回取得",
      lastError: "最新エラー",
      emptyTitle: "フィードを選択",
      emptyBody: "フィードを選択すると、タイトル、フォルダー、有効状態、ソースの重みを編集できます。"
    },
    fullContent: {
      label: "本文ソース",
      modes: {
        feed_only: "Feed の内容を使用（既定）",
        fetch_full_content: "Web 記事全文を取得"
      },
      feedOnlyHint: "全文配信の RSS では、多くの場合これが高速で安定しています。",
      fetchHint:
        "要約のみの RSS に向いています。失敗する場合があり、ペイウォールは回避しません。",
      preview: "全文取得をプレビュー",
      backfill: "現在の Feed 記事を取得",
      backfilling: "取得中",
      backfillConfirm:
        "現在の RSS を再読み込みし、その RSS にまだ含まれている記事だけを対象に Web 全文を取得します。このフィードの全履歴は走査しません。",
      stats: {
        articlesSeen: "現在の RSS 記事数",
        attempted: "試行",
        succeeded: "成功",
        failed: "失敗",
        skipped: "スキップ",
        changed: "内容変更",
        limited: "50 件制限"
      },
      limited: "先頭 50 件に制限",
      notLimited: "未実行"
    },
    actions: {
      save: "保存",
      saving: "保存中",
      cancel: "キャンセル",
      rename: "名前を変更",
      viewArticles: "記事を見る",
      delete: "削除"
    },
    errors: {
      folderTitleRequired: "フォルダー名を入力してください。",
      feedTitleRequired: "フィードのタイトルを入力してください。",
      sourceWeight: "ソースの重みは -1 から 1 までの数値で入力してください。"
    }
  },
  settings: {
    kicker: "Settings",
    pageTitle: "設定",
    loading: "設定を読み込んでいます",
    status: "設定は最新です",
    sections: {
      language: {
        title: "言語",
        body: "画面に表示する言語を選びます。保存した設定は再読み込み後も引き継がれます。",
        localeLabel: "表示言語",
        zhCN: "简体中文",
        enUS: "English",
        jaJP: "日本語",
        defaultHomeViewLabel: "最初に開く画面",
        defaultHomeViewRecommended: "おすすめ",
        defaultHomeViewLatest: "最新"
      },
      account: {
        title: "アカウントのセキュリティ",
        body: "現在のアクセスパスワードを変更します。本人確認のため、先に現在のパスワードを入力してください。",
        currentPasswordLabel: "現在のパスワード",
        newPasswordLabel: "新しいパスワード",
        confirmPasswordLabel: "新しいパスワードの確認",
        currentPasswordPlaceholder: "現在のアクセスパスワードを入力",
        newPasswordPlaceholder: "8 文字以上",
        confirmPasswordPlaceholder: "新しいパスワードをもう一度入力",
        submit: "パスワードを変更",
        submitting: "変更中",
        saved: "アクセスパスワードを更新しました。",
        errors: {
          currentRequired: "現在のパスワードを入力してください。",
          newRequired: "新しいパスワードを入力してください。",
          confirmRequired: "新しいパスワードをもう一度入力してください。",
          mismatch: "新しいパスワードが一致しません。"
        }
      },
      behavior: {
        title: "行動の記録",
        body: "記事一覧とあとで読むキューで、自動的に記録する閲覧行動を管理します。",
        algorithmTransparencyLink: "アルゴリズムの透明性を見る",
        markScrolledArticlesIgnored: "開かずに通過した記事を無視済みにし、未読から外す",
        removeReadLaterOnReadComplete: "あとで読むの記事を読み終えたら、あとで読むから外す",
        infiniteArticleLoading: "無限読み込み：一覧の末尾までスクロールすると次の記事を自動で読み込む",
        cocoonLevel: "パーソナライズ度",
        cocoonLevelHint: "1 はより開かれた分散的な探索、10 はより個人に合わせた安定的で控えめな変化です。どのレベルでも購読フィード内だけで並び替え、重複排除と明示的な低評価を尊重します。",
        interestClusterLimits: {
          title: "興味クラスタの上限",
          body: "興味クラスタは多ければよいとは限りません。毎日の Inbox 記事が少ない場合や購読フィードが集中している場合は、少なめのクラスタのほうがおすすめが安定することがあります。",
          embeddingCostHint:
            "上限を上げると主にローカルの並び替えとベクトル類似度計算の負荷が増えます。外部 Embedding 呼び出しが比例して増えるわけではありません。",
          performancePreset: "性能プリセット",
          presets: [
            "低スペック VPS：24 / 16 · 8 / 6",
            "中程度の NAS：48 / 32 · 16 / 12",
            "高性能サーバーまたはローカル PC：96 / 64 · 28 / 20"
          ],
          customPreset: "カスタム",
          positiveLabel: "正方向の興味クラスタ",
          negativeLabel: "負方向の興味クラスタ",
          positiveFamilyLabel: "正方向のテーマグループ",
          negativeFamilyLabel: "負方向のテーマグループ",
          fieldHint:
            "クラスタは記事との精密な照合に使い、テーマグループは説明と多様性に使います。テーマグループ上限は成熟したグループだけを制限し、余りを無理にまとめません。"
        }
      },
      telemetry: {
        title: "フィードバック送信",
        body: "邸報の改善に役立てるため、エラー、パフォーマンス、利用体験に関するフィードバックデータを送信するかを管理します。",
        enabledLabel: "邸報の改善に役立つフィードバックデータを共有する",
        enabledBody: "既定でオンです。オフにすると、ブラウザーとサーバーから新しい Sentry テレメトリーイベントを送信しません。"
      },
      reader: {
        title: "読書",
        body: "記事本文の読みやすさと密度を調整します。変更はすぐにリーダーへ反映されます。",
        fontSize: "文字サイズ",
        lineHeight: "行間",
        paragraphGap: "段落間隔",
        readerWidth: "本文幅"
      },
      retention: {
        title: "記事の保持",
        body: "保持期間を過ぎた記事はバックグラウンドで整理されます。0 を指定すると永続保持です。お気に入りとあとで読むは個別に保持できます。",
        retentionDays: "保持日数",
        keepFavorites: "お気に入り記事を保持",
        keepReadLater: "あとで読む記事を保持",
        enabled: "オン",
        disabled: "オフ",
        cleanupConfirm:
          "保持期間を過ぎた過去の記事は削除され、復元できません。整理はバックグラウンドキューに入り、設定保存中に同期実行されません。続行しますか？",
        mappingHint: "API フィールド retention.retentionDays は storage key retention.articleDays に保存されます。"
      },
      about: {
        title: "このアプリについて",
        body: "バージョン、作者、プロジェクトリンクです。",
        version: "現在のバージョン",
        latestVersion: "最新バージョン",
        latestLoading: "最新バージョンを確認中",
        latestUnknown: "まだ確認していません",
        latestUnavailable: "GitHub Release はまだありません",
        latestCurrent: (version: string) => `最新です：${version}`,
        latestUpdateAvailable: (version: string) => `新しいバージョンがあります：${version}`,
        latestError: (message: string) => `確認に失敗しました：${message}`,
        latestCheckedAt: (value: string) => `前回確認：${value}`,
        latestNeverChecked: "確認履歴はまだありません",
        checkRelease: "更新を確認",
        checkingRelease: "確認中",
        releaseLink: "Release を表示",
        author: "作者",
        authorName: "Pls",
        telemetryLabel: "フィードバックデータ",
        telemetryBody:
          "邸報の改善に使うエラー、パフォーマンス、利用体験のフィードバックデータを開発者へ送信するかを管理します。",
        xAccount: "X アカウント",
        blog: "作者ブログ",
        homepage: "プロジェクトサイト",
        github: "プロジェクト GitHub"
      },
      provider: {
        title: "インテリジェンス",
        body: "OpenAI 互換、Gemini AI Studio、Ollama の embedding provider を設定します。有効な provider がない場合、邸報は基本の並び替えを使い続けます。",
        loading: "インテリジェンス設定を読み込んでいます",
        providerLabel: "Provider",
        newProvider: "新しい embedding provider",
        typeLabel: "種類",
        openaiCompatible: "OpenAI 互換",
        gemini: "Gemini AI Studio",
        ollama: "Ollama",
        nameLabel: "名前",
        baseUrlLabel: "Base URL",
        baseUrlPlaceholder: "https://api.example.com/v1",
        geminiBaseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta",
        ollamaBaseUrlPlaceholder: "http://127.0.0.1:11434",
        modelLabel: "モデル",
        modelPlaceholder: "text-embedding-3-small",
        geminiModelPlaceholder: "gemini-embedding-001",
        ollamaModelPlaceholder: "nomic-embed-text",
        dimensionLabel: "次元数",
        textMaxCharsLabel: "テキスト切り出し長（文字）",
        requestsPerMinuteLabel: "QPM（分あたり batch リクエスト）",
        requestsPerDayLabel: "QPD（日あたり batch リクエスト）",
        unlimitedPlaceholder: "空欄なら無制限",
        apiKeyLabel: "API Key",
        apiKeyPlaceholder: "エンドポイントに応じて任意で入力",
        apiKeyRetainPlaceholder: "空欄なら保存済みのキーを保持",
        ollamaApiKeyHint: "ローカルの Ollama API は通常 API key を必要としません。",
        geminiApiKeyHint: "Gemini AI Studio は Gemini embedding API 呼び出し時に x-goog-api-key を使います。",
        modelHint: "注意：モデル系列、次元数、テキスト切り出し長を変えると新しいベクトル空間が作成されます。既存のベクトルは再利用されず、新しい index の生成後に意味的なおすすめが回復します。",
        textMaxCharsHint: "注意：テキスト切り出し長を変えると既存ベクトルと新しい方針が一致しなくなります。保存して現在の Provider にすると新しい active index が作成されるため、ベクトルの再生成または補完を行ってください。",
        ollamaTextMaxCharsHint: "中国語コンテンツでは Ollama の切り出し長を 4000 文字以下にしてください。bge-m3 などで文脈長エラーが続く場合は 3000 を試してください。",
        rateLimitHint: "QPM/QPD は batch リクエスト単位で数えます。QPM に達すると次の分まで待機し、QPD に達するとローカル日付の翌日まで停止します。空欄なら制限しません。",
        activateHint: "保存だけではプロファイルを更新するだけです。「現在の Provider にする」を押した時だけ、embedding 生成、active index、おすすめで使う Provider が切り替わります。",
        activeTitle: "現在の Provider",
        activeEmptyTitle: "現在の Provider はありません",
        activeBody: (name: string, model: string, dimension: number) =>
          `${name} · ${model} / ${dimension}`,
        activeEmptyBody: "邸報は基本の並び替えを使い続けます。まず provider プロファイルを保存し、それを現在の Provider にしてください。",
        profileListLabel: "Provider プロファイル",
        currentBadge: "現在",
        profileBadge: "プロファイル",
        qualityTierLabel: "品質レベル",
        quality: {
          basic: "基本",
          recommended: "推奨",
          bestQuality: "高品質"
        },
        enabledStatus: "有効",
        disabledStatus: "無効",
        disabled: "未設定",
        lastTestSuccess: (value: string) => `接続テスト成功：${value}`,
        lastTestFailed: (value: string) => `接続テスト失敗：${value}`,
        lastTestUnknown: "接続テストはまだ実行されていません。",
        save: "プロファイルを保存",
        saving: "保存中",
        activate: "現在の Provider にする",
        activating: "切り替え中",
        activeActionCurrent: "すでに現在の Provider です",
        test: "接続をテスト",
        testing: "テスト中",
        delete: "削除",
        deleting: "削除中",
        deleteHint: "embedding index を持つ provider は削除できません。使わない場合は、別の互換 Provider に切り替えてください。",
        indexesTitle: "Embedding indexes",
        connectionStatusTitle: "接続テスト状態",
        embeddingJobStatusTitle: "Embedding job 状態",
        indexesBody: "Index には coverage、キュー状態、直近の失敗が表示されます。接続テストと embedding job の状態は別々に扱います。",
        usageWindowLabel: "Embedding 使用量の期間",
        usageWindows: {
          "24h": "24H",
          "7d": "7日",
          "30d": "30日"
        },
        usage: (itemCount: number, requestCount: number, estimatedTokens: number) =>
          `ローカル推定：${itemCount} inputs · ${requestCount} batch リクエスト · ${estimatedTokens} tokens`,
        noIndexes: "現在の Provider にすると active index が作成されます。",
        indexStatus: (model: string, status: string, count: number) =>
          `${model} · ${status} · ${count} 件の embedding`,
        coverage: (embeddingCount: number, candidateCount: number, ratio: string) =>
          `${embeddingCount} / ${candidateCount} · ${ratio}`,
        indexTotal: (count: number) => `Index 合計：${count} 件の embedding`,
        coverageUnavailable: "Coverage は利用できません",
        pendingJobs: (count: number) => `${count} 件待機中`,
        failedJobs: (count: number) => `${count} 件失敗`,
        lastFailedAt: (value: string) => `最終失敗：${value}`,
        lastError: (value: string) => `エラー：${value}`,
        noJobFailures: "embedding job の失敗はありません。",
        rebuild: "ベクトル index を再構築",
        rebuilding: "キューに追加済み",
        backfill: "不足ベクトルを補完",
        backfilling: "キューに追加済み",
        notices: {
          saved: "Embedding provider を保存しました。",
          activated: "現在の embedding provider を切り替えました。",
          tested: "接続テストに成功しました。",
          deleted: "Embedding provider を削除しました。",
          rebuildQueued: "Embedding index の再構築をキューに追加しました。",
          backfillQueued: "Embedding backfill をキューに追加しました。"
        },
        errors: {
          nameRequired: "Provider 名を入力してください。",
          baseUrlRequired: "Base URL を入力してください。",
          modelRequired: "モデル名を入力してください。",
          dimension: "次元数は 1 から 20000 までの整数で入力してください。",
          textMaxChars: "テキスト切り出し長は 1000 から 200000 までの整数で入力してください。",
          requestsPerMinute: "QPM は空欄、または正の整数で入力してください。",
          requestsPerDay: "QPD は空欄、または正の整数で入力してください。"
        }
      }
    },
    actions: {
      save: "設定を保存",
      saving: "保存中"
    },
    notices: {
      saved: "設定を保存しました。"
    },
    errors: {
      invalidNumber: "有効な数値を入力してください。",
      fontSize: "文字サイズは 16 から 24 の範囲で指定してください。",
      lineHeight: "行間は 1.45 から 2.1 の範囲で指定してください。",
      paragraphGap: "段落間隔は 0.6 から 1.6 の範囲で指定してください。",
      readerWidth: "本文幅は 560 から 860 の範囲で指定してください。",
      retentionDays: "保持日数は 0 から 3650 までの整数で入力してください。0 は永続保持です。",
      cocoonLevel: "パーソナライズ度は 1 から 10 までの整数で入力してください。",
      maxPositiveInterestClusters:
        "正方向の興味クラスタ上限は 8 から 192 までの整数で入力してください。",
      maxNegativeInterestClusters:
        "負方向の興味クラスタ上限は 4 から 128 までの整数で入力してください。",
      maxPositiveInterestFamilies:
        "正方向のテーマグループ上限は 2 から 64 までの整数で入力してください。",
      maxNegativeInterestFamilies:
        "負方向のテーマグループ上限は 1 から 48 までの整数で入力してください。"
    },
    units: {
      px: "px",
      days: "日",
      level: "レベル"
    }
  },
  opml: {
    import: "OPML をインポート",
    importing: "インポート中",
    export: "OPML をエクスポート",
    exporting: "エクスポート中",
    importSummary: (feedsCreated: number, feedsSkipped: number, foldersCreated: number) =>
      `${feedsCreated} 件のフィードをインポートし、${feedsSkipped} 件をスキップ、${foldersCreated} 件のフォルダーを追加しました。`,
    importErrors: (count: number) => `${count} 件の項目をインポートできませんでした。`
  },
  articles: {
    allSources: "すべてのソース",
    title: "最新",
    views: {
      latest: "最新",
      recommended: "おすすめ",
      favorites: "お気に入り",
      read_later: "あとで読む"
    },
    sort: {
      label: "並び順",
      favorited_desc: "最近お気に入りにした順",
      favorited_asc: "古くお気に入りにした順",
      ranked: "パーソナライズ",
      read_later_desc: "最近追加した順",
      read_later_asc: "古く追加した順",
      published_desc: "新しい公開順",
      published_asc: "古い公開順"
    },
    loadMore: "さらに読み込む",
    loadingMore: "読み込み中",
    retryLoadMore: "再読み込み",
    loadingSlow: "読み込みに予想より時間がかかっています。邸報はまだ読み取りを続けています。",
    emptyNoFeedsTitle: "フィードはまだありません",
    emptyNoFeedsBody: "RSS / Atom フィードを追加すると、ここに記事が表示されます。",
    emptyNoArticlesTitle: "記事はまだありません",
    emptyNoArticlesBody: "フィードを更新するか、すべてのソースに戻ってください。",
    emptyNoUnreadTitle: "未読記事はありません",
    emptyNoUnreadBody: "既読または無視済みの記事を見るには、未読のみをオフにしてください。",
    unreadOnly: "未読のみ",
    filters: {
      label: "記事フィルター",
      timeWindowTitle: "記事の期間を選択",
      timeWindows: {
        all: "すべて",
        "24h": "24H",
        "7d": "7日",
        "30d": "30日"
      },
      unreadTitle: "未読記事のみ"
    },
    itemMeta: (date: string, feedTitle: string) => `${date} · ${feedTitle}`,
    state: {
      unseen: "新着",
      ignored: "無視済み",
      opened: "開封済み",
      reading: "読書中",
      read: "読了",
      unread: "未読",
      favorited: "お気に入り",
      liked: "いいね済み",
      readLater: "あとで読む"
    }
  },
  readerCommands: {
    markScopeRead: {
      unreadWithCount: (count: number) => `未読 ${count}`,
      toggleUnread: "未読のみ",
      clear: "消化",
      clearForWindow: (window: string) =>
        window === "all" ? "消化" : window === "24h" ? "24H 以前を消化" : `${window} 以前を消化`,
      clearShort: "✓",
      clearTitle: "現在の範囲を既読にする",
      clearTitleForWindow: (window: string) =>
        window === "all" ? "すべての未読を既読にする" : `${window} より古い未読を既読にする`,
      confirmTitle: "未読を消化",
      confirmBody: (count: number) => `現在の範囲にある ${count} 件の未読記事を既読にしますか？`,
      confirmBodyForWindow: (count: number, window: string) =>
        window === "all"
          ? `${count} 件すべての未読記事を既読にしますか？`
          : `${window} より古い ${count} 件の未読記事を既読にしますか？`,
      confirmBodyLoading: "対象範囲の未読記事数を確認しています…",
      confirmBodyUnknown: "この範囲の未読記事を既読にしますか？",
      confirmHint:
        "お気に入りやあとで読むは解除されず、おすすめへの肯定的なフィードバックとしても扱われません。",
      cancel: "キャンセル",
      confirm: "既読にする",
      clearing: "処理中",
      cleared: (count: number) => `現在の範囲で ${count} 件の記事を既読にしました。`,
      nothingToClear: "現在の範囲に未読記事はありません。",
      error: "一括既読に失敗しました。もう一度お試しください。"
    }
  },
  algorithmTransparency: {
    kicker: "Personalization Details",
    pageTitle: "アルゴリズムの透明性",
    status: "アルゴリズム情報は最新です",
    backToSettings: "設定に戻る",
    noWarnings: "警告なし",
    sections: {
      currentStatus: "現在のおすすめ状態",
      currentClusters: "現在の興味クラスター",
      topicFamilies: "テーマグループ概要",
      maintenance: "アルゴリズムのメンテナンス",
      mergeCandidates: "重複候補のクラスター",
      labelLexicon: "ラベル辞書",
      algorithmExplanation: "アルゴリズム説明",
      terms: "用語",
      scoreTable: "行動スコア表",
      rankingFlow: "ランキングの流れ",
      channelRules: "チャンネルのルール",
      dataAndFallback: "ローカルデータとフォールバック"
    },
    statusTones: {
      normal: "正常",
      warning: "警告",
      stopped: "停止",
      disabled: "無効"
    },
    statusTable: {
      module: "モジュール",
      status: "状態",
      summary: "概要"
    },
    fields: {
      provider: "Provider",
      index: "Index",
      coverage: "Coverage",
      behaviorCounts: "行動数",
      clusters: "クラスター",
      lastUpdates: "最終更新",
      warnings: "警告",
      cocoon: "パーソナライズ度",
      exploration: "探索",
      formula: "現在の式",
      automaticMaintenance: "自動メンテナンス",
      failureStates: "フォールバック / タスク状態"
    },
    clusters: {
      empty: "興味クラスターはまだ形成されていません。いいね、お気に入り、あとで読む、読了によって自動的に生成されます。",
      generated:
        "興味クラスターはシステムが事前に用意したものではありません。ラベルはローカルのキーワード、代表記事、フィード名から生成され、手動で名前を変更できます。",
      positive: "ポジティブ",
      negative: "ネガティブ",
      positiveGroupTitle: "ポジティブ興味クラスター",
      negativeGroupTitle: "ネガティブ興味クラスター",
      fallbackName: (index: number) => `興味クラスター #${index}`,
      sourceLabel: "ソース",
      source: {
        manual: "ユーザー指定",
        keywords: "キーワード推定",
        representative_titles: "代表タイトル推定",
        feeds: "フィード名推定",
        fallback: "自動フォールバック"
      },
      confidenceLabel: "信頼度",
      confidence: {
        high: "高",
        medium: "中",
        low: "低"
      },
      lowConfidence: "自動推定のため、正確でない場合があります",
      lowConfidenceAdvice: "自動ラベルの信頼度が低いため、必要に応じて手動で名前を変更してください。",
      collisionResolved: "重複するクラスター名を避けるため、このラベルは自動的に区別されました。",
      possibleDuplicate: (label: string, similarity: string) =>
        `重複の可能性：${similarity} で「${label}」に類似`,
      autoInference: (label: string) => `自動推定：${label}`,
      evidence: (count: number) => `根拠記事：${count} 件`,
      generatedAt: (value: string) => `生成：${value}`,
      topTerms: "キーワード",
      representativeArticles: "代表記事",
      feedTitles: "フィード",
      rename: "名前を変更",
      renameLabel: "クラスター表示名",
      renamePlaceholder: "例：AI コーディングエージェント",
      saveLabel: "名前を保存",
      clearManualLabel: "自動ラベルに戻す",
      cancelRename: "キャンセル",
      details: (weight: string, sampleCount: number, updatedAt: string) =>
        `重み ${weight} · サンプル ${sampleCount} · 更新 ${updatedAt}`,
      diagnostics: (
        supportArticleCount: number,
        sourceCount: number,
        strongSignalRatio: string,
        topSourceShare: string,
        averageSimilarity: string
      ) =>
        `診断：根拠記事 ${supportArticleCount} · ソース ${sourceCount} · 強い信号 ${strongSignalRatio} · 最大ソース比率 ${topSourceShare} · 平均類似度 ${averageSimilarity}`,
      risk: {
        low: "過学習リスク低",
        medium: "過学習リスク中",
        high: "過学習リスク高"
      },
      matched: (name: string, similarity: string, weight: string, sampleCount: number) =>
        `あなたの興味クラスター「${name}」に類似しています。類似度 ${similarity}、クラスター重み ${weight}、サンプル ${sampleCount}。`,
      openAll: "すべての興味クラスターを見る",
      allTitle: "すべての興味クラスター",
      allSummary: (count: number) => `${count} 件の興味クラスターを重み順に表示しています。`,
      back: "透明性ページに戻る"
    },
    families: {
      empty: "テーマグループはまだ生成されていません。次回のおすすめメンテナンスで自動的に作成されます。",
      summary: (positive: number, negative: number, risk: string) =>
        `ポジティブテーマ ${positive} 件 · ネガティブテーマ ${negative} 件 · 集中リスク ${risk}`,
      rowMeta: (
        clusterCount: number,
        supportArticleCount: number,
        sourceCount: number,
        dominance: string,
        maturity: string
      ) =>
        `${clusterCount} クラスター · ${supportArticleCount} 記事 · ${sourceCount} ソース · 比率 ${dominance} · 成熟度 ${maturity}`,
      clusterFamily: "所属テーマ",
      clusterCount: (count: number) => `${count} クラスター`,
      positiveFallback: "ポジティブテーマ",
      negativeFallback: "ネガティブテーマ",
      ungroupedFallback: "テーマグループなし",
      rename: "名前を変更",
      renameLabel: "テーマグループ表示名",
      renamePlaceholder: "例: AI プロダクトと開発",
      saveLabel: "名前を保存",
      cancelRename: "キャンセル",
      clearManualLabel: "自動名に戻す",
      risk: {
        low: "低",
        medium: "中",
        high: "高"
      }
    },
    mergeCandidates: {
      title: "重複候補のクラスター",
      body: "診断は active index 内の同じ polarity のクラスターだけを比較します。マージはプロファイルを変更するため、既定では確認が必要です。",
      empty: "未処理の重複クラスター候補はありません。",
      left: "左のクラスター",
      right: "右のクラスター",
      metrics: "指標",
      recommendation: "推奨",
      actions: "操作",
      merge: "マージ",
      ignore: "無視",
      metricSummary: (centroid: string, label: string, evidence: string, score: string) =>
        `centroid ${centroid} · label ${label} · evidence ${evidence} · score ${score}`,
      recommendations: {
        auto_merge: "高信頼",
        review: "確認",
        ignore: "無視"
      }
    },
    lexicon: {
      title: "ラベル辞書",
      body: "ストップワード、保護語、フィルターは説明用ラベルだけに影響します。ランキングには影響せず、embedding も要求しません。",
      stopwordsAdd: "カスタムストップワード",
      protectedTermsAdd: "カスタム保護語",
      stopwordPlaceholder: "article / affiliation / URL の残り",
      addStopword: "ストップワードを追加",
      noStopwords: "カスタムストップワードはまだありません。",
      saveAndRebuild: "保存してクラスターラベルを再構築"
    },
    maintenance: {
      disclosureHint: "システムが正常に動作している場合、これらを手動で実行する必要はありません。",
      body:
        "これらのタスクはローカルのおすすめ状態をメンテナンスします。Provider を呼び出す可能性があるタスクは別途明示されています。迷った場合はランキング再計算または最近の意図の再構築から始めてください。",
      run: "実行",
      running: "キューに追加中",
      remoteUse: "外部利用",
      lastState: "最新状態",
      neverRun: "記録なし",
      skipped: "スキップ",
      notice: (label: string, existing: boolean) =>
        existing ? `${label} はすでに未完了ジョブがあります。` : `${label} をキューに追加しました。`,
      tasks: {
        ranking_recalculate: {
          label: "ランキングを再計算",
          description: "おすすめ一覧とあとで読む一覧のローカルランキングスコアを再計算します。embedding は要求しません。",
          remoteUse: "provider は呼び出しません"
        },
        fingerprint_backfill: {
          label: "フィンガープリントを補完",
          description: "重複検出に使うタイトルと要約のフィンガープリントを不足分だけ追加します。",
          remoteUse: "provider は呼び出しません"
        },
        duplicate_rebuild: {
          label: "重複を再構築",
          description: "記事フィンガープリントから重複グループを再構築し、同じ話題の連続を減らします。",
          remoteUse: "provider は呼び出しません"
        },
        keyword_rebuild: {
          label: "キーワードプロファイルを再構築",
          description: "ローカル行動と記事テキストからキーワードプロファイルを再構築します。記事が整理済みの場合はスナップショットを利用します。",
          remoteUse: "provider は呼び出しません"
        },
        cluster_label_rebuild: {
          label: "クラスターラベルを再構築",
          description: "ローカルの根拠記事、プロファイルキーワード、フィード名から興味クラスターの表示ラベルを更新します。",
          remoteUse: "provider は呼び出しません"
        },
        cluster_merge_diagnostics: {
          label: "クラスター重複診断を再構築",
          description: "重複している可能性がある興味クラスター候補だけを生成します。プロファイルやランキングは変更しません。",
          remoteUse: "provider は呼び出しません"
        },
        interest_family_rebuild: {
          label: "テーマグループを再構築",
          description: "近い興味クラスターを内部テーマグループにまとめ、多様性と診断に使います。",
          remoteUse: "provider は呼び出しません"
        },
        cluster_auto_merge: {
          label: "高信頼クラスターを自動マージ",
          description: "有効な場合だけ高信頼候補をマージします。マージはプロファイルを変更し、ランキング再計算を起動します。",
          remoteUse: "provider は呼び出しません"
        },
        recent_intent_rebuild: {
          label: "最近の意図を再構築",
          description: "最近の読書行動から短期的な興味を更新します。",
          remoteUse: "provider は呼び出しません"
        },
        ftrl_train: {
          label: "ローカルランカーを学習",
          description: "行動サンプルから軽量なローカルランキングモデルを学習します。既定では自動昇格しません。",
          remoteUse: "provider は呼び出しません"
        },
        evaluation: {
          label: "ランキング評価を実行",
          description: "ローカルのリプレイ診断を実行し、おすすめチェーンが健全か確認します。",
          remoteUse: "provider は呼び出しません"
        },
        ftrl_promote: {
          label: "ローカルモデルを昇格",
          description: "サンプル品質が十分な場合、shadow モデルを制限付きの重みで active ranking に追加します。",
          remoteUse: "provider は呼び出しません"
        },
        ftrl_reset: {
          label: "ローカルモデルをリセット",
          description: "FTRL の重みとサンプルを消去します。モデル状態が明らかにおかしい場合だけ使用してください。",
          remoteUse: "provider は呼び出しません"
        }
      }
    },
    terms: [
      {
        term: "Embedding",
        description:
          "Embedding は記事内容のベクトル表現です。邸報はこれを使って記事と興味クラスターの近さを比較します。provider はベクトルを生成するだけで、最終的な並び順は決めません。"
      },
      {
        term: "ユーザープロファイルカード",
        description:
          "邸報は記事ごとに静的なカードを書くのではなく、あなたの行動をポジティブ / ネガティブな興味クラスター、ソース嗜好、記事状態へ変換します。ランキング時には候補記事のベクトルをそれらのクラスターと比較します。"
      },
      {
        term: "興味クラスター",
        description:
          "興味クラスターは、類似する記事ベクトルからまとめられたトピックの中心です。いいね、お気に入り、あとで読む、読了はポジティブクラスターを強め、興味なしや非表示はネガティブクラスターを作ります。"
      },
      {
        term: "Coverage",
        description:
          "Coverage は、ランキング対象の記事のうち embedding 済みの記事がどれだけあるかを示します。低い場合でも新着記事は表示されますが、新鮮度、ソース、状態への依存が大きくなります。"
      },
      {
        term: "基本の並び替え",
        description:
          "provider、embedding、十分なプロファイル信号がない場合、邸報は基本の並び替えを使います。主に時刻、ソースの重み、明示的な記事状態を見て、意味的な類似度は使いません。"
      },
      {
        term: "MMR",
        description:
          "MMR は似た記事が一覧を埋め尽くさないよう、軽く分散させる仕組みです。パーソナライズ度によって分散の強さが変わります。"
      }
    ],
    algorithmExplanation: [
      {
        name: "候補収集",
        role: "チャンネル、ソース、フォルダー、未読 / 今日フィルター、ページングから候補プールを作ります。"
      },
      {
        name: "可視性フィルター",
        role: "非表示、興味なし、削除済みの記事は通常一覧から外れます。お気に入りとあとで読むはそれぞれのキューとして残ります。"
      },
      {
        name: "意味的マッチング",
        role: "active embedding index がある場合、候補記事とポジティブ / ネガティブ興味クラスターを比較します。"
      },
      {
        name: "ソースと新鮮度",
        role: "手動のソース重み、feed_stats のソース嗜好、時間減衰を組み合わせ、RSS タイムラインを説明可能に保ちます。"
      },
      {
        name: "状態と低評価",
        role: "お気に入り、いいね、あとで読む、読書進捗はランキングを上げます。興味なしは他の状態を解除し、類似トピックを下げます。"
      },
      {
        name: "重複排除と MMR",
        role: "近重複、露出、多様性の補正は最後の段階で適用され、同じ話題の連続を減らします。"
      },
      {
        name: "フォールバック",
        role: "provider、index、coverage、プロファイルデータが不足している場合、読書機能を保ったまま基本の並び替えへ戻ります。"
      }
    ],
    scoreTable: {
      columns: {
        behavior: "行動",
        modelCard: "プロファイルスコア",
        source: "ソース嗜好",
        ranking: "短期ランキング",
        notes: "メモ"
      },
      rows: [
        {
          behavior: "開かずに通過 / 無視",
          modelCard: "0",
          source: "-0.05",
          ranking: "-0.025, state -0.08",
          notes: "弱いネガティブ信号です。タイトルに惹かれなかったことを示すだけで、それ自体ではネガティブクラスターを作りません。"
        },
        {
          behavior: "記事を開く",
          modelCard: "0",
          source: "+0.02",
          ranking: "+0.005, state +0.015 to +0.02",
          notes: "ごく軽いポジティブ信号です。開封は読了とは異なり、主に無視済み記事を開封済みに戻すために使われます。"
        },
        {
          behavior: "25% 読む",
          modelCard: "+1.2",
          source: "0",
          ranking: "+0.01",
          notes: "非常に軽い興味信号です。邸報は最も高い進捗段階の差分だけを適用します。"
        },
        {
          behavior: "50% 読む",
          modelCard: "+2.0",
          source: "0",
          ranking: "+0.04",
          notes: "意味のある読書信号として扱い始めます。"
        },
        {
          behavior: "75% 読む",
          modelCard: "+3.0",
          source: "0",
          ranking: "+0.06",
          notes: "強い読書信号です。"
        },
        {
          behavior: "読了 / 90%",
          modelCard: "+4.0",
          source: "+1.0",
          ranking: "+0.10, read state -0.08",
          notes: "そのトピックが有用だったことを示しますが、読み終えた記事は再表示されすぎないよう少し下げられます。"
        },
        {
          behavior: "あとで読むに保存",
          modelCard: "+3.0",
          source: "+1.0",
          ranking: "+0.08, state +0.08",
          notes: "あとで読むは読む予定のキューであり、このページでは引き続きパーソナライズされた並び順を使います。"
        },
        {
          behavior: "お気に入り",
          modelCard: "+6.0",
          source: "+2.0",
          ranking: "+0.12, state +0.04",
          notes: "お気に入りはライブラリ / ブックマーク信号です。お気に入りチャンネルは既定ではパーソナライズ並び替えを使いません。"
        },
        {
          behavior: "いいね",
          modelCard: "+8.0",
          source: "+3.0",
          ranking: "+0.16, state +0.10",
          notes: "最も強いポジティブ信号です。似たトピックをもっと見たいことを明示します。"
        },
        {
          behavior: "いいねを解除",
          modelCard: "-1.0",
          source: "-0.4",
          ranking: "-0.04",
          notes: "弱い補正信号です。既定では新しい強いネガティブクラスターは作りません。"
        },
        {
          behavior: "興味なし",
          modelCard: "-6.0",
          source: "-2.5",
          ranking: "現在の記事を除外、類似トピックは最大 -0.45",
          notes: "強いネガティブフィードバックです。ネガティブクラスターを作り、類似候補を下げます。"
        }
      ]
    },
    rankingFlowDiagram: [
      {
        phase: "候補",
        title: "候補を集める",
        description: "チャンネル、ソース、フォルダー、未読フィルター、カーソルが候補プールを作ります。"
      },
      {
        phase: "フィルター",
        title: "表示不可の項目を外す",
        description: "非表示、興味なし、削除済みの記事は通常一覧から外れます。"
      },
      {
        phase: "状態",
        title: "記事状態を読む",
        description: "お気に入り、いいね、あとで読む、読書深度、無視、開封が state score に入ります。"
      },
      {
        phase: "ソース",
        title: "ソース嗜好を計算",
        description: "手動のソース重みと feed_stats が source score に合成されます。"
      },
      {
        phase: "時間",
        title: "新鮮度を計算",
        description: "公開時刻または発見時刻から、約 36 時間の半減期で freshness score を計算します。"
      },
      {
        phase: "プロファイル",
        title: "プロファイルカードに照合",
        description: "active embedding index がある場合、ベクトルがポジティブ / ネガティブ興味クラスターに照合されます。"
      },
      {
        phase: "合成",
        title: "ランキングスコアを合成",
        description: "興味、ソース、新鮮度、状態、ネガティブ補正が active rank score を作ります。"
      },
      {
        phase: "出力",
        title: "チャンネル別に返す",
        description: "最新は時刻、おすすめとあとで読むはパーソナライズ、お気に入りは保存時刻を使います。"
      }
    ],
    channelRules: [
      "最新：既定では時刻の降順です。未読フィルターは派生した未読状態を絞り込むだけで、並び順の意味は変えません。",
      "おすすめ：パーソナライズされた並び順です。プロファイルカードまたは embedding がない場合、邸報は基本の並び替えへ戻ります。",
      "あとで読む：あとで読むの記事だけを表示しますが、読む予定のキューとしてパーソナライズされた並び順を使います。",
      "お気に入り：ライブラリ / ブックマークモードです。既定ではお気に入りにした時刻の降順で、保存時刻と公開時刻を切り替えられます。パーソナライズは使いません。"
    ],
    copy: {
      localData:
        "邸報は、生の行動イベント、記事状態、読書進捗、ソース嗜好、興味クラスター、embedding provider 設定、index 状態をローカルに保存します。API key は現在、MVP のローカル SQLite 保存方針を使います。",
      fallback:
        "provider が未設定、index coverage が低い、provider リクエストが失敗、記事に embedding がない、または診断が利用できない場合、邸報は基本の並び替えへ戻ります。フォールバックは読書を妨げません。"
    }
  },
  recommendationStatus: {
    title: "おすすめ状態",
    loading: "おすすめ状態を読み込んでいます",
    fallback: "おすすめ状態を取得できません。記事一覧は引き続き読めます。",
    warmupNotice:
      "現在はユーザー行動を蓄積している段階です。おすすめはまだ正確でない可能性があるため、しばらくは「最新」ビューを通常の RSS リーダーとしてお使いください。",
    modes: {
      baseline: "基本の並び替え",
      personalized: "パーソナライズおすすめが有効",
      embedding: "Embedding 生成中",
      degraded: "Provider に問題、フォールバック中"
    },
    metrics: {
      behaviorCount: (count: number) => `${count} 件の行動`,
      coverage: (ratio: string) => `Coverage ${ratio}`,
      clusters: (positive: number, negative: number) => `クラスター +${positive} / -${negative}`,
      lastUpdate: (ranking: string, profile: string) => `Rank ${ranking} · Profile ${profile}`,
      unknown: "不明"
    }
  },
  recommendationInventory: {
    eyebrow: "おすすめ在庫",
    close: "おすすめ在庫を閉じる",
    connectionError: "おすすめ在庫の接続が一時的に切れています。自動的に再接続します。",
    emptyNotice:
      "並び替え済みの在庫を読み切りました。さらに読み込むと予備の並び順を使うため、関連性が低くなる可能性があります。バックエンドの並び替え完了を待つこともできます。",
    rankingNotice:
      "バックエンドで並び替え中です。並び替え済み在庫がなくなると、一時的に予備の並び順を使います。完了後、在庫は自動更新されます。",
    systemTitle: "システム概要",
    open: (status: string) => `おすすめ在庫を見る：${status}`,
    statuses: {
      available: "在庫あり",
      empty: "在庫なし",
      ranking: "並び替え中",
      loading: "読み込み中",
      unavailable: "不明"
    },
    summaries: {
      available: (remaining: number, total: number) =>
        `現在のおすすめ列には、並び替え済み記事が残り ${remaining} 件あります。並び替え済み合計は ${total} 件です。`,
      empty: (fallback: number) =>
        `現在のおすすめ列には、並び替え済み記事が残っていません。予備の記事は約 ${fallback} 件ありますが、関連性が低い可能性があります。`,
      ranking: (remaining: number, running: number, queued: number) =>
        `バックエンドの並び替えは実行中 ${running} 件、待機中 ${queued} 件です。並び替え済み在庫は残り ${remaining} 件です。`,
      loading: "おすすめ在庫を読み込んでいます。",
      unavailable: "おすすめ在庫を取得できません。"
    },
    metrics: {
      remainingSorted: "残り並び替え済み",
      sortedTotal: "並び替え済み合計",
      latestActive: "最新並び替え",
      staleActive: "古い並び替え",
      loaded: "読み込み済み",
      fallback: "予備列",
      unrankedFallback: "未ソート予備",
      rankingJobs: "並び替えジョブ",
      rankContext: "Rank context",
      lastRankedAt: "最終並び替え",
      updatedAt: "状態更新",
      rankingJobValue: (running: number, queued: number) => `実行 ${running} · 待機 ${queued}`
    }
  },
  reader: {
    originalLink: "原文",
    backToList: "一覧に戻る",
    reload: "再読み込み",
    selectArticleTitle: "記事を選択",
    selectArticleBody: "記事の詳細はここに表示されます。",
    feedOnlyNotice: "現在はフィードの要約のみ利用できます。",
    contentSource: {
      success: "本文は Web 記事全文の取得結果です。",
      feed_only: "本文は RSS / Atom Feed の内容です。",
      failed: "Web 記事全文の取得に失敗しました。現在の内容は Feed 由来です。",
      failedWithError: (error: string) =>
        `Web 記事全文の取得に失敗しました。現在の内容は Feed 由来です。${error}`,
      skipped: "Web 記事全文は使用されていません。現在の内容は Feed 由来です。",
      pending: "本文処理は待機中です。現在は Feed 内容または要約を表示しています。",
      noContent: "利用できる本文がありません。"
    },
    discovery: {
      relatedTitle: "関連記事",
      relatedPrompt: "この話題をもう少し追いますか？",
      relatedIntro: "今読んだ内容に近い記事を探します",
      relatedButton: "関連記事を探す",
      relatedLoading: "関連記事を探しています...",
      relatedEmpty: "適切な関連記事はまだ見つかりません。",
      relatedError: "関連記事の読み込みに失敗しました。",
      more: "もっと見る",
      personalizedTitle: "こちらもおすすめ",
      personalizedLoading: "あなた向けの記事を選んでいます...",
      personalizedEmpty: "続けて読む候補はまだ見つかりません。",
      personalizedError: "続けて読む候補の読み込みに失敗しました。",
      retry: "再試行",
      unavailable: {
        no_active_embedding: "この記事ではまだ利用できる意味インデックスがありません。",
        article_embedding_missing: "この記事ではまだ利用できる意味インデックスがありません。",
        insufficient_candidates: "候補記事がまだ十分ではありません。"
      }
    },
    noContent: "この記事にはまだ本文がありません。",
    meta: (feedTitle: string, date?: string, author?: string | null) =>
      [feedTitle, date, author].filter(Boolean).join(" · ")
  },
  fullContentPreview: {
    pageTitle: "全文取得プレビュー",
    status: "プレビューはデータベースへ書き込みません",
    kicker: "Content preview",
    back: "フィード管理に戻る",
    reload: "もう一度プレビュー",
    loading: "プレビュー中",
    articleUrl: "記事 URL",
    resultStatus: "状態",
    extractedTitle: "取得したタイトル",
    statuses: {
      success: "成功",
      failed: "失敗",
      skipped: "スキップ"
    },
    noPreview: "利用できるプレビューはありません。",
    noDbWrite: "既存の Feed 内容には影響しません。"
  },
  explanation: {
    title: "おすすめ理由",
    entryTitle: "おすすめの説明",
    open: "詳しい理由を見る",
    teaser: "内部の生スコアではなく、理解しやすい理由だけを表示します。",
    lazy: "半分以上読み進めるとおすすめ理由を表示します。",
    sortLabel: "現在の並び順メモ",
    sortTitle: "現在のビューの並び順",
    loading: "おすすめ理由を生成しています",
    empty: "明確なおすすめ信号はまだありません。",
    generatedAt: (date: string) => `${date} に生成`,
    sorting: {
      latest: "このビューは現在、公開時刻順に並んでいます。",
      recommended: "おすすめは、プロファイルカード、ソース嗜好、新鮮度、記事状態を組み合わせます。",
      favorites: "お気に入りは既定で保存時刻順に並び、パーソナライズランキングは使いません。",
      read_later: "あとで読むは、役に立ちそうな記事を上げるためにパーソナライズランキングを使います。"
    },
    types: {
      interest: "興味",
      source: "ソース",
      freshness: "新鮮度",
      state: "状態",
      fallback: "基本",
      negative: "ネガティブ",
      penalty: "フィルター",
      exploration: "発見"
    },
    reasons: {
      interest: "最近のポジティブな興味に近いため、順位が上がっています。",
      interestCluster: (summary: string) =>
        `最近のポジティブな興味に近いため、順位が上がっています。${summary}`,
      interestFamily: (label: string) =>
        `興味トピック「${label}」に近いため、順位が上がっています。`,
      recentIntent: "最近の読書傾向に近いため、順位が上がっています。",
      sourcePositive: (label: string) => `ソース ${label} が順位を上げています。`,
      sourceNegative: (label: string) => `ソース ${label} は現在重みが低めです。`,
      freshness: "新しい記事のため、新鮮度による加点があります。",
      statePositive: "お気に入り、あとで読む、読書進捗が順位を上げました。",
      stateNegative: "無視、読了などの状態が優先度を下げました。",
      fallback: "基本の並び替えが有効で、まだ強い信号はありません。",
      negative: "最近のネガティブ行動が順位を下げました。",
      penalty: "非表示または興味なしの状態は順位を大きく下げます。",
      exploration:
        "この記事はフィードの偏りを広げるために表示されています。設定でアルゴリズムの情報偏りレベルを調整できます。"
    }
  },
  actions: {
    favorite: "お気に入り",
    unfavorite: "お気に入り解除",
    like: "いいね",
    unlike: "いいね解除",
    readLater: "あとで読む",
    removeReadLater: "あとで読むから外す",
    markRead: "既読にする",
    markUnread: "未読に戻す",
    notInterested: "興味なし",
    notInterestedActive: "興味なし",
    saving: "保存中",
    aria: {
      favorite: "この記事をお気に入りに追加",
      unfavorite: "この記事のお気に入りを解除",
      like: "この記事にいいね",
      unlike: "この記事のいいねを解除",
      readLater: "この記事をあとで読むに保存",
      removeReadLater: "この記事をあとで読むから外す",
      markRead: "この記事を既読にする",
      markUnread: "この記事を未読に戻す",
      notInterested: "似た記事をおすすめしない",
      notInterestedActive: "興味なしに設定済み",
      group: "記事操作"
    },
    errors: {
      favorite: "お気に入りの更新に失敗しました。",
      like: "いいねの更新に失敗しました。",
      readLater: "あとで読むの更新に失敗しました。",
      readStatus: "既読状態の更新に失敗しました。",
      notInterested: "興味なしの操作に失敗しました。",
      open: "記事を開いた記録に失敗しました。",
      generic: "操作に失敗しました。もう一度お試しください。"
    }
  },
  notices: {
    feedAddedAndRefreshed: (feedTitle: string) => `追加して更新しました：${feedTitle}`,
    feedRefreshed: (feedTitle: string) => `更新しました：${feedTitle}`,
    allFeedsRefreshQueued: (count: number) =>
      count > 0
        ? `${count} 件のフィード更新をキューに追加しました。`
        : "更新が必要な有効フィードはありません。",
    opmlImported: (feedsCreated: number, feedsSkipped: number, foldersCreated: number) =>
      `OPML のインポートが完了しました：${feedsCreated} 件のフィードを追加、${feedsSkipped} 件をスキップ、${foldersCreated} 件のフォルダーを追加しました。`,
    opmlExported: "OPML をエクスポートしました。"
  },
  pwa: {
    offline:
      "現在オフラインです。キャッシュされたアプリシェルは開けますが、記事データにはネットワーク接続が必要です。",
    updateAvailable: "邸報の新しいバージョンがあります。",
    updateNow: "更新する",
    dismiss: "あとで"
  },
  errors: {
    api: {
      requestFailed: "リクエストに失敗しました。もう一度お試しください。",
      requestTimeout: "リクエストがタイムアウトしました。バックグラウンドメンテナンス中の可能性があります。",
      databaseBusy: "邸報はバックグラウンドメンテナンス中です。少し待ってから再試行してください。",
      httpError: (status: number) => `リクエストに失敗しました（HTTP ${status}）。`
    }
  }
} as const satisfies Dictionary;

export const dictionaries = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "ja-JP": jaJP
} as const satisfies Record<Locale, Dictionary>;

export type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Dictionary;
  formatDate: (value: string | Date) => string;
  formatArticleDate: (value: string | Date) => string;
};

export type DibaoI18nProviderProps = {
  children: ReactNode;
  locale?: Locale;
};

const defaultI18n = createI18n(defaultLocale);
const I18nContext = createContext<I18nValue>(defaultI18n);

export function DibaoI18nProvider(props: DibaoI18nProviderProps) {
  const [locale, setLocale] = useState<Locale>(() => props.locale ?? browserPreferredLocale());
  const value = useMemo(() => createI18n(locale, {}, setLocale), [locale]);

  useEffect(() => {
    if (props.locale !== undefined) {
      setLocale(props.locale);
    }
  }, [props.locale]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    document.documentElement.lang = locale;
    document.title = dictionaries[locale].common.brandName;
  }, [locale]);

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function browserPreferredLocale(): Locale {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return defaultLocale;
  }

  const languages = navigator.languages?.length
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : [];

  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized === "zh-cn" || normalized.startsWith("zh")) {
      return "zh-CN";
    }
    if (normalized === "ja-jp" || normalized.startsWith("ja")) {
      return "ja-JP";
    }
    if (normalized === "en-us" || normalized.startsWith("en")) {
      return "en-US";
    }
  }

  return defaultLocale;
}

export function createI18n(
  locale: Locale = defaultLocale,
  options: { timeZone?: string } = {},
  setLocale: (locale: Locale) => void = () => undefined
): I18nValue {
  const formatter = createDateFormatter(locale, options);
  const articleFormatter = createArticleDateFormatter(locale, options);

  return {
    locale,
    setLocale,
    t: dictionaries[locale],
    formatDate(value) {
      return formatter.format(new Date(value));
    },
    formatArticleDate(value) {
      return articleFormatter.format(new Date(value));
    }
  };
}

export function createDateFormatter(
  locale: Locale = defaultLocale,
  options: { timeZone?: string } = {}
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(options.timeZone ? { timeZone: options.timeZone } : {})
  });
}

export function createArticleDateFormatter(
  locale: Locale = defaultLocale,
  options: { timeZone?: string } = {}
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(options.timeZone ? { timeZone: options.timeZone } : {})
  });
}
