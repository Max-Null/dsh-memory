import { describe, expect, it } from 'vitest'
import { MemoryId } from '../src/engine.ts'
import type { MemoryRecord } from '../src/engine.ts'
import { DEFAULT_SUMMARY_CHARS, OMITTED_NOTICE_LIMIT, deriveSummary, omittedNotice, renderInjection } from '../src/injection.ts'

function record(id: string, content: string, updatedAt: number, namespace: 'global' | 'project' = 'global'): MemoryRecord {
  return {
    id: MemoryId(id), namespace, status: 'approved', injected: true,
    content, keywords: [], createdAt: updatedAt, updatedAt,
  }
}

describe('injection rendering (0.5.2)', () => {
  it('deriveSummary: short text stays, long first line truncates, multiline takes first line', () => {
    expect(deriveSummary('short note', 80)).toBe('short note')
    expect(deriveSummary('a'.repeat(200), 80)).toBe(`${'a'.repeat(80)}…`)
    expect(deriveSummary('first line\nsecond line', 80)).toBe('first line')
    // 空行开头：回退到折叠后的全文
    expect(deriveSummary('\n  \nspread across lines', 80)).toBe('spread across lines')
  })

  it('renderInjection: no budget injects everything with derived summaries', () => {
    const rendered = renderInjection([
      record('a', 'alpha note', 2),
      record('b', `beta ${'x'.repeat(200)}`, 1),
    ], null, DEFAULT_SUMMARY_CHARS)
    expect(rendered.lines).toHaveLength(2)
    expect(rendered.lines[0]).toContain('alpha note')
    expect(rendered.lines[1]).toContain('x'.repeat(70)) // 长内容摘要化（首行 80 字截断，含 'beta ' 前缀）
    expect(rendered.lines[1]).not.toContain('x'.repeat(80))
    expect(rendered.omitted).toBe(0)
    expect(rendered.budget).toBeNull()
  })

  it('renderInjection: budget keeps newest first and counts omissions', () => {
    const rendered = renderInjection([
      record('old', 'old note', 1),
      record('mid', 'mid note', 2),
      record('new', 'new note', 3),
    ], 100, DEFAULT_SUMMARY_CHARS)
    expect(rendered.lines).toHaveLength(1)
    expect(rendered.lines[0]).toContain('new note') // 最近更新优先
    expect(rendered.omitted).toBe(2)
  })

  it('renderInjection: tiny budget may omit even the newest entry', () => {
    const rendered = renderInjection([record('only', 'only note', 1)], 10, DEFAULT_SUMMARY_CHARS)
    expect(rendered.lines).toEqual([])
    expect(rendered.omitted).toBe(1)
  })

  it('renderInjection: lastUsedAt outranks updatedAt when both present (0.5.3)', () => {
    const usedRecently = {
      ...record('old-updated', 'stale but recently searched', 1),
      lastUsedAt: 999,
    }
    const updatedRecently = record('recent', 'recent edit never searched', 500)
    const rendered = renderInjection([updatedRecently, usedRecently], null, DEFAULT_SUMMARY_CHARS)
    expect(rendered.lines[0]).toContain('stale but recently searched')
  })
})

describe('预算诊断（2026-09-18）', () => {
  it('renderInjection: omittedRecords 给出被跳过的明细，且不混进注入行', () => {
    const rendered = renderInjection([
      record('old', 'old note', 1),
      record('mid', 'mid note', 2),
      record('new', 'new note', 3),
    ], 100, DEFAULT_SUMMARY_CHARS)

    expect(rendered.omitted).toBe(2)
    // 明细按渲染顺序（新→旧），与注入行同一套排序
    expect(rendered.omittedRecords.map(item => String(item.id))).toEqual(['mid', 'old'])
    expect(rendered.omittedRecords[0]?.line).toContain('mid note')
    expect(rendered.omittedRecords[0]?.summary).toBe('mid note')
    // 明细只活在 omittedRecords 里：注入行既没有它们，也没有诊断文本
    expect(rendered.lines.some(line => line.includes('mid note'))).toBe(false)
    expect(rendered.lines.every(line => !line.includes('未注入'))).toBe(true)
  })

  it('omittedNotice: 无省略返回空串；有省略列出短摘要而不是 id', () => {
    const none = renderInjection([record('a', 'alpha note', 1)], null, DEFAULT_SUMMARY_CHARS)
    expect(omittedNotice(none)).toBe('')

    const some = renderInjection([
      record('aaaabbbbcccc', '[适配纪律] 统计必须回到原文核实，凭印象写会出错', 1),
      record('dddd', 'delta note', 2),
    ], 100, DEFAULT_SUMMARY_CHARS)
    expect(some.omitted).toBe(1)

    const notice = omittedNotice(some)
    expect(notice).toContain('另有 1 条')
    expect(notice).toContain('适配纪律')          // 摘要进了诊断行
    expect(notice).not.toContain('aaaabbbb')      // 不再只列 id
    // 摘要按 OMITTED_SUMMARY_CHARS 截断（超长时尾部补省略号）
    expect(some.omittedRecords[0]?.summary.length).toBeLessThanOrEqual(25)
  })

  it('omittedNotice: 超过上限只列前 N 条并以省略号结尾', () => {
    const records = Array.from({ length: OMITTED_NOTICE_LIMIT + 3 }, (_, index) =>
      record(`id${String(index).padStart(6, '0')}`, `note ${index}`, index + 1))
    // 预算 1：一条都装不下，全部出局
    const rendered = renderInjection(records, 1, DEFAULT_SUMMARY_CHARS)
    expect(rendered.omitted).toBe(records.length)

    const notice = omittedNotice(rendered)
    expect(notice).toContain(`另有 ${records.length} 条`)
    expect(notice.endsWith('…）')).toBe(true)
    expect(notice.match(/note \d+/g)).toHaveLength(OMITTED_NOTICE_LIMIT)
  })
})
