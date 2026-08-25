/**
 * 注入渲染（0.5.2）：`memory:recall` 与面板「注入预览」共用的确定性
 * 渲染——摘要化 + 预算截断。纯函数、无模型调用：注入行 = 每条记忆的
 * 单行摘要（内容过长取首行截断），超出预算（字符数）时按「最近更新
 * 优先」贪心保留，省略计数返回给 UI 提示。
 */

import type { MemoryRecord } from './engine.ts'

/** 摘要截断上限（字符）：中英混合场景下 ~40-60 token。 */
export const DEFAULT_SUMMARY_CHARS = 80
/** 注入预算（字符）：0.5.2 起默认开启，防常驻注入随记忆增长膨胀上下文。 */
export const DEFAULT_INJECTION_BUDGET = 1500

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
  return `- [memory:${String(record.id).slice(0, 8)}:${record.namespace}] ${deriveSummary(record.content, summaryChars)}`
}

export interface InjectionRender {
  /** 实际注入行（已按预算截断、按更新时间降序）。 */
  lines: string[]
  /** 生效的预算（字符；null = 无限制）。 */
  budget: number | null
  /** 因预算被省略的候选条数（0 = 全部注入）。 */
  omitted: number
  /** 实际注入的字符数（摘要 + 标记开销之和）。 */
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
  let chars = 0
  let omitted = 0
  for (const record of ordered) {
    const text = injectionLine(record, summaryChars)
    const cost = text.length + LINE_OVERHEAD
    if (budget !== null && budget > 0 && chars + cost > budget) {
      omitted++
      continue
    }
    lines.push(text)
    chars += cost
  }
  return { lines, budget: budget ?? null, omitted, chars }
}
