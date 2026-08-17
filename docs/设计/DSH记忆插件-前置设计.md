# DSH 记忆插件 — 前置设计

> 版本：v0.1（前置研究）
> 日期：2026-08-14
> 状态：**已实现并发布**（2026-08-15，`@max-null/dsh-memory`，GitHub `Max-Null/dsh-memory`）
> 关联：`docs/决策/2026-08-14-基座选择-维持OpenCode-DSH暂不切换.md`、oc-plus 分形 Guardian（`H:\MaxNull\WorkStation\oc-plus\分形\`）
> 结论绑定：DeepSeek Harness pre-release（HEAD `47f9438` @ 2026-08-13，无 tagged release）

---

## 一、背景与目标

oc-plus 对 OpenCode 的增强中，**分形 Guardian 记忆引擎**是核心价值：三层存储（`blocks/` 知识块 + `triggers/` 触发规则 + `events.log` 事件日志）、LLM 自主学习、频率控制、BM25/向量检索。

它踩过一个实打实的坑（oc-plus 机制说明 §八）：用 `system.transform` 每轮注入 ~300+ 字符规则文本做「行为前门」，导致 system prompt 膨胀、token 命中率暴跌——**「动 system prompt → 缓存命中失效」的实证**，最终废弃并替换为独立 flash 分类器。

本设计回答一个问题：**当 DeepSeek Harness 成熟后，这套记忆机制如何按 DSH 的原则重建，而不是把 OC 的实现硬搬过去。** 前置设计先落盘（引擎无关资产），实现等 DSH tagged + 稳定 API。

## 二、核心原则（DSH 原生的记忆模型）

DSH 的记忆/上下文架构是事件溯源式的，四条原则必须遵守：

1. **会话历史是 append-only 事件日志的投影，日志永不被删改**（`dsh-session`）。记忆压缩 = compaction 在 surface 层做 `replace`，原始事件保留、可回放。
2. **稳定记忆进 system-prompt section，动态记忆进历史/context**。system prompt 是确定性有序前缀（身份 -100 / persona 0 / 工具 100–199），**禁止把会变的东西塞进去**——这正是 oc-plus 花钱买来的教训，DSH 把它做成了契约。
3. **缓存前缀稳定是一等公民契约**：每个包的 README 都有「KV Cache effect」节；`request/header` 事件快照完整请求信封（system prompt + 工具 + 前缀），可精确重建"哪一处变了"。
4. **模型可见 ⟺ 已入日志**：任何到达模型请求的内容都必须能从会话日志重建，新模型可见输入必须有会话事件。

## 三、oc-plus → DSH 能力映射

| oc-plus 分形 Guardian | DSH 对应扩展点 | 搬运方式 |
|---|---|---|
| `events.log` 原始日志 | session 事件日志（append-only，已存在） | ✅ 复用 |
| `system.transform` 注入 | `ctx.systemPrompt.section()` / `context()` | 🔄 重写 |
| `chat.message` 同轮注入 | `agent.inject()` / context provider | 🔄 重写 |
| `event` 监听 | `session/event` 订阅 + `SessionEventMap` declaration merging | 🔄 重写 |
| 频率控制（每 5 轮） | context provider 每 assembly 求值 + 自写节流 | 🔁 概念带走 |
| `blocks/` 知识块（跨会话持久） | `ctx.storage.domain`（KV 域，json/sqlite 后端） | ✅ 复用（已 spike 验证） |
| `triggers/` glob 规则 | context provider（按 assembly 求值） | 🔄 重写 |
| 提交知识提取 / LLM 自主学习 | 监听事件 + `ctx.llm.stream()` 批量分析 | 🔁 概念带走 |
| 习惯确认 pending→auto | 插件状态机 + `interaction` 包 ask-user | 🔁 概念带走 |
| 双路除重 / PageOut 衰减 | 自写逻辑 | ✅ 带走 |
| BM25 + 向量检索 | BM25 纯逻辑可移植；向量需外部嵌入（DSH 无 embedding seam） | 🔁 BM25 移植 / ⚠️ 向量待嵌入源 |
| 哨兵 flash 分类器 | 独立 `llm.stream()`（compaction 摘要调用即此模式） | 🔁 概念带走 |

> 图例：✅ 复用 / 🔁 带走概念重写实现 / 🔄 按 DSH 语义重写 / 🆕 DSH 空白需新建。

**关键结论**：oc-plus 三层里，底层（事件日志）DSH 原生就有且更彻底（append-only + 可回放 + `request/header` 快照）。跨会话记忆库有现成 `ctx.storage.domain` seam（已 spike 验证）。唯一需外部来源的是**向量检索的嵌入**（DSH 无 embedding seam）；BM25 关键字检索可无依赖移植。

## 四、插件设计（DSH 侧）

### 4.1 组件划分

| 组件 | 职责 | 挂载的 DSH 扩展点 |
|---|---|---|
| Memory Store | 跨会话持久记忆（blocks + triggers） | 自写存储（或复用 `session-persistence` 的写路径） |
| Retriever | BM25 + 向量召回 | 自写（移植 engine） |
| Injector | 稳定记忆进 section，动态记忆进 context | `ctx.systemPrompt.section()` + `context()` |
| Learner | 监听事件，批量 LLM 分析出习惯 | `session/event` 订阅 + `ctx.llm.stream()` |
| Confirmer | pending → auto 的用户确认 | `interaction` 包 + 状态机 |

### 4.2 缓存安全契约（每组件如何保持前缀稳定）

| 记忆内容 | 注入通道 | 缓存行为 | 规则 |
|---|---|---|---|
| 核心规则（身份/底线） | `section()`（固定 order） | 前缀稳定（内容不变则缓存复用） | 内容变了才失效，从首个变化 token 起 |
| 知识索引（每 5 轮） | `context()`（动态快照） | append-only 进历史 | 变化只影响历史位置之后 |
| 触发规则命中 | `context()` 按 assembly 求值 | append-only | 未命中贡献空文本 = 零 token |
| 膨胀治理 | compaction（不归记忆插件管） | 从被替换历史处失效 | 前缀（system prompt）仍复用 |

**核心纪律**（oc-plus 血泪教训的 DSH 落地版）：**凡是会随轮次/会话变化的内容，一律走 context 进历史；凡是永久稳定的，才允许进 section。** 反向使用就是重新踩坑。

## 五、待实测清单（spike 验证点）

前置研究阶段用一个最小 spike 验证三件事，用事实代替推测。

**验证结果（2026-08-14，vitest 3/3 通过，临时 spike 已删）**：

- [x] `ctx.systemPrompt.section()` 承载"稳定记忆"：两次 `assemble()` 的 section 名称/顺序/文本完全一致 → 前缀稳定 ✅
- [x] `ctx.systemPrompt.context()` 按 assembly 求值做"动态触发"：未命中贡献空文本（`renderContextSnapshot` 返回 `''` = 零成本），命中贡献记忆文本 ✅
- [x] `session/event` 订阅收到 `turn/start`、`user/message` 两个 append 事件 → 可作自主学习事件源 ✅

**跨会话记忆库 + 检索 spike（2026-08-14，vitest 1/1 通过，临时 spike 已删）**：

- [x] `ctx.storage.domain` 作跨会话记忆库：`defineDomain('memory', { tables: { blocks, triggers } })` → 写块 → 关闭域 → 重开（模拟下个会话）→ 读回 ✅（json 后端落盘 + zod 校验 + `domain/changed` 事件）
- [x] 关键词召回（BM25 前置）：纯逻辑遍历 blocks 匹配 keyword，无外部依赖 ✅
- ⚠️ **向量检索**：DSH 无 embedding seam（LLM 只做 chat 流式；DeepSeek 适配器无嵌入端点）——向量检索需外部嵌入源，BM25 是零依赖的第一步
- ⚠️ **跨进程可见性**：`storage-domain` 的 `domain/changed` 是进程内事件，第二进程/重连 GUI 观察不到变化（跨进程推送 deferred）——fractal GUI 是独立 Electron 进程，落地时需注意这条限制

## 六、触发条件（何时进入生产级实现）

- [ ] DSH 发布首个 tagged release、公开 API 稳定（`SESSION_FORMAT_VERSION` 脱离 0）
- [ ] 决策记录 `2026-08-14-基座选择…` 的"重评估条件"任一满足（DSH 交互式接口 / tagged / OC 阻塞）
- [ ] spike 三个验证点全部跑通
