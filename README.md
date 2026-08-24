# dsh-memory

本插件属于 **`@max-null/*` 插件系列**——这一系列共同构成 **[SSID（思灵 · Seek Soul in Darkness）](https://github.com/Max-Null/seek-soul-in-darkness)** 桌面体验。SSID 是整合它们的盒：`dsh-capture` · `dsh-chat-rail` · `dsh-chinese-thinking` · `dsh-draft-polish` · `dsh-guardian` · `dsh-habit` · `dsh-header-unify` · `dsh-memory` · `dsh-node-appearance` · `dsh-plugin-center` · `dsh-skill-mcp-center` · `dsh-ssid-panels` · `dsh-ssid-zh-ui`。

This plugin belongs to the **`@max-null/*` family** — a set of plugins that together form the **[SSID (思灵 · Seek Soul in Darkness)](https://github.com/Max-Null/seek-soul-in-darkness)** desktop experience.

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**跨会话明文记忆插件**。遵循「一切皆插件」——它不修改 DSH 源码，声明 `name`/`inject`/`apply`，由 Loader 从 `cordis.yml` 加载。

## 设计原则

1. **人是所有者**：模型只能写入 `suggested` 状态的记忆，绝不自我提升；只有人工确认（`setStatus`）才能让记忆生效。
2. **可观测先于精准**：每条记忆是明文，`memory_list` 随时可见、`memory_forget` 随时删除——不存在"静默暗礁"。
3. **明文是人机共享的审计窗口**：记忆是可读文本，模型可自检其是否过期或出错（规划中的 v2）。
4. **确定性且缓存安全**：BM25 关键词检索是存储的纯函数、无 LLM 调用；固定指引进 system-prompt section，`auto` 记忆进 context。

## 用法

```bash
npm install @max-null/dsh-memory
```

在你的 `cordis.yml` 加一条（其余 storage / system-prompt / tools 由宿主已有；记忆的存储后端由插件自己注册）：

```yaml
- id: memory
  name: '@max-null/dsh-memory'
```

## 提供的服务与工具

- **服务** `ctx.memory`：`remember` / `list` / `search` / `forget` / `setStatus`
- **工具**：`memory_save`、`memory_list`、`memory_search`、`memory_confirm`、`memory_forget`
- **注入**：`tool:memory` 指引 section + `memory:recall` 召回 context（`auto` 记忆，带 `[memory:<id>]` 来源标记）

## 两层存储（global / project）

记忆按 `namespace` 分两层物理存储，各落在独立的明文 JSON：

| namespace | 默认位置 | 用途 |
|---|---|---|
| `global` | `$DSH_HOME/storages/memory.json` | 跨项目的个人偏好 |
| `project` | `<cwd>/.dsh/storages/memory_project.json` | 跟随仓库的项目共识，可 git 分享 |

两个根都可用 config 覆盖（`globalRoot` / `projectRoot`）。`memory_list` / `memory_search` 不带 `namespace` 过滤时会同时查两层。

## 使用流程（人工确认闸门）

```
模型 memory_save     →  status: suggested（只是建议，未生效）
人 memory_confirm    →  status: auto（生效，自动进入每轮的 recall context）
memory_search        →  随时按关键词召回任意状态的记忆
memory_forget        →  随时删除
```

模型**永远不能自我提升**一条记忆——`memory_save` 只写 `suggested`，只有人在明确要求时（`memory_confirm`）才能让它生效。这保证了记忆不是黑盒：人随时能看、能改、能删。

## 为什么明文 + BM25，而不是向量检索

向量检索的记忆本体是一串不可读的数字，过期信息会成为**无法观测、无法修复的静默暗礁**；BM25 + 明文让每一次召回都可解释、每一条记忆都可见可删。语义（向量）检索留作 v2 的可选项，且以"可观测 + 可修复"为门槛，而非时间表。

明文还有一层**跟随仓库分享**的好处：`project` 命名空间的记忆落在项目文件夹内（`<cwd>/.dsh/storages/memory_project.json`），随 `git` 提交、分享给所有协作者；`global` 命名空间的记忆留在本地 `$DSH_HOME`。团队的共识（"本项目统一用 Vue3 `<script setup>`"）能沉淀进仓库，而不是散落在每个人的本地。FTS5 的 SQLite 二进制、向量的数字串，都无法这样"跟着仓库走"。

## SSID 系列

## 开发

```bash
npm install
npm run typecheck   # tsc 严格类型检查
npm test            # vitest 单测
npm run build       # 产出 dist/
node scripts/verify-loader.mjs   # 用 Loader 端到端验证插件可加载
```

## 依赖（peerDependencies，由宿主提供）

`@deepseek-ai/cordis`、`@deepseek-ai/dsh-storage`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-storage-json`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools`
