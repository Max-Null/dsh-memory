/**
 * 同步写盘层。
 *
 * 锁的是两条硬要求（设计 §9.2 第 1 步）：增量写（内容没变不重写）、删除先算差集。
 * 增量这条要用 **mtime 不变**来验，不能只验"返回 written=0"——实现完全可以报告 0
 * 却仍然重写文件，那 git 照样会脏。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeMirror } from '../src/sync-writer.ts'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-writer-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一条待写文件（路径用 `join` 产出，模拟 exportRecords 的形状）。 */
function record(id: string, content = '{\n  "a": 1\n}\n') {
  return { path: join('records', 'global', `${id}.json`), content }
}

describe('sync writer', () => {
  it('首次写盘把记录落到 records/ 下，目录自动创建', () => {
    const dir = join(tempRoot(), 'mirror')
    const run = writeMirror({ targetDir: dir, files: [record('a'), record('b')] })

    expect(run).toMatchObject({ written: 2, unchanged: 0, removed: 0 })
    expect(readFileSync(join(dir, 'records/global/a.json'), 'utf8')).toBe('{\n  "a": 1\n}\n')
    expect(readFileSync(join(dir, 'records/global/b.json'), 'utf8')).toBe('{\n  "a": 1\n}\n')
  })

  it('内容没变时一个文件都不重写（mtime 不变，不是只看返回值）', async () => {
    const dir = join(tempRoot(), 'mirror')
    const files = [record('a'), record('b')]
    writeMirror({ targetDir: dir, files })

    const target = join(dir, 'records/global/a.json')
    const mtimeBefore = statSync(target).mtimeMs
    // mtime 精度有限，隔一瞬再写，避免"同毫秒"掩盖真实重写
    await new Promise(resolve => setTimeout(resolve, 20))

    const run = writeMirror({ targetDir: dir, files })

    expect(run).toMatchObject({ written: 0, unchanged: 2, removed: 0 })
    expect(statSync(target).mtimeMs).toBe(mtimeBefore)
  })

  it('内容变了就重写那一个，其余不动', () => {
    const dir = join(tempRoot(), 'mirror')
    writeMirror({ targetDir: dir, files: [record('a', '{"v":1}\n'), record('b', '{"v":1}\n')] })

    const run = writeMirror({ targetDir: dir, files: [record('a', '{"v":2}\n'), record('b', '{"v":1}\n')] })

    expect(run).toMatchObject({ written: 1, unchanged: 1, removed: 0 })
    expect(readFileSync(join(dir, 'records/global/a.json'), 'utf8')).toBe('{"v":2}\n')
  })

  it('磁盘上多出来的记录被删掉（删除先算差集）', () => {
    const dir = join(tempRoot(), 'mirror')
    writeMirror({ targetDir: dir, files: [record('a'), record('b'), record('c')] })

    const run = writeMirror({ targetDir: dir, files: [record('a'), record('c')] })

    expect(run.removed).toBe(1)
    expect(run.removedPaths).toEqual(['records/global/b.json'])
    expect(existsSync(join(dir, 'records/global/b.json'))).toBe(false)
    expect(existsSync(join(dir, 'records/global/a.json'))).toBe(true)
  })

  it('不碰 conflicts/ 与 index.json —— 它们不归写盘层管', () => {
    const dir = join(tempRoot(), 'mirror')
    mkdirSync(join(dir, 'conflicts'), { recursive: true })
    writeFileSync(join(dir, 'conflicts/some-uuid.本机.json'), '{"left":1}\n', 'utf8')
    writeFileSync(join(dir, 'index.json'), '{"generated":true}\n', 'utf8')

    writeMirror({ targetDir: dir, files: [record('a')] })
    // 第二次写盘时才可能触发删除——用少一条的集合再跑一次
    writeMirror({ targetDir: dir, files: [] })

    expect(existsSync(join(dir, 'conflicts/some-uuid.本机.json'))).toBe(true)
    expect(existsSync(join(dir, 'index.json'))).toBe(true)
  })

  it('空集合 + 空目录时什么都不做', () => {
    const dir = join(tempRoot(), 'mirror')
    const run = writeMirror({ targetDir: dir, files: [] })
    expect(run).toMatchObject({ written: 0, unchanged: 0, removed: 0 })
    expect(existsSync(join(dir, 'records'))).toBe(false)
  })

  it('项目分目录也按同样规则写', () => {
    const dir = join(tempRoot(), 'mirror')
    const files = [
      { path: join('records', 'project', 'workstation', 'p1.json'), content: '{"p":1}\n' },
      { path: join('records', 'global', 'g1.json'), content: '{"g":1}\n' },
    ]
    const run = writeMirror({ targetDir: dir, files })

    expect(run).toMatchObject({ written: 2, unchanged: 0 })
    expect(readFileSync(join(dir, 'records/project/workstation/p1.json'), 'utf8')).toBe('{"p":1}\n')
  })
})
