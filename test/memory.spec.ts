import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  // 0.3.6：面板端点需要 webServer/webRuntime（测试环境 mock）
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webRuntime' as never, { trustedHosts: [] } as never)
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-global-'))
  // 0.3.4：project 记忆按工作区 cwd 路由——临时目录充当两个工作区
  const workspaceA = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-a-'))
  const workspaceB = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-b-'))
  const fiber = await ctx.plugin(plugin, { globalRoot })
  return { ctx, fiber, globalRoot, workspaceA, workspaceB }
}

describe('dsh-memory plugin', () => {
  it('registers the memory service, six tools, guidance, self context, and recall context', async () => {
    const { ctx, fiber } = await setup()

    expect(await ctx.memory.list()).toEqual([])
    for (const name of ['memory_save', 'memory_list', 'memory_search', 'memory_forget', 'memory_confirm', 'memory_update']) {
      expect(ctx.tools.get(name)?.name).toBe(name)
    }
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'tool:memory')).toBe(true)
    expect(assembly.contexts.some(context => context.name === 'memory:recall')).toBe(true)
    // 0.3.2：记忆机制自述常驻上下文（LLM 每轮知道有记忆机制）
    const self = assembly.contexts.find(context => context.name === 'memory:self')
    expect(self?.text).toContain('dsh-memory v')
    expect(self?.text).toContain('memory_update')

    await fiber.dispose()
    expect(ctx.tools.get('memory_save')).toBeUndefined()
  })

  it('stores global and workspace memories in physically separate roots', async () => {
    const { ctx, globalRoot, workspaceA } = await setup()

    const globalRecord = await ctx.memory.remember({ content: 'global convention', keywords: ['global'] })
    const projectRecord = await ctx.memory.remember({
      content: 'Vue3 用 <script setup>', keywords: ['vue'], namespace: 'project',
    }, workspaceA)

    // Physical separation: global lands in the home root, workspace in <cwd>/.dsh/storages.
    expect(existsSync(join(globalRoot, 'memory.json'))).toBe(true)
    expect(existsSync(join(workspaceA, '.dsh', 'storages'))).toBe(true)

    expect(globalRecord.namespace).toBe('global')
    expect(projectRecord.namespace).toBe('project')

    expect(await ctx.memory.list({}, workspaceA)).toHaveLength(2)
    // 无 cwd（未选工作区）：project 部分为空——只剩 global
    expect(await ctx.memory.list()).toHaveLength(1)
    expect((await ctx.memory.list({ namespace: 'project' }, workspaceA)).map(r => r.content))
      .toEqual(['Vue3 用 <script setup>'])
    expect((await ctx.memory.list({ namespace: 'global' })).map(r => r.content))
      .toEqual(['global convention'])
  })

  it('0.3.4: workspace memory routes by cwd — different workspaces are isolated', async () => {
    const { ctx, workspaceA, workspaceB } = await setup()

    await ctx.memory.remember({ content: 'in workspace A', namespace: 'project' }, workspaceA)
    await ctx.memory.remember({ content: 'in workspace B', namespace: 'project' }, workspaceB)

    // 各工作区只见自己的
    expect((await ctx.memory.list({ namespace: 'project' }, workspaceA)).map(r => r.content))
      .toEqual(['in workspace A'])
    expect((await ctx.memory.list({ namespace: 'project' }, workspaceB)).map(r => r.content))
      .toEqual(['in workspace B'])
    // 无 cwd（未选工作区）：project 部分为空
    expect(await ctx.memory.list({ namespace: 'project' })).toEqual([])
    // 检索也按 cwd 路由：B 工作区搜不到 A 的内容（BM25 部分 token 命中 B 自己的条目）
    expect((await ctx.memory.search('workspace A', { namespace: 'project' }, workspaceA)).map(h => h.record.content))
      .toEqual(['in workspace A'])
    const bHits = (await ctx.memory.search('workspace A', { namespace: 'project' }, workspaceB)).map(h => h.record.content)
    expect(bHits).not.toContain('in workspace A')
  })

  it('recalls, promotes, and forgets across both namespaces', async () => {
    const { ctx, workspaceA } = await setup()

    const record = await ctx.memory.remember({ content: '中文编码规范优先', keywords: ['编码'] })
    expect((await ctx.memory.search('编码')).map(hit => hit.record.content)).toEqual(['中文编码规范优先'])

    // 0.3.0：审核通过 = approved；且不改变注入状态（默认不注入）
    const promoted = await ctx.memory.setStatus(record.id, 'approved')
    expect(promoted.status).toBe('approved')
    expect(promoted.injected).toBe(false)

    const wsRecord = await ctx.memory.remember({ content: 'ws fact', namespace: 'project' }, workspaceA)
    await ctx.memory.setStatus(wsRecord.id, 'approved', workspaceA)
    expect((await ctx.memory.list({ namespace: 'project', status: 'approved' }, workspaceA)).map(r => r.content))
      .toEqual(['ws fact'])

    expect(await ctx.memory.forget(record.id)).toBe(true)
    expect(await ctx.memory.forget(record.id)).toBe(false)
    expect(await ctx.memory.forget(wsRecord.id, workspaceA)).toBe(true)
    expect(await ctx.memory.list()).toEqual([])
  })

  it('confirms a suggested memory through memory_confirm', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'to confirm' })

    const tool = ctx.tools.get('memory_confirm')
    expect(tool?.presentCall?.({ id: String(record.id) })).toEqual({
      card: 'generic', title: 'Confirm memory', kind: 'other', rawInput: String(record.id),
    })

    await tool?.execute?.({ id: String(record.id) }, {} as never)
    // 0.3.0：审核语义——approved，不再直接变 auto
    expect((await ctx.memory.list())[0]?.status).toBe('approved')
    expect((await ctx.memory.list())[0]?.injected).toBe(false)
  })

  it('0.3.0: new records default to suggested + injected:false', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'fresh suggestion' })
    expect(record.status).toBe('suggested')
    expect(record.injected).toBe(false)
  })

  it('0.3.0: recall context injects only approved + injected:true (global; workspace never injects)', async () => {
    const { ctx, fiber, workspaceA } = await setup()
    const a = await ctx.memory.remember({ content: 'inject me' })
    const b = await ctx.memory.remember({ content: 'approved but not injected' })
    const c = await ctx.memory.remember({ content: 'still suggested' })
    // 工作区记忆不注入（0.3.4：注入只 global；工作区靠检索）
    const ws = await ctx.memory.remember({ content: 'workspace fact', namespace: 'project' }, workspaceA)
    await ctx.memory.setStatus(ws.id, 'approved', workspaceA)
    await ctx.memory.setInjected(ws.id, true, workspaceA)

    await ctx.memory.setStatus(a.id, 'approved')
    await ctx.memory.setStatus(b.id, 'approved')
    await ctx.memory.setInjected(a.id, true)

    const assembly = await ctx.systemPrompt.assemble()
    const recall = assembly.contexts.find(context => context.name === 'memory:recall')?.text
    expect(recall).toContain('inject me')
    expect(recall).not.toContain('approved but not injected')
    expect(recall).not.toContain('still suggested')
    expect(recall).not.toContain('workspace fact') // 工作区记忆不注入

    await fiber.dispose()
  })

  it('0.3.0: list filters by injected switch', async () => {
    const { ctx } = await setup()
    const a = await ctx.memory.remember({ content: 'always on' })
    const b = await ctx.memory.remember({ content: 'on demand' })
    await ctx.memory.setStatus(a.id, 'approved')
    await ctx.memory.setInjected(a.id, true)

    expect((await ctx.memory.list({ injected: true })).map(r => r.content)).toEqual(['always on'])
    expect((await ctx.memory.list({ injected: false })).map(r => r.content)).toEqual(['on demand'])
    expect((await ctx.memory.list({ status: 'approved', injected: true })).map(r => r.content)).toEqual(['always on'])
    // 非法组合不出现：suggested 不能 injected
    expect(await ctx.memory.list({ status: 'suggested', injected: true })).toEqual([])
  })

  it('0.3.0: setInjected toggles without touching review status', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'switch me' })
    await ctx.memory.setStatus(record.id, 'approved')

    const on = await ctx.memory.setInjected(record.id, true)
    expect(on.status).toBe('approved')
    expect(on.injected).toBe(true)

    const off = await ctx.memory.setInjected(record.id, false)
    expect(off.status).toBe('approved')
    expect(off.injected).toBe(false)
  })

  it('0.3.0: legacy migration — auto→approved+injected:true, suggest→suggested, missing injected→false', async () => {
    const { ctx, globalRoot } = await setup()
    await ctx.memory.remember({ content: 'seed' }) // 保证表存在
    const file = join(globalRoot, 'memory.json')
    const unit = JSON.parse(readFileSync(file, 'utf8')) as {
      tables: { blocks: Record<string, unknown> }
    }
    unit.tables.blocks['legacy-auto'] = {
      namespace: 'global', status: 'auto', content: 'legacy auto', keywords: [], createdAt: 1, updatedAt: 1,
    }
    unit.tables.blocks['legacy-suggest'] = {
      namespace: 'global', status: 'suggest', content: 'legacy suggest', keywords: [], createdAt: 1, updatedAt: 1,
    }
    unit.tables.blocks['legacy-plain'] = {
      namespace: 'global', status: 'suggested', content: 'legacy plain', keywords: [], createdAt: 1, updatedAt: 1,
    }
    writeFileSync(file, JSON.stringify(unit))

    await ctx.memory.reload()
    const byContent = Object.fromEntries((await ctx.memory.list()).map(r => [r.content, r]))
    expect(byContent['legacy auto']?.status).toBe('approved')
    expect(byContent['legacy auto']?.injected).toBe(true)
    expect(byContent['legacy suggest']?.status).toBe('suggested')
    expect(byContent['legacy suggest']?.injected).toBe(false)
    expect(byContent['legacy plain']?.status).toBe('suggested')
    expect(byContent['legacy plain']?.injected).toBe(false)
  })

  it('0.3.1: update rewrites content/keywords, resets to suggested, keeps injected switch', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'stale fact', keywords: ['old'] })
    await ctx.memory.setStatus(record.id, 'approved')
    await ctx.memory.setInjected(record.id, true)

    const updated = await ctx.memory.update(record.id, { content: 'fresh fact', keywords: ['new', 'Key'] })
    expect(updated.content).toBe('fresh fact')
    expect(updated.keywords).toEqual(['new', 'key']) // lowercased
    expect(updated.status).toBe('suggested')          // 重置待审核
    expect(updated.injected).toBe(true)               // 注入开关保留（审核通过后恢复）

    // 未审核不注入（status 非 approved）
    expect(await ctx.memory.list({ status: 'approved', injected: true })).toEqual([])

    // 只改 content 不动 keywords
    const partial = await ctx.memory.update(record.id, { content: 'half update' })
    expect(partial.content).toBe('half update')
    expect(partial.keywords).toEqual(['new', 'key'])
  })

  it('0.3.1: memory_update tool exists and rewires to engine.update', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'to update' })
    const tool = ctx.tools.get('memory_update')
    expect(tool?.name).toBe('memory_update')
    const result = await tool?.execute?.({ id: String(record.id), content: 'updated' }, {} as never)
    expect(result?.content).toBe('updated')
    expect(result?.status).toBe('suggested')
    expect((await ctx.memory.list())[0]?.content).toBe('updated')
  })

  it('0.3.7: reload keeps project tables reachable (backend not re-registered)', async () => {
    const { ctx, workspaceA } = await setup()
    await ctx.memory.remember({ content: 'ws before reload', namespace: 'project' }, workspaceA)
    expect((await ctx.memory.list({ namespace: 'project' }, workspaceA)).map(r => r.content))
      .toEqual(['ws before reload'])

    await ctx.memory.reload()

    // reload 后 project 表仍可读（backend 只注册一次，重开不重复注册）
    expect((await ctx.memory.list({ namespace: 'project' }, workspaceA)).map(r => r.content))
      .toEqual(['ws before reload'])
    // 且仍可写
    await ctx.memory.remember({ content: 'ws after reload', namespace: 'project' }, workspaceA)
    expect((await ctx.memory.list({ namespace: 'project' }, workspaceA)).map(r => r.content).sort())
      .toEqual(['ws after reload', 'ws before reload'])
  })

  it('reload picks up externally edited storage files (2026-08-19 regression)', async () => {
    const { ctx, globalRoot } = await setup()
    await ctx.memory.remember({ content: 'in-process record' })
    expect((await ctx.memory.list()).map(r => r.content)).toEqual(['in-process record'])

    // 外部应用直接编辑文件：往 memory.json 的 blocks 表塞一条新记录。
    const file = join(globalRoot, 'memory.json')
    const unit = JSON.parse(readFileSync(file, 'utf8')) as {
      tables: { blocks: Record<string, unknown> }
    }
    unit.tables.blocks['external-id'] = {
      namespace: 'global', status: 'auto', content: 'externally edited', keywords: [], createdAt: 1, updatedAt: 1,
    }
    writeFileSync(file, JSON.stringify(unit))

    // reload 前：内存缓存仍是旧数据。
    expect((await ctx.memory.list()).map(r => r.content)).toEqual(['in-process record'])

    await ctx.memory.reload()
    expect((await ctx.memory.list()).map(r => r.content).sort())
      .toEqual(['externally edited', 'in-process record'])
    // 外部写入的旧 auto 也走迁移：approved + injected:true
    expect((await ctx.memory.list({ status: 'approved', injected: true })).map(r => r.content))
      .toEqual(['externally edited'])
  })
})
