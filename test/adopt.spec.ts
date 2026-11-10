/**
 * `adopt` —— 按指定 id 写入外来记录，同步导入专用。
 *
 * 两条判据：id 必须原样落下（否则同一件事在五个环境变成五条），
 * `updatedAt` 不能被导入时刻覆盖（否则冲突判定按时间取新就失效了）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-adopt-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webStartup' as never, { trustedHosts: [] } as never)
  const globalRoot = tempRoot()
  const fiber = await ctx.plugin(plugin, { globalRoot, backup: { enabled: false } })
  return { ctx, fiber }
}

/** 造一条外来记录（模拟另一端的 block）。 */
function foreignBlock(overrides: Record<string, unknown> = {}) {
  return {
    namespace: 'global' as const,
    status: 'approved' as const,
    content: '来自工作机的一条记忆',
    keywords: ['工作机', '同步'],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  }
}

const FOREIGN_ID = '11111111-2222-3333-4444-555555555555'

describe('adopt（同步导入）', () => {
  it('按指定 id 落库，id 不被重新生成', async () => {
    const { ctx, fiber } = await setup()
    const record = await ctx.memory.adopt(FOREIGN_ID, foreignBlock())

    expect(record.id).toBe(FOREIGN_ID)
    const hits = await ctx.memory.search('工作机')
    expect(hits.some(hit => hit.record.id === FOREIGN_ID)).toBe(true)
    await fiber.dispose()
  })

  it('不覆盖原始 updatedAt —— 否则按时间取新的冲突判定会失效', async () => {
    const { ctx, fiber } = await setup()
    const block = foreignBlock({ updatedAt: 1_700_000_100_000 })
    const record = await ctx.memory.adopt(FOREIGN_ID, block)

    expect(record.updatedAt).toBe(1_700_000_100_000)
    await fiber.dispose()
  })

  it('同一 id 重复 adopt 是覆盖而不是新增', async () => {
    const { ctx, fiber } = await setup()
    await ctx.memory.adopt(FOREIGN_ID, foreignBlock({ content: '第一版' }))
    await ctx.memory.adopt(FOREIGN_ID, foreignBlock({ content: '第二版' }))

    const all = await ctx.memory.list({})
    const matched = all.filter(record => record.id === FOREIGN_ID)
    expect(matched).toHaveLength(1)
    expect(matched[0]?.content).toBe('第二版')
    await fiber.dispose()
  })

  it('外来记录同样过 schema 校验（不合规会被拒）', async () => {
    const { ctx, fiber } = await setup()
    // status 不在枚举里
    await expect(
      ctx.memory.adopt(FOREIGN_ID, foreignBlock({ status: 'deleted' } as never)),
    ).rejects.toThrow()
    await fiber.dispose()
  })

  it('项目层的记录落到指定工作区', async () => {
    const { ctx, fiber } = await setup()
    const workspace = tempRoot()
    const record = await ctx.memory.adopt(
      FOREIGN_ID,
      foreignBlock({ namespace: 'project' as const, content: '工作区里的一条' }),
      workspace,
    )

    expect(record.namespace).toBe('project')
    const hits = await ctx.memory.search('工作区里的一条', undefined, workspace)
    expect(hits.length).toBe(1)
    await fiber.dispose()
  })
})
