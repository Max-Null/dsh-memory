# dsh-memory

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**跨会话明文记忆插件**。遵循「一切皆插件」——它不修改 DSH 源码，声明 `name`/`inject`/`apply`，由 Loader 从 `cordis.yml` 加载。

## 设计原则

1. **人是所有者**：模型只能写入 `suggested` 状态的记忆，绝不自我提升；只有人工确认（`setStatus`）才能让记忆生效。
2. **可观测先于精准**：每条记忆是明文，`memory_list` 随时可见、`memory_forget` 随时删除——不存在"静默暗礁"。
3. **明文是人机共享的审计窗口**：记忆是可读文本，模型可自检其是否过期或出错（规划中的 v2）。
4. **确定性且缓存安全**：BM25 关键词检索是存储的纯函数、无 LLM 调用；固定指引进 system-prompt section，`auto` 记忆进 context。

## 用法

```bash
npm install dsh-memory
```

在你的 `cordis.yml` 加一条（其余 storage / storage-domain / system-prompt / tools 由宿主已有）：

```yaml
- id: memory
  name: 'dsh-memory'
```

## 提供的服务与工具

- **服务** `ctx.memory`：`remember` / `list` / `search` / `forget` / `setStatus`
- **工具**：`memory_save`、`memory_list`、`memory_search`、`memory_forget`
- **注入**：`tool:memory` 指引 section + `memory:recall` 召回 context（`auto` 记忆，带 `[memory:<id>]` 来源标记）

## 开发

```bash
npm install
npm run typecheck   # tsc 严格类型检查
npm test            # vitest 单测
npm run build       # 产出 dist/
node scripts/verify-loader.mjs   # 用 Loader 端到端验证插件可加载
```

## 依赖（peerDependencies，由宿主提供）

`@deepseek-ai/cordis`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools`
