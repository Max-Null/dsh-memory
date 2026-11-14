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
import { collectMirror, syncPull, syncPush, syncStatus } from '../src/sync-service.ts'
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

/**
 * 多端（2026-11-14）：两端共用一个镜像目录，模拟两个环境推同一个远端。
 *
 * 旧实现在这里会互删：后 push 的一端把「本机看不见的」记录全删掉。这两个用例
 * 先红再改，是 A/B/C 三件改动的回归锁。
 */
describe('sync service（多端）', () => {
  it('两端共用一个镜像时，后 push 的一端不删前端的记录', async () => {
    const a = await setup()
    const b = await setup()
    await a.memory.remember({ content: 'A 端的一条记忆', keywords: ['a'] })
    const mirror = tempRoot()
    await syncPush(a.memory, { mirrorDir: mirror, envName: 'device-a' })
    expect(readdirSync(join(mirror, 'records/global')).length).toBe(1)

    await b.memory.remember({ content: 'B 端的一条记忆', keywords: ['b'] })
    await syncPush(b.memory, { mirrorDir: mirror, envName: 'device-b' })

    // A 的那条必须还在，加上 B 的，一共两条
    expect(readdirSync(join(mirror, 'records/global')).length).toBe(2)
    await a.dispose()
    await b.dispose()
  })

  it('A 删掉的记忆，B pull 后本地也删掉（墓碑跨端生效）', async () => {
    const a = await setup()
    const b = await setup()
    const record = await a.memory.remember({ content: '要被删掉的记忆', keywords: ['x'] })
    const mirror = tempRoot()
    await syncPush(a.memory, { mirrorDir: mirror, envName: 'device-a' })

    // B 先拉到这条
    const first = await syncPull(b.memory, { mirrorDir: mirror, envName: 'device-b' })
    expect(first.imported).toBeGreaterThanOrEqual(1)
    expect((await b.memory.list({})).some(item => item.id === record.id)).toBe(true)

    // A 删掉再推：应该留下墓碑，并把镜像里的文件删掉（本端确认删除）
    await a.memory.forget(record.id)
    const pushed = await syncPush(a.memory, { mirrorDir: mirror, envName: 'device-a' })
    expect(pushed.tombstones).toBeGreaterThanOrEqual(1)

    // B 再拉：墓碑生效，本地删掉
    await syncPull(b.memory, { mirrorDir: mirror, envName: 'device-b' })
    expect((await b.memory.list({})).some(item => item.id === record.id)).toBe(false)
    await a.dispose()
    await b.dispose()
  })
})
