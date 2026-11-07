/**
 * storage backend 的名字必须随 fiber 释放。
 *
 * issue #3（2026-11-05 外部报障）的现象：装了本插件后，通过插件市场更新**任意其它插件**
 * 都会报 `storage backend 'memory-global' is already registered`——更新流程会在同一进程里
 * 重新组合 profile 并做一次构建校验，memory entry 第二次激活时撞上自己上次留下的名字。
 *
 * 根因：`dsh-storage` 的 `BackendRegistry.register()` 契约是「注册是一个 effect，返回的
 * disposer 负责摘掉这个名字」，而 `MemoryEngine[Service.init]` 丢掉了那个 disposer。
 *
 * 本用例锁的是行为而不是实现：**dispose 之后再挂载一次，不能抛 duplicate-backend**。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-lifecycle-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个能挂载本插件的 ctx；`storage` 服务只装一次，供两次挂载共用。 */
async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webStartup' as never, { trustedHosts: [] } as never)
  return ctx
}

describe('storage backend 生命周期', () => {
  it('dispose 后重新挂载不会抛 duplicate-backend', async () => {
    const ctx = await baseContext()
    const globalRoot = tempRoot()
    const config = { globalRoot, backup: { enabled: false } }

    const first = await ctx.plugin(plugin, config)
    await first.dispose()

    // 名字若没随 fiber 释放，这里会抛
    // `StorageError: storage backend 'memory-global' is already registered`。
    const second = await ctx.plugin(plugin, config)
    expect(second).toBeDefined()
    await second.dispose()
  })

  it('打开过工作区后 dispose，重新挂载也能再次打开同一个工作区', async () => {
    const ctx = await baseContext()
    const globalRoot = tempRoot()
    const workspace = tempRoot()
    const config = { globalRoot, backup: { enabled: false } }

    const first = await ctx.plugin(plugin, config)
    await ctx.memory.remember({ content: '工作区记忆', keywords: ['ws'], namespace: 'project' }, workspace)
    await first.dispose()

    // 诊断：文件应仍在磁盘上（dispose 只关句柄，不删数据）
    const storageDir = join(workspace, '.dsh', 'storages')
    const onDisk = existsSync(storageDir) ? readdirSync(storageDir) : []
    expect(onDisk.some(n => n.startsWith('memory_project_'))).toBe(true)

    const second = await ctx.plugin(plugin, config)
    const listed = await ctx.memory.list({ namespace: 'project' }, workspace)
    expect(listed.length).toBe(1)
    const hits = await ctx.memory.search('工作区记忆', undefined, workspace)
    expect(hits.length).toBe(1)
    await second.dispose()
  })
})
