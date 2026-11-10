/**
 * 镜像的远端层。
 *
 * **这一层的真实路径无法离线测**：`isomorphic-git` 的 `push` 在没有 `http` 参数时
 * 直接抛错（2026-11-11 实测，本地 bare 仓库也走不通）。所以这里测的是离线可验的部分：
 * 前置校验与 remote 管理。真实推送必须用真仓库 + PAT，由 `memory_sync` 的端到端验收覆盖。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import git from 'isomorphic-git'
import { ensureRemote, pullMirror, pushMirror } from '../src/sync-remote.ts'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-remote-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 建一个已初始化的仓库目录。 */
async function repo(): Promise<string> {
  const dir = join(tempRoot(), 'mirror')
  await git.init({ fs: nodeFs, dir, defaultBranch: 'main' })
  return dir
}

describe('sync remote', () => {
  it('对非仓库目录 push 会明确失败，而不是抛异常', async () => {
    const run = await pushMirror({ dir: join(tempRoot(), 'nope'), url: 'https://example.com/x.git' })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('not a git repository')
  })

  it('对非仓库目录 pull 同样明确失败', async () => {
    const run = await pullMirror({ dir: join(tempRoot(), 'nope'), url: 'https://example.com/x.git' })
    expect(run.ok).toBe(false)
    expect(run.error).toContain('not a git repository')
  })

  it('ensureRemote 设置 origin', async () => {
    const dir = await repo()
    await ensureRemote(dir, 'https://github.com/Max-Null/dsh-memory-sync.git')
    const remotes = await git.listRemotes({ fs: nodeFs, dir })
    expect(remotes.find(r => r.remote === 'origin')?.url).toBe('https://github.com/Max-Null/dsh-memory-sync.git')
  })

  it('ensureRemote 幂等：同一地址重复调用不会报错', async () => {
    const dir = await repo()
    const url = 'https://github.com/a/b.git'
    await ensureRemote(dir, url)
    await ensureRemote(dir, url)
    const remotes = await git.listRemotes({ fs: nodeFs, dir })
    expect(remotes.filter(r => r.remote === 'origin')).toHaveLength(1)
  })

  it('ensureRemote 换地址时会重设（用户换了仓库）', async () => {
    const dir = await repo()
    await ensureRemote(dir, 'https://github.com/a/old.git')
    await ensureRemote(dir, 'https://github.com/a/new.git')
    const remotes = await git.listRemotes({ fs: nodeFs, dir })
    expect(remotes.find(r => r.remote === 'origin')?.url).toBe('https://github.com/a/new.git')
  })

  it('非仓库目录上调用 ensureRemote 不抛异常', async () => {
    await expect(ensureRemote(join(tempRoot(), 'nope'), 'https://x/y.git')).resolves.toBeUndefined()
  })
})
