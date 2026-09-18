/**
 * 跨工作区可见性：工作区链（④-A 2026-09-19）。
 *
 * 背景：project 记忆按「会话 cwd」分文件存放（文件名 = `memory_project_<djb2(cwd)>.json`），
 * 而读写路径原先只认当前 cwd 那一张表——父目录会话读不到子目录的记忆，反过来也一样。
 * 实测（2026-09-19）全工作区 136 条 project 记忆散在 4 处，任一会话最多只看得见其中一部分。
 *
 * 本方案把「当前工作区的表」扩为「工作区链」：cwd 自身 + **文件已存在**的祖先层级。
 * 三条边界由用例锁住：
 * ① 祖先只收文件已存在的层级——对不存在的层级打开表会凭空创建空记忆文件；
 * ② 写入与新建仍只落当前 cwd——「我在这个项目里记的东西」不该推理到别处；
 * ③ 检索得到就要改得动——定位类操作（update / forget / setStatus / setInjected）同样走链。
 *
 * 路径一律经 `join()` 规范化：`projectBackendName` 对字符串敏感，`H:\a\b` 与 `H:/a/b`
 * 会算出**不同**的文件名（设计文档 §2.3）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
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
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-chain-root-'))
  const fiber = await ctx.plugin(plugin, { globalRoot })
  return { ctx, fiber, globalRoot }
}

/** 造一棵隔离的工作区树（祖先链上除我们放的记忆外不会有别的东西）。 */
async function tree(...segments: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-chain-'))
  const leaf = join(root, ...segments)
  await mkdir(leaf, { recursive: true })
  return leaf
}

describe('工作区链（④-A）', () => {
  it('子工作区能检索到祖先工作区的记忆，并带 `..` 来源标记', async () => {
    const { ctx, fiber } = await setup()
    const parent = await tree()
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })

    await ctx.memory.remember(
      { content: '祖先的约定：Vue3 用 script setup', keywords: ['vue'], namespace: 'project' },
      parent,
    )

    const hits = await ctx.memory.search('vue', undefined, child)
    expect(hits.length).toBe(1)
    expect(hits[0]!.record.content).toContain('祖先的约定')
    expect(hits[0]!.record.scope).toBe('..')

    await fiber.dispose()
  })

  it('多级祖先各归其位：自身无标记、父级 `..`、祖父级 `../..`', async () => {
    const { ctx, fiber } = await setup()
    const root = await tree()
    const mid = join(root, 'mid')
    const leaf = join(mid, 'leaf')
    await mkdir(leaf, { recursive: true })

    await ctx.memory.remember({ content: '根级约定 rootkw', keywords: ['rootkw'], namespace: 'project' }, root)
    await ctx.memory.remember({ content: '中间级约定 midkw', keywords: ['midkw'], namespace: 'project' }, mid)
    await ctx.memory.remember({ content: '自身约定 leafkw', keywords: ['leafkw'], namespace: 'project' }, leaf)

    const hits = await ctx.memory.search('约定', undefined, leaf)
    const scopeByContent = new Map(hits.map(hit => [hit.record.content.split(' ')[0]!, hit.record.scope]))
    expect(scopeByContent.get('自身约定')).toBeUndefined()
    expect(scopeByContent.get('中间级约定')).toBe('..')
    expect(scopeByContent.get('根级约定')).toBe('../..')

    await fiber.dispose()
  })

  it('写入只落当前工作区，不会串到祖先', async () => {
    const { ctx, fiber } = await setup()
    const parent = await tree()
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })

    await ctx.memory.remember(
      { content: '写在子工作区的约定 leafonly', keywords: ['leafonly'], namespace: 'project' },
      child,
    )

    // 从父目录检索：子目录的记忆**不该**回流上来（链是单向向上的）
    const fromParent = await ctx.memory.search('leafonly', undefined, parent)
    expect(fromParent.length).toBe(0)
    // 子目录自己当然看得到
    const fromChild = await ctx.memory.search('leafonly', undefined, child)
    expect(fromChild.length).toBe(1)

    await fiber.dispose()
  })

  it('祖先层级没有记忆文件时不会被凭空创建', async () => {
    const { ctx, fiber } = await setup()
    const root = await tree()
    const mid = join(root, 'mid')
    const leaf = join(mid, 'leaf')
    await mkdir(leaf, { recursive: true })

    await ctx.memory.search('anything', undefined, leaf)

    expect(existsSync(join(root, '.dsh', 'storages'))).toBe(false)
    expect(existsSync(join(mid, '.dsh', 'storages'))).toBe(false)

    await fiber.dispose()
  })

  it('检索得到的祖先记录就改得动：update 与 forget 都走链', async () => {
    const { ctx, fiber } = await setup()
    const parent = await tree()
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })

    const record = await ctx.memory.remember(
      { content: '待修改的祖先约定 oldkw', keywords: ['oldkw'], namespace: 'project' },
      parent,
    )

    await ctx.memory.update(record.id, { content: '已修改的祖先约定 newkw', keywords: ['newkw'] }, child)
    expect((await ctx.memory.search('newkw', undefined, child)).length).toBe(1)
    expect((await ctx.memory.search('oldkw', undefined, child)).length).toBe(0)

    expect(await ctx.memory.forget(record.id, child)).toBe(true)
    expect((await ctx.memory.search('newkw', undefined, child)).length).toBe(0)

    await fiber.dispose()
  })

  it('跨工作区命中也记账（祖先记录的 lastUsedAt 会被更新）', async () => {
    const { ctx, fiber } = await setup()
    const parent = await tree()
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })

    const record = await ctx.memory.remember(
      { content: '会被跨区命中的约定 hitkw', keywords: ['hitkw'], namespace: 'project' },
      parent,
    )
    expect(record.lastUsedAt).toBeUndefined()

    await ctx.memory.search('hitkw', undefined, child)

    const fromChild = await ctx.memory.list({ namespace: 'project' }, child)
    const found = fromChild.find(entry => String(entry.id) === String(record.id))
    expect(found?.lastUsedAt).toBeTypeOf('number')

    await fiber.dispose()
  })

  it('路径分隔符形式不影响祖先解析（正反斜杠经 join 规范化后一致）', async () => {
    const { ctx, fiber } = await setup()
    const parent = await tree()
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })

    await ctx.memory.remember(
      { content: '祖先的约定 slashkw', keywords: ['slashkw'], namespace: 'project' },
      parent,
    )

    const hits = await ctx.memory.search('slashkw', undefined, child.replace(/\\/g, '/'))
    expect(hits.length).toBe(1)
    expect(hits[0]!.record.scope).toBe('..')

    await fiber.dispose()
  })

  it('无祖先记忆时行为与既有完全一致（记录不带 scope）', async () => {
    const { ctx, fiber } = await setup()
    const solo = await tree('solo')

    await ctx.memory.remember(
      { content: '孤立工作区的约定 solokw', keywords: ['solokw'], namespace: 'project' },
      solo,
    )

    const hits = await ctx.memory.search('solokw', undefined, solo)
    expect(hits.length).toBe(1)
    expect(hits[0]!.record.scope).toBeUndefined()
    expect((await ctx.memory.list({ namespace: 'project' }, solo)).length).toBe(1)

    await fiber.dispose()
  })
})
