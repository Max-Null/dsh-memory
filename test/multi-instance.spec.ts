/**
 * 多实例写入协调（2026-09-17）。
 *
 * 两个 DSH 实例（web 与 SiSD 桌面壳）共用同一个 DSH_HOME 时，storage 层的写入是
 * 「读—改—写全量覆盖」，且官方两个后端都声明不做跨进程协调——后写者会抹掉先写者
 * 的记忆。写入路径因此加了刷新门：开写前比对存储文件指纹，变过就重载（等价于
 * 「update 前先 select」）。
 *
 * 这些用例直接改写存储文件来模拟另一个实例的写入：它的写入只落在磁盘上，不经过
 * 被测引擎的内存态——这正是真实冲突的形状。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-multi-'))
  const fiber = await ctx.plugin(plugin, { globalRoot })
  return { ctx, fiber, globalRoot, file: join(globalRoot, 'memory.json') }
}

/** 读存储文档、交给 mutator 改、写回——扮演「另一个实例的写入」。 */
function writeAsExternal(file: string, mutate: (doc: any) => void): void {
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  mutate(doc)
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
}

function externalBlock(content: string, namespace: 'global' | 'project' = 'global') {
  const now = Date.now()
  return {
    namespace,
    status: 'approved',
    injected: false,
    content,
    keywords: ['external'],
    createdAt: now,
    updatedAt: now,
    hitCount: 0,
  }
}

async function contents(ctx: Context): Promise<string[]> {
  return (await ctx.memory.list()).map(record => record.content)
}

describe('多实例写入协调', () => {
  it('外部实例新增的记忆，不会被本地随后的写入覆盖', async () => {
    const { ctx, file } = await setup()
    await ctx.memory.remember({ content: '本地一', keywords: ['local1'] })

    writeAsExternal(file, doc => { doc.tables.blocks['external-1'] = externalBlock('外部一条') })

    await ctx.memory.remember({ content: '本地二', keywords: ['local2'] })

    const all = await contents(ctx)
    expect(all).toContain('外部一条')
    expect(all).toContain('本地一')
    expect(all).toContain('本地二')
  })

  it('外部实例删除的记忆，不会被本地写入复活', async () => {
    const { ctx, file } = await setup()
    const doomed = await ctx.memory.remember({ content: '将被外部删除', keywords: ['doomed'] })

    writeAsExternal(file, doc => { delete doc.tables.blocks[String(doomed.id)] })

    await ctx.memory.remember({ content: '本地新写', keywords: ['fresh'] })

    const ids = (await ctx.memory.list()).map(record => String(record.id))
    expect(ids).not.toContain(String(doomed.id))
  })

  it('本地 update 前先 select：外部新增的记忆在更新另一条时仍然保留', async () => {
    const { ctx, file } = await setup()
    const target = await ctx.memory.remember({ content: '原始内容', keywords: ['target'] })

    writeAsExternal(file, doc => { doc.tables.blocks['external-2'] = externalBlock('更新期间外部写入') })

    await ctx.memory.update(target.id, { content: '改过的内容' })

    const all = await contents(ctx)
    expect(all).toContain('更新期间外部写入')
    expect(all).toContain('改过的内容')
    expect(all).not.toContain('原始内容')
  })

  it('外部实例改走一条记忆后，本地的整份写入不会把它带回来', async () => {
    const { ctx, file } = await setup()
    await ctx.memory.remember({ content: '甲', keywords: ['a'] })

    writeAsExternal(file, doc => {
      const blocks = doc.tables.blocks
      const key = Object.keys(blocks)[0] as string
      blocks[key] = { ...blocks[key], content: '被外部改写' }
    })

    await ctx.memory.remember({ content: '乙', keywords: ['b'] })

    const all = await contents(ctx)
    expect(all).toContain('被外部改写')
    expect(all).not.toContain('甲')
  })

  // 刷新门会 `reload()`，而 reload 关闭并清空**全部**已开的工作区表。写入体若在图省事
  // 读同步缓存（`projectTables.get`）而不是重新取表，重载之后它会读到 `undefined`，
  // 于是工作区侧的写入被静默跳过——命中记账首先是受害者（只在内存态里记账，不报错）。
  it('外部改动触发重载后，工作区记忆的命中记账不丢', async () => {
    const { ctx, file } = await setup()
    const projectCwd = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
    // 先写一条 global 记忆：外部实例的改动落在 global 存储上，它得先存在
    await ctx.memory.remember({ content: '全局里另一条', keywords: ['全局'] })
    await ctx.memory.remember(
      { content: '工作区里的一条', keywords: ['工作区命中'], namespace: 'project' },
      projectCwd,
    )

    // 外部实例改 global 存储：下一次写入的刷新门因此重载，工作区表的缓存随之清空
    writeAsExternal(file, doc => { doc.tables.blocks['external-3'] = externalBlock('外部一条') })

    await ctx.memory.search('工作区命中', undefined, projectCwd)

    const records = await ctx.memory.list({ kind: 'fact' }, projectCwd)
    const hit = records.find(record => record.content === '工作区里的一条')
    expect(hit?.namespace).toBe('project')
    expect(hit?.hitCount).toBe(1)
  })

  // 刷新门每次发现外部写入都会 `reload()`，而用户能感知到的第一个后果不是数据、
  // 是**上下文**：注入 provider 是同步回调，只读已打开的表——表被关掉就等于这个
  // 工作区没有常驻记忆。reload 的语义是「重读磁盘」，不是「把次要的表丢掉」。
  it('重载后工作区常驻记忆仍在注入集合里', async () => {
    const { ctx } = await setup()
    const projectCwd = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
    const record = await ctx.memory.remember(
      { content: '工作区常驻记忆', keywords: ['工作区常驻'], namespace: 'project' },
      projectCwd,
    )
    await ctx.memory.setInjected(record.id, true, projectCwd)
    expect(ctx.memory.recallRecords(projectCwd).map(hit => hit.content)).toContain('工作区常驻记忆')

    await ctx.memory.reload()

    expect(ctx.memory.recallRecords(projectCwd).map(hit => hit.content)).toContain('工作区常驻记忆')
  })

  // ④-A 把**读**路径扩到了祖先链，而写路径的门当时没跟着扩：`refreshForWrite` 只列
  // global + 当前 cwd，祖先层的文件却被 `noteStoreStamps` 记进指纹表——**记了却不检查**。
  // 于是被这个会话打开过的祖先层一旦遭外部改动，改写它的那次写入（命中记账、以及
  // update/forget 这类定位到祖先记录的操作）会把旧内存态整份覆盖上去，外部改动无声消失。
  // 2026-09-19 用受控探针在真实会话里撞到过这个形状（新探针被抹掉、旧记录连同 hitCount 复活）。
  it('祖先层被外部改动后，跨链命中记账不会把它覆盖回去', async () => {
    const { ctx } = await setup()
    const parentCwd = await mkdtemp(join(tmpdir(), 'dsh-memory-anc-'))
    const childCwd = join(parentCwd, 'child')
    await mkdir(childCwd, { recursive: true })

    // 祖先层先有一条记忆：它的存储文件存在，child 的链才会把它纳入
    await ctx.memory.remember(
      { content: '祖先层里的一条', keywords: ['祖先层检索'], namespace: 'project' },
      parentCwd,
    )

    // child 会话检索一次——祖先层的表由此进入缓存，这正是覆盖得以发生的前提
    const first = await ctx.memory.search('祖先层检索', undefined, childCwd)
    expect(first.length).toBe(1)

    // 另一个实例改祖先层的存储文件：只落磁盘，不经过本引擎的内存态
    const storeDir = join(parentCwd, '.dsh', 'storages')
    const parentFile = join(storeDir, readdirSync(storeDir)[0] as string)
    writeAsExternal(parentFile, doc => {
      doc.tables.blocks['external-anc'] = externalBlock('祖先层外部新增', 'project')
    })

    // 再检索一次：命中记账写回祖先层的表——这一写必须先把外部改动读进来
    await ctx.memory.search('祖先层检索', undefined, childCwd)

    const blocks = JSON.parse(readFileSync(parentFile, 'utf8')).tables.blocks
    expect(Object.keys(blocks)).toContain('external-anc')
    expect(blocks['external-anc'].content).toBe('祖先层外部新增')
  })
})
