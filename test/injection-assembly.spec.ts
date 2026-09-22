/**
 * 注入的装配级完整性（0.7.3）。
 *
 * 注入 provider 是**同步**的，只读已打开的工作区表，而表是异步打开的——「重启后首轮
 * 工作区记忆缺席一轮」就是这么来的：`session/created` 的预热是 fire-and-forget，跑不赢
 * 紧随其后的首次组装。组装 waterfall 是异步的，在那里补一次预热并重渲染那条 context，
 * 首轮就不再缺席。
 *
 * 用例构造「表未打开但磁盘有数据」的方式：**让引擎从未打开过这个 cwd**，把存储文件按
 * 真实形状直接放到它的位置上——这正是刚重启时内存与磁盘的关系。不走「两个引擎实例」：
 * 存储层不允许同一 unit 有两个活句柄（`a unit has exactly one live handle`），而前一个
 * 引擎的 dispose 并不会立刻释放它。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt, { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

async function setup(extra: { injectionBudget?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webRuntime' as never, { trustedHosts: [] } as never)
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-assembly-'))
  await ctx.plugin(plugin, { globalRoot, ...extra })
  return { ctx }
}

/** 组装一次，带上「当前会话的 cwd」——provider 与 waterfall 都从这条路径取它。 */
async function assembleFor(ctx: Context, cwd?: string) {
  return await ctx.systemPrompt.assemble(
    (cwd === undefined ? {} : { agent: { session: { header: { cwd } } } }) as never,
  )
}

const recallTextOf = (assembly: { contexts: readonly { name: string, text: string }[] }): string =>
  assembly.contexts.find(entry => entry.name === 'memory:recall')?.text ?? ''

/** 工作区存储的文件名（engine 的 projectBackendName：djb2 over 小写路径，36 进制）。 */
function projectStoreName(cwd: string): string {
  let h = 5381
  const text = cwd.toLowerCase()
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `memory_project_${Math.abs(h).toString(36)}`
}

/** 用例会伪造 Date（拉开两条记忆的创建时间），任何失败路径都要恢复真实时钟。 */
afterEach(() => { vi.useRealTimers() })

describe('注入在装配层的完整性', () => {
  it('工作区表未打开时（等价于刚重启），首轮组装就带上工作区记忆', async () => {
    const { ctx } = await setup()
    const source = await mkdtemp(join(tmpdir(), 'dsh-memory-src-'))
    const target = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))

    // 先在 source 里由引擎写一条，拿到存储文档的真实形状
    const record = await ctx.memory.remember(
      { content: '工作区常驻记忆', keywords: ['工作区常驻'], namespace: 'project' },
      source,
    )
    await ctx.memory.setInjected(record.id, true, source)

    // 按同样的形状落到 target 的位置；引擎从未打开过 target，所以它的工作区表是空的
    const name = projectStoreName(target)
    const shape = JSON.parse(readFileSync(
      join(source, '.dsh', 'storages', `${projectStoreName(source)}.json`), 'utf8',
    )) as { unit: Record<string, unknown>, tables: { blocks: Record<string, unknown> } }
    const block = Object.values(shape.tables.blocks)[0]
    const targetDir = join(target, '.dsh', 'storages')
    await mkdir(targetDir, { recursive: true })
    writeFileSync(join(targetDir, `${name}.json`), `${JSON.stringify({
      ...shape,
      unit: { ...shape.unit, name },
      tables: { blocks: { external: block } },
    }, null, 2)}\n`, 'utf8')

    expect(ctx.memory.projectOpen(target)).toBe(false)
    expect(recallTextOf(await assembleFor(ctx, target))).toContain('工作区常驻记忆')
    // 补完这一次，表就打开了——后续轮次走同步路径
    expect(ctx.memory.projectOpen(target)).toBe(true)
  })

  it('表已打开时不改动 provider 的渲染结果', async () => {
    const { ctx } = await setup()
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
    const record = await ctx.memory.remember(
      { content: '工作区常驻记忆', keywords: ['工作区常驻'], namespace: 'project' },
      cwd,
    )
    await ctx.memory.setInjected(record.id, true, cwd)

    expect(ctx.memory.projectOpen(cwd)).toBe(true)
    expect(recallTextOf(await assembleFor(ctx, cwd))).toContain('工作区常驻记忆')
  })

  it('没有会话 cwd 时不介入（返回的仍是 provider 的组装结果）', async () => {
    const { ctx } = await setup()
    const assembly = await assembleFor(ctx)
    expect(assembly.contexts.some(entry => entry.name === 'memory:recall')).toBe(true)
  })

  it('预算装不下时常驻记忆出局，id 出现在诊断行（2026-09-18）', async () => {
    const { ctx } = await setup({ injectionBudget: 100 })
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))

    // 注入按「最近更新优先」排序，两条的 updatedAt 必须有确定先后。伪造 Date 而不是
    // sleep：Windows 的时钟粒度可能让一次短 sleep 之后拿到的仍是同一个值。
    const base = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(base)
    const older = await ctx.memory.remember({ content: '较早的常驻约定', namespace: 'project' }, cwd)
    await ctx.memory.setInjected(older.id, true, cwd)
    vi.setSystemTime(base + 60_000)
    const newer = await ctx.memory.remember({ content: '较新的常驻约定', namespace: 'project' }, cwd)
    await ctx.memory.setInjected(newer.id, true, cwd)
    vi.useRealTimers()

    const text = recallTextOf(await assembleFor(ctx, cwd))
    // 行首格式是区分「进了注入行」与「只出现在诊断行」的唯一可靠判据——
    // 0.9.1 起出局者的短摘要也会出现在诊断行里，光断言内容包含会混淆两者
    expect(text).toMatch(/^- \[memory:.*较新的常驻约定/m)
    expect(text).not.toMatch(/^- \[memory:.*较早的常驻约定/m)
    expect(text).toContain('另有 1 条常驻因预算未注入')
    expect(text).toContain('较早的常驻约定')   // 出局者以短摘要出现，不再只报 id
  })

  it('0.12.0: 检索不改变注入顺序（本版核心回归）', async () => {
    const { ctx } = await setup({ injectionBudget: 100 })
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))

    const base = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(base)
    const older = await ctx.memory.remember({ content: '较早的常驻约定', namespace: 'project' }, cwd)
    await ctx.memory.setInjected(older.id, true, cwd)
    vi.setSystemTime(base + 60_000)
    const newer = await ctx.memory.remember({ content: '较新的常驻约定', namespace: 'project' }, cwd)
    await ctx.memory.setInjected(newer.id, true, cwd)
    vi.useRealTimers()

    const before = recallTextOf(await assembleFor(ctx, cwd))

    // 反复检索「较早」那条：旧实现下 markUsed 会刷新它的 lastUsedAt，把它顶到预算前面
    await ctx.memory.search('较早的常驻约定', {}, cwd)
    await ctx.memory.search('较早的常驻约定', {}, cwd)

    const after = recallTextOf(await assembleFor(ctx, cwd))
    expect(after).toBe(before)   // 注入副本一字未变
  })

  it('0.12.0: 候选提示出现在注入副本里——判断者必须看得见', async () => {
    const { ctx } = await setup()
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
    await ctx.memory.remember({ content: 'alpha 候选条目', keywords: ['alpha'], namespace: 'project' }, cwd)

    // 命中两次即达候选阈值（判据不变，只是不再自动改状态）
    await ctx.memory.search('alpha', {}, cwd)
    await ctx.memory.search('alpha', {}, cwd)

    const text = recallTextOf(await assembleFor(ctx, cwd))
    // 候选是「该不该钉」的待办，而判断者就是读这段上下文的模型——它必须自己走到眼前，
    // 不能只躺在要主动调的工具里（那等于不存在）。
    expect(text).toContain('被反复检索但未常驻')
  })

  it('预算充裕时不出诊断行（自消除）', async () => {
    const { ctx } = await setup()
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
    const record = await ctx.memory.remember({ content: '唯一常驻', namespace: 'project' }, cwd)
    await ctx.memory.setInjected(record.id, true, cwd)

    const text = recallTextOf(await assembleFor(ctx, cwd))
    expect(text).toContain('唯一常驻')
    expect(text).not.toContain('未注入')
  })

  it('记忆正文含字面 {{ }} 时注入副本被中和，组装渲染不抛错（0.11.1）', async () => {
    const { ctx } = await setup()
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
    const record = await ctx.memory.remember(
      { content: '项目里 Vue 模板用 {{ count }} 做插值', keywords: ['vue'], namespace: 'project' },
      cwd,
    )
    await ctx.memory.setInjected(record.id, true, cwd)

    const assembly = await assembleFor(ctx, cwd)
    const text = recallTextOf(assembly)
    expect(text).toContain('做插值')      // 这条记忆确实进了注入
    expect(text).not.toContain('{{')      // 但副本里的字面双括号已被中和

    // 验收判据是「真实插值路径不抛」，不是字符串断言。注意 renderPrompt() 只处理
    // sections，而 memory:recall 是 context —— 必须用 renderContextSections；
    // 拿前者测这条会得到假的「通过」（2026-09-23 实测踩过）。
    expect(() => renderContextSections(assembly)).not.toThrow()
  })
})
