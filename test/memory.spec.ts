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
    // 工具清单漏列的守卫（0.10.0 曾漏掉 prompt_* 系列、0.12.0 补了 memory_sweep）：
    // 自述是模型行为的实际控制器，清单陈旧等于它按一份不存在的工具面行事。
    expect(self?.text).toContain('memory_sweep')
    expect(self?.text).toContain('11 个工具')

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

  it('2026-09-15: 写入即 approved（静默机制），injected 仍为 false', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'fresh memory' })
    expect(record.status).toBe('approved')
    expect(record.injected).toBe(false)
    expect(record.quarantined).toBe(false)
  })

  it('2026-09-15: 命中危险内容规则的写入被隔离——不进列表、不进检索，可显式取出审', async () => {
    const { ctx } = await setup()
    const secret = await ctx.memory.remember({ content: 'api_key = sk-abcdefghijklmnopqrstuvwx' })
    expect(secret.status).toBe('suggested')
    expect(secret.quarantined).toBe(true)
    expect(secret.quarantineReason).toBeDefined()
    expect((await ctx.memory.list()).some(record => record.id === secret.id)).toBe(false)
    expect((await ctx.memory.search('api_key')).length).toBe(0)
    expect((await ctx.memory.list({ quarantined: true })).some(record => record.id === secret.id)).toBe(true)
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

  it('2026-09-15: update rewrites content/keywords, keeps status and injected switch', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'stale fact', keywords: ['old'] })
    await ctx.memory.setInjected(record.id, true)

    const updated = await ctx.memory.update(record.id, { content: 'fresh fact', keywords: ['new', 'Key'] })
    expect(updated.content).toBe('fresh fact')
    expect(updated.keywords).toEqual(['new', 'key']) // lowercased
    expect(updated.status).toBe('approved')          // 静默机制：改动保持生效，不再退回待审核
    expect(updated.injected).toBe(true)              // 注入开关保留
    expect(updated.quarantined).toBe(false)

    // 仍在注入名单里
    expect((await ctx.memory.list({ status: 'approved', injected: true })).length).toBe(1)

    // 只改 content 不动 keywords
    const partial = await ctx.memory.update(record.id, { content: 'half update' })
    expect(partial.content).toBe('half update')
    expect(partial.keywords).toEqual(['new', 'key'])
  })

  it('2026-09-15: update 命中危险规则则转为隔离（不进列表与检索）', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'plain note' })
    await ctx.memory.setInjected(record.id, true)

    const updated = await ctx.memory.update(record.id, { content: 'token = ghp_0123456789abcdefghijklmnopqrst' })
    expect(updated.quarantined).toBe(true)
    expect(updated.status).toBe('suggested')
    expect((await ctx.memory.list()).some(item => item.id === record.id)).toBe(false)
  })

  it('0.12.0: 命中两次不再自动升常驻，只进候选（判据倒置的修正）', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'alpha beta gamma', keywords: ['alpha'] })
    expect(record.injected).toBe(false)

    await ctx.memory.search('alpha')
    const afterFirst = (await ctx.memory.list())[0]
    expect(afterFirst?.injected).toBe(false)   // 一次偶然命中不够
    expect(afterFirst?.hitCount).toBe(1)
    expect(ctx.memory.candidates().some(item => item.id === record.id)).toBe(false)

    await ctx.memory.search('alpha')
    const afterSecond = (await ctx.memory.list())[0]
    // 关键：命中次数继续记，但不再据此改变注入状态——连自动标记都不落
    expect(afterSecond?.injected).toBe(false)
    expect(afterSecond?.injectedAuto).toBeUndefined()
    expect(afterSecond?.hitCount).toBe(2)
    // 提示仍然在，只是决定权回到判断者手里
    expect(ctx.memory.candidates().some(item => item.id === record.id)).toBe(true)
  })

  it('0.12.0: 取消自动升之后，命中记账照旧（hitCount 与 lastUsedAt 都还在累加）', async () => {
    const { ctx } = await setup()
    await ctx.memory.remember({ content: 'alpha beta', keywords: ['alpha'] })

    await ctx.memory.search('alpha')
    await ctx.memory.search('alpha')
    await ctx.memory.search('alpha')

    const after = (await ctx.memory.list())[0]
    expect(after?.hitCount).toBe(3)                       // 记账没被误删
    expect(after?.lastUsedAt).toBeTypeOf('number')
    expect(after?.injected).toBe(false)                   // 但状态一动不动
  })

  it('0.12.0: 命中不再改写既有的注入状态（含 injectedAuto: true 的历史记录）', async () => {
    const { ctx, globalRoot } = await setup()
    const record = await ctx.memory.remember({ content: 'alpha beta', keywords: ['alpha'] })

    // 构造 0.12.0 之前的自动升形态：直接改存储文件 + reload（引擎对表有内存缓存）
    const file = join(globalRoot, 'memory.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      tables: { blocks: Record<string, Record<string, unknown>> }
    }
    Object.assign(raw.tables.blocks[record.id], { injected: true, injectedAuto: true })
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    await ctx.memory.reload()

    await ctx.memory.search('alpha')
    await ctx.memory.search('alpha')

    const after = (await ctx.memory.list())[0]
    expect(after?.injected).toBe(true)          // 历史状态原样保留，不被记账路径改写
    expect(after?.injectedAuto).toBe(true)
    expect(after?.hitCount).toBe(2)             // 记账照常
    expect(ctx.memory.candidates().some(item => item.id === record.id)).toBe(false)  // 已常驻的不算候选
  })

  it('0.12.0: candidates 的筛选条件逐条成立', async () => {
    const { ctx } = await setup()
    const plain = await ctx.memory.remember({ content: 'alpha plain', keywords: ['alpha'] })
    const pinned = await ctx.memory.remember({ content: 'alpha pinned', keywords: ['alpha'], injected: true })
    const muted = await ctx.memory.remember({ content: 'alpha muted', keywords: ['alpha'], injected: false })
    await ctx.memory.promptAdd({ name: 'cand-guard', content: 'alpha template body', tags: ['alpha'] })

    await ctx.memory.search('alpha')
    await ctx.memory.search('alpha')

    const found = ctx.memory.candidates()
    const ids = found.map(item => item.id)
    expect(ids).toContain(plain.id)            // 命够的普通记录 → 入
    expect(ids).not.toContain(pinned.id)       // 已常驻 → 不入
    expect(ids).not.toContain(muted.id)        // 人工否决（injectedAuto === false）→ 不入
    // 隔离记录不入这条由 status/quarantined 双重保证，但未直接投毒构造（触发危险内容检测
    // 会引入不确定性）——留在代码里可见即可。
    expect(found.every(item => item.status === 'approved')).toBe(true)
    expect(found.every(item => (item.hitCount ?? 0) >= 2)).toBe(true)
    expect(found.some(item => (item.kind ?? 'fact') === 'prompt')).toBe(false)
  })

  it('0.12.0: memory_list 按更新时间过滤（工具层解析 7d 与绝对日期）', async () => {
    const { ctx, globalRoot } = await setup()
    const old = await ctx.memory.remember({ content: 'alpha old', keywords: ['alpha'] })
    const fresh = await ctx.memory.remember({ content: 'alpha fresh', keywords: ['alpha'] })

    // 把 old 的更新时刻改到 30 天前（再造出「新旧」两种记录）
    const file = join(globalRoot, 'memory.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      tables: { blocks: Record<string, Record<string, unknown>> }
    }
    raw.tables.blocks[old.id].updatedAt = Date.now() - 30 * 24 * 60 * 60 * 1000
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    await ctx.memory.reload()

    const tool = ctx.tools.get('memory_list')
    const idsOf = async (args: Record<string, unknown>): Promise<string[]> =>
      (await tool?.execute?.(args, {} as never) as Array<{ id: string }>).map(item => item.id)

    const recent = await idsOf({ after: '7d' })
    expect(recent).toContain(String(fresh.id))
    expect(recent).not.toContain(String(old.id))

    const before = await idsOf({ before: '7d' })
    expect(before).toContain(String(old.id))
    expect(before).not.toContain(String(fresh.id))

    expect(await idsOf({})).toHaveLength(2)              // 不过滤时两条都在
    expect(await idsOf({ after: '乱写' })).toHaveLength(2) // 解析不出 = 不过滤，不报错
  })

  it('0.12.0: sweep 是只读的——连跑两次不产生任何写入', async () => {
    const { ctx, globalRoot } = await setup()
    await ctx.memory.remember({ content: 'alpha one', keywords: ['alpha'] })
    const two = await ctx.memory.remember({ content: 'alpha two', keywords: ['alpha'] })
    await ctx.memory.setInjected(two.id, true)

    const file = join(globalRoot, 'memory.json')
    const before = readFileSync(file, 'utf8')
    const first = await ctx.memory.sweep()
    const afterFirst = readFileSync(file, 'utf8')
    const second = await ctx.memory.sweep()
    const afterSecond = readFileSync(file, 'utf8')

    expect(afterFirst).toBe(before)            // 一个字都没写（连时间戳都没有）
    expect(afterSecond).toBe(before)
    expect(second).toEqual(first)              // 幂等
    expect(first.resident.total).toBe(1)
    expect(first.resident.injected).toBe(1)
  })

  it('0.12.0: sweep 的 days 决定久未命中的边界，常驻不算久未命中', async () => {
    const { ctx } = await setup()
    const fresh = await ctx.memory.remember({ content: 'alpha fresh', keywords: ['alpha'] })
    const resident = await ctx.memory.remember({
      content: 'alpha resident', keywords: ['alpha'], injected: true,
    })

    const far = Date.now() + 200 * 24 * 60 * 60 * 1000   // 站在 200 天之后回看
    const report = await ctx.memory.sweep(undefined, { days: 90, now: far })
    const ids = report.longUnused.map(item => item.id)
    expect(ids).toContain(String(fresh.id))              // 非常驻且久未命中
    expect(ids).not.toContain(String(resident.id))       // 常驻的「没被查过」是正常的

    // 阈值放宽到 300 天：同一份数据不再算久未命中（边界确实由 days 决定）
    const relaxed = await ctx.memory.sweep(undefined, { days: 300, now: far })
    expect(relaxed.longUnused).toHaveLength(0)
  })

  it('0.12.0: sweep 报出失效记录（带原因）与候选', async () => {
    const { ctx } = await setup()
    const voided = await ctx.memory.remember({ content: 'alpha voided', keywords: ['alpha'] })
    await ctx.memory.retract(voided.id, '记错了')
    const candidate = await ctx.memory.remember({ content: 'alpha candidate', keywords: ['alpha'] })
    await ctx.memory.search('alpha')
    await ctx.memory.search('alpha')

    const report = await ctx.memory.sweep()
    expect(report.stale.map(item => item.id)).toContain(String(voided.id))
    expect(report.stale.find(item => item.id === String(voided.id))?.reason).toBe('已撤回：记错了')
    expect(report.candidates.map(item => item.id)).toContain(String(candidate.id))
  })

  it('0.12.0: supersede 把目标标成被取代，取代者自身不动', async () => {
    const { ctx } = await setup()
    const older = await ctx.memory.remember({ content: 'alpha old rule', keywords: ['alpha'] })
    const newer = await ctx.memory.remember({ content: 'alpha new rule', keywords: ['alpha'] })

    const voided = await ctx.memory.supersede(newer.id, older.id)
    expect(voided.id).toBe(older.id)
    expect(voided.stale).toBe(true)
    expect(voided.staleReason).toContain(String(newer.id).slice(0, 8))
    expect(voided.content).toBe('alpha old rule')        // 内容保留，只是标了作废

    const source = (await ctx.memory.list()).find(item => item.id === newer.id)
    expect(source?.stale).not.toBe(true)                 // 取代者本身不被动
    expect(source?.content).toBe('alpha new rule')
  })

  it('0.12.0: retract 标记作废，内容仍能被检索检回', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'alpha wrong note', keywords: ['alpha'] })

    const voided = await ctx.memory.retract(record.id, '当时记错了')
    expect(voided.stale).toBe(true)
    expect(voided.staleReason).toBe('已撤回：当时记错了')
    expect(voided.content).toBe('alpha wrong note')      // 不删内容

    // 带标注等核对——检索侧放行，注入侧挡下（与锚点失效同一条路径）
    const hits = await ctx.memory.search('alpha')
    expect(hits.some(hit => hit.record.id === record.id)).toBe(true)
  })

  it('0.12.0: 作废同时撤掉常驻，并退出注入候选', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'alpha pinned', keywords: ['alpha'], injected: true })
    expect((await ctx.memory.list())[0]?.injected).toBe(true)
    expect(ctx.memory.recallRecords().some(item => item.id === record.id)).toBe(true)

    await ctx.memory.retract(record.id, '不再适用')

    const after = (await ctx.memory.list())[0]
    expect(after?.injected).toBe(false)                  // 撤常驻
    expect(after?.status).toBe('approved')               // 但状态不变：仍可检索
    expect(ctx.memory.recallRecords().some(item => item.id === record.id)).toBe(false)
  })

  it('0.12.0: supersede / retract 的边界——自身、未知 id 都拒绝', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'alpha note', keywords: ['alpha'] })

    await expect(ctx.memory.supersede(record.id, record.id)).rejects.toThrow(/itself/)
    await expect(ctx.memory.supersede(record.id, 'no-such-id' as never)).rejects.toThrow(/unknown/)
    await expect(ctx.memory.retract('no-such-id' as never, 'x')).rejects.toThrow(/unknown/)
  })

  it('0.12.0: memory_update 的三个动作按 retract > supersedes > update 分派', async () => {
    const { ctx } = await setup()
    const target = await ctx.memory.remember({ content: 'alpha target', keywords: ['alpha'] })
    const source = await ctx.memory.remember({ content: 'alpha source', keywords: ['alpha'] })
    const tool = ctx.tools.get('memory_update')

    // supersedes：标目标作废，本条不变
    const afterSuper = await tool?.execute?.(
      { id: String(source.id), supersedes: String(target.id) }, {} as never)
    expect(afterSuper?.id).toBe(target.id)
    expect(afterSuper?.stale).toBe(true)
    expect((await ctx.memory.list()).find(item => item.id === source.id)?.stale).not.toBe(true)

    // retract 优先于 content：同时给两者时走撤回，content 不生效
    const afterRetract = await tool?.execute?.(
      { id: String(source.id), content: 'should not apply', retract: '换个说法' }, {} as never)
    expect(afterRetract?.stale).toBe(true)
    expect(afterRetract?.content).toBe('alpha source')
    expect(afterRetract?.staleReason).toBe('已撤回：换个说法')
  })

  it('2026-09-15: 宽命中不批量记账（命中计数只认前几名，否则候选清单被灌满噪音）', async () => {
    const { ctx } = await setup()
    // 20 条都含 alpha：BM25 会把它们全部打分，模拟真实库里的宽命中面
    for (let i = 0; i < 20; i += 1) {
      await ctx.memory.remember({ content: `alpha beta note ${i}`, keywords: ['alpha'] })
    }

    const hits = await ctx.memory.search('alpha')
    expect(hits.length).toBe(20)   // 返回值不受记账上限影响

    const all = await ctx.memory.list()
    const counted = all.filter(item => (item.hitCount ?? 0) > 0)
    expect(counted.length).toBe(5)
    expect(counted.every(item => item.injected === false)).toBe(true)   // 一次检索不足以升常驻
  })

  it('2026-09-15: 模板记录不参与记忆检索，也不会被自动升常驻', async () => {
    const { ctx } = await setup()
    await ctx.memory.promptAdd({ name: 'promo-guard', content: 'alpha beta gamma template body', tags: ['alpha'] })

    const hits = await ctx.memory.search('alpha')
    expect(hits.some(hit => (hit.record.kind ?? 'fact') === 'prompt')).toBe(false)

    await ctx.memory.search('alpha')
    const prompts = await ctx.memory.list({ kind: 'prompt' })
    const target = prompts.find(item => item.meta?.name === 'promo-guard')
    expect(target?.injected).toBe(false)
    expect(target?.injectedAuto).toBeUndefined()

    // 兜底：即使存储里被标成 injected（旧版本或人工改文件留下的），注入列表也不收模板
    expect(ctx.memory.recallRecords().some(item => item.kind === 'prompt')).toBe(false)
  })

  it('2026-09-15: 人工开过的注入不被自动降级（那是人的决定，不是信号的结论）', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'manual pin' })
    await ctx.memory.setInjected(record.id, true)

    const demoted = await ctx.memory.demoteStale(undefined, Date.now() + 60 * 24 * 60 * 60 * 1000)
    expect(demoted).toBe(0)
    expect((await ctx.memory.list())[0]?.injected).toBe(true)
  })

  it('2026-09-15: 人工关掉的注入不被自动重开（人工控制优先，与降级侧对称）', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'alpha beta gamma', keywords: ['alpha'] })
    await ctx.memory.setInjected(record.id, false)   // 人工显式关闭

    await ctx.memory.search('alpha')
    await ctx.memory.search('alpha')

    const after = (await ctx.memory.list())[0]
    expect(after?.injected).toBe(false)     // 命中再多也不越过人工决定
    expect(after?.injectedAuto).toBe(false)
    expect(after?.hitCount).toBe(2)         // 计数照常，只是不再据此改注入
  })

  it('2026-09-18: remember 显式指定注入即接管，省略则维持缺省与自动升级资格', async () => {
    const { ctx } = await setup()

    const pinned = await ctx.memory.remember({ content: 'standing rule', injected: true })
    expect(pinned.status).toBe('approved')
    expect(pinned.injected).toBe(true)
    expect(pinned.injectedAuto).toBe(false)   // 有意决定，不吃自动升降

    // 省略参数：不注入，且 injectedAuto 不落值——保留「被反复命中即进候选提示」的资格
    const plain = await ctx.memory.remember({ content: 'on demand fact' })
    expect(plain.injected).toBe(false)
    expect(plain.injectedAuto).toBeUndefined()

    // 显式 false 同样是接管：此后被反复命中也不重开
    const muted = await ctx.memory.remember({ content: 'alpha beta gamma', keywords: ['alpha'], injected: false })
    await ctx.memory.search('alpha')
    await ctx.memory.search('alpha')
    const after = (await ctx.memory.list()).find(item => item.id === muted.id)
    expect(after?.injected).toBe(false)
    expect(after?.injectedAuto).toBe(false)
  })

  it('2026-09-18: remember 指定注入不越过隔离边界', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'token = ghp_0123456789abcdefghijklmnopqrst', injected: true })
    expect(record.quarantined).toBe(true)
    expect(record.status).toBe('suggested')
    expect(record.injected).toBe(false)
  })

  it('2026-09-18: update 可切注入位，省略则连 injectedAuto 一起保持', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'rule draft' })

    const on = await ctx.memory.update(record.id, { injected: true })
    expect(on.injected).toBe(true)
    expect(on.injectedAuto).toBe(false)

    // 只改内容、省略 injected：注入位与其归属都不动
    const kept = await ctx.memory.update(record.id, { content: 'rule v2' })
    expect(kept.content).toBe('rule v2')
    expect(kept.injected).toBe(true)
    expect(kept.injectedAuto).toBe(false)

    const off = await ctx.memory.update(record.id, { injected: false })
    expect(off.injected).toBe(false)
    expect(off.injectedAuto).toBe(false)
  })

  it('2026-09-18: update 改过注入位之后，自动通道两个方向都失效', async () => {
    const { ctx } = await setup()

    const muted = await ctx.memory.remember({ content: 'alpha beta gamma', keywords: ['alpha'] })
    await ctx.memory.update(muted.id, { injected: false })
    await ctx.memory.search('alpha')
    await ctx.memory.search('alpha')
    const afterMute = (await ctx.memory.list()).find(item => item.id === muted.id)
    expect(afterMute?.injected).toBe(false)   // 命中再多也不越过显式决定

    const pinned = await ctx.memory.remember({ content: 'pinned through update' })
    await ctx.memory.update(pinned.id, { injected: true })
    expect(await ctx.memory.demoteStale(undefined, Date.now() + 60 * 24 * 60 * 60 * 1000)).toBe(0)
    const afterPin = (await ctx.memory.list()).find(item => item.id === pinned.id)
    expect(afterPin?.injected).toBe(true)     // 长期未命中也不撤
  })

  it('2026-09-18: update 命中危险规则时连带撤下注入', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'plain note', injected: true })
    expect(record.injected).toBe(true)

    const updated = await ctx.memory.update(record.id, { content: 'token = ghp_0123456789abcdefghijklmnopqrst' })
    expect(updated.quarantined).toBe(true)
    expect(updated.status).toBe('suggested')
    expect(updated.injected).toBe(false)      // 隔离内容不得常驻
  })

  it('2026-09-18: 未审核记录不接受注入（与自动升级同一门槛）', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'pending note' })
    await ctx.memory.setStatus(record.id, 'suggested')

    const updated = await ctx.memory.update(record.id, { injected: true })
    expect(updated.status).toBe('suggested')
    expect(updated.injected).toBe(false)
  })

  it('2026-09-18: memory_save / memory_update 工具的 injected 参数落到存储', async () => {
    const { ctx } = await setup()
    const save = ctx.tools.get('memory_save')
    const saved = await save?.execute?.({ content: 'tool-level pin', injected: true }, {} as never) as { id: string, injected: boolean }
    expect(saved.injected).toBe(true)

    const update = ctx.tools.get('memory_update')
    const off = await update?.execute?.({ id: String(saved.id), injected: false }, {} as never) as { injected: boolean }
    expect(off.injected).toBe(false)
  })

  it('2026-09-15: 自动升的常驻在长期未命中后降级——记忆不会无限累积', async () => {
    const { ctx, globalRoot } = await setup()
    const record = await ctx.memory.remember({ content: 'alpha beta', keywords: ['alpha'] })

    // 0.12.0 取消了自动升，所以「自动升上来的常驻」只能构造出来——但**自动降级规则本身
    // 仍然成立**（库里还留着 0.12.0 之前自动升的记录），因此用例保留、换构造方式：直接改
    // 存储文件造出 `injectedAuto: true` + 陈旧 lastUsedAt，再 reload 让引擎读到。
    const file = join(globalRoot, 'memory.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      tables: { blocks: Record<string, Record<string, unknown>> }
    }
    const stored = raw.tables.blocks[record.id]
    stored.injected = true
    stored.injectedAuto = true
    stored.lastUsedAt = Date.now() - 90 * 24 * 60 * 60 * 1000
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    await ctx.memory.reload()

    const before = (await ctx.memory.list())[0]
    expect(before?.injected).toBe(true)
    expect(before?.injectedAuto).toBe(true)

    expect(await ctx.memory.demoteStale(undefined, Date.now())).toBe(1)

    const after = (await ctx.memory.list())[0]
    expect(after?.injected).toBe(false)
    expect(after?.status).toBe('approved')   // 只是退出常驻，仍可检索
  })

  it('2026-09-15: 旧 suggested 迁移为 approved（新语义写入即生效），且迁移幂等', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'legacy pending note' })
    // 模拟旧数据：把记录降到「等人工审核」的状态（旧语义里的 suggested）
    await ctx.memory.setStatus(record.id, 'suggested')
    expect((await ctx.memory.list())[0]?.status).toBe('suggested')

    const stats = await ctx.memory.migrateLegacy()
    expect(stats.approved).toBe(1)
    expect(stats.quarantined).toBe(0)
    expect((await ctx.memory.list())[0]?.status).toBe('approved')

    // 幂等：再跑一次无事可做（也因此不会重复留备份）
    expect(await ctx.memory.migrateLegacy()).toEqual({ approved: 0, quarantined: 0, counted: 0 })
  })

  it('0.3.1: memory_update tool exists and rewires to engine.update', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: 'to update' })
    const tool = ctx.tools.get('memory_update')
    expect(tool?.name).toBe('memory_update')
    const result = await tool?.execute?.({ id: String(record.id), content: 'updated' }, {} as never)
    expect(result?.content).toBe('updated')
    expect(result?.status).toBe('approved')   // 静默机制：更新即生效
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

  it('2026-09-15 ⑧: 来源字段缺省 agent，可显式写 human；旧记录无此字段照常工作', async () => {
    const { ctx, globalRoot } = await setup()
    const agentRecord = await ctx.memory.remember({ content: 'model note' })
    const humanRecord = await ctx.memory.remember({ content: 'human note', source: 'human' })
    expect(agentRecord.source).toBe('agent')
    expect(humanRecord.source).toBe('human')

    // 落盘明文可查（三处字段同步：MemoryRecord / StoredBlock / blockSchema）
    const file = join(globalRoot, 'memory.json')
    const unit = JSON.parse(readFileSync(file, 'utf8')) as {
      tables: { blocks: Record<string, { source?: string }> }
    }
    expect(unit.tables.blocks[String(agentRecord.id)]?.source).toBe('agent')
    expect(unit.tables.blocks[String(humanRecord.id)]?.source).toBe('human')

    // 兼容旧记忆：无 source 的旧记录照常读写，source 保持 undefined（来源未知，不猜）
    unit.tables.blocks['legacy-no-source'] = {
      namespace: 'global', status: 'approved', content: 'legacy no source', keywords: [], createdAt: 1, updatedAt: 1,
    }
    writeFileSync(file, JSON.stringify(unit))
    await ctx.memory.reload()

    const legacy = (await ctx.memory.list()).find(record => record.content === 'legacy no source')
    expect(legacy?.source).toBeUndefined()
    expect(legacy?.status).toBe('approved')
    // 迁移不碰旧记录的 source（缺省即「未知历史来源」）
    await ctx.memory.migrateLegacy()
    expect((await ctx.memory.list()).find(record => record.content === 'legacy no source')?.source).toBeUndefined()
  })

  it('2026-09-15 ⑥: 每次检索记一条查询日志（查询文本截断 + 命中数 + 时间），与 memory.json 同目录', async () => {
    const { ctx, globalRoot } = await setup()
    await ctx.memory.remember({ content: 'alpha beta', keywords: ['alpha'] })

    await ctx.memory.search('alpha')
    await ctx.memory.search(`  ${'x'.repeat(200)}  `)

    // 与 memory.json 同目录（不落子目录）
    expect(existsSync(join(globalRoot, 'memory.json'))).toBe(true)
    const log = JSON.parse(readFileSync(join(globalRoot, 'query-log.json'), 'utf8')) as {
      queries: Array<{ query: string, hits: number, at: number }>
    }
    expect(log.queries.map(entry => [entry.query, entry.hits]))
      .toEqual([['alpha', 1], ['x'.repeat(120), 0]])
    expect(log.queries.every(entry => entry.at > 0)).toBe(true)
  })

  it('2026-09-15 ⑥: 查询日志写失败不影响检索（日志是旁路证据，不是检索的一部分）', async () => {
    // 让日志路径指向一个目录：写文件必失败（EISDIR），检索照常
    const logDir = await mkdtemp(join(tmpdir(), 'dsh-memory-logdir-'))
    const { ctx } = await setup({ queryLogPath: logDir })
    await ctx.memory.remember({ content: 'alpha beta', keywords: ['alpha'] })

    expect((await ctx.memory.search('alpha')).map(hit => hit.record.content)).toEqual(['alpha beta'])
    // 检索路径的其他环节（命中记账）也不受牵连
    expect((await ctx.memory.list())[0]?.hitCount).toBe(1)
  })

  it('2026-09-15 ⑥: 模板库检索不进记忆查询日志', async () => {
    const { ctx, globalRoot } = await setup()
    await ctx.memory.search('template query', { kind: 'prompt' })
    expect(existsSync(join(globalRoot, 'query-log.json'))).toBe(false)
  })

  it('2026-09-15 ⑥: 查询里带凭据时不落原文（按硬拦规则脱敏）', async () => {
    const { ctx, globalRoot } = await setup()
    await ctx.memory.search('api_key = sk-abcdefghijklmnopqrstuvwx')

    const raw = readFileSync(join(globalRoot, 'query-log.json'), 'utf8')
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    const log = JSON.parse(raw) as { queries: Array<{ query: string, hits: number }> }
    expect(log.queries[0]?.query).toContain('已脱敏')
    expect(log.queries[0]?.hits).toBe(0)
  })

  it('2026-09-15 ⑥: 反查——空命中的查询能指出「本应命中」的候选（vue3 ↔ vue）', async () => {
    const { ctx } = await setup()
    const record = await ctx.memory.remember({ content: '组合式 API 的写法', keywords: ['vue'] })

    // 检索按整词比对：vue3 against keywords ['vue'] 不命中——正是反例 4 的漏检
    expect(await ctx.memory.search('vue3')).toEqual([])

    const report = await ctx.memory.suggestKeywordGaps()
    expect(report.logSize).toBe(1)
    expect(report.misses).toBe(1)
    expect(report.gaps.map(gap => gap.query)).toEqual(['vue3'])
    const candidates = report.gaps[0]?.candidates ?? []
    expect(candidates.map(candidate => candidate.id)).toEqual([String(record.id)])
    expect(candidates[0]?.exact).toBe(0)
    expect(candidates[0]?.relaxed).toEqual(['vue3'])   // 前缀近似把它捞了回来
    expect(candidates[0]?.keywords).toEqual(['vue'])   // 补写 keywords 的基础
    expect(candidates[0]?.excerpt).toContain('组合式')

    // 第一版只产出报告：不自动改写记忆
    expect((await ctx.memory.list())[0]?.keywords).toEqual(['vue'])
  })

  it('2026-09-15 ⑥: 反查——确实没有的查询归为知识缺口（候选为空）', async () => {
    const { ctx } = await setup()
    await ctx.memory.remember({ content: 'alpha beta', keywords: ['alpha'] })
    await ctx.memory.search('zebra')

    const report = await ctx.memory.suggestKeywordGaps()
    expect(report.gaps.map(gap => gap.query)).toEqual(['zebra'])
    expect(report.gaps[0]?.candidates).toEqual([])
  })

  it('2026-09-15 ⑥: 影响力统计按来源聚合（写入量 / 命中数 / 注入数）', async () => {
    const { ctx, globalRoot } = await setup()
    await ctx.memory.remember({ content: 'alpha beta', keywords: ['alpha'] })
    await ctx.memory.remember({ content: 'alpha gamma', keywords: ['alpha'] })
    await ctx.memory.remember({ content: 'alpha from human', keywords: ['alpha'], source: 'human' })

    await ctx.memory.search('alpha')   // 三条各命中一次
    const bySource = Object.fromEntries((await ctx.memory.sourceStats()).map(stat => [stat.source, stat]))
    expect(bySource.agent?.writes).toBe(2)
    expect(bySource.agent?.hits).toBe(2)
    expect(bySource.human?.writes).toBe(1)
    expect(bySource.human?.hits).toBe(1)
    expect(bySource.agent?.injected).toBe(0)   // 命中一次还没到自动升常驻的阈值

    // 无 source 的旧记录归 unknown（不猜测历史来源）
    const file = join(globalRoot, 'memory.json')
    const unit = JSON.parse(readFileSync(file, 'utf8')) as { tables: { blocks: Record<string, unknown> } }
    unit.tables.blocks['legacy-source-less'] = {
      namespace: 'global', status: 'approved', content: 'legacy fact', keywords: [], createdAt: 1, updatedAt: 1,
    }
    writeFileSync(file, JSON.stringify(unit))
    await ctx.memory.reload()
    const after = Object.fromEntries((await ctx.memory.sourceStats()).map(stat => [stat.source, stat]))
    expect(after.unknown?.writes).toBe(1)
    expect(after.agent?.writes).toBe(2)
  })
})
