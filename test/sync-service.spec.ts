/**
 * 同步编排的端到端：真实记忆库 → 镜像 → 本地提交。
 *
 * 不涉及网络（`remote` 不配），所以这条链能在任何机器上验通。三条断言覆盖
 * 「一次写对、二次不写、删了留墓碑」——分别对应增量、幂等、删除三件事。
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
import { collectMirror, syncPush, syncStatus } from '../src/sync-service.ts'
import type { MemoryEngine } from '../src/engine.ts'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-sync-e2e-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(): Promise<{ memory: MemoryEngine, dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webStartup' as never, { trustedHosts: [] } as never)
  const globalRoot = tempRoot()
  const fiber = await ctx.plugin(plugin, { globalRoot, backup: { enabled: false } })
  const memory = ctx.get('memory') as MemoryEngine
  return { memory, dispose: () => fiber.dispose() }
}

describe('sync service（端到端，无远端）', () => {
  it('记忆库 → 镜像 → 提交：文件与提交都产生', async () => {
    const { memory, dispose } = await setup()
    const first = await memory.remember({ content: '第一条记忆', keywords: ['一'] })
    await memory.remember({ content: '第二条记忆', keywords: ['二'] })

    const mirror = tempRoot()
    const run = await syncPush(memory, { mirrorDir: mirror })

    expect(run.files).toBe(2)
    expect(run.written).toBe(2)
    expect(run.committed).toBe(true)
    expect(run.sha).toMatch(/^[0-9a-f]{40}$/u)
    // 没配 remote：明确说明，而不是假装推过了
    expect(run.pushed).toBe(false)
    expect(run.error).toContain('未配置远端')

    expect(existsSync(join(mirror, 'records/global', `${first.id}.json`))).toBe(true)
    await dispose()
  })

  it('第二次 push 什么都不写、也不产生新提交', async () => {
    const { memory, dispose } = await setup()
    await memory.remember({ content: '一条', keywords: ['k'] })
    const mirror = tempRoot()

    const first = await syncPush(memory, { mirrorDir: mirror })
    const second = await syncPush(memory, { mirrorDir: mirror })

    expect(first.committed).toBe(true)
    expect(second.written).toBe(0)
    expect(second.unchanged).toBe(1)
    expect(second.committed).toBe(false)

    const status = await syncStatus({ mirrorDir: mirror })
    expect(status.commits).toBe(1)
    await dispose()
  })

  it('删掉一条后 push：出现墓碑，且记录文件消失', async () => {
    const { memory, dispose } = await setup()
    const doomed = await memory.remember({ content: '会被删掉的', keywords: ['del'] })
    const kept = await memory.remember({ content: '会留下的', keywords: ['keep'] })
    const mirror = tempRoot()

    await syncPush(memory, { mirrorDir: mirror })
    await memory.forget(doomed.id)
    const after = await syncPush(memory, { mirrorDir: mirror })

    expect(after.tombstones).toBe(1)
    expect(existsSync(join(mirror, 'records/global', `${doomed.id}.json`))).toBe(false)
    expect(existsSync(join(mirror, 'records/global', `${kept.id}.json`))).toBe(true)
    expect(existsSync(join(mirror, 'tombstones', `${doomed.id}.json`))).toBe(true)

    const status = await syncStatus({ mirrorDir: mirror })
    expect(status.tombstones).toBe(1)
    await dispose()
  })

  it('首次 push 不产生墓碑（哪怕远端已有记录）', async () => {
    const { memory, dispose } = await setup()
    await memory.remember({ content: '唯一一条', keywords: ['only'] })
    const mirror = tempRoot()

    const run = await syncPush(memory, { mirrorDir: mirror })
    expect(run.tombstones).toBe(0)
    expect(existsSync(join(mirror, 'tombstones'))).toBe(false)
    await dispose()
  })

  it('collectMirror 只导出内容字段，不含本地瞬态', async () => {
    const { memory, dispose } = await setup()
    const record = await memory.remember({ content: '带瞬态的记忆', keywords: ['k'] })
    // 触发一次检索，让 hitCount / lastUsedAt 落盘
    await memory.search('带瞬态的记忆')
    const latest = (await memory.list({})).find(item => item.id === record.id)
    expect(latest?.hitCount ?? 0).toBeGreaterThan(0)

    const files = await collectMirror(memory)
    const payload = JSON.parse(files[0]?.content ?? '{}') as Record<string, unknown>
    expect(payload).not.toHaveProperty('hitCount')
    expect(payload).not.toHaveProperty('lastUsedAt')
    expect(payload.content).toBe('带瞬态的记忆')
    await dispose()
  })

  it('项目层的记录落到 records/project/<项目名>/ 下', async () => {
    const { memory, dispose } = await setup()
    const workspace = join(tempRoot(), 'MyProj')
    await memory.remember({ content: '项目里的记忆', keywords: ['p'], namespace: 'project' }, workspace)

    const mirror = tempRoot()
    await syncPush(memory, { mirrorDir: mirror })

    const projectDir = join(mirror, 'records/project')
    const names = existsSync(projectDir) ? readdirSync(projectDir) : []
    // 项目名统一小写（跨 Windows / WSL 对齐）
    expect(names).toEqual(['myproj'])
    await dispose()
  })
})
