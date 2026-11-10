/**
 * 墓碑规划。
 *
 * 最要紧的一条是**首次同步不产生墓碑**：没有「曾经有过」这个信息时，把所有
 * 「远端有本地没有」判成删除，会把另一端刚记的东西全删掉。这条用独立用例锁住。
 */
import { describe, expect, it } from 'vitest'
import { dropTombstoned, planTombstones } from '../src/sync-tombstone.ts'
import type { SyncState } from '../src/sync-tombstone.ts'

function state(global: string[], project: Record<string, string[]> = {}): SyncState {
  return { global, project }
}

describe('sync tombstones', () => {
  it('首次同步（无上次状态）永远不产生墓碑', () => {
    const plan = planTombstones({
      previous: undefined,
      current: state(['a', 'b']),
      at: 1234,
    })
    expect(plan).toEqual([])
  })

  it('曾同步过、现在没了 → 产生墓碑', () => {
    const plan = planTombstones({
      previous: state(['a', 'b']),
      current: state(['a']),
      at: 1234,
    })
    expect(plan).toEqual([{ id: 'b', scope: 'global', deletedAt: 1234 }])
  })

  it('项目层同样处理，且带项目名', () => {
    const plan = planTombstones({
      previous: state([], { workstation: ['p1', 'p2'] }),
      current: state([], { workstation: ['p1'] }),
      at: 99,
    })
    expect(plan).toEqual([{ id: 'p2', scope: 'project', projectName: 'workstation', deletedAt: 99 }])
  })

  it('新增的记录不会被误判成删除', () => {
    const plan = planTombstones({
      previous: state(['a']),
      current: state(['a', 'b', 'c']),
      at: 1,
    })
    expect(plan).toEqual([])
  })

  it('整个项目消失时它的记录全部进墓碑', () => {
    const plan = planTombstones({
      previous: state([], { gone: ['x', 'y'] }),
      current: state([], {}),
      at: 7,
    })
    expect(plan).toHaveLength(2)
    expect(plan.every(t => t.projectName === 'gone')).toBe(true)
  })

  it('写过的墓碑从状态里剔除，下一轮不会被重复判成删除', () => {
    const previous = state(['a', 'b'], { workstation: ['p1', 'p2'] })
    const current = state(['a'], { workstation: ['p1'] })
    const written = planTombstones({ previous, current, at: 5 })
    expect(written).toHaveLength(2)

    const next = dropTombstoned(previous, written)
    expect(next.global).toEqual(['a'])
    expect(next.project.workstation).toEqual(['p1'])

    // 用更新后的状态再算一次：不该再产生墓碑
    expect(planTombstones({ previous: next, current, at: 6 })).toEqual([])
  })

  it('没有墓碑时状态原样返回', () => {
    const previous = state(['a'])
    expect(dropTombstoned(previous, [])).toBe(previous)
  })
})
