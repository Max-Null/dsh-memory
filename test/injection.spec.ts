import { describe, expect, it } from 'vitest'
import { MemoryId } from '../src/engine.ts'
import type { MemoryRecord } from '../src/engine.ts'
import { DEFAULT_SUMMARY_CHARS, deriveSummary, renderInjection } from '../src/injection.ts'

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
