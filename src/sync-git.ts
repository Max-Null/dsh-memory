/**
 * 同步镜像的本地 git 仓库层。
 *
 * **这一步不联网**：只做 `init` / `add` / `commit`。远端 push 是下一步，单独一层——
 * 分层的理由是可验证性：本地仓库能在完全离线的情况下验通「记忆库 → 镜像 → 有历史的
 * 仓库」整条链，网络问题留到那一层单独排查。
 *
 * `isomorphic-git` 走**动态 import**（体积理由见设计 §五）：没开同步的人不加载它。
 *
 * **无改动不产生空提交**：定时跑一次同步是常态，每次都留一个空提交会让 `git log`
 * 变成时间戳噪声，真正的变更被淹掉。
 *
 * @module dsh-memory/sync-git
 */

import { existsSync, mkdirSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'

/** {@link commitMirror} 的入参。 */
export interface MirrorCommitOptions {
  /** 镜像仓库目录。 */
  readonly dir: string
  /** 提交信息。 */
  readonly message: string
  /** 作者；isomorphic-git 没有可读的全局 git 配置，必须显式传。 */
  readonly author: { readonly name: string, readonly email: string }
}

/** 一次提交的结果。 */
export interface MirrorCommitRun {
  /** 是否真的产生了提交（无改动时为 `false`）。 */
  readonly committed: boolean
  /** 新提交的 sha；没有提交时缺省。 */
  readonly sha?: string
  /** 本次涉及的路径数（新增 + 修改 + 删除）。 */
  readonly filesChanged: number
}

/** 仓库默认分支——与 GitHub 侧的约定一致。 */
const DEFAULT_BRANCH = 'main'

/** 动态载入 isomorphic-git（体积理由见文件头）。 */
async function loadGit(): Promise<typeof import('isomorphic-git')> {
  return await import('isomorphic-git')
}

/** 确保目录是一个 git 仓库；已初始化时什么都不做。 */
async function ensureRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  if (existsSync(join(dir, '.git'))) return
  const git = await loadGit()
  await git.init({ fs: nodeFs, dir, defaultBranch: DEFAULT_BRANCH })
}

/**
 * 把镜像目录的当前状态提交成一个 commit。
 *
 * 三种路径逐个处理：新增/修改走 `add`，**删除走 `remove`**——只 `add` 的话，
 * 镜像里被删掉的记录在 git 看来会一直存在。
 *
 * @param options - 目录、提交信息与作者。
 * @returns 是否提交、sha 与涉及的路径数。
 */
export async function commitMirror(options: MirrorCommitOptions): Promise<MirrorCommitRun> {
  await ensureRepo(options.dir)
  const git = await loadGit()

  // statusMatrix 每行是 [filepath, head, workdir, stage]：
  // head=1 表示上一个 commit 里有；workdir=0 表示工作区里已经没有。
  const matrix = await git.statusMatrix({ fs: nodeFs, dir: options.dir })
  const changed = matrix.filter(([, head, workdir, stage]) => head !== workdir || workdir !== stage)
  if (changed.length === 0) {
    return { committed: false, filesChanged: 0 }
  }

  for (const [filepath, , workdir] of changed) {
    if (workdir === 0) await git.remove({ fs: nodeFs, dir: options.dir, filepath })
    else await git.add({ fs: nodeFs, dir: options.dir, filepath })
  }

  const sha = await git.commit({
    fs: nodeFs,
    dir: options.dir,
    message: options.message,
    author: options.author,
  })

  return { committed: true, sha, filesChanged: changed.length }
}

/**
 * 读仓库的提交历史（从新到旧）。测试与 `memory_sync status` 共用。
 *
 * @param dir - 镜像仓库目录。
 * @param depth - 最多取多少条；缺省不限。
 * @returns 提交列表（sha / message / 时间）。仓库尚未建立时返回空数组。
 */
export async function readHistory(
  dir: string,
  depth?: number,
): Promise<Array<{ sha: string, message: string, at: number }>> {
  if (!existsSync(join(dir, '.git'))) return []
  const git = await loadGit()
  try {
    const commits = await git.log({ fs: nodeFs, dir, ...depth === undefined ? {} : { depth } })
    return commits.map(entry => ({
      sha: entry.oid,
      message: entry.commit.message.trim(),
      at: entry.commit.author.timestamp * 1000,
    }))
  } catch {
    // 空仓库（init 之后一个 commit 都没有）会在这里抛；那是正常状态。
    return []
  }
}
