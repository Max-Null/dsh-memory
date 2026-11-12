/**
 * 云同步默认关闭，且开关是**显式的**。
 *
 * 2026-11-11 用户明确：实验性功能默认关闭，不影响其他人用。
 * 2026-11-12 用户进一步要求：判据从「配了 remote 就算开」改成与日记一致的 `enabled` 开关
 * ——「我打开了这个功能」和「我碰巧填了一个字段」是两件事。
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

  it('配了 remote 但没开 enabled 仍然不注册', async () => {
    // 2026-11-12 的关键反转：remote 只是「目标」，开关才是「意图」。
    // 只填 remote 就算开，会让一次配置试验变成意外开机。
    const { fiber, self } = await mount({ sync: { remote: 'https://example.com/x.git' } })
    expect(plugin.registeredToolNames).not.toContain('memory_sync')
    expect(self).toContain('你有 14 个工具')
    await fiber.dispose()
  })

  it('enabled 显式为 false 时，哪怕 remote 齐全也不注册', async () => {
    const { fiber } = await mount({ sync: { enabled: false, remote: 'https://example.com/x.git' } })
    expect(plugin.registeredToolNames).not.toContain('memory_sync')
    await fiber.dispose()
  })

  it('enabled 打开且配了 remote 才注册，自述变成 16 个', async () => {
    const { fiber, self } = await mount({ sync: { enabled: true, remote: 'https://example.com/x.git' } })
    const names = plugin.registeredToolNames
    expect(names).toContain('memory_sync')
    expect(names).toContain('memory_conflicts')
    expect(self).toContain('你有 16 个工具')
    expect(self).toContain('memory_sync')
    await fiber.dispose()
  })

  it('enabled 打开但没配 remote 也注册——只做本地镜像与提交', async () => {
    // 开关与目标解耦的收益：先只开本地镜像（不推送）是合法的一档，
    // 执行 push 时会明确报「未配置远端地址 —— 已完成本地提交」，而不是静默不动作。
    const { fiber } = await mount({ sync: { enabled: true } })
    expect(plugin.registeredToolNames).toContain('memory_sync')
    await fiber.dispose()
  })

  // 注：这里不手写 `{ get: () => ... }` 来模拟 Volatile——cordis 的 `resolveConfig`
  // 会以 `volatile config cannot contain functions` 拒绝它。传裸配置才是真实路径：
  // schema 声明了 `.volatile()`，挂载时被包装，`apply` 收到的就是 `Volatile`。
  // 所以上面「enabled: true 才注册」这条同时锁住了 `syncOn` 的解包——写成直接读
  // `config.sync.enabled` 时它立刻变红。
})
