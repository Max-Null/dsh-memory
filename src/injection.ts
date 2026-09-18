/**
 * 注入渲染（0.5.2）：`memory:recall` 与面板「注入预览」共用的确定性
 * 渲染——摘要化 + 预算截断。纯函数、无模型调用：注入行 = 每条记忆的
 * 单行摘要（内容过长取首行截断），超出预算（字符数）时按「最近更新
 * 优先」贪心保留；省略明细返回给面板与预算诊断（2026-09-18）。
 */

import type { MemoryRecord } from './engine.ts'

/** 摘要截断上限（字符）：中英混合场景下 ~40-60 token。 */
export const DEFAULT_SUMMARY_CHARS = 80
/** 注入预算（字符）：0.5.2 起默认开启，防常驻注入随记忆增长膨胀上下文。 */
export const DEFAULT_INJECTION_BUDGET = 1500
/** 诊断行列出的条数上限（2026-09-18）：超出只列前 N 个，防这行本身失控。 */
export const OMITTED_NOTICE_LIMIT = 12
/** 诊断行里每条出局者的摘要长度（2026-09-18）：够认出是哪条即可。 */
export const OMITTED_SUMMARY_CHARS = 24

/** 单条注入行的固定标记开销（不含摘要本体）。 */
const LINE_OVERHEAD = 27

/**
 * 确定性摘要：取首行，超过 maxChars 截断加省略号。
 * 空内容/空首行回退为去掉换行后的前 maxChars（保证 any 内容有摘要）。
 */
export function deriveSummary(content: string, maxChars: number): string {
  const firstLine = content.split('\n')[0]!.trim()
  if (firstLine !== '') {
    return firstLine.length <= maxChars ? firstLine : `${firstLine.slice(0, maxChars)}…`
  }
  const collapsed = content.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return content
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}…`
}

/** 一条注入行的渲染文本（与面板预览完全一致）。 */
export function injectionLine(record: MemoryRecord, summaryChars: number): string {
  // ④-A：跨工作区召回时带来源标记（`..` / `../..`）；当前工作区不带，保持既有格式
  const scope = record.scope === undefined ? '' : `@${record.scope}`
  return `- [memory:${String(record.id).slice(0, 8)}:${record.namespace}${scope}] ${deriveSummary(record.content, summaryChars)}`
}

export interface InjectionRender {
  /** 实际注入行（已按预算截断、按更新时间降序）。 */
  lines: string[]
  /** 生效的预算（字符；null = 无限制）。 */
  budget: number | null
  /** 因预算被省略的候选条数（0 = 全部注入）。 */
  omitted: number
  /**
   * 被省略条目的明细：`summary` 供预算诊断行报出「是哪条」，`line` 与
   * {@link lines} 同格式、供面板明细直接渲染，`id` 备用。诊断行**不占预算**——
   * 它由 `recallText` 追加在注入行之后，不参与这里的截断。
   */
  omittedRecords: Array<{ id: string, line: string, summary: string }>
  /** 实际注入的字符数（摘要 + 标记开销之和；不含 {@link omittedRecords}）。 */
  chars: number
}

/**
 * 由候选记录渲染注入行：按使用序降序（lastUsedAt 优先、缺省回退
 * updatedAt——最近使用/更新的记忆最先），逐条累加开销直到预算用尽；
 * 预算为 null 或非正数时全量注入（不过滤）。
 */
export function renderInjection(
  records: readonly MemoryRecord[],
  budget: number | null,
  summaryChars: number,
): InjectionRender {
  const ordered = [...records].sort((left, right) =>
    (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt))
  const lines: string[] = []
  const omittedRecords: Array<{ id: string, line: string, summary: string }> = []
  let chars = 0
  let omitted = 0
  for (const record of ordered) {
    const text = injectionLine(record, summaryChars)
    const cost = text.length + LINE_OVERHEAD
    if (budget !== null && budget > 0 && chars + cost > budget) {
      omitted++
      omittedRecords.push({
        id: String(record.id),
        line: text,
        summary: deriveSummary(record.content, OMITTED_SUMMARY_CHARS),
      })
      continue
    }
    lines.push(text)
    chars += cost
  }
  return { lines, budget: budget ?? null, omitted, omittedRecords, chars }
}

/**
 * 预算诊断行（2026-09-18）：列出被预算挡在外面的条目，**带短摘要而不是只有 id**——
 * 「主动去查这个 id 是什么」正是最容易省略的那一步，而省略它就等于看不出来。
 * 只报出局者、不报进场者（后者本来就在注入列表里）。**不占注入预算**（调用方把它
 * 追加在注入行之后），清理干净后自行消失（`omitted === 0` 返回空串）；超出
 * {@link OMITTED_NOTICE_LIMIT} 只列前 N 个。
 */
export function omittedNotice(rendered: InjectionRender): string {
  if (rendered.omitted === 0) return ''
  const shown = rendered.omittedRecords.slice(0, OMITTED_NOTICE_LIMIT)
  const labels = shown.map(record => record.summary)
  const truncated = rendered.omittedRecords.length > shown.length ? '…' : ''
  return `（另有 ${rendered.omitted} 条常驻因预算未注入：${labels.join('、')}${truncated}）`
}

/** 子项目索引行列出的条数上限（④-B）：超出以 `…` 结尾，防这行本身失控。 */
export const NEIGHBOR_NOTICE_LIMIT = 5

/**
 * 子项目索引行（④-B 2026-09-19）：告诉模型「当前工作区下面还有什么」——它补的是
 * 「不知道存在」这个检索的结构性盲区，而**不搬运内容**（正文照旧走 memory_search）。
 *
 * 与预算诊断行同待遇：**不占注入预算**、自消除（没有子项目记忆时返回空串）。
 * 只报条数不报 id——这一行的用途是给出**规模与入口**，不是当检索结果用。
 */
export function neighborNotice(neighbors: ReadonlyArray<{ name: string, count: number }>): string {
  if (neighbors.length === 0) return ''
  const shown = neighbors.slice(0, NEIGHBOR_NOTICE_LIMIT)
  const labels = shown.map(neighbor => `${neighbor.name}（${neighbor.count} 条）`)
  const truncated = neighbors.length > shown.length ? '…' : ''
  return `（本工作区下另有 ${neighbors.length} 个子项目带记忆：${labels.join('、')}${truncated}——用 memory_search 检索）`
}

/** 索引行列出的主题数上限（① 2026-09-19）：常数级——这行不随库增长。 */
export const INDEX_NOTICE_TOPICS = 5

/**
 * 记忆索引行（① 2026-09-19）：给出「库里还有什么、按什么去搜」。
 *
 * 它补的是**检索的结构性盲区**——检索是有意图的动作，不知道某条记忆存在就搜不出它。
 * 注入行每轮只装得下约 11 条，其余上百条对模型完全不可见；这一行报出**规模与入口**，
 * 让「不在场」变成「知道存在、需要时去取」。
 *
 * 为什么不做成一条常驻记忆（用户最初的设想）：那样它会自己占约 135 字符预算、参与零和
 * 竞争、可能自己也被挤掉，而且记忆增删后**不会自动更新**（目录与内容不一致且无人察觉）。
 * 做成系统生成的行则：不占预算、不可能腐化、永远反映当前状态。
 *
 * 主题取自各条的 `keywords` 词频——那是记忆写入时被要求「给多角度」的字段，**与检索用的
 * 是同一套词汇**，所以索引里出现的词就是能搜到的词。同频时按字典序排，保证输出确定。
 */
export function indexNotice(records: ReadonlyArray<MemoryRecord>): string {
  const usable = records.filter(record =>
    record.status === 'approved'
    && record.quarantined !== true
    && (record.kind ?? 'fact') !== 'prompt')
  if (usable.length === 0) return ''
  const counts = new Map<string, number>()
  for (const record of usable) {
    for (const keyword of record.keywords) {
      counts.set(keyword, (counts.get(keyword) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return ''
  const topics = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, INDEX_NOTICE_TOPICS)
  const labels = topics.map(([topic, count]) => `${topic}(${count})`)
  return `（索引：当前可见 ${usable.length} 条记忆，主题集中在 ${labels.join('、')}——用 memory_search 检索）`
}
