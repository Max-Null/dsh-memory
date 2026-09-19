/**
 * 记忆的跨层移动（迭代设计 §3.2）。
 *
 * 两个方向共用一个操作：向上提到祖先层或 `global`，向下把误放高层的降回它真正属于的
 * 工作区。这些用例盯住的是**后果**——移动之后谁还看得见它。因为「约束不是禁止方向，
 * 而是让后果可见」正是这个工具与它前身（只允许向上的 `memory_promote`）的分界：
 * 向上移动源层不会失明（继承只向上），向下移动则会。
 *
 * **测试隔离（第一版在这里翻过车）**：每个用例只在自己 `mkdtemp` 出来的根底下建工作区树，
 * 绝不把记忆写到 `tmpdir()` 本身。`tmpdir()` 是所有 spec 的**共同祖先**，往那里写一条记忆，
 * 别的用例的工作区链就会走上去把它读进来——表现为一堆毫不相干的断言多出一条记录。
 * 那不是泄漏，恰恰是祖先链在正常工作。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp } from 'node:fs/promises'
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
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webRuntime' as never, { trustedHosts: [] } as never)
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-move-'))
  const fiber = await ctx.plugin(plugin, { globalRoot })
  return { ctx, fiber, globalRoot }
}

/** 一棵三层的工作区树：root → root/mid → root/mid/leaf。root 是这一支的共同祖先，也是隔离边界。 */
async function workspaceTree() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-mv-'))
  const mid = join(root, 'mid')
  const leaf = join(mid, 'leaf')
  await mkdir(leaf, { recursive: true })
  return { root, mid, leaf }
}

async function idsAt(ctx: Context, namespace: 'global' | 'project', cwd?: string): Promise<string[]> {
  return (await ctx.memory.list({ namespace }, cwd)).map(record => String(record.id))
}

describe('记忆的跨层移动', () => {
  it('提到上一层后，源层仍然看得见它（继承只向上）', async () => {
    const { ctx } = await setup()
    const { mid, leaf } = await workspaceTree()
    const record = await ctx.memory.remember(
      { content: '对两支都成立的知识', keywords: ['两支'], namespace: 'project' },
      leaf,
    )

    const outcome = await ctx.memory.move(record.id, '..', leaf)

    expect(outcome.from).toBe(join(leaf))
    expect(outcome.to).toBe(join(mid))
    expect(outcome.sourceStillSees).toBe(true)
    // 源层仍检索得到——它现在是祖先记忆，带 scope 标记
    const hits = await ctx.memory.search('两支', undefined, leaf)
    expect(hits.length).toBe(1)
    expect(hits[0]?.record.scope).toBe('..')
  })

  it('从 global 降到工作区：范围缩小，global 层不再看得见它', async () => {
    const { ctx } = await setup()
    const { root } = await workspaceTree()
    const record = await ctx.memory.remember({ content: '其实只属于这个项目', keywords: ['降级'] })
    expect(record.namespace).toBe('global')

    const outcome = await ctx.memory.move(record.id, 'self', root)

    expect(outcome.from).toBe('global')
    expect(outcome.to).toBe(join(root))
    expect(outcome.sourceStillSees).toBe(false)
    expect(await idsAt(ctx, 'global')).not.toContain(String(record.id))
    expect(await idsAt(ctx, 'project', root)).toContain(String(record.id))
  })

  it('移进 global 后任何工作区都看得见它，源层也保留', async () => {
    const { ctx } = await setup()
    const { root } = await workspaceTree()
    const record = await ctx.memory.remember(
      { content: '其实哪个项目都成立', keywords: ['升级'], namespace: 'project' },
      root,
    )

    const outcome = await ctx.memory.move(record.id, 'global', root)

    expect(outcome.from).toBe(join(root))
    expect(outcome.to).toBe('global')
    expect(outcome.sourceStillSees).toBe(true)
    expect(await idsAt(ctx, 'global')).toContain(String(record.id))
    // 源工作区仍检索得到（走的正是 global 表）
    expect((await ctx.memory.search('升级', undefined, root)).length).toBe(1)
  })

  it('跨两层提到共同祖先也对得上', async () => {
    const { ctx } = await setup()
    const { root, leaf } = await workspaceTree()
    const record = await ctx.memory.remember(
      { content: '往上两层', keywords: ['两层'], namespace: 'project' },
      leaf,
    )

    const outcome = await ctx.memory.move(record.id, '../..', leaf)
    expect(outcome.to).toBe(join(root))
    expect(outcome.sourceStillSees).toBe(true)
    expect(await idsAt(ctx, 'project', root)).toContain(String(record.id))
  })

  it('拒绝未定义的目标写法，且拒绝时不动记录', async () => {
    const { ctx } = await setup()
    const { root } = await workspaceTree()
    const record = await ctx.memory.remember(
      { content: '目标写错', keywords: ['越界'], namespace: 'project' },
      root,
    )

    await expect(ctx.memory.move(record.id, 'nowhere', root)).rejects.toThrow(/unknown move target/)
    await expect(ctx.memory.move(record.id, '../sibling', root)).rejects.toThrow(/unknown move target/)
    expect(await idsAt(ctx, 'project', root)).toContain(String(record.id))
  })

  it('拒绝越过盘根的目标', async () => {
    const { ctx } = await setup()
    const { root } = await workspaceTree()
    const record = await ctx.memory.remember(
      { content: '爬太高', keywords: ['盘根'], namespace: 'project' },
      root,
    )
    await expect(ctx.memory.move(record.id, '../../../../../../../../..', root))
      .rejects.toThrow(/above the filesystem root/)
  })

  it('拒绝未知 id 与同层移动', async () => {
    const { ctx } = await setup()
    const { root } = await workspaceTree()
    const record = await ctx.memory.remember(
      { content: '原地不动', keywords: ['同层'], namespace: 'project' },
      root,
    )
    const unknown = '00000000-0000-4000-8000-000000000000'
    await expect(ctx.memory.move(unknown as never, 'self', root)).rejects.toThrow(/unknown memory/)
    await expect(ctx.memory.move(record.id, 'self', root)).rejects.toThrow(/already stored/)
  })
})
