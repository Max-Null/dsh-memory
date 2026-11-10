/**
 * 云同步默认关闭。
 *
 * 2026-11-11 用户明确：实验性功能默认关闭，不影响其他人用。
 *
 * 判据不是「注册了再报错」，而是**根本不注册**——模型看不到工具就不会去调。
 * 连带要求自述里的工具清单与数量跟着变，否则模型会按一份不存在的工具面行事。
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-sync-off-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function mount(config: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webStartup' as never, { trustedHosts: [] } as never)
  const globalRoot = tempRoot()
  const fiber = await ctx.plugin(plugin, { globalRoot, backup: { enabled: false }, ...config })
  const self = (await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'memory:self')?.text ?? ''
  return { fiber, self }
}

describe('云同步默认关闭', () => {
  it('不配 sync 时两个同步工具根本不注册', async () => {
    const { fiber, self } = await mount({})
    const names = plugin.registeredToolNames
    expect(names).not.toContain('memory_sync')
    expect(names).not.toContain('memory_conflicts')
    // 自述跟着变：14 个，且清单里不提同步工具
    expect(self).toContain('你有 14 个工具')
    expect(self).not.toContain('memory_sync')
    await fiber.dispose()
  })

  it('只配 mirrorDir 不配 remote 仍然不启用', async () => {
    // 本地镜像不解决任何问题；判据只认 remote。
    const { fiber } = await mount({ sync: { mirrorDir: 'H:/tmp/mirror' } })
    expect(plugin.registeredToolNames).not.toContain('memory_sync')
    await fiber.dispose()
  })

  it('配了 remote 才注册，且自述变成 16 个', async () => {
    const { fiber, self } = await mount({ sync: { remote: 'https://example.com/x.git' } })
    const names = plugin.registeredToolNames
    expect(names).toContain('memory_sync')
    expect(names).toContain('memory_conflicts')
    expect(self).toContain('你有 16 个工具')
    expect(self).toContain('memory_sync')
    await fiber.dispose()
  })
})
