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
import { DEFAULT_INJECTION_BUDGET, DEFAULT_SUMMARY_CHARS, renderInjection } from './injection.ts'

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
}

interface MemoryToolHit {
  record: MemoryToolRecord
  score: number
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
const GUIDANCE =
  'Use memory tools for cross-session preferences, habits, and project conventions. '
  + '记忆工具用于跨会话的偏好、习惯与项目约定。'
  + 'memory_save always records a suggestion (`suggested`) and never makes it effective itself — '
  + 'a human approves it. memory_save 永远只写入建议（`suggested`），不会自行生效——需人工审核通过。'
  + 'Approval only marks the content reviewed; whether it is injected every turn is a separate '
  + 'human-controlled switch (`injected`). 审核通过只代表内容被认可；是否每轮常驻注入由独立的'
  + '人工开关（`injected`）控制。'
  + 'When earlier context may be relevant, call memory_search to recall it — reviewable memories '
  + '(`suggested`) are searchable too. 相关历史上下文可用 memory_search 检索——待审核的记忆也可检索。'
  + 'Every memory is plaintext and inspectable with memory_list; memory_forget removes one. '
  + '所有记忆均为明文，可用 memory_list 查看；memory_forget 删除一条。'
  + 'Approved + injected memories of the CURRENT session workspace are every-turn injected too. '
  + '已审核 + 常驻注入开关打开的工作区记忆也会每轮注入（按当前会话工作区路由）。'

// 0.5.1：`memory:recall` provider 可经 AssembleContext.agent 拿到当前会话
// 的 header.cwd——注入 = global + 当前会话工作区的 approved+injected
// （0.3.4 起工作区记忆就按会话 cwd 路由；provider 是同步回调，只读已
// 打开/缓存的表，未打开时本轮工作区部分为空，由 ensureProjectOpen 预热）。
// 0.5.2：注入经摘要化 + 预算截断（renderInjection，纯函数）防上下文膨胀。
function recallText(memory: MemoryEngine, projectCwd: string | undefined, budget: number | null, summaryChars: number): string {
  const rendered = renderInjection(memory.recallRecords(projectCwd), budget, summaryChars)
  if (rendered.lines.length === 0) return ''
  return `Remembered preferences and conventions — apply these:\n${rendered.lines.join('\n')}`
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

  ctx.systemPrompt.context({
    name: 'memory:recall',
    order: 50,
    text: (assembly) => {
      const cwd = assemblyProjectCwd(assembly)
      if (cwd !== undefined) void memory.ensureProjectOpen(cwd).catch(() => { /* 预热失败无碍：本轮工作区部分为空，下一轮重试 */ })
      const budget = config?.injectionBudget ?? DEFAULT_INJECTION_BUDGET
      const summaryChars = config?.summaryChars ?? DEFAULT_SUMMARY_CHARS
      return recallText(memory, cwd, budget, summaryChars)
    },
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
    description: 'Record one cross-session memory as a suggestion. It never becomes effective until a human confirms it; the model must not present a suggestion as confirmed.',
    parameters: {
      content: { type: 'string', required: true, description: 'Plaintext memory content.' },
      namespace: { type: 'string', enum: ['global', 'project'], description: 'Where it applies; defaults to global.' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'Explicit searchable anchors for memory_search.' },
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
      }, execProjectCwd(exec)).then(recordValue)
    },
    presentCall: args => present('Save memory', 'other', args.content),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List every stored memory, optionally filtered by namespace, status, or injected switch. Every memory is plaintext and inspectable. 列出全部记忆，可按 namespace/status/injected 过滤；均为明文可查。',
    parameters: {
      namespace: { type: 'string', enum: ['global', 'project'], description: 'Restrict to one namespace. 限定单个命名空间.' },
      status: { type: 'string', enum: ['suggested', 'approved'], description: 'Restrict to one review status. 限定审核状态（suggested=待审核 / approved=已审核）.' },
      injected: { type: 'boolean', description: 'Restrict by the persistent-injection switch. 按常驻注入开关过滤.' },
    },
    output: {
      schema: { type: 'array', items: RECORD_SCHEMA },
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.list({
        ...args.namespace === undefined ? {} : { namespace: args.namespace },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.injected === undefined ? {} : { injected: args.injected },
      }, execProjectCwd(exec)).then(records => records.map(recordValue))
    },
    presentCall: () => present('List memories', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Recall stored memories by keyword. Deterministic literal matching — a miss means no stored term matched the query. 按关键词检索记忆（中文 2-gram + 关键词加权；配置嵌入时含语义融合；含待审核条目）。',
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
    name: 'memory_update',
    description: 'Update the content or keywords of one stored memory (e.g. correcting stale facts). The record is re-marked `suggested` — the human must review it again before it is approved/injected again. 修改一条记忆的内容或关键词（如修正过时信息）。改动后该记忆重置为待审核（suggested），需人工再次审核；常驻注入开关保留原值（审核通过后恢复）。',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id from memory_list. 记忆 id（来自 memory_list）.' },
      content: { type: 'string', description: 'New content; omit to keep current. 新内容；省略则保留现有内容.' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'New keywords; omit to keep current. 新关键词；省略则保留现有.' },
    },
    output: {
      schema: RECORD_SCHEMA,
      render: (_args, value) => renderJson(value),
    },
    execute(args, exec) {
      return memory.update(args.id as never, {
        ...args.content === undefined ? {} : { content: args.content },
        ...args.keywords === undefined ? {} : { keywords: args.keywords },
      }, execProjectCwd(exec)).then(recordValue)
    },
    presentCall: args => present('Update memory', 'other', args.id),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_confirm',
    description: 'Approve a suggested memory so it is marked human-reviewed (`approved`). Approval does NOT enable persistent injection — whether a memory is injected every turn is a separate human-controlled switch (`injected`). Only call this when the human explicitly asks to approve a memory; never self-promote a suggestion. 将待审核记忆标记为已审核（approved）。审核通过不改变注入状态——是否每轮常驻注入由独立的人工开关（injected）控制。仅在用户明确要求审核某条记忆时调用；模型不得自我提升。',
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
}
