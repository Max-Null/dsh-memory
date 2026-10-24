import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import type { MemoryConfig } from '../src/engine.ts'

let home: string

async function setup(extra: MemoryConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webStartup' as never, { trustedHosts: [] } as never)
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-diary-'))
  const fiber = await ctx.plugin(plugin, { globalRoot, ...extra })
  return { ctx, fiber }
}

const diaryContextOf = async (ctx: Context): Promise<string | undefined> => {
  const assembly = await ctx.systemPrompt.assemble()
  return assembly.contexts.find(entry => entry.name === 'memory:diary')?.text
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-home-diary-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('日记机制接线（2026-10-24 设计方案）', () => {
  it('默认开启：工具注册着，写入落到 <DSH_HOME>/diary', async () => {
    const { ctx, fiber } = await setup()
    const write = ctx.tools.get('diary_write')
    expect(write).toBeDefined()

    const saved = await write?.execute?.({ text: '今天他问了两件事。' }, {} as never) as { date: string, created: boolean }
    expect(saved.created).toBe(true)
    expect(existsSync(join(home, 'diary', `${saved.date}.md`))).toBe(true)
    expect(readdirSync(join(home, 'diary'))).toHaveLength(1)

    await fiber.dispose()
  })

  it('关闭时工具拒绝写入，且不产生任何文件', async () => {
    const { ctx, fiber } = await setup({ diary: { enabled: false } })
    const write = ctx.tools.get('diary_write')
    await expect(async () => write?.execute?.({ text: '不该写进去' }, {} as never))
      .rejects.toThrow(/关闭/)
    expect(existsSync(join(home, 'diary'))).toBe(false)

    await fiber.dispose()
  })

  it('关闭时读工具也拒绝——不想被收集的人，也不该被翻旧账', async () => {
    const { ctx, fiber } = await setup({ diary: { enabled: false } })
    const read = ctx.tools.get('diary_read')
    await expect(async () => read?.execute?.({}, {} as never)).rejects.toThrow(/关闭/)

    await fiber.dispose()
  })

  it('开启时注入指针行，关闭时整条不注入', async () => {
    const on = await setup()
    expect(await diaryContextOf(on.ctx)).toBeDefined()
    await on.fiber.dispose()

    const off = await setup({ diary: { enabled: false } })
    expect(await diaryContextOf(off.ctx)).toBeUndefined()
    await off.fiber.dispose()
  })

  it('指针行不含日记正文', async () => {
    const { ctx, fiber } = await setup()
    await ctx.tools.get('diary_write')?.execute?.({ text: '他说手麻了' }, {} as never)

    const text = await diaryContextOf(ctx)
    expect(text).toContain(join(home, 'diary'))
    expect(text).not.toContain('手麻')

    await fiber.dispose()
  })

  it('提醒只出现一次：同一进程里再组装就不重复催', async () => {
    const { ctx, fiber } = await setup()

    const first = await diaryContextOf(ctx)
    expect(first).toContain('日记提醒')

    const second = await diaryContextOf(ctx)
    expect(second).toBeDefined()
    expect(second).not.toContain('日记提醒')

    await fiber.dispose()
  })
})
