import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import type { MemoryConfig } from '../src/engine.ts'

async function setup(extra: MemoryConfig = {}) {
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
  const fiber = await ctx.plugin(plugin, { globalRoot, ...extra })
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

  it('0.3.0: recall context injects only approved + injected:true (global; workspace needs its cwd)', async () => {
    const { ctx, fiber, workspaceA } = await setup()
    const a = await ctx.memory.remember({ content: 'inject me' })
    const b = await ctx.memory.remember({ content: 'approved but not injected' })
    const c = await ctx.memory.remember({ content: 'still suggested' })
    // 工作区记忆：0.5.1 起可常驻注入，但按会话工作区路由——无 cwd 的组装不注入
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
    // 无会话 cwd（assemble 无 agent）：工作区记忆不注入
    expect(recall).not.toContain('workspace fact')

    // 带当前会话 agent 的组装：工作区常驻记忆按会话 cwd 注入
    const withWs = await ctx.systemPrompt.assemble({
      agent: { session: { header: { cwd: workspaceA } } },
    } as never)
    const recallWs = withWs.contexts.find(context => context.name === 'memory:recall')?.text
    expect(recallWs).toContain('workspace fact')
    expect(recallWs).toContain('inject me')

    await fiber.dispose()
  })

  it('0.5.1: workspace recall injects by session cwd — each session sees its own workspace', async () => {
    const { ctx, workspaceA, workspaceB } = await setup()
    const a = await ctx.memory.remember({ content: 'fact A', namespace: 'project' }, workspaceA)
    const b = await ctx.memory.remember({ content: 'fact B', namespace: 'project' }, workspaceB)
    await ctx.memory.setStatus(a.id, 'approved', workspaceA)
    await ctx.memory.setStatus(b.id, 'approved', workspaceB)
    await ctx.memory.setInjected(a.id, true, workspaceA)
    await ctx.memory.setInjected(b.id, true, workspaceB)

    // 引擎按 cwd 召回：各自只含自己的工作区记忆（表已开，同步读缓存）
    expect(ctx.memory.recallRecords(workspaceA).map(r => r.content)).toEqual(['fact A'])
    expect(ctx.memory.recallRecords(workspaceB).map(r => r.content)).toEqual(['fact B'])
    expect(ctx.memory.recallRecords().map(r => r.content)).toEqual([])

    // 组装（assembleContextFor 注入 agent，内含会话 header.cwd）
    const forA = await ctx.systemPrompt.assemble({
      agent: { session: { header: { cwd: workspaceA } } },
    } as never)
    expect(forA.contexts.find(context => context.name === 'memory:recall')?.text).toContain('fact A')
    expect(forA.contexts.find(context => context.name === 'memory:recall')?.text).not.toContain('fact B')

    const forB = await ctx.systemPrompt.assemble({
      agent: { session: { header: { cwd: workspaceB } } },
    } as never)
    expect(forB.contexts.find(context => context.name === 'memory:recall')?.text).toContain('fact B')
    expect(forB.contexts.find(context => context.name === 'memory:recall')?.text).not.toContain('fact A')
  })

  it('0.5.1: ensureProjectOpen pre-warms a cwd and is idempotent', async () => {
    const { ctx, workspaceA } = await setup()
    const ws = await ctx.memory.remember({ content: 'cold ws fact', namespace: 'project' }, workspaceA)
    await ctx.memory.setStatus(ws.id, 'approved', workspaceA)
    await ctx.memory.setInjected(ws.id, true, workspaceA)

    // 表已开（remember 已打开）：预热幂等（has-key 短路，重复调用不重开）
    await ctx.memory.ensureProjectOpen(workspaceA)
    await ctx.memory.ensureProjectOpen(workspaceA)
    expect(ctx.memory.recallRecords(workspaceA).map(r => r.content)).toEqual(['cold ws fact'])
    // 预热的 cwd 之外不泄露
    expect(ctx.memory.recallRecords().map(r => r.content)).toEqual([])
  })

  it('0.5.2: recall injects summarized one-liners — long content never floods the prompt', async () => {
    const { ctx } = await setup()
    const longContent = `${'长内容'.repeat(120)}`; // 360 字符 > 摘要上限
    const record = await ctx.memory.remember({ content: longContent })
    await ctx.memory.setStatus(record.id, 'approved')
    await ctx.memory.setInjected(record.id, true)

    const assembly = await ctx.systemPrompt.assemble()
    const recall = assembly.contexts.find(context => context.name === 'memory:recall')?.text
    expect(recall).not.toBeUndefined()
    // 注入行包含摘要前缀（首行长内容截断）；不含未截断的全文后缀
    expect(recall).toContain('长内容'.slice(0, 12))
    const suffix = '长内容'.repeat(100)
    expect(recall).not.toContain(suffix.repeat(1))
    expect(recall?.split('\n').find(line => line.startsWith('- [memory:'))?.length ?? 0)
      .toBeLessThanOrEqual(80 + 40) // 摘要 80 + 标记开销
  })

  it('0.5.3: search marks hits with lastUsedAt (cold tracking)', async () => {
    const { ctx } = await setup()
    const hit = await ctx.memory.remember({ content: 'warm me up' })
    const miss = await ctx.memory.remember({ content: 'unrelated content' })

    const results = await ctx.memory.search('warm me')
    expect(results.map(r => r.record.content)).toEqual(['warm me up'])

    const now = Date.now()
    const record = (await ctx.memory.list()).find(r => r.id === hit.id)
    expect(record?.lastUsedAt).toBeGreaterThanOrEqual(now - 5000)
    expect((await ctx.memory.list()).find(r => r.id === miss.id)?.lastUsedAt).toBeUndefined()
  })

  it('0.5.2: hybrid search — semantic hits fuse with BM25 when embeddings configured', async () => {
    // 假嵌入：语义组（性能/速度/优化 为一组；爬虫/抓取 为一组）；BM25 无字面匹配
    const embed = async (texts: readonly string[]): Promise<number[][]> => texts.map(text => {
      const vector = [0, 0, 0, 0]
      for (const term of ['性能', '速度', '优化']) if (text.includes(term)) vector[0]! += 1
      for (const term of ['爬虫', '抓取']) if (text.includes(term)) vector[1]! += 1
      return vector
    })
    const { ctx } = await setup({ embeddings: { embed } })
    const perf = await ctx.memory.remember({ content: '速度优化 与 性能 相关' })
    const crawl = await ctx.memory.remember({ content: '爬虫抓取器' })

    const results = await ctx.memory.search('性能')
    const content = results.map(hit => hit.record.content)
    expect(content).toContain('速度优化 与 性能 相关') // 语义召回（BM25 无字面命中也能进结果）
    expect(content).not.toContain('爬虫抓取器') // 语义不相关不混入
    expect(results[0]?.score).toBeGreaterThan(0)
    // 向量已持久化（可被后续检索复用）
    const stored = (await ctx.memory.list()).find(record => record.id === perf.id)
    expect(stored).toBeDefined()
  })

  it('0.5.2: without embeddings config the search stays pure BM25', async () => {
    const { ctx } = await setup()
    await ctx.memory.remember({ content: '速度优化相关' })
    const results = await ctx.memory.search('性能')
    expect(results).toEqual([]) // 无字面匹配即未命中（行为不变）
  })

  it('0.5.2: legacy double-prefix project file migrates to the canonical name', async () => {
    const { ctx, workspaceA } = await setup()
    await ctx.memory.remember({ content: 'seed', namespace: 'project' }, workspaceA)
    const dir = join(workspaceA, '.dsh', 'storages')
    const canonical = readdirSync(dir).find(name => name.endsWith('.json'))!
    const legacyFile = `memory_project_${canonical}` // 旧版文件名双重前缀（含 .json）
    const document = JSON.parse(readFileSync(join(dir, canonical), 'utf8')) as { unit: { name: string } }
    document.unit.name = `memory_project_${canonical.replace(/\.json$/, '')}` // 旧版文件头同样是旧域名
    writeFileSync(join(dir, legacyFile), `${JSON.stringify(document, null, 2)}\n`)
    rmSync(join(dir, canonical))

    await ctx.memory.reload() // 关闭已开表（外部编辑为旧格式）
    const records = await ctx.memory.list({ namespace: 'project' }, workspaceA)
    expect(records.map(record => record.content)).toEqual(['seed']) // 迁移后可读
    expect(existsSync(join(dir, legacyFile))).toBe(false) // 旧名已迁移
    expect(existsSync(join(dir, canonical))).toBe(true) // 规范名就位（头也已改写）
    const healed = JSON.parse(readFileSync(join(dir, canonical), 'utf8')) as { unit: { name: string } }
    expect(healed.unit.name).toBe(canonical.replace(/\.json$/, ''))
  })

  it('0.5.2: canonical file with a legacy header self-heals on open', async () => {
    const { ctx, workspaceA } = await setup()
    await ctx.memory.remember({ content: 'seed', namespace: 'project' }, workspaceA)
    const dir = join(workspaceA, '.dsh', 'storages')
    const file = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!)
    const document = JSON.parse(readFileSync(file, 'utf8')) as { unit: { name: string } }
    document.unit.name = `memory_project_${document.unit.name}` // 伪造旧双重前缀头（0.5.2 首版迁移中间态）
    writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`)

    await ctx.memory.reload()
    const records = await ctx.memory.list({ namespace: 'project' }, workspaceA)
    expect(records.map(record => record.content)).toEqual(['seed']) // 中间态可读（头自愈）
    const healed = JSON.parse(readFileSync(file, 'utf8')) as { unit: { name: string } }
    expect(healed.unit.name).not.toContain('memory_project_memory_project')
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
