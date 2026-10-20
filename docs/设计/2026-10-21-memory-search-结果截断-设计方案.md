# memory_search 的结果截断：设计方案（2026-10-21）

> 状态：**设计待评审**（未实现）
> 关联：GitHub `Max-Null/dsh-memory#1`；`src/index.ts`（工具层）、`src/engine.ts`（检索本体）、`src/bm25.ts`（分词）
> 不涉及：`src/injection.ts`（常驻注入预算）、`src/routes.ts`（面板端点）

## 一、这个改动带来什么

一次 `memory_search` 默认最多返回 20 条，宽查询的返回体从数万字符降到数千；要看全量传 `limit: 0`。检索本身、排序、命中记账都不变。

**非目标**：offset 分页、改 BM25 打分或分词、改命中记账口径、给记忆加重要性字段、给 `memory_list` 加分页。

## 二、现状

四条事实均按当前源码核对（`0.16.0`）：

| 事实 | 位置 |
|:--|:--|
| `memory_search` 参数只有 `query` / `namespace` / `status` / `kind` | `src/index.ts:558-563` |
| `rank()` 过滤 `score > 0` 后原样返回，无截断 | `src/engine.ts:1150-1153` |
| 命中记账只取 BM25 前 5（`HIT_MARK_LIMIT`） | `src/engine.ts:241`、`:1157` |
| 中文分词 = 每个汉字单字 + 每对相邻字 bigram | `src/bm25.ts:22-23` |

本机 279 条项目记忆库的实测（直接调 `dist/bm25.js` 的 `bm25FieldScores`，不经插件）：

| 查询 | 命中 | top1 | #5 | #20 | #50 | 末位 |
|:--|--:|--:|--:|--:|--:|--:|
| `旁观助手 判据` | 235 / 279 | 44.2 | 14.5 | 5.6 | 3.9 | 0.40 |
| `memory_search limit 分页` | 168 / 279 | 9.0 | 7.0 | 4.7 | 3.2 | 0.62 |
| `仓库巡检` | 99 / 279 | 40.7 | 11.1 | 6.5 | 2.3 | 1.14 |
| `ssid` | 180 / 279 | 0.93 | 0.91 | 0.88 | 0.82 | 0.31 |

读法：

- **命中面 35%–84%**，且多词查询的分数是连续衰减，没有陡崖。所谓"噪声"不是排序坏了，而是**正分结果整批返回**——排名仍然有信息量，只是尾部对调用方已无价值。
- **单 token 查询没有分辨力**：`ssid` 的 top1 与 #50 差 0.11，前 50 名彼此几乎等价。这类查询的"排序"本身不携带信息，截断与提示改窄查询比调排序更有效。
- issue 里「96 条中 83 条 >40」的原始统计不来自本机 `~/.dsh/storages/query-log.json`（本机这份只有 4 条，命中 224–271，10 份备份一致），无法逐条复核；上表用独立实测复核同一机制。

## 三、接口

### 3.1 参数

`memory_search` 新增 `limit`：

```ts
limit: { type: 'integer', default: 20, description: 'Maximum hits to return (default 20). Pass 0 for no limit. 最多返回条数（默认 20；0 = 不限）.' },
```

取值语义：

| 输入 | 行为 |
|:--|:--|
| 省略 | 20 |
| `0` | 不限（等价旧行为） |
| 正整数 | 该值 |
| 负数 | 按 20（保守；负值没有"更多"的含义） |

依据：当前依赖 `@deepseek-ai/dsh-tools@0.2.0-rc.1` 的 `ValueSchemaSpec` 支持 `integer` 与 `number`，并允许 `default` 注解（`lib/types/schema.d.ts:20-36`）。`default` 是**非验证性注解**，不会填充实参——`execute` 里仍需 `args.limit ?? 20`。`src/index.ts:97` 那条「工具参数里没有 number 先例」的注释描述的是既有用法，不是能力限制；peer 范围下界 `0.1.1-rc.1` 是否同样支持 `integer` 未核，若类型检查在旧内核上不通过，退回字符串写法（与 `after` / `before` 同风格）。

### 3.2 返回

形状不变：仍是 `Array<{ record, score }>`，改的只有长度。

截断的事实写进工具描述而不是返回体：**返回条数等于 `limit` 时可能还有更多，要看全量传 `limit: 0`**。

为什么不做 `total` 字段：要把总数交给调用方，只能把返回从数组改成对象（或塞一条哨兵），前者牵动所有既有调用方——模型是按数组理解这个工具的。用「条数 == limit」换零结构变更，代价是恰好命中 `limit` 条时分不清"正好这么多"和"被截断"；两种情况下下一步动作相同（`limit: 0` 或把查询写窄），代价可接受。

### 3.3 截断发生在工具层，不进 engine

`prompt_search` 在 `src/index.ts:604-605` 用 `memory.search()` 的**全量**命中算 `hitIds`，再据此把命中的模板排到前面。若把截断写进 `engine.search()`，排在第 25 名的模板会明明命中却排到未命中模板之后——静默错误，且现有测试覆盖不到（`test/memory.spec.ts` 直接调 `ctx.memory.search`，看不到工具层）。

因此：

- `engine.search()` / `rank()` 一行不动，语义固定为「全部正分命中」；
- 截断只发生在 `memory_search` 的 `execute` 里。

### 3.4 记账口径不动

`markUsed` 仍按 BM25 前 5（`src/engine.ts:1157`）。理由：宽查询会把半个库记成热的；top5 是"真正排前"的那几条，`limit` 不改变任何记账行为。

`query-log.json` 的 `hits` 字段已经是真实命中数（`src/engine.ts:1135`），"本次命中多少条"在日志侧一直有答案，本方案不回传给调用方。

### 3.5 工具描述

现描述（"Deterministic literal matching — a miss means no stored term matched the query"）保留，追加两句：

- 返回条数上限与 `limit: 0`；
- **查询写窄更容易找到**：单 token 或泛词会命中大半个库且尾部无分辨力（实测 `ssid` 前 50 名分数几乎相同）。

第二句是治本的一半——截断只降成本，不改召回质量。

## 四、影响面

| 侧 | 影响 |
|:--|:--|
| 模型 | 默认返回变短；排序列表分辨力上升；需要全量时显式 `limit: 0` |
| `prompt_search` | 无影响（不走工具层截断），但需要回归测试钉住 §3.3 的边界 |
| 面板 / `routes.ts` | 无影响——`routes.ts` 没有检索端点 |
| `memory_list` | 不变。它是"看全库"的入口，但没有分页；本方案不碰它（见 §六-3） |
| 既有测试 | `test/memory.spec.ts` 直调 engine，不受影响 |
| README | 使用流程一节补一句默认上限；工具清单不动 |

## 五、测试计划

新增（`test/memory.spec.ts`，沿用 `ctx.tools.get(...)?.execute?.(args, {} as never)` 的既有写法）：

1. 造 25 条同词记忆：默认返回 20 条，且是分数最高的 20 条；
2. `limit: 0` 返回全部 25 条；
3. `limit: 5` 返回 5 条；`limit: 100` 返回 25 条（不补空）；
4. `limit: -1` 按 20；
5. **边界保护**：`ctx.memory.search(q)` 仍返回 25 条（engine 层不截断）；
6. **回归**：造 25 条都命中同一词的模板，断言 `prompt_search` 仍把命中模板全部排在前面（证明 `hitIds` 用的是全量）；
7. 记账不变：一次宽查询后只有分数前 5 的 `hitCount` +1。

参数校验（`validateArgs` 拒绝非整数）由 dsh-tools 在 `execute` 前完成，工具层测试直接调 `execute` 绕过了它——这一条不在单测覆盖范围内，靠 `tsc` 的类型推导兜住。

## 六、未决

1. **默认 20 还是 10**：实测没有陡降点可选，20 是"仍覆盖有答案价值部分"的经验值。上线后用 `query-log.json` 的 `hits` 分布复核，必要时再调。
2. **要不要给截断一个显式信号**：任何显式信号都会改变返回形状（见 §3.2）。若将来模型确实误判，再考虑对象返回。
3. **`memory_list` 没有分页**：283 条全量比 `memory_search` 更贵。本方案不解决；若不解决，`limit: 0` 会成为绕道，而不是催生"用 list 看全库"的习惯。
4. **issue 评论 2 的 `priority` / `pinned`**：那是注入预算议题，与本方案无关。注入候选本来就只取 `injected: true`（`src/engine.ts:1990-1997`），真实场景是两个都钉了常驻、按 `updatedAt` 排序时后者赢；omission 诊断行已经暴露这个事实。要动排序，先回答"重要性由谁给"。

## 七、实施进度

已实现（2026-10-21，`0.17.0`）：

- `src/index.ts`：`memory_search` 增加 `limit`（`DEFAULT_SEARCH_LIMIT = 20`）与工具层截断；工具描述补上限约定与窄查询提示。
- `README.md`：使用流程补默认上限一句。
- 未动：`engine.search()` / `rank()` / `markUsed()`——§3.3 与 §3.4 的边界由测试钉住。
- 测试：`test/memory.spec.ts` 新增三例——默认 20 与 `limit` 归一（含 `0` / 负数 / 超量）、记账仍只前 5、`prompt_search` 不被截断。`npm run typecheck` 与全量 182 个测试通过。
