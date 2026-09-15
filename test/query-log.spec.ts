import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QueryLog,
  appendQueryEntry,
  normalizeQuery,
  parseQueryLog,
  rankGapCandidates,
  serializeQueryLog,
  summarizeQueryLog,
  summarizeSources,
} from '../src/query-log.ts'

/** 临时目录中的日志文件（时钟固定，便于断言）。 */
async function tempLog(options: { limit?: number, nested?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-querylog-'))
  const path = options.nested === true ? join(dir, 'nested', 'query-log.json') : join(dir, 'query-log.json')
  return { dir, path, log: new QueryLog({ path, ...options.limit === undefined ? {} : { limit: options.limit }, now: () => 1000 }) }
}

describe('查询日志（2026-09-15 静默记忆机制 ⑥）', () => {
  it('normalizeQuery：折叠空白 + 截断到上限', () => {
    expect(normalizeQuery('  alpha   beta  ')).toBe('alpha beta')
    expect(normalizeQuery('x'.repeat(200))).toHaveLength(120)
    expect(normalizeQuery('短查询')).toBe('短查询')
  })

  it('appendQueryEntry：有界保留（越界丢最旧）且不改入参', () => {
    const base = [{ query: 'x', hits: 0, at: 1 }]
    const next = appendQueryEntry(base, { query: 'y', hits: 1, at: 2 })
    expect(base).toHaveLength(1)                                  // 纯函数：入参不动
    expect(next.map(entry => entry.query)).toEqual(['x', 'y'])

    const capped = appendQueryEntry(
      [
        { query: 'a', hits: 0, at: 1 },
        { query: 'b', hits: 0, at: 2 },
      ],
      { query: 'c', hits: 0, at: 3 },
      2,
    )
    expect(capped.map(entry => entry.query)).toEqual(['b', 'c'])   // 丢的是最旧的 a
  })

  it('parseQueryLog：坏 JSON / 坏条目一律丢弃，接受裸数组与 {queries} 两种形态', async () => {
    expect(parseQueryLog('')).toEqual([])
    expect(parseQueryLog('{ not json')).toEqual([])
    expect(parseQueryLog('42')).toEqual([])
    expect(parseQueryLog('{"queries":[{"query":"a","hits":1,"at":2}]}'))
      .toEqual([{ query: 'a', hits: 1, at: 2 }])
    // 裸数组形态（手工编辑过的文件）+ 缺 at → 0（时间未知，排序时自然靠后）
    expect(parseQueryLog('[{"query":"a","hits":1}]')).toEqual([{ query: 'a', hits: 1, at: 0 }])
    // 坏条目：空 query / hits 非数字 / 非对象 → 丢掉；负数 hits 归零
    expect(parseQueryLog('{"queries":[{"query":"","hits":1},{"query":"b","hits":"x"},{"query":"c","hits":-3,"at":5},"junk"]}'))
      .toEqual([{ query: 'c', hits: 0, at: 5 }])
  })

  it('serializeQueryLog：{queries} 形态 + 2 空格缩进 + 尾换行', async () => {
    const text = serializeQueryLog([{ query: 'a', hits: 1, at: 2 }])
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('"queries"')
    expect(text.split('\n')[2]).toBe('    {')   // 2 空格缩进（与仓库其他存储文件一致）
    expect(parseQueryLog(text)).toEqual([{ query: 'a', hits: 1, at: 2 }])
  })

  it('summarizeQueryLog：空命中计数 + 去重查询（最近出现的在前）', () => {
    const summary = summarizeQueryLog([
      { query: 'a', hits: 2, at: 100 },
      { query: 'b', hits: 0, at: 200 },
      { query: 'a', hits: 0, at: 300 },
      { query: 'b', hits: 0, at: 400 },
    ])
    expect(summary.total).toBe(4)
    expect(summary.misses).toBe(3)
    expect(summary.lastAt).toBe(400)
    expect(summary.gaps).toEqual([
      { query: 'b', count: 2, lastAt: 400 },
      { query: 'a', count: 1, lastAt: 300 },
    ])
    expect(summarizeQueryLog([]).gaps).toEqual([])
    expect(summarizeQueryLog([{ query: 'a', hits: 0, at: 1 }], 0).gaps).toEqual([]) // limit 可截空
  })

  it('rankGapCandidates：精确词元与前缀近似两档，其余不进候选', () => {
    const docs = [
      { id: 'a', body: '组合式 API 的写法', tags: 'vue' },
      { id: 'b', body: 'alpha beta', tags: 'alpha' },
      { id: 'c', body: '完全无关的内容', tags: 'other' },
    ]
    // 前缀近似：检索按整词比对漏掉 vue3，反查把它捞出来
    const relaxed = rankGapCandidates('vue3', docs)
    expect(relaxed.map(candidate => candidate.id)).toEqual(['a'])
    expect(relaxed[0]?.relaxed).toEqual(['vue3'])
    expect(relaxed[0]?.exact).toBe(0)

    // 精确词元：现在重搜就该命中
    const exact = rankGapCandidates('alpha', docs)
    expect(exact.map(candidate => candidate.id)).toEqual(['b'])
    expect(exact[0]?.exact).toBeGreaterThan(0)

    // 两档都不沾 = 知识缺口（无候选）
    expect(rankGapCandidates('zebra', docs)).toEqual([])
    expect(rankGapCandidates('   ', docs)).toEqual([])
    expect(rankGapCandidates('alpha', docs, 0)).toEqual([])
  })

  it('rankGapCandidates：精确命中排在仅前缀近似之前', () => {
    const docs = [
      { id: 'relaxed', body: 'beta', tags: '' },
      { id: 'exact', body: 'alpha', tags: '' },
    ]
    expect(rankGapCandidates('alpha beta3', docs).map(candidate => candidate.id))
      .toEqual(['exact', 'relaxed'])
  })

  it('summarizeSources：按来源聚合写入量 / 命中数 / 注入数，旧记录归 unknown', () => {
    expect(summarizeSources([
      { source: 'agent', hitCount: 3, injected: true },
      { source: 'agent', hitCount: 0, injected: false },
      { source: 'human', hitCount: 1, injected: false },
      { hitCount: 5, injected: true }, // 无 source = 历史记录
    ])).toEqual([
      { source: 'agent', writes: 2, hits: 3, injected: 1 },
      { source: 'human', writes: 1, hits: 1, injected: 0 },
      { source: 'unknown', writes: 1, hits: 5, injected: 1 },
    ])
    expect(summarizeSources([])).toEqual([])
  })

  it('QueryLog：文件往返、有界保留、缺失与损坏都退化为空日志', async () => {
    const { path, log } = await tempLog({ limit: 3 })

    expect(log.readLog()).toEqual([])                       // 文件不存在 → 空
    for (const query of ['q1', 'q2', 'q3', 'q4']) log.appendQuery({ query, hits: 0 })

    const entries = log.readLog()
    expect(entries.map(entry => entry.query)).toEqual(['q2', 'q3', 'q4']) // 有界：丢最旧
    expect(entries.every(entry => entry.at === 1000)).toBe(true)          // 时钟注入生效
    expect(log.summarize().misses).toBe(3)

    const onDisk = await readFileSync(path, 'utf8')
    expect(onDisk.endsWith('\n')).toBe(true)
    expect(parseQueryLog(onDisk)).toEqual(entries)

    // 损坏文件：读返回空（不抛），追加会在空日志之上重建
    await writeFileSync(path, '{ broken')
    expect(log.readLog()).toEqual([])
    expect(log.appendQuery({ query: 'after-corruption', hits: 1 }).map(entry => entry.query))
      .toEqual(['after-corruption'])
    expect(log.summarize().gaps).toEqual([])
  })

  it('QueryLog：父目录不存在时自动创建（日志与 memory.json 同目录，不预设子目录）', async () => {
    const { path, log } = await tempLog({ nested: true })
    const written = log.appendQuery({ query: 'nested write', hits: 2 })
    expect(written).toHaveLength(1)
    expect(parseQueryLog(await readFileSync(path, 'utf8')).map(entry => entry.query)).toEqual(['nested write'])
  })
})
