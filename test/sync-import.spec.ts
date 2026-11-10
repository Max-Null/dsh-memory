/**
 * 导入规划层。
 *
 * 这一层是纯函数，所以可以穷举冲突场景而不碰任何真实数据——这正是把「写」拆出去的
 * 目的。四条路径各锁一条：新增、一致、远端新、本地新；外加项目落不了地的情况。
 */
import { describe, expect, it } from 'vitest'
import { planImport } from '../src/sync-import.ts'
import type { ImportedBlock, IncomingRecord, LocalLayer } from '../src/sync-import.ts'

/** 造一条最小合法记录。 */
function block(overrides: Partial<ImportedBlock> = {}): ImportedBlock {
  return {
    namespace: 'global',
    status: 'approved',
    content: '一条记忆',
    keywords: ['kw'],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  } as ImportedBlock
}

function incoming(id: string, b: ImportedBlock, projectName?: string): IncomingRecord {
  return projectName === undefined
    ? { id, scope: b.namespace, block: b }
    : { id, scope: 'project', projectName, block: { ...b, namespace: 'project' } }
}

function layer(blocks: Record<string, ImportedBlock>): LocalLayer {
  return { blocks }
}

const EMPTY = layer({})

describe('sync import planning', () => {
  it('本地没有的记录进 upserts', () => {
    const plan = planImport({
      incoming: [incoming('a', block())],
      localGlobal: EMPTY,
      localProjects: {},
    })
    expect(plan.upserts).toHaveLength(1)
    expect(plan.upserts[0]?.id).toBe('a')
    expect(plan.conflicts).toHaveLength(0)
  })

  it('内容完全一致时计入 unchanged，不产生操作', () => {
    const b = block()
    const plan = planImport({
      incoming: [incoming('a', b)],
      localGlobal: layer({ a: b }),
      localProjects: {},
    })
    expect(plan.upserts).toHaveLength(0)
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  it('内容不同且远端更新：记冲突，同时写入远端版本', () => {
    const mine = block({ content: '本地版本', updatedAt: 2000 })
    const theirs = block({ content: '远端版本', updatedAt: 3000 })
    const plan = planImport({
      incoming: [incoming('a', theirs)],
      localGlobal: layer({ a: mine }),
      localProjects: {},
    })

    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]?.newer).toBe('theirs')
    expect(plan.conflicts[0]?.mine.content).toBe('本地版本')
    expect(plan.conflicts[0]?.theirs.content).toBe('远端版本')
    // 远端更新的那份仍然写进去，否则用户永远看到旧内容
    expect(plan.upserts).toHaveLength(1)
    expect(plan.upserts[0]?.block.content).toBe('远端版本')
  })

  it('内容不同且本地更新：记冲突，但不覆盖本地', () => {
    const mine = block({ content: '本地较新', updatedAt: 5000 })
    const theirs = block({ content: '远端较旧', updatedAt: 1000 })
    const plan = planImport({
      incoming: [incoming('a', theirs)],
      localGlobal: layer({ a: mine }),
      localProjects: {},
    })

    expect(plan.conflicts[0]?.newer).toBe('mine')
    expect(plan.upserts).toHaveLength(0)
  })

  it('项目在本地不存在时进 orphaned，不丢也不报错', () => {
    const plan = planImport({
      incoming: [incoming('p1', block(), 'workstation')],
      localGlobal: EMPTY,
      localProjects: {},
    })
    expect(plan.orphaned).toEqual(['p1'])
    expect(plan.upserts).toHaveLength(0)
  })

  it('项目名大小写不敏感地匹配本地项目', () => {
    const b = block({ namespace: 'project' })
    const plan = planImport({
      incoming: [{ id: 'p1', scope: 'project', projectName: 'WorkStation', block: b }],
      localGlobal: EMPTY,
      localProjects: { workstation: layer({}) },
    })
    expect(plan.orphaned).toHaveLength(0)
    expect(plan.upserts).toHaveLength(1)
  })

  it('本地瞬态字段不参与一致性判断（hitCount 变了不算冲突）', () => {
    const mine = block({ hitCount: 0 })
    const theirs = block({ hitCount: 42, lastUsedAt: 9999 })
    const plan = planImport({
      incoming: [incoming('a', theirs)],
      localGlobal: layer({ a: mine }),
      localProjects: {},
    })
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })
})
