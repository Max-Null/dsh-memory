# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.7.0] - 2026-09-15

### Changed（行为变更；旧数据兼容）

- **写入即生效**：`memory_save` 不再只写「待审核」——低危内容直接 `approved`。人从「逐条放行」降为例外干预（钉住 / 删除 / 回滚）。`memory_update` 同样保持生效，不再把记录退回待审核。
- **`memory_confirm` 语义变更**：从「必经审核闸门」变为「放行被隔离的记忆」（同时解除隔离）。

### Added

- **危险内容硬拦（隔离位）**：写入或更新时命中密钥/凭据规则（8 类：常见平台密钥前缀、私钥块、赋值式秘密、认证头、带口令连接串等）的记录被隔离——**不进注入、不进检索**，直到人工放行或删除。
- **淘汰机制（信号驱动的常驻升降）**：记录新增 `hitCount`；命中达 2 次即自动打开常驻注入（`injectedAuto`）；超过 30 天未再命中则自动撤下。人工动过的开关双向豁免——既不自动升也不自动降，人是唯一能表达「不要这条常驻」的角色。
- **命中记账只认前几名**：一次检索最多把 BM25 前 5 名记为「被使用」。不设上限时命中计数会退化成「和查询有任意字符重叠」：BM25 对常见 2-gram 给全库打分，本机实测一句查询命中 81 条，三次测试检索就把 89 条记忆全升成常驻、占满注入预算。检索返回值不受此上限影响。
- **模板不再参与记忆检索**：`memory_search` 默认只搜 `fact` 记录，模板走自己的 `prompt_search` 通道（显式传 `kind` 的调用方照旧生效）；`recallRecords` 另加兜底，存储里即使存在被标了注入的模板也不进上下文。此前模板混在候选池里，既占返回条数，又会因「经常被搜到」被记命中——而模板正是明确不该进上下文的一类。
- **有效性锚点**：记录可声明锚点（`env` / `tool-list` / `self-version`），绑定到可探测的环境值；会话启动时批量校验，值变了即标 `stale` 并撤常驻，且在 `memory_search` 结果里带失效标注——过时的记忆不再被当成仍然正确。
- **会话启动维护**：每次会话首次打开工作区时做一次（幂等、失败不阻断）——旧数据迁移、长期未命中降级、锚点校验。
- **注入自述改为行为指引**：每轮注入的机制说明从「机制是什么」改为「何时写入 ①②③ / 不要记什么 / 怎么写关键词」，让模型自行维护记忆——不依赖人工闸门，也不引入后台分析管道。

### 兼容

- 全部新字段可选，**旧记忆文件照常读写**；旧枚举 `auto` / `suggest` 在读时迁移。
- **一次性迁移**：旧 `suggested` 逐条过危险检测——安全升 `approved`，命中则隔离；有 `lastUsedAt` 而缺 `hitCount` 的回填 1；旧 `injected: true` 且无 `injectedAuto` 的一律不动。迁移前把存储文件备份为 `.bak-<日期>-migration`。

## [0.5.2] - 2026-08-25

### Added

- **注入预算治理**：`memory:recall` 每轮注入改为单行摘要（首行截断，`summaryChars` 可配）+ 预算上限（`injectionBudget`，默认 1500 字符，超预算按最近使用/更新优先省略）；面板「注入预览」显示预算使用与省略条数，与真实注入同源渲染。
- **中文检索升级**：tokenize 对 CJK 连续段产出单字 + 2-gram（中英混合精度提升）；`memory_search` 改为 content 与 keywords 分离的加权 BM25（`bm25FieldScores`，人工关键词命中权重更高）；新增 `rrfFuse`/`cosineSimilarity` 导出。
- **记忆生命周期**：记录新增 `lastUsedAt`（memory_search 命中时写回），注入排序按最近使用优先，面板显示上次使用日期与冷数据提示（30 天未检索）。
- **混合语义检索**：可选 `embeddings` 配置（`embed` + 可选 `similarity`），启用后 memory_search 以 BM25 与语义结果做 RRF 融合，向量持久化到存储文件（`vector` 字段，明文可读）；缺省/失败自动降级纯 BM25。
- **工程债**：project 存储文件名规范化（去除双重前缀）——`memory_project_<hash>.json`，旧名文件打开时自动迁移（失败回退旧名，不丢数据）。

## [0.5.1] - 2026-08-25

### Added

- 工作区（project）记忆支持常驻注入：`memory:recall` provider 经 `AssembleContext.agent` 拿到当前会话 `header.cwd`，每轮注入 = global 的 approved+injected + **当前会话工作区**的 approved+injected，多工作区会话互不泄露。预热路径（`session/created` + provider 兜底）保证首轮或次轮即可注入；面板开关与注入预览（`/memory/api/injectionPreview`、`remote.memory.injectionPreview`）按当前会话工作区路由并标注 namespace。

## [0.2.0] - 2026-08-16

### Added

- 新增 `cordis.patch.yml`（bundle patch）并在 `package.json` 声明 `dsh.bundle`，支持通过 `dsh plugin add` 一键安装。

## 0.1.x（早期版本）

- 跨会话明文记忆：BM25 关键词检索（无向量嵌入）。
- `memory_save/list/search/forget` 工具与 `memory_confirm` 人工确认闸门（`suggested` → `auto`，模型永不自我提升）。
- 按 namespace 拆分 `global`（`$DSH_HOME/storages`）与 `project`（项目 `.dsh/storages`，随 git 分享）两层存储。
