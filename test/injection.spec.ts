import { describe, expect, it } from 'vitest'
import { MemoryId } from '../src/engine.ts'
import type { MemoryRecord } from '../src/engine.ts'
import { DEFAULT_SUMMARY_CHARS, OMITTED_NOTICE_LIMIT, STALE_NOTICE_LIMIT, candidateNotice, deriveSummary, formatDay, injectionLine, neutralizeBraces, omittedNotice, renderInjection, staleNotice } from '../src/injection.ts'

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

  it('0.12.0: lastUsedAt 不再影响注入顺序（旧语义的反向守卫）', () => {
    // 方向在 0.12.0 被反转。0.5.3 起 `lastUsedAt` 压过 `updatedAt`，而 `markUsed` 就在
    // 检索路径上——于是「查得多的」挤掉「钉得牢的」，一次 memory_search 就能改变下一轮的
    // 注入内容。现在顺序只由 `updatedAt` 决定：lastUsedAt 再新也不得前移。
    const usedRecently = {
      ...record('old-updated', 'stale but recently searched', 1),
      lastUsedAt: 999_999,
    }
    const updatedRecently = record('recent', 'recent edit never searched', 500)
    const rendered = renderInjection([updatedRecently, usedRecently], null, DEFAULT_SUMMARY_CHARS)
    expect(rendered.lines[0]).toContain('recent edit never searched')
  })
})

describe('时间标记（0.12.0）', () => {
  const at = new Date(2026, 8, 14, 10, 30).getTime()   // 2026-09-14 本地时间

  it('formatDay 取本地日期', () => {
    expect(formatDay(at)).toBe('2026-09-14')
    expect(formatDay(new Date(2026, 0, 3).getTime())).toBe('2026-01-03')   // 补零
  })

  it('注入行带日期，且与 scope 的顺序不歧义（日期在前）', () => {
    const plain = injectionLine({ ...record('abc', 'note', at), updatedAt: at }, DEFAULT_SUMMARY_CHARS)
    expect(plain).toContain('@2026-09-14')
    const scoped = injectionLine(
      { ...record('abc', 'note', at), updatedAt: at, scope: '..' }, DEFAULT_SUMMARY_CHARS)
    expect(scoped).toContain('@2026-09-14@..')
  })
})

describe('诊断行（0.12.0：新失效与候选）', () => {
  it('staleNotice: 空清单不出行；非空报条数与摘要', () => {
    expect(staleNotice([])).toBe('')
    const line = staleNotice([{ summary: '旧的部署路径' }, { summary: '过时的 API 形状' }])
    expect(line).toContain('2 条记忆失效')
    expect(line).toContain('旧的部署路径')
    expect(line).toContain('过时的 API 形状')
  })

  it('staleNotice: 超出上限只列前几条并以 … 收尾', () => {
    const many = Array.from({ length: STALE_NOTICE_LIMIT + 2 }, (_, index) => ({ summary: `第 ${index} 条` }))
    const line = staleNotice(many)
    expect(line).toContain(`${many.length} 条记忆失效`)   // 数量报全量
    expect(line.endsWith('…）')).toBe(true)                // 明细截断有标记
  })

  it('candidateNotice: 空清单不出行；用短摘要并报总数', () => {
    expect(candidateNotice([])).toBe('')
    const line = candidateNotice([{ content: '一条很长的候选记忆正文，摘要只取前面一小段' }])
    expect(line).toContain('1 条被反复检索但未常驻')
    expect(line).toContain('一条很长的候选记忆正文')
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

describe('neutralizeBraces (0.11.1)', () => {
  it('中和字面双花括号（严格插值下它会抛错并炸掉会话）', () => {
    expect(neutralizeBraces('a {{footer}} b')).toBe('a { {footer}} b')
    expect(neutralizeBraces('a {{footer}} b')).not.toContain('{{')
  })

  it('三连左花括号不残留（Mustache raw partial 场景）', () => {
    expect(neutralizeBraces('Mustache raw partial: {{{footer}}}')).not.toContain('{{')
  })

  it('四连与更长的连续左花括号都收敛', () => {
    // 单遍 replaceAll 不够：`{{{{a}}}}` 单遍得 `{ {{ {a}}}}`，仍含 `{{`——循环是必需的
    expect(neutralizeBraces('{{{{a}}}}')).toBe('{ { { {a}}}}')
    expect(neutralizeBraces('{'.repeat(50))).not.toContain('{{')
    expect(neutralizeBraces('{'.repeat(1000))).not.toContain('{{')
  })

  it('无花括号的文本原样返回', () => {
    expect(neutralizeBraces('plain text 中文')).toBe('plain text 中文')
  })

  it('孤立的左花括号也一并中和', () => {
    // 不闭合的 `{{` 本不触发插值（按字面放过），多中和一处无害，换来实现简单可靠
    expect(neutralizeBraces('这里的 {{ 没有闭合')).toBe('这里的 { { 没有闭合')
  })
})
