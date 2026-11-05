/**
 * 同步导出层。
 *
 * 两条最容易错的判据锁在这里：
 * ① 本地瞬态字段不能进镜像 —— 否则每次检索都让远端仓库变脏；
 * ② 工作区目录名必须与引擎写记忆文件名时同口径 —— 否则镜像落在另一个目录名下，
 *    另一端拉下来看起来像「这个项目的记忆凭空少了一批」。
 */
import { describe, expect, it } from 'vitest'
import { exportRecords, workspaceSlug } from '../src/sync-export.ts'

/** 造一份 unit 形状的文档。 */
function doc(blocks: Record<string, unknown>): unknown {
  return { unit: { name: 'memory', version: 1 }, global: null, tables: { blocks } }
}

/** 一条最小合法记录。 */
function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: 'global',
    status: 'approved',
    content: '一条记忆',
    keywords: ['kw'],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('sync export', () => {
  it('剥掉本地瞬态字段：hitCount / lastUsedAt / vector 不进镜像', () => {
    const run = exportRecords({
      globalDocument: doc({
        a: block({ hitCount: 7, lastUsedAt: 999, vector: [0.1, 0.2], content: '正文' }),
      }),
    })

    expect(run.files).toHaveLength(1)
    const payload = JSON.parse(run.files[0]!.content)
    expect(payload.content).toBe('正文')
    expect(payload).not.toHaveProperty('hitCount')
    expect(payload).not.toHaveProperty('lastUsedAt')
    expect(payload).not.toHaveProperty('vector')
  })

  it('保留跨端有意义的字段：injected / topic / anchor / stale 这些要跟着走', () => {
    const run = exportRecords({
      globalDocument: doc({
        a: block({
          injected: true,
          injectedAuto: false,
          topic: '约定',
          kind: 'fact',
          stale: true,
          staleReason: '被取代',
          anchor: { kind: 'path-exists', name: 'H:/x', value: 'present' },
          source: 'agent',
        }),
      }),
    })

    const payload = JSON.parse(run.files[0]!.content)
    expect(payload.injected).toBe(true)
    expect(payload.injectedAuto).toBe(false)
    expect(payload.topic).toBe('约定')
    expect(payload.stale).toBe(true)
    expect(payload.staleReason).toBe('被取代')
    expect(payload.anchor).toEqual({ kind: 'path-exists', name: 'H:/x', value: 'present' })
  })

  it('隔离记录整条不导出——隔离区的存在理由就是它可能含凭据类内容', () => {
    const run = exportRecords({
      globalDocument: doc({
        正常: block({ content: '可以同步' }),
        隔离: block({ content: '疑似密钥', quarantined: true, quarantineReason: '命中凭据规则' }),
      }),
    })

    expect(run.files).toHaveLength(1)
    expect(run.files[0]!.content).toContain('可以同步')
    expect(run.skippedQuarantined).toBe(1)
  })

  it('global 落 records/global/，工作区落 records/project/<slug>/', () => {
    const run = exportRecords({
      globalDocument: doc({ g1: block() }),
      projectDocuments: [{ cwd: 'H:\\proj\\demo', document: doc({ p1: block({ namespace: 'project' }) }) }],
    })

    const paths = run.files.map(f => f.path.replace(/\\/gu, '/')).sort()
    expect(paths).toEqual([
      `records/global/g1.json`,
      `records/project/${workspaceSlug('H:\\proj\\demo')}/p1.json`,
    ])
  })

  it('工作区目录名与引擎实际写出的文件名同口径（本机三处真实路径）', () => {
    // 这些值取自磁盘上真实存在的 `memory_project_<slug>.json`；算法是纯字符串运算，
    // 换机器也成立。两边分叉的后果见文件头 ②。
    expect(workspaceSlug('H:\\MaxNull\\WorkStation')).toBe('3rf76j')
    expect(workspaceSlug('H:\\MaxNull\\WorkStation\\deepseek-harness')).toBe('34he9k')
    expect(workspaceSlug('H:\\MaxNull\\WorkStation\\seek-soul-in-darkness')).toBe('ubctph')
  })

  it('大小写不同的同一路径得到同一个 slug（Windows 路径不区分大小写）', () => {
    expect(workspaceSlug('H:\\MaxNull\\WorkStation')).toBe(workspaceSlug('h:\\maxnull\\workstation'))
  })

  it('文档形状不符时返回空结果而不是抛错——一个坏库不该卡死整个同步', () => {
    expect(exportRecords({ globalDocument: null }).files).toEqual([])
    expect(exportRecords({ globalDocument: { tables: {} } }).files).toEqual([])
    expect(exportRecords({ globalDocument: { tables: { blocks: [] } } }).files).toEqual([])
  })

  it('每个文件以换行结尾，且是合法 JSON', () => {
    const run = exportRecords({ globalDocument: doc({ a: block() }) })
    const content = run.files[0]!.content
    expect(content.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(content)).not.toThrow()
  })
})
