/**
 * `dsh-memory`: a cross-session, deterministic, human-owned memory plugin for
 * the DeepSeek Harness. Load it in `cordis.yml` beside the storage, storage
 * domain, system prompt, and tools plugins; it registers `ctx.memory`, four
 * model tools, a stable guidance section, and a recall context.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { MemoryEngine } from './engine.ts'
import type { MemoryConfig, MemoryHit, MemoryRecord } from './engine.ts'
import { MemoryGateway } from './remote.ts'
import { mountMemoryApi } from './routes.ts'
import { SELF_DESCRIPTION } from './self.ts'
import { DEFAULT_INJECTION_BUDGET, DEFAULT_SUMMARY_CHARS, candidateNotice, indexNotice, neighborNotice, neutralizeBraces, omittedNotice, renderInjection, staleNotice } from './injection.ts'

export { MemoryEngine } from './engine.ts'
export type {
  MemoryChange,
  MemoryConfig,
  MemoryFilter,
  MemoryHit,
  MemoryNamespace,
  MemoryRecord,
  MemoryStatus,
  MemoryWrite,
} from './engine.ts'
export { MemoryId } from './engine.ts'
export { bm25FieldScores, bm25Scores, cosineSimilarity, rrfFuse, tokenize } from './bm25.ts'

export const name = 'dsh-memory'
export const inject = ['storage', 'systemPrompt', 'tools', 'webServer', 'webRuntime']

/** Compact model-facing record; the branded id serializes as its string. */
interface MemoryToolRecord {
  id: string
  namespace: 'global' | 'project'
  status: 'suggested' | 'approved'
  injected: boolean
  content: string
  keywords: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  /** 锚点已失效（2026-09-15）：内容可能已过时，据此行动前先核对现状。 */
  stale?: boolean
  /** 失效原因（锚点名 + 声明值 vs 当前值）。 */
  staleReason?: string
  /** 命中次数（淘汰机制的输入）。 */
  hitCount?: number
  /** 已隔离：不进注入、不进检索（此字段一般只在显式过滤时才出现）。 */
  quarantined?: boolean
  /**
   * 来源工作区（④-A 2026-09-19）：仅在跨工作区召回时出现——缺省 = 当前会话工作区，
   * `..` / `../..` = 上级工作区。
   */
  scope?: string
}

interface MemoryToolHit {
  record: MemoryToolRecord
  score: number
}

/**
 * 解析时间过滤参数（0.12.0）：`7d` / `30d` 这类相对天数，或 `YYYY-MM-DD` 绝对日期。
 *
 * **为什么用字符串而不是数字**：工具参数里目前没有 number 类型的先例（`type: 'number'` 只
 * 出现在输出 schema），不拿一个未验证的参数类型去赌；字符串也天然容纳 `7d` 这种相对写法。
 * 解析不出（空串 / 格式不对）一律返回 `undefined` = 不过滤，**不报错**——过滤条件是辅助
 * 信息，让它把一次查询整体打断得不偿失。
 *
 * 绝对日期按**本地时区**解释（`.dsh` 的存储时间戳是 epoch，用户在本地日期里思考），
 * 相对天数以 `now` 为基准往前推。
 */
function parseTimeFilter(input: string | undefined, now: number): number | undefined {
  if (input === undefined) return undefined
  const text = input.trim()
  if (text === '') return undefined
  const relative = /^(\d+)d$/.exec(text)
  if (relative !== null) return now - Number(relative[1]) * 24 * 60 * 60 * 1000
  const absolute = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (absolute !== null) {
    return new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3])).getTime()
  }
  return undefined
}

const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    namespace: { type: 'string', required: true, enum: ['global', 'project'] },
    status: { type: 'string', required: true, enum: ['suggested', 'approved'] },
    injected: { type: 'boolean', required: true },
    content: { type: 'string', required: true },
    keywords: { type: 'array', required: true, items: { type: 'string' } },
    createdAt: { type: 'number', required: true },
    updatedAt: { type: 'number', required: true },
    lastUsedAt: { type: 'number' },
    stale: { type: 'boolean', description: '内容可能已过时（锚点失效）：据此行动前先核对现状，核对后用 memory_update 修正或刷新。' },
    staleReason: { type: 'string' },
    hitCount: { type: 'number' },
    quarantined: { type: 'boolean' },
    scope: { type: 'string', description: '来源工作区（④-A）：缺省 = 当前会话工作区；`..` / `../..` = 上级工作区。' },
  },
} as const

const HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    record: { ...RECORD_SCHEMA, required: true },
    score: { type: 'number', required: true },
  },
} as const

/**
 * 体检报告的输出（0.12.0）：四类清单一律只读。`summary` 与注入行同量级，直接念给人听
 * 不失真——这个工具的主要用法就是「你问起时我念给你看」。
 */
const SWEEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stale: {
      type: 'array',
      required: true,
      description: '当前失效的记录（锚点不符 / 被取代 / 已撤回），带原因。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          reason: { type: 'string' },
        },
      },
    },
    longUnused: {
      type: 'array',
      required: true,
      description: '久未被检索命中的非常驻记录——清理或归档的候选材料。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          lastUsed: { type: 'number', required: true },
        },
      },
    },
    candidates: {
      type: 'array',
      required: true,
      description: '被反复检索命中但没有被钉成常驻：要不要钉的待办。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          hitCount: { type: 'number', required: true },
        },
      },
    },
    resident: {
      type: 'object',
      required: true,
      additionalProperties: false,
      description: '常驻与注入预算的占用；`omitted > 0` 表示「钉了却没进来」。',
      properties: {
        total: { type: 'number', required: true },
        injected: { type: 'number', required: true },
        budget: { type: 'number', description: '生效预算（字符）；无限制时不出现。' },
        omitted: { type: 'number', required: true },
      },
    },
  },
} as const

/** 模板记录（0.6.0）：不暴露本地文件路径（meta.path 引擎内部使用）。 */
const PROMPT_RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    dimension: { type: 'string' },
    difficulty: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', required: true },
    source: { type: 'string', enum: ['user', 'agent'], required: true },
    namespace: { type: 'string', enum: ['global', 'project'], required: true },
  },
} as const

function recordValue(record: MemoryRecord): MemoryToolRecord {
  return {
    id: String(record.id),
    namespace: record.namespace,
    status: record.status,
    injected: record.injected,
    content: record.content,
    keywords: record.keywords,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt },
    ...record.stale === undefined ? {} : { stale: record.stale },
    ...record.staleReason === undefined ? {} : { staleReason: record.staleReason },
    hitCount: record.hitCount,
    ...record.quarantined === true ? { quarantined: true } : {},
    ...record.scope === undefined ? {} : { scope: record.scope },
  }
}

function hitValue(hit: MemoryHit): MemoryToolHit {
  return { record: recordValue(hit.record), score: hit.score }
}

/** 模板记录投影（0.6.0）：不暴露本地路径；summary 供模型判断是否取全文。 */
interface PromptToolRecord {
  id: string
  name: string
  dimension?: string
  difficulty?: string
  tags: string[]
  summary: string
  source: 'user' | 'agent'
  namespace: 'global' | 'project'
}

function promptValue(record: MemoryRecord): PromptToolRecord {
  const meta = record.meta
  return {
    id: String(record.id),
    name: meta?.name ?? '',
    ...meta?.dimension === undefined ? {} : { dimension: meta.dimension },
    ...meta?.difficulty === undefined ? {} : { difficulty: meta.difficulty },
    tags: meta?.tags ?? [],
    summary: meta?.summary ?? record.content.slice(0, 200),
    source: meta?.source ?? 'user',
    namespace: record.namespace,
  }
}

// 0.3.0：审核语义双语（host 侧 GUIDANCE 无法跟随 DSH locale 动态切换，
// 采用中英双语都写、模型自取——设计文档「风险与注意」）。
// 0.9.2：常驻注入不再是「人工开关」——0.8.0 起模型侧可经 `injected` 参数显式钉住。
// 旧表述会让模型以为自己没有该权限，也与同段「人工只在例外时介入」自相矛盾。
// 0.10.0：补 namespace 判据——此前只有工具 schema 的 `defaults to global`，全体系没有
// 任何「该记哪一层」的说明，陌生环境的模型会全写 global，project 层因此永远空着。
const GUIDANCE =
  'Use memory tools for cross-session preferences, habits, and project conventions. '
  + '记忆工具用于跨会话的偏好、习惯与项目约定。'
  + 'memory_save writes a memory that takes effect immediately (`approved`) — memories are maintained '
  + 'by the system and the model, and humans intervene only as exceptions. Credential-like content is '
  + 'quarantined instead. memory_save 写入即生效（`approved`）——记忆由系统与模型自行维护，人工只在例外时介入；'
  + '命中危险内容规则（密钥/凭据）的写入会被隔离。'
  + 'Choose the namespace by one question — **does this still hold in a different project?** Yes → `global` '
  + '(preferences, habits, environment knowledge); no → `project` (this repository\'s own conventions, '
  + 'architecture decisions, its pitfalls). '
  + '用一句话选 namespace——**换个项目，这条还成立吗？** 成立 → `global`（偏好、习惯、环境知识）；'
  + '不成立 → `project`（本仓库自己的约定、架构决策、它踩过的坑）。'
  + 'Record where a conclusion came from, not just the conclusion: the reason it holds, and the situation '
  + 'that forced it out. A conclusion without its origin is a ruler with no provenance — it looks '
  + 'self-evident, and self-evident things get applied mechanically. '
  + '记结论时一并记下**它是怎么来的**——它为什么成立，以及是什么场景把它逼出来的。没有出处的结论像一把'
  + '没有来历的尺子：看起来天经地义，而天经地义的东西最容易被机械套用。'
  + 'Pass `injected: true` on memory_save / memory_update to pin a memory resident in every turn\'s context: '
  + 'the same switch the settings panel exposes, exempting the record from the remaining automatic rule '
  + '(demote after long idle; repeated hits no longer promote anything — they only feed the candidate hint). '
  + 'Reserve it for rules, standing agreements and judgement criteria '
  + '— the kind that must apply even when nobody thinks to search for them; facts, references and case notes '
  + 'stay search-only. '
  + '给 memory_save / memory_update 传 `injected: true` 即把这条钉成每轮常驻——与设置面板是同一个开关，'
  + '此后不受剩下那条自动规则（长期未命中自动撤下）影响；反复命中已不再自动开启任何东西，只喂候选提示。'
  + '只用于规则、长期约定与判据这类'
  + '「没人想起来搜也必须生效」的记忆；事实、参考与案例留作按需检索。'
  + 'When earlier context may be relevant, call memory_search to recall it — reviewable memories '
  + '相关历史上下文可用 memory_search 检索；被隔离的记录不进检索。'
  + 'Every memory is plaintext and inspectable with memory_list; memory_forget removes one. '
  + '所有记忆均为明文，可用 memory_list 查看；memory_forget 删除一条。'
  + 'Approved + injected memories of the CURRENT session workspace are every-turn injected too. '
  + '已审核 + 常驻注入开关打开的工作区记忆也会每轮注入（按当前会话工作区路由）。'
  + 'When the library grows, call memory_sweep for a read-only health check (stale records with reasons, '
  + 'long-unused ones, candidates that keep being retrieved without being pinned, and budget usage). '
  + '库变大之后用 memory_sweep 做只读体检——失效记录（带原因）、久未命中、被反复检索却未常驻的候选、以及预算占用。'

// 0.5.1：`memory:recall` provider 可经 AssembleContext.agent 拿到当前会话
// 的 header.cwd——注入 = global + 当前会话工作区的 approved+injected
// （0.3.4 起工作区记忆就按会话 cwd 路由；provider 是同步回调，只读已
// 打开/缓存的表，未打开时本轮工作区部分为空，由 ensureProjectOpen 预热）。
// 0.5.2：注入经摘要化 + 预算截断（renderInjection，纯函数）防上下文膨胀。
// 0.9.0：装不下的条目不再是无声丢弃——末尾追加一行预算诊断（omittedNotice），
// 报出被挡在外面的 id；它只在有出局时出现，清理干净即消失。
// 0.11.1：返回值经 neutralizeBraces 中和字面 `{{`——严格插值下它会抛错，让该会话的
// 全部模型请求一起失败（机制见 injection.ts 的 neutralizeBraces）。
function recallText(memory: MemoryEngine, projectCwd: string | undefined, budget: number | null, summaryChars: number): string {
  const rendered = renderInjection(memory.recallRecords(projectCwd), budget, summaryChars)
  const parts: string[] = []
  if (rendered.lines.length > 0) {
    parts.push(`Remembered preferences and conventions — apply these:\n${rendered.lines.join('\n')}`)
  }
  // 全部出局（lines 为空）时诊断照出——那正是最该报的情形
  const notice = omittedNotice(rendered)
  if (notice !== '') parts.push(notice)
  // 0.12.0：新失效（稀有，出现即值得看一眼）与候选（该不该钉的待办）。
  // 两者都不占预算；候选必须走到眼前，因为判断者就是读这段上下文的模型自己。
  const stale = staleNotice(memory.lastSweepReport?.stale ?? [])
  if (stale !== '') parts.push(stale)
  const candidates = candidateNotice(memory.candidates(projectCwd))
  if (candidates !== '') parts.push(candidates)
  // ① 索引行：给出「库里还有什么、按什么去搜」（不占预算、长度常数级）
  const index = indexNotice(memory.indexCandidates(projectCwd))
  if (index !== '') parts.push(index)
  // ④-B：子项目索引（有才出、不占预算）——补「不知道存在」这个检索的结构性盲区
  const neighbors = neighborNotice(memory.neighborsOf(projectCwd))
  if (neighbors !== '') parts.push(neighbors)
  // 中和整个注入副本，而不是在各子行内部：四条子路径（注入行 / 预算诊断 / 索引行 /
  // 子项目索引）在这里唯一汇合，一处即全覆盖，将来新增子行也不必记得各自中和。
  // 这四行都承载模型或用户可写的文本——记忆正文、关键词、子项目目录名。
  return neutralizeBraces(parts.join('\n'))
}

/** 从组装上下文取当前 agent 会话的工作区 cwd（AssembleContext.agent 由 dsh-agent 声明合并提供）。 */
function assemblyProjectCwd(assembly: unknown): string | undefined {
  return (assembly as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)
    ?.agent?.session?.header?.cwd
}

/** 会话 header 的 cwd（session/created 事件载荷），预热 work 区表用。 */
function sessionProjectCwd(session: unknown): string | undefined {
  const cwd = (session as { meta?: { cwd?: unknown } } | undefined)?.meta?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** 从工具执行上下文取调用会话的工作区 cwd（0.3.4 工作区路由）。 */
function execProjectCwd(exec: unknown): string | undefined {
  return (exec as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)
    ?.agent?.session?.header?.cwd
}

function renderJson(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

export async function apply(ctx: Context, config?: MemoryConfig): Promise<void> {
  await ctx.plugin(MemoryEngine, config)
  await ctx.plugin(MemoryGateway)
  // 0.3.6：自带面板数据通道（HTTP，独立包无需 Typert 构建产物）
  mountMemoryApi(ctx)
  const memory = ctx.get('memory')
  if (memory === undefined) throw new Error('memory engine failed to register')

  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: 115,
    text: GUIDANCE,
  })

  // 0.3.2：记忆机制自述——常驻注入（不落用户存储），随发版更新。
  // order 49 < recall(50)：机制说明在具体记忆内容之前。
  ctx.systemPrompt.context({
    name: 'memory:self',
    order: 49,
    text: SELF_DESCRIPTION,
  })

  const injectionBudget = config?.injectionBudget ?? DEFAULT_INJECTION_BUDGET
  const summaryChars = config?.summaryChars ?? DEFAULT_SUMMARY_CHARS
  ctx.systemPrompt.context({
    name: 'memory:recall',
    order: 50,
    text: (assembly) => {
      const cwd = assemblyProjectCwd(assembly)
      if (cwd !== undefined) void memory.ensureProjectOpen(cwd).catch(() => { /* 预热失败无碍：本轮工作区部分为空，由下面的 waterfall 兜底 */ })
      return recallText(memory, cwd, injectionBudget, summaryChars)
    },
  })

  // 上面那条 provider 是**同步**的（`SystemPrompt.context` 的 `text` 类型就是
  // `string | ((context) => string)`），而工作区表是异步打开的：重启后首次组装时
  // 它还没打开，工作区记忆会整整缺席一轮（等预热完成，第二轮才回来）。
  // `system-prompt/assemble` 是异步 waterfall、文档写明「返回值权威」，在这里补一次。
  //
  // **不能拿「此刻表是否打开」当作「provider 渲染时表是否打开」的判据**：provider 里那次
  // 预热的 Promise 可能在 `next()` 的 await 期间就完成了，于是这里看到「已打开」而跳过，
  // 而 provider 渲染时它还是空的。所以这里总是重渲染一遍——`renderInjection` 是纯函数、
  // 读的是内存表，代价可忽略；文本没变就原样返回，不动 downstream 看到的对象。
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    const cwd = assemblyProjectCwd(context)
    if (cwd === undefined || cwd === '') return assembled
    if (!memory.projectOpen(cwd)) await memory.ensureProjectOpen(cwd).catch(() => undefined)
    const text = recallText(memory, cwd, injectionBudget, summaryChars)
    const current = assembled.contexts.find(entry => entry.name === 'memory:recall')
    if (current === undefined || current.text === text) return assembled
    return {
      ...assembled,
      contexts: assembled.contexts.map(entry => entry.name === 'memory:recall' ? { ...entry, text } : entry),
    }
  })

  // 会话创建即预热对应工作区的 project 表（0.5.1）：让首轮模型请求就
  // 能注入工作区常驻记忆（provider 同步只读已打开的表）。
  // session/created 事件由 dsh-session 提供（可选依赖：无 session 服务
  // 的环境不派发事件，预热由 provider 路径兜底）。
  const emitter = ctx as unknown as { on?: (event: string, handler: (session: unknown) => void) => void }
  emitter.on?.('session/created', (session) => {
    const cwd = sessionProjectCwd(session)
    if (cwd !== undefined) void memory.ensureProjectOpen(cwd).catch(() => { /* 预热失败无碍 */ })
  })

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: 'Save one cross-session memory. It takes effect immediately; credential-like content is quarantined instead. Record durable preferences, corrections and reusable conclusions — not transient state, guesses, or facts readable from the repo (record where to look instead). 保存一条跨会话记忆：写入即生效；命中密钥/凭据规则的写入会被隔离。只记长期偏好、纠正与可复用结论——不记临时状态、推测、或能从仓库读到的事实（那类记「去哪查」）。',
    parameters: {
      content: { type: 'string', required: true, description: 'Plaintext memory content.' },
      namespace: { type: 'string', enum: ['global', 'project'], description: 'Where it applies; defaults to global.' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'Explicit searchable anchors for memory_search. Give several angles (synonyms, abbreviations, zh/en) or it will not be found later. 多角度关键词（同义词、缩写、中英），否则将来检索不到它。' },
      injected: { type: 'boolean', description: 'Set true to make this memory resident in every turn\'s context, as a deliberate decision that no longer auto-expires. Reserve it for rules, standing agreements and judgement criteria — the kind that must apply even when nobody thinks to search for them. Facts, references and case notes stay search-only (omit it). 设为 true 让这条记忆每轮常驻上下文，且视为有意决定、不再被自动淘汰。只用于规则、长期约定与判据——那些「没人想起来搜也必须生效」的记忆；事实、参考与案例留作按需检索（省略即可）。' },
      anchor: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional validity anchor: bind this memory to a probeable environment value so it auto-expires when that value changes. Use only for facts that depend on the environment (tool behaviour under a specific version, config decided by an env var). 可选锚点：把记忆绑到可探测的环境值，值变了自动失效。只用于「随环境变化的事实」。',
        properties: {
          kind: { type: 'string', required: true, enum: ['env', 'tool-list', 'self-version', 'path-exists'], description: 'env = a named environment variable; tool-list = the available tool set; self-version = this plugin version; path-exists = a path that should still exist (`name` = the path, `value` = `present` or `absent`).' },
          name: { type: 'string', description: 'For kind=env: the variable name.' },
          value: { type: 'string', required: true, description: 'The value probed at write time.' },
        },
      },
    },
    output: {
      schema: RECORD_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.remember({
        content: args.content,
        ...args.namespace === undefined ? {} : { namespace: args.namespace },
        ...args.keywords === undefined ? {} : { keywords: args.keywords },
        ...args.injected === undefined ? {} : { injected: args.injected },
        // 参数已由 tool schema 校验，这里的窄化只为过类型
        ...args.anchor === undefined
          ? {}
          : { anchor: args.anchor as { kind: 'env' | 'tool-list' | 'self-version' | 'path-exists', name?: string, value: string } },
      }, execProjectCwd(exec)).then(recordValue)
    },
    presentCall: args => present('Save memory', 'other', args.content),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List every stored memory, optionally filtered by namespace, status, injected switch, or update time. Every memory is plaintext and inspectable. 列出全部记忆，可按 namespace/status/injected/更新时间过滤；均为明文可查。',
    parameters: {
      namespace: { type: 'string', enum: ['global', 'project'], description: 'Restrict to one namespace. 限定单个命名空间.' },
      status: { type: 'string', enum: ['suggested', 'approved'], description: 'Restrict to one review status. 限定审核状态（suggested=待审核 / approved=已审核）.' },
      injected: { type: 'boolean', description: 'Restrict by the persistent-injection switch. 按常驻注入开关过滤.' },
      after: { type: 'string', description: 'Only memories updated at/after this time: `YYYY-MM-DD`, or a relative form like `7d` / `30d`. 只返回此后更新过的记忆（`YYYY-MM-DD`，或相对形式 `7d` / `30d`）.' },
      before: { type: 'string', description: 'Only memories updated at/before this time (same forms as `after`). 只返回此前更新过的记忆（写法同 after）.' },
    },
    output: {
      schema: { type: 'array', items: RECORD_SCHEMA },
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      const now = Date.now()
      const after = parseTimeFilter(args.after, now)
      const before = parseTimeFilter(args.before, now)
      return memory.list({
        ...args.namespace === undefined ? {} : { namespace: args.namespace },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.injected === undefined ? {} : { injected: args.injected },
        ...after === undefined ? {} : { after },
        ...before === undefined ? {} : { before },
      }, execProjectCwd(exec)).then(records => records.map(recordValue))
    },
    presentCall: () => present('List memories', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Recall stored memories by keyword. Deterministic literal matching — a miss means no stored term matched the query. 按关键词检索记忆（中文 2-gram + 关键词加权；配置嵌入时含语义融合；含待审核条目，被隔离的除外）。',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword query. 关键词查询.' },
      namespace: { type: 'string', enum: ['global', 'project'], description: 'Restrict to one namespace. 限定单个命名空间.' },
      status: { type: 'string', enum: ['suggested', 'approved'], description: 'Restrict to one review status. 限定审核状态.' },
      kind: { type: 'string', enum: ['fact', 'prompt'], description: 'Restrict by record kind — fact (memories, default) or prompt (templates; use prompt_search instead). 按记录类别过滤：fact=记忆（默认）/ prompt=模板（模板请用 prompt_search）.' },
    },
    output: {
      schema: { type: 'array', items: HIT_SCHEMA },
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.search(args.query, {
        ...args.namespace === undefined ? {} : { namespace: args.namespace },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.kind === undefined ? {} : { kind: args.kind },
      }, execProjectCwd(exec)).then(hits => hits.map(hitValue))
    },
    presentCall: args => present('Search memory', 'read', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'prompt_search',
    description: 'Search prompt templates by keyword plus dimension/difficulty/tag filters. Returns matching summaries; call prompt_get for the full text. 按关键词+维度/难度/标签检索提示词模板，返回匹配摘要；取全文用 prompt_get。',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword query (name/tag/body). 关键词查询（名称/标签/正文）.' },
      dimension: { type: 'string', description: 'Filter by dimension (前端/后端/…). 按维度过滤.' },
      difficulty: { type: 'string', description: 'Filter by difficulty (L1-L5/LX). 按难度过滤.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Filter by any of these tags. 按任一标签过滤.' },
      namespace: { type: 'string', enum: ['global', 'project'], description: 'Restrict to one namespace. 限定单个命名空间.' },
    },
    output: {
      schema: { type: 'array', items: PROMPT_RECORD_SCHEMA },
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.refreshPromptIndex(execProjectCwd(exec)).then(async () => {
        const all = await memory.list({ kind: 'prompt', ...args.namespace === undefined ? {} : { namespace: args.namespace } }, execProjectCwd(exec))
        const filtered = all.filter(record => {
          const meta = record.meta
          if (meta === undefined) return true
          if (args.dimension !== undefined && args.dimension !== '' && meta.dimension !== args.dimension) return false
          if (args.difficulty !== undefined && args.difficulty !== '' && meta.difficulty !== args.difficulty) return false
          if (args.tags !== undefined && args.tags.length > 0 && !args.tags.some(tag => meta.tags.includes(tag))) return false
          return true
        })
        const quoted = JSON.stringify(args.query ?? '')
        const hits = await memory.search(quoted, { kind: 'prompt', ...args.namespace === undefined ? {} : { namespace: args.namespace } }, execProjectCwd(exec))
        const hitIds = new Set(hits.map(hit => String(hit.record.id)))
        // 过滤器命中列表按检索分排序在前，未命中关键词的过滤命中排后（按名称）
        const byQuery = filtered.filter(record => hitIds.has(String(record.id)))
        const rest = filtered
          .filter(record => !hitIds.has(String(record.id)))
          .sort((a, b) => (a.meta?.name ?? '').localeCompare(b.meta?.name ?? ''))
        return [...byQuery, ...rest].map(promptValue)
      })
    },
    presentCall: args => present('Search prompt library', 'read', args.query),
  }))

  ctx.tools.register(defineTool({
    name: 'prompt_get',
    description: 'Fetch a prompt template full text by id or name (name matches the file stem without the seq prefix). 按 id 或名称取模板全文（名称 = 文件名去序号部分）。',
    parameters: {
      nameOrId: { type: 'string', required: true, description: 'Template id or name. 模板 id 或名称.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', required: true },
        dimension: { type: 'string' },
        difficulty: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        body: { type: 'string', required: true },
        fallback: { type: 'string' },
      } },
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.promptGet(args.nameOrId, execProjectCwd(exec)).then(file => ({
        name: file.meta.name,
        ...file.meta.dimension === undefined ? {} : { dimension: file.meta.dimension },
        ...file.meta.difficulty === undefined ? {} : { difficulty: file.meta.difficulty },
        tags: file.meta.tags,
        body: file.body,
        ...file.fallback === null ? {} : { fallback: file.fallback },
      }))
    },
    presentCall: args => present('Get prompt template', 'read', args.nameOrId),
  }))

  ctx.tools.register(defineTool({
    name: 'prompt_list',
    description: 'List every prompt template index (no full text), optionally filtered by dimension/difficulty/tag. 列出全部模板索引（不含全文），可按维度/难度/标签过滤。',
    parameters: {
      dimension: { type: 'string', description: '按维度过滤.' },
      difficulty: { type: 'string', description: '按难度过滤.' },
      tags: { type: 'array', items: { type: 'string' }, description: '按任一标签过滤.' },
      namespace: { type: 'string', enum: ['global', 'project'], description: '限定单个命名空间.' },
    },
    output: {
      schema: { type: 'array', items: PROMPT_RECORD_SCHEMA },
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.refreshPromptIndex(execProjectCwd(exec)).then(() => memory.list({ kind: 'prompt', ...args.namespace === undefined ? {} : { namespace: args.namespace } }, execProjectCwd(exec))).then(records =>
        records.filter(record => {
          const meta = record.meta
          if (meta === undefined) return false
          if (args.dimension !== undefined && args.dimension !== '' && meta.dimension !== args.dimension) return false
          if (args.difficulty !== undefined && args.difficulty !== '' && meta.difficulty !== args.difficulty) return false
          if (args.tags !== undefined && args.tags.length > 0 && !args.tags.some(tag => meta.tags.includes(tag))) return false
          return true
        }).sort((a, b) => (a.meta?.seq ?? 0) - (b.meta?.seq ?? 0)).map(promptValue))
    },
    presentCall: () => present('List prompt templates', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'prompt_add',
    description: 'Add one prompt template to the library (writes a metadata-marked md file; source=agent is surfaced in the UI). 新增一条提示词模板（写元数据 md 文件；source=agent 在 UI 角标提示）。',
    parameters: {
      name: { type: 'string', required: true, description: 'Template name (also the file stem). 模板名称（也是文件名）.' },
      content: { type: 'string', required: true, description: 'The prompt body. 提示词正文.' },
      dimension: { type: 'string', description: '维度（前端/后端/…）.' },
      difficulty: { type: 'string', description: '难度（L1-L5/LX）.' },
      tags: { type: 'array', items: { type: 'string' }, description: '检索用标签.' },
      fallback: { type: 'string', description: '可选备用提示词.' },
      namespace: { type: 'string', enum: ['global', 'project'], description: '默认 global.' },
    },
    output: {
      schema: PROMPT_RECORD_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.promptAdd({
        name: args.name,
        content: args.content,
        ...args.dimension === undefined ? {} : { dimension: args.dimension },
        ...args.difficulty === undefined ? {} : { difficulty: args.difficulty },
        ...args.tags === undefined ? {} : { tags: args.tags },
        ...args.fallback === undefined ? {} : { fallback: args.fallback },
        ...args.namespace === undefined ? {} : { namespace: args.namespace },
        source: 'agent',
      }, execProjectCwd(exec)).then(promptValue)
    },
    presentCall: args => present('Add prompt template', 'other', args.name),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one stored memory by id. The human owner may remove any memory.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id from memory_list or memory_search.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true } } },
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.forget(args.id as never, execProjectCwd(exec)).then(deleted => ({ deleted }))
    },
    presentCall: args => present('Forget memory', 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_move',
    description: 'Move one memory to another layer: `global`, `self` (the current workspace), or a relative ancestor (`..` / `../..`). Use it when a memory sits at the wrong level — a project-specific rule parked in `global` that leaks into unrelated workspaces, or a fact that turned out to hold for sibling projects too. The record keeps its id, and the result reports whether the source layer still sees it. 把一条记忆移到另一层：`global`、`self`（当前工作区）或相对祖先（`..` / `../..`）。用于记忆待错了层——只属于某个项目的规矩躺在 `global` 里、漏进无关工作区，或某条事实其实对兄弟项目也成立。id 保持不变，结果里会报告移动后源层是否仍看得见它。',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id from memory_list or memory_search. 要移动的记忆 id。' },
      to: { type: 'string', required: true, description: 'Target layer: `global`, `self` (current workspace), or a relative ancestor such as `..` / `../..`. 目标层：`global`、`self`（当前工作区），或 `..` / `../..` 这样的相对祖先。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          from: { type: 'string', required: true, description: '移动前所在的层（`global` 或工作区路径）。' },
          to: { type: 'string', required: true, description: '移动后的层。' },
          sourceStillSees: { type: 'boolean', required: true, description: '源层移动后是否仍看得见它。为假表示源层及其下层从此看不见这条记忆。' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.move(args.id as never, args.to, execProjectCwd(exec))
    },
    presentCall: args => present('Move memory', 'other', `${args.id} → ${args.to}`),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_update',
    description: 'Update the content, keywords or persistent-injection switch of one stored memory (e.g. correcting stale facts). The record keeps its review status; content that looks like a credential quarantines it instead. 修改一条记忆的内容、关键词或常驻注入开关（如修正过时信息）。改动后记忆保持原有审核状态；若新内容命中危险规则则转为隔离。',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id from memory_list. 记忆 id（来自 memory_list）.' },
      content: { type: 'string', description: 'New content; omit to keep current. 新内容；省略则保留现有内容.' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'New keywords; omit to keep current. 新关键词；省略则保留现有.' },
      supersedes: { type: 'string', description: 'Mark the memory with this id as superseded by the current one (the current record is unchanged; only the other gets the void mark). 把该 id 指向的记忆标成「被本条取代」——本条不变，只写对方的作废标记。与 content / retract 互斥。' },
      retract: { type: 'string', description: 'Retract this memory: give a reason and it is marked void (content kept, no longer injected, still searchable). 撤回本条：给一个原因即标记作废——内容保留、不再进注入，检索仍可检回。与 content / supersedes 互斥。' },
      injected: { type: 'boolean', description: 'Set or clear the persistent-injection switch; omit to keep the current value. Setting it records a deliberate decision — the memory stops being auto-demoted (repeated hits no longer promote anything). See memory_save for what deserves residency. 设置或清除常驻注入开关；省略则保持原值。给值即视为有意决定——此后不受自动降级影响（反复命中已不再自动开启任何东西）。何时该常驻见 memory_save。' },
    },
    output: {
      schema: RECORD_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      const cwd = execProjectCwd(exec)
      const id = args.id as never
      // 三种动作互斥，按 retract > supersedes > update 的次序取第一个（与工具描述一致）：
      // 前两个是「标状态」，第三个才是「改内容」。同时给多个时以更重的动作为准。
      if (args.retract !== undefined) return memory.retract(id, args.retract, cwd).then(recordValue)
      if (args.supersedes !== undefined) return memory.supersede(id, args.supersedes as never, cwd).then(recordValue)
      return memory.update(id, {
        ...args.content === undefined ? {} : { content: args.content },
        ...args.keywords === undefined ? {} : { keywords: args.keywords },
        ...args.injected === undefined ? {} : { injected: args.injected },
      }, cwd).then(recordValue)
    },
    presentCall: args => present('Update memory', 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_confirm',
    description: 'Release a quarantined memory: marks it human-reviewed (`approved`) and clears its quarantine. Under the silent mechanism ordinary writes already take effect by themselves, so call this only when the human explicitly asks to release a quarantined memory. 放行一条被隔离的记忆：标记为已审核并解除隔离。静默机制下普通写入已自行生效，因此仅在用户明确要求放行隔离记忆时调用。',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id from memory_list. 记忆 id（来自 memory_list）.' },
    },
    output: {
      schema: RECORD_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.setStatus(args.id as never, 'approved', execProjectCwd(exec)).then(recordValue)
    },
    presentCall: args => present('Confirm memory', 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_sweep',
    description: 'Read-only health check: lists stale memories (with the reason), long-unused non-resident ones, candidates that keep being retrieved without being pinned, and how much of the injection budget the resident set takes. Changes nothing. 只读体检：列出失效的记忆（带原因）、久未被检索命中的非常驻记录、被反复检索却未常驻的候选，以及常驻占用了多少注入预算。不修改任何状态——最坏情况是报告不准，而不是误改内容。',
    parameters: {},
    output: {
      schema: SWEEP_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    execute(_args, exec) {
      return memory.sweep(execProjectCwd(exec))
    },
    presentCall: () => present('Sweep memory', 'other', 'read-only'),
  }))
}
