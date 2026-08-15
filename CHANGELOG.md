# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-08-16

### Added

- 新增 `cordis.patch.yml`（bundle patch）并在 `package.json` 声明 `dsh.bundle`，支持通过 `dsh plugin add` 一键安装。

## 0.1.x（早期版本）

- 跨会话明文记忆：BM25 关键词检索（无向量嵌入）。
- `memory_save/list/search/forget` 工具与 `memory_confirm` 人工确认闸门（`suggested` → `auto`，模型永不自我提升）。
- 按 namespace 拆分 `global`（`$DSH_HOME/storages`）与 `project`（项目 `.dsh/storages`，随 git 分享）两层存储。
