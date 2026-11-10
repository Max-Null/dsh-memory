/**
 * 镜像的本地 git 层。
 *
 * 这一步不联网，所以整条链（init → add → commit → 历史）都能在离线状态下验完。
 * 最要紧的一条断言是**无改动不产生空提交**：定时同步是常态，每次都留个空提交会让
 * `git log` 变成时间戳噪声，真正的变更被淹掉。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commitMirror, readHistory } from '../src/sync-git.ts'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-git-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const AUTHOR = { name: 'dsh-memory', email: 'dsh-memory@localhost' }

describe('sync git', () => {
  it('空目录：初始化仓库但不产生空提交', async () => {
    const dir = join(tempRoot(), 'mirror')
    const run = await commitMirror({ dir, message: 'sync', author: AUTHOR })

    expect(run.committed).toBe(false)
    expect(run.filesChanged).toBe(0)
    expect(await readHistory(dir)).toEqual([])
  })

  it('有文件时产生提交，sha 与历史可读', async () => {
    const dir = join(tempRoot(), 'mirror')
    mkdirSync(join(dir, 'records/global'), { recursive: true })
    writeFileSync(join(dir, 'records/global/a.json'), '{"a":1}\n', 'utf8')

    const run = await commitMirror({ dir, message: 'sync: 1 条', author: AUTHOR })

    expect(run.committed).toBe(true)
    expect(run.sha).toMatch(/^[0-9a-f]{40}$/u)
    expect(run.filesChanged).toBe(1)

    const history = await readHistory(dir)
    expect(history).toHaveLength(1)
    expect(history[0]?.message).toBe('sync: 1 条')
    expect(history[0]?.sha).toBe(run.sha)
  })

  it('内容没变时不产生第二个提交', async () => {
    const dir = join(tempRoot(), 'mirror')
    mkdirSync(join(dir, 'records/global'), { recursive: true })
    writeFileSync(join(dir, 'records/global/a.json'), '{"a":1}\n', 'utf8')
    await commitMirror({ dir, message: 'first', author: AUTHOR })

    const second = await commitMirror({ dir, message: 'should not happen', author: AUTHOR })

    expect(second.committed).toBe(false)
    expect(await readHistory(dir)).toHaveLength(1)
  })

  it('新增第二个文件会产生一次新提交', async () => {
    const dir = join(tempRoot(), 'mirror')
    mkdirSync(join(dir, 'records/global'), { recursive: true })
    writeFileSync(join(dir, 'records/global/a.json'), '{"a":1}\n', 'utf8')
    await commitMirror({ dir, message: 'first', author: AUTHOR })

    writeFileSync(join(dir, 'records/global/b.json'), '{"b":1}\n', 'utf8')
    const second = await commitMirror({ dir, message: 'second', author: AUTHOR })

    expect(second.committed).toBe(true)
    expect(second.filesChanged).toBe(1)
    expect(await readHistory(dir)).toHaveLength(2)
  })

  it('删掉一个文件也会被提交（不是只在 add 上做文章）', async () => {
    const dir = join(tempRoot(), 'mirror')
    mkdirSync(join(dir, 'records/global'), { recursive: true })
    writeFileSync(join(dir, 'records/global/a.json'), '{"a":1}\n', 'utf8')
    writeFileSync(join(dir, 'records/global/b.json'), '{"b":1}\n', 'utf8')
    await commitMirror({ dir, message: 'first', author: AUTHOR })

    rmSync(join(dir, 'records/global/b.json'))
    const second = await commitMirror({ dir, message: '删除 b', author: AUTHOR })

    expect(second.committed).toBe(true)
    const history = await readHistory(dir)
    expect(history[0]?.message).toBe('删除 b')
  })

  it('深度参数限制返回的提交条数', async () => {
    const dir = join(tempRoot(), 'mirror')
    mkdirSync(join(dir, 'records/global'), { recursive: true })
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(join(dir, `records/global/${name}.json`), `{"n":"${name}"}\n`, 'utf8')
      await commitMirror({ dir, message: `add ${name}`, author: AUTHOR })
    }
    expect(await readHistory(dir)).toHaveLength(3)
    expect(await readHistory(dir, 2)).toHaveLength(2)
  })
})
