/**
 * 查询日志与影响力统计（2026-09-15 静默记忆机制，设计文档 §三.5 / §六.6）。
 *
 * 漏检不产生任何事件：「该用却搜不到」与「真没用了」在旧信号里长得一样（反例 4），
 * 照使用信号沉底会误杀。所以插件必须自己观察自己——记录每次检索的查询与命中数
 * （有界保留），事后低频反查「这些查询本该命中谁」；同一份数据反过来按**来源**聚合
 * 影响力（写入量 / 命中数），作为「某来源写入多、命中 0」这类关闭信号的判据（反例 5）。
 *
 * 纯文件读写 + 纯函数，不引入依赖。日志是检索路径上的**旁路**：写失败绝不能影响
 * 检索结果，因此文件读写各自容错，抛错只由调用方处理（引擎侧一律 try/catch）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tokenize } from './bm25.ts'

/** 有界保留条数（设计文档 §六.6「有界保留」，建议最近 200 条）。 */
export const QUERY_LOG_LIMIT = 200
/** 单条查询文本的截断上限（字符）——日志只用于反查，不需要全文。 */
export const QUERY_TEXT_LIMIT = 120
/** 单次反查报告的查询个数上限（低频反查：一次看一小批就够）。 */
export const GAP_QUERY_LIMIT = 10
/** 每个查询给出的候选上限。 */
export const GAP_CANDIDATE_LIMIT = 5
/**
 * 前缀近似匹配的最短词元长度：太短会连出一片噪声（CJK 单字/双字元长度都不足 3，
 * 因此这一档实质上只对英文与标识符生效）。
 */
const RELAXED_MIN_CHARS = 3

/** 记忆来源：'agent' = 主模型写入；'human' = 人工写入。 */
export type MemorySource = 'agent' | 'human'

/** 聚合时无来源字段的旧记录归入此组（不猜测，保留「未知历史来源」）。 */
export const UNKNOWN_SOURCE = 'unknown'

/** One recorded `memory_search` call: the query text, how many records it hit, and when. */
export interface QueryLogEntry {
  /** 查询文本（已折叠空白并截断）。 */
  query: string
  /** 本次检索的命中条数；0 = 空命中，正是反查的入口。 */
  hits: number
  /** 记录时间（epoch ms）。 */
  at: number
}

/** 一次查询日志写入（`at` 缺省 = 现在）。 */
export interface QueryLogInput {
  query: string
  hits: number
  at?: number
}

/** 日志文件位置与有界条数。 */
export interface QueryLogOptions {
  /** 日志文件绝对路径（与 memory.json 同目录）。 */
  path: string
  /** 有界保留条数；缺省 {@link QUERY_LOG_LIMIT}。 */
  limit?: number
  /** 时钟（测试注入用）；缺省 Date.now。 */
  now?: () => number
}

/** 一个空命中查询在日志里的累计形态（反查的输入）。 */
export interface QueryGapSummary {
  query: string
  /** 该查询空命中的次数。 */
  count: number
  /** 最近一次出现的时间。 */
  lastAt: number
}

/** 查询日志的聚合摘要（纯统计，不读文件）。 */
export interface QueryLogSummary {
  /** 日志条数。 */
  total: number
  /** 空命中（hits === 0）的条数。 */
  misses: number
  /** 去重后的空命中查询，最近出现的在前（最多 `limit` 个）。 */
  gaps: QueryGapSummary[]
  /** 最近一条日志的时间（0 = 空日志）。 */
  lastAt: number
}

/** 反查候选：一条可能与查询相关、但检索当时没有命中的记忆。 */
export interface GapCandidate {
  /** 记录 id（字符串形态）。 */
  id: string
  /** 记录正文（调用方按需截断）。 */
  content: string
  /** 精确词元命中数：> 0 表示「现在重搜就该命中」。 */
  exact: number
  /** 前缀近似命中的查询词元（如 vue3 ↔ vue）。 */
  relaxed: string[]
}

/** 影响力统计的输入：一条现存记录的来源与影响面。 */
export interface SourceTallyInput {
  /** 来源；缺省 = 旧记录（无来源字段）。 */
  source?: MemorySource
  /** 被检索命中的累计次数。 */
  hitCount: number
  /** 是否常驻注入（真正改变每轮决策的那部分）。 */
  injected: boolean
}

/** 按来源聚合的影响力（设计文档 §六.6 的三个数里的前两个 + 注入面）。 */
export interface SourceStat {
  source: MemorySource | typeof UNKNOWN_SOURCE
  /** 写入量：现存的该来源记录数。 */
  writes: number
  /** 被检索命中数：现存记录 `hitCount` 合计。 */
  hits: number
  /** 常驻注入条数。 */
  injected: number
}

/** 查询文本规范化（纯函数）：折叠空白 + 截断。 */
export function normalizeQuery(query: string, limit = QUERY_TEXT_LIMIT): string {
  const collapsed = query.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit)
}

/**
 * 逐条校验（纯函数）：结构不对的条目丢弃——日志是辅助证据，
 * 一条坏记录不该让整份日志失效。
 */
function toEntry(value: unknown): QueryLogEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as { query?: unknown, hits?: unknown, at?: unknown }
  if (typeof entry.query !== 'string' || entry.query.trim() === '') return undefined
  if (typeof entry.hits !== 'number' || !Number.isFinite(entry.hits)) return undefined
  return {
    query: normalizeQuery(entry.query),
    hits: Math.max(0, Math.trunc(entry.hits)),
    at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
  }
}

/**
 * 容错解析（纯函数）：坏 JSON / 坏结构 → 空日志（绝不抛）。
 * 接受两种形态：裸数组，以及 `{ queries: [...] }`（本模块写出的形态）。
 */
export function parseQueryLog(text: string): QueryLogEntry[] {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return []
  }
  let raw: unknown
  if (Array.isArray(document)) raw = document
  else if (typeof document === 'object' && document !== null) raw = (document as { queries?: unknown }).queries
  else return []
  if (!Array.isArray(raw)) return []
  return raw.map(toEntry).filter((entry): entry is QueryLogEntry => entry !== undefined)
}

/** 序列化（纯函数）：2 空格缩进 + 尾换行，与仓库其他存储文件一致。 */
export function serializeQueryLog(log: readonly QueryLogEntry[]): string {
  return `${JSON.stringify({ queries: log }, null, 2)}\n`
}

/** 纯函数：追加一条并截到上限（最新的在末尾；返回新数组，不改入参）。 */
export function appendQueryEntry(
  log: readonly QueryLogEntry[],
  input: QueryLogInput,
  limit = QUERY_LOG_LIMIT,
): QueryLogEntry[] {
  const appended = [...log, {
    query: normalizeQuery(input.query),
    hits: Math.max(0, Math.trunc(input.hits)),
    at: input.at ?? Date.now(),
  }]
  const cap = Math.max(0, Math.trunc(limit))
  return appended.length <= cap ? appended : appended.slice(appended.length - cap)
}

/** 聚合摘要（纯函数）：空命中计数 + 去重查询列表（反查入口）。 */
export function summarizeQueryLog(log: readonly QueryLogEntry[], limit = GAP_QUERY_LIMIT): QueryLogSummary {
  const byQuery = new Map<string, QueryGapSummary>()
  let misses = 0
  let lastAt = 0
  for (const entry of log) {
    if (entry.at > lastAt) lastAt = entry.at
    if (entry.hits > 0) continue
    misses += 1
    const seen = byQuery.get(entry.query)
    if (seen === undefined) {
      byQuery.set(entry.query, { query: entry.query, count: 1, lastAt: entry.at })
      continue
    }
    seen.count += 1
    if (entry.at > seen.lastAt) seen.lastAt = entry.at
  }
  const gaps = [...byQuery.values()]
    .sort((left, right) => right.lastAt - left.lastAt)
    .slice(0, Math.max(0, Math.trunc(limit)))
  return { total: log.length, misses, gaps, lastAt }
}

/**
 * 反查排序（纯函数）：把一个空命中的查询与当前记忆库对起来，找出「本应命中」的候选。
 *
 * 两档匹配，都只看字面，因此结论可解释：
 * ①**精确词元**（与检索同一套分词）：命中即代表现在重搜会命中——日志里却是 0，
 *   说明那条记忆是查询之后才写入的（或当时被过滤挡掉了）；
 * ②**前缀近似**（长度 ≥ {@link RELAXED_MIN_CHARS} 且互为前缀）：覆盖「vue3 ↔ vue」
 *   这类标识符/版本号变体——检索按整词比对必然漏，而它往往正是该补 keywords 的那条。
 *
 * 两档都无候选 = 知识缺口（这类知识库里确实还没有），本身也是有用信息。
 */
export function rankGapCandidates(
  query: string,
  docs: readonly { id: string, body: string, tags?: string }[],
  limit = GAP_CANDIDATE_LIMIT,
): GapCandidate[] {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return []
  const candidates: GapCandidate[] = []
  for (const doc of docs) {
    const docTerms = new Set(tokenize(doc.tags === undefined ? doc.body : `${doc.body} ${doc.tags}`))
    const exact = queryTerms.filter(term => docTerms.has(term)).length
    const relaxed: string[] = []
    for (const term of queryTerms) {
      if (docTerms.has(term) || term.length < RELAXED_MIN_CHARS) continue
      for (const candidate of docTerms) {
        if (candidate.length < RELAXED_MIN_CHARS) continue
        if (candidate.startsWith(term) || term.startsWith(candidate)) {
          relaxed.push(term)
          break
        }
      }
    }
    if (exact === 0 && relaxed.length === 0) continue
    candidates.push({ id: doc.id, content: doc.body, exact, relaxed })
  }
  return candidates
    .sort((left, right) =>
      right.exact - left.exact
      || right.relaxed.length - left.relaxed.length
      || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, Math.trunc(limit)))
}

/**
 * 按来源聚合影响力（纯函数，设计文档 §六.6 / 反例 5）：写入量与被检索命中数。
 *
 * **第三个数的取舍**：设计文档要的「被人工删除数」在这里没有，原因是它无法归属——
 * 来源字段长在记录上，`memory_forget` 删除记录时来源一起消失，查询日志也不携带来源，
 * 于是删除量只能数出总数、数不出是谁写的。按「日志里曾经的 id 现已不存在」做差异法
 * 同样归不到来源（能归的只有还活着的记录，活着的没被删）。要拿到它需要在 `forget()`
 * 里追加带来源的删除墓碑，第一版不做：先攒前两个数，等真需要判 habit / guardian 时再补。
 */
export function summarizeSources(records: readonly SourceTallyInput[]): SourceStat[] {
  const stats = new Map<SourceStat['source'], SourceStat>()
  for (const record of records) {
    const source: SourceStat['source'] = record.source ?? UNKNOWN_SOURCE
    const stat = stats.get(source) ?? { source, writes: 0, hits: 0, injected: 0 }
    stat.writes += 1
    stat.hits += Math.max(0, Math.trunc(record.hitCount))
    if (record.injected) stat.injected += 1
    stats.set(source, stat)
  }
  const order: Array<SourceStat['source']> = ['agent', 'human', UNKNOWN_SOURCE]
  return [...stats.values()]
    .sort((left, right) => order.indexOf(left.source) - order.indexOf(right.source))
}

/**
 * 有界查询日志（文件 + 上面的纯函数）。每次追加都是读-改-写整个文件：单进程内由
 * 事件循环串行化，多进程并发（两个 DSH 实例）可能丢条目——日志是旁路证据，可接受。
 */
export class QueryLog {
  private readonly limit: number
  private readonly now: () => number

  constructor(private readonly options: QueryLogOptions) {
    this.limit = options.limit ?? QUERY_LOG_LIMIT
    this.now = options.now ?? Date.now
  }

  /** 读日志；文件缺失或损坏 → 空数组（绝不抛）。 */
  readLog(): QueryLogEntry[] {
    try {
      if (!existsSync(this.options.path)) return []
      return parseQueryLog(readFileSync(this.options.path, 'utf8'))
    } catch {
      return []
    }
  }

  /**
   * 追加一条（有界：越界丢最旧）。**写失败会抛**——由调用方兜住：
   * 检索路径上的日志失败绝不能改变检索结果。
   * @returns 写入后的完整日志（调用方可直接用，不必重读）。
   */
  appendQuery(input: QueryLogInput): QueryLogEntry[] {
    const next = appendQueryEntry(this.readLog(), { ...input, at: input.at ?? this.now() }, this.limit)
    mkdirSync(dirname(this.options.path), { recursive: true })
    writeFileSync(this.options.path, serializeQueryLog(next))
    return next
  }

  /** 聚合摘要（空命中与去重查询列表）。 */
  summarize(limit?: number): QueryLogSummary {
    return summarizeQueryLog(this.readLog(), limit)
  }
}
