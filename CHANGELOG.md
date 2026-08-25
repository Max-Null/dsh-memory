# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

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
