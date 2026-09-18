/**
 * 子项目索引行（④-B 2026-09-19）。
 *
 * 与 ④-A 同源：两者都在补「不知道存在」这个检索的结构性盲区。区别是方向——④-A 沿 cwd
 * **向上**找祖先记忆（内容可检索），④-B 向**下**看子目录（只报规模与入口，不搬运内容）。
 *
 * 三条设计约束由用例锁住：
 * ① **不占注入预算**：与预算诊断行同待遇，是附加行而非记忆条目；
 * ② **自消除**：没有子项目记忆时整行不出现，不产生永久噪音；
 * ③ **provider 同步、扫描异步**：注入回调只能读缓存，扫描必须发生在预热路径上——
 *    未预热时该轮缺席、下一轮补上（与工作区表预热同一套取舍）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { NEIGHBOR_NOTICE_LIMIT, neighborNotice } from '../src/injection.ts'
import * as plugin from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  ctx.provide('webServer' as never, { register: () => () => {} } as never)
  ctx.provide('webRuntime' as never, { trustedHosts: [] } as never)
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-neighbor-'))
  const fiber = await ctx.plugin(plugin, { globalRoot })
  return { ctx, fiber, globalRoot }
}

async function tree(...segments: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-neighbor-ws-'))
  const leaf = join(root, ...segments)
  await mkdir(leaf, { recursive: true })
  return leaf
}

async function assembleFor(ctx: Context, cwd?: string) {
  return await ctx.systemPrompt.assemble(
    (cwd === undefined ? {} : { agent: { session: { header: { cwd } } } }) as never,
  )
}

const recallTextOf = (assembly: { contexts: readonly { name: string, text: string }[] }): string =>
  assembly.contexts.find(entry => entry.name === 'memory:recall')?.text ?? ''

describe('子项目索引行（④-B）', () => {
  it('纯函数：无邻居时返回空串（自消除）', () => {
    expect(neighborNotice([])).toBe('')
  })

  it('纯函数：行内含项目名、条数与检索入口', () => {
    const line = neighborNotice([{ name: 'sub-a', count: 3 }])
    expect(line).toContain('本工作区下另有 1 个子项目带记忆')
    expect(line).toContain('sub-a（3 条）')
    expect(line).toContain('memory_search')
  })

  it('纯函数：超过上限时截断，但仍报出总数', () => {
    const many = Array.from({ length: NEIGHBOR_NOTICE_LIMIT + 3 }, (_, index) => ({ name: `p${index}`, count: 1 }))
    const line = neighborNotice(many)
    expect(line).toContain(`另有 ${NEIGHBOR_NOTICE_LIMIT + 3} 个子项目`)
    expect(line).toContain('…')
    expect(line).not.toContain(`p${NEIGHBOR_NOTICE_LIMIT}`)
  })

  it('发现只报带记忆的子目录，按条数降序', async () => {
    const { ctx, fiber } = await setup()
    const parent = await tree()
    await mkdir(join(parent, 'child-a'), { recursive: true })
    await mkdir(join(parent, 'child-b'), { recursive: true })
    await mkdir(join(parent, 'empty-child'), { recursive: true })

    for (const content of ['a1', 'a2']) {
      await ctx.memory.remember(
        { content, keywords: [content], namespace: 'project' },
        join(parent, 'child-a'),
      )
    }
    await ctx.memory.remember(
      { content: 'b1', keywords: ['b1'], namespace: 'project' },
      join(parent, 'child-b'),
    )

    const found = await ctx.memory.discoverNeighbors(parent)
    expect(found.map(entry => entry.name)).toEqual(['child-a', 'child-b'])
    expect(found[0]!.count).toBe(2)
    expect(found[1]!.count).toBe(1)

    await fiber.dispose()
  })

  it('发现结果被缓存：未预热时同步读为空，预热后可同步读取', async () => {
    const { ctx, fiber } = await setup()
    const parent = await tree()
    const child = join(parent, 'sub')
    await mkdir(child, { recursive: true })
    await ctx.memory.remember({ content: 'x', keywords: ['x'], namespace: 'project' }, child)

    expect(ctx.memory.neighborsOf(parent)).toEqual([])
    await ctx.memory.discoverNeighbors(parent)
    expect(ctx.memory.neighborsOf(parent)).toEqual([{ name: 'sub', count: 1 }])

    await fiber.dispose()
  })

  it('端到端：预热后组装出的注入里出现索引行', async () => {
    const { ctx, fiber } = await setup()
    const parent = await tree()
    const child = join(parent, 'sub')
    await mkdir(child, { recursive: true })
    await ctx.memory.remember(
      { content: '子项目自己的约定', keywords: ['subkw'], namespace: 'project' },
      child,
    )
    await ctx.memory.ensureProjectOpen(parent)
    await ctx.memory.discoverNeighbors(parent)

    const text = recallTextOf(await assembleFor(ctx, parent))
    expect(text).toContain('本工作区下另有 1 个子项目带记忆')
    expect(text).toContain('sub（1 条）')

    await fiber.dispose()
  })

  it('端到端：没有子项目记忆时整行不出现', async () => {
    const { ctx, fiber } = await setup()
    const solo = await tree()
    await ctx.memory.ensureProjectOpen(solo)
    await ctx.memory.discoverNeighbors(solo)

    const text = recallTextOf(await assembleFor(ctx, solo))
    expect(text).not.toContain('子项目带记忆')

    await fiber.dispose()
  })
})
