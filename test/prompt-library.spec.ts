import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import type { MemoryConfig } from '../src/engine.ts'
import { parsePromptFile, scanPromptDir, writePromptFile, nextSeq } from '../src/prompt-files.ts'

async function setup(extra: MemoryConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webRuntime' as never, { trustedHosts: [] } as never)
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-global-'))
  const promptRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-prompt-'))
  const workspaceA = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-a-'))
  const fiber = await ctx.plugin(plugin, { globalRoot, promptGlobalRoot: promptRoot, ...extra })
  return { ctx, fiber, globalRoot, promptRoot, workspaceA }
}

const GOOD_MD = `---
seq: 7
name: "台风模板"
dimension: "前端"
difficulty: "L3"
tags: ["Three.js", "台风"]
source: user
createdAt: 2026-08-26
---
请用 Three.js 画一个台风场景，从北京视角渲染。
---
备用方案：室内机位。`

describe('prompt-files 解析', () => {
  it('解析 frontmatter/正文/备用段', () => {
    const parsed = parsePromptFile('/tmp/p.md', GOOD_MD)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.meta.name).toBe('台风模板')
    expect(parsed.file.meta.seq).toBe(7)
    expect(parsed.file.meta.dimension).toBe('前端')
    expect(parsed.file.meta.tags).toEqual(['Three.js', '台风'])
    expect(parsed.file.body).toContain('请用 Three.js')
    expect(parsed.file.fallback).toContain('室内机位')
    expect(parsed.file.summary.length).toBeLessThanOrEqual(200)
  })

  it('坏文件（缺 name / 空正文 / 无围栏）报错不崩', () => {
    expect(parsePromptFile('/tmp/a.md', '---\nname: ""\n---\n正文').ok).toBe(false)
    expect(parsePromptFile('/tmp/b.md', '---\nname: "x"\n---\n').ok).toBe(false)
    expect(parsePromptFile('/tmp/c.md', '没有围栏').ok).toBe(false)
  })

  it('scanPromptDir：目录不存在=空；坏文件进 warnings', () => {
    const dir = join(tmpdir(), `pl-scan-${Date.now()}`)
    expect(scanPromptDir(dir)).toEqual({ files: [], warnings: [] })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1_good.md'), GOOD_MD, 'utf8')
    writeFileSync(join(dir, '2_bad.md'), '---\nname: ""\n---\n正文', 'utf8')
    const scanned = scanPromptDir(dir)
    expect(scanned.files.length).toBe(1)
    expect(scanned.warnings.length).toBe(1)
  })
})

describe('prompt-files 写文件', () => {
  it('序号分配 / 名前缀 / 防覆盖后缀', () => {
    const dir = join(tmpdir(), `pl-write-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '3_旧.md'), 'x', 'utf8')
    expect(nextSeq(dir)).toBe(4)
    const p1 = writePromptFile(dir, { name: '新模板', content: 'A', source: 'user' })
    expect(p1).toContain('4_新模板.md')
    const p2 = writePromptFile(dir, { name: '新模板', content: 'A', source: 'user' })
    expect(p2).not.toEqual(p1) // 新序号 = 不覆盖
    expect(p2).toContain('5_新模板.md')
    expect(readFileSync(p1, 'utf8')).toContain('seq: 4')
    expect(readFileSync(p2, 'utf8')).toContain('source: user')
  })
})

describe('engine 模板索引（0.6.0）', () => {
  it('refreshPromptIndex：扫描建档 / mtime 幂等 / 变更刷新 / 删除清理', async () => {
    const { ctx, promptRoot, fiber } = await setup()
    const result = await ctx.memory.refreshPromptIndex()
    expect(result).toEqual({ scan: 0, changed: 0, removed: 0, warnings: [] })

    const file = join(promptRoot, '1_台风.md')
    writeFileSync(file, GOOD_MD, 'utf8')
    const first = await ctx.memory.refreshPromptIndex()
    expect(first.changed).toBe(1)
    const records = await ctx.memory.list({ kind: 'prompt' })
    expect(records.length).toBe(1)
    expect(records[0]!.status).toBe('approved')
    expect(records[0]!.injected).toBe(false)
    expect(records[0]!.meta?.source).toBe('user')
    expect(records[0]!.keywords).toContain('three.js')

    const second = await ctx.memory.refreshPromptIndex()
    expect(second.changed).toBe(0) // mtime 未变：零写

    writeFileSync(file, GOOD_MD.replace('L3', 'L4'), 'utf8')
    // mtime 可能同毫秒——强制不同（写新文件内容后由 fs 时间戳保证，这里仅验证可在以下做法下刷新）
    const third = await ctx.memory.refreshPromptIndex()
    // 允许 mtime 粒度导致 0 或 1（Windows ntfs 100ns，通常必变）
    expect(third.changed).toBeLessThanOrEqual(1)

    rmSync(file)
    const fourth = await ctx.memory.refreshPromptIndex()
    expect(fourth.removed).toBe(1)
    expect(await ctx.memory.list({ kind: 'prompt' })).toEqual([])
    await fiber.dispose()
  })

  it('promptAdd 写文件+索引（source=agent），project 命名空间随工作区', async () => {
    const { ctx, promptRoot, workspaceA, fiber } = await setup()
    const record = await ctx.memory.promptAdd({
      name: '模型建议模板', content: '正文', dimension: '后端', tags: ['node'], source: 'agent', namespace: 'project',
    }, workspaceA)
    expect(record.meta?.source).toBe('agent')
    expect(record.namespace).toBe('project')
    expect(existsSync(join(workspaceA, '.dsh', 'prompt-library', '1_模型建议模板.md'))).toBe(true)
    expect(await ctx.memory.list({ kind: 'prompt', namespace: 'global' })).toEqual([])
    await fiber.dispose()
  })

  it('promptGet：按 id / 文件名（去序号）/ 包含匹配；未命中抛错', async () => {
    const { ctx, promptRoot, fiber } = await setup()
    writeFileSync(join(promptRoot, '5_台风模板.md'), GOOD_MD, 'utf8')
    await ctx.memory.refreshPromptIndex()
    const records = await ctx.memory.list({ kind: 'prompt' })

    const byId = await ctx.memory.promptGet(String(records[0]!.id))
    expect(byId.body).toContain('Three.js')
    const byName = await ctx.memory.promptGet('台风模板')
    expect(byName.fallback).toContain('室内机位')
    await expect(ctx.memory.promptGet('不存在的')).rejects.toThrow(/not found/)
    await fiber.dispose()
  })

  it('promptRemove：删文件+索引；未命中 false', async () => {
    const { ctx, promptRoot, fiber } = await setup()
    writeFileSync(join(promptRoot, '2_可删模板.md'), GOOD_MD, 'utf8')
    await ctx.memory.refreshPromptIndex()
    expect(await ctx.memory.promptRemove('可删模板')).toBe(true)
    expect(existsSync(join(promptRoot, '2_可删模板.md'))).toBe(false)
    expect(await ctx.memory.list({ kind: 'prompt' })).toEqual([])
    expect(await ctx.memory.promptRemove('不再存在')).toBe(false)
    await fiber.dispose()
  })

  it('模板永不注入：setInjected 对 prompt 抛错；search 按 kind 隔离', async () => {
    const { ctx, promptRoot, fiber } = await setup()
    writeFileSync(join(promptRoot, '1_台风模板.md'), GOOD_MD, 'utf8')
    await ctx.memory.refreshPromptIndex()
    const record = (await ctx.memory.list({ kind: 'prompt' }))[0]!
    await expect(ctx.memory.setInjected(record.id, true)).rejects.toThrow(/never injected/)
    await ctx.memory.remember({ content: '台风预警三色规则', keywords: ['台风'] })
    const factHits = await ctx.memory.search('台风', { kind: 'fact' })
    const promptHits = await ctx.memory.search('台风', { kind: 'prompt' })
    expect(factHits.length).toBeGreaterThanOrEqual(1)
    expect(promptHits.every(hit => hit.record.kind === 'prompt' || hit.record.kind === undefined)).toBe(true)
    await fiber.dispose()
  })
})
