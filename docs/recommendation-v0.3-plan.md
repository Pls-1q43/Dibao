# 邸报 0.3 推荐系统研发计划

来源：[0.2/0.3 推荐算法优化备忘录](https://app.notion.com/p/382ca795c95680d9a966d699c061450c)。本计划把备忘录中可在 NAS + SQLite 单用户环境安全落地的部分拆成 0.3 工作；不引入新的远程推荐依赖。

## 版本目标

0.3 让现有的兴趣簇、近期意图、来源偏好、去重与探索位形成一个可重建、可解释、可回退的本地推荐记忆层。新能力先以 shadow 形式计算和展示，人工审阅诊断、性能和负反馈后才可单项启用。

## P0：统一用户表示

- 维护唯一的、带 schema version 的 `UserRepresentationSnapshot`。
- 快照只引用或汇总原始画像表；原始行为、兴趣簇、来源统计和 rank score 始终是事实来源。
- 生成任务不得调用 embedding provider，也不得阻塞阅读或登录路径。
- 推荐透明页展示快照版本、生成时间、活跃 index 与有界摘要。

## P1：跨会话疲劳与探索结果

- 推荐列表的实际可见项目通过独立、幂等的曝光记录写入本地；曝光不改变文章状态，也不会制造 ignored 或负画像。
- 对重复事件组、兴趣家族、来源依次施加轻微、短期、可恢复的疲劳降权；正向行为会消解对应疲劳。
- 记录探索曝光及其结果，复用 `exploration_buckets` 的 alpha/beta 统计。

## P2：近期历史与可学习探索

- 每篇候选文章只比较有限的近期有效行为和已有 embedding，取 Top-K 形成严格封顶的近期相关分。
- 现有探索槽在通过 shadow 评估后使用 Beta-Bernoulli Thompson Sampling 选择安全的来源、兴趣家族或低维组合桶。
- 显式 hide/not interested、订阅源边界、去重、保存状态和茧房探索比例始终优先。

## 非目标与发布门槛

- P3 的 FTRL 组合特征、冷启动体验仅准备诊断；P4 向量量化只在性能数据证明需要后另立计划。
- 不使用 LLM、远程 reranker、额外 embedding provider、独立向量库或 GPU 训练。
- 所有升级均为 append-only migration + 后台派生数据；不得隐式重算 embedding。
- 通过 `npm run typecheck`、`npm test`、`npm run build`、推荐性能基线和 Synology 0.3 测试验证后，才允许把任一 shadow 模块切为 active。
