/**
 * 记忆索引行（① 2026-09-19）。
 *
 * 注入行每轮只装得下约 11 条常驻，其余上百条对模型完全不可见——而「不知道某条记忆存在」
 * 是检索的结构性盲区：检索是有意图的动作，搜不出自己不知道存在的东西。索引行报出**规模
 * 与入口**，把「不在场」变成「知道存在、需要时去取」，且**不搬运内容**。
 *
 * 两条硬约束由用例锁住：
 * ① **不占注入预算**：它与预算诊断行同待遇，是附加行而非记忆条目；
 * ② **长度常数级**：库从 10 条涨到 1000 条，这行的长度不能跟着涨（否则它自己会变成
 *    新的膨胀源）。主题数固定上限、条数只报数字。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { MemoryId } from '../src/engine.ts'
import type { MemoryRecord } from '../src/engine.ts'
import { INDEX_NOTICE_TOPICS, indexNotice } from '../src/injection.ts'
import * as plugin from '../src/index.ts'

function record(id: string, keywords: string[]): MemoryRecord {
  return {
    id: MemoryId(id), namespace: 'project', status: 'approved', injected: false,
    content: `摘要 ${id}`, keywords, createdAt: 0, updatedAt: 0,
  }
}

describe('记忆索引行（①）', () => {
  it('空库不出行（自消除）', () => {
    expect(indexNotice([])).toBe('')
  })

  it('隔离记录与模板都不计入', () => {
    expect(indexNotice([{ ...record('a', ['kw']), quarantined: true }])).toBe('')
    expect(indexNotice([{ ...record('b', ['kw']), kind: 'prompt' }])).toBe('')
  })

  it('行内含可见条数与主题，主题按词频降序、同频按字典序', () => {
    const line = indexNotice([
      record('a', ['alpha', 'common']),
      record('b', ['beta', 'common']),
      record('c', ['gamma', 'common']),
    ])
    expect(line).toContain('当前可见 3 条记忆')
    expect(line).toContain('common(3)')
    expect(line.indexOf('alpha(1)')).toBeLessThan(line.indexOf('beta(1)'))
    expect(line).toContain('memory_search')
  })

  it('主题数不超过上限', () => {
    const keywords = Array.from({ length: 20 }, (_, index) => `kw${String(index).padStart(2, '0')}`)
    const shown = indexNotice([record('a', keywords)]).match(/kw\d+\(\d+\)/g) ?? []
    expect(shown.length).toBe(INDEX_NOTICE_TOPICS)
  })

  it('行长为常数级：库从 10 条涨到 1000 条，长度几乎不变', () => {
    const build = (size: number): MemoryRecord[] =>
      Array.from({ length: size }, (_, index) => record(`r${index}`, ['共享主题', `独有${index}`]))
    const small = indexNotice(build(10))
    const large = indexNotice(build(1000))
    // 只有两处数字会变长（条数 10 → 1000、词频 10 → 1000），各 +2 字符封顶
    expect(large.length - small.length).toBeLessThanOrEqual(8)
    expect(large).toContain('当前可见 1000 条记忆')
  })

  it('端到端：组装出的注入里出现索引行（且与注入行、诊断行并存）', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    ctx.provide('webServer' as never, { register: () => () => {} } as never)
    ctx.provide('webRuntime' as never, { trustedHosts: [] } as never)
    const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-index-'))
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-memory-index-ws-'))
    const fiber = await ctx.plugin(plugin, { globalRoot })

    await ctx.memory.remember(
      { content: '常驻的那条', keywords: ['常驻主题'], namespace: 'project', injected: true },
      workspace,
    )
    await ctx.memory.remember(
      { content: '只可检索的那条', keywords: ['检索主题'], namespace: 'project' },
      workspace,
    )
    await ctx.memory.ensureProjectOpen(workspace)

    const assembly = await ctx.systemPrompt.assemble(
      { agent: { session: { header: { cwd: workspace } } } } as never,
    )
    const text = assembly.contexts.find(entry => entry.name === 'memory:recall')?.text ?? ''
    expect(text).toContain('当前可见 2 条记忆')
    expect(text).toContain('常驻主题(1)')
    expect(text).toContain('检索主题(1)')
    expect(text).toContain('- [memory:') // 注入行仍在

    await fiber.dispose()
  })
})
