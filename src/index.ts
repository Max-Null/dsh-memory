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
export { bm25Scores, tokenize } from './bm25.ts'

export const name = 'dsh-memory'
export const inject = ['storage', 'systemPrompt', 'tools']

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
  }
}

function hitValue(hit: MemoryHit): MemoryToolHit {
  return { record: recordValue(hit.record), score: hit.score }
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

function recallText(memory: MemoryEngine): string {
  // 0.3.0：只注入「已审核 + 常驻开关打开」的记忆（二维模型）
  const auto = memory.list({ status: 'approved', injected: true })
  if (auto.length === 0) return ''
  const lines = auto.map(record => `- [memory:${String(record.id)}] ${record.content}`)
  return `Remembered preferences and conventions — apply these:\n${lines.join('\n')}`
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
  const memory = ctx.get('memory')
  if (memory === undefined) throw new Error('memory engine failed to register')

  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: 115,
    text: GUIDANCE,
  })

  ctx.systemPrompt.context({
    name: 'memory:recall',
    order: 50,
    text: () => recallText(memory),
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
    execute(args, _exec) {
      return memory.remember({
        content: args.content,
        ...args.namespace === undefined ? {} : { namespace: args.namespace },
        ...args.keywords === undefined ? {} : { keywords: args.keywords },
      }).then(recordValue)
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
    execute(args, _exec) {
      return Promise.resolve(memory.list({
        ...args.namespace === undefined ? {} : { namespace: args.namespace },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.injected === undefined ? {} : { injected: args.injected },
      }).map(recordValue))
    },
    presentCall: () => present('List memories', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Recall stored memories by keyword. Deterministic literal matching — a miss means no stored term matched the query. 按关键词检索记忆（含待审核条目）。',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword query. 关键词查询.' },
      namespace: { type: 'string', enum: ['global', 'project'], description: 'Restrict to one namespace. 限定单个命名空间.' },
      status: { type: 'string', enum: ['suggested', 'approved'], description: 'Restrict to one review status. 限定审核状态.' },
    },
    output: {
      schema: { type: 'array', items: HIT_SCHEMA },
      render: (_args, value) => renderJson(value),
    },
    execute(args, _exec) {
      return Promise.resolve(memory.search(args.query, {
        ...args.namespace === undefined ? {} : { namespace: args.namespace },
        ...args.status === undefined ? {} : { status: args.status },
      }).map(hitValue))
    },
    presentCall: args => present('Search memory', 'read', args.query),
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
    execute(args, _exec) {
      return memory.forget(args.id as never).then(deleted => ({ deleted }))
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
    execute(args, _exec) {
      return memory.update(args.id as never, {
        ...args.content === undefined ? {} : { content: args.content },
        ...args.keywords === undefined ? {} : { keywords: args.keywords },
      }).then(recordValue)
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
    execute(args, _exec) {
      return memory.setStatus(args.id as never, 'approved').then(recordValue)
    },
    presentCall: args => present('Confirm memory', 'other', args.id),
  }))
}
