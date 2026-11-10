/**
 * 同步镜像的远端层：`push` / `pull` / 状态查询。
 *
 * **必须走 HTTP**：`isomorphic-git` 的 `push` 在没有 `http` 参数时直接抛
 * `The function requires a "http" parameter but none was provided`（2026-11-11 实测，
 * 想用本地 bare 仓库做离线测试也走不通）。所以本层天然依赖网络，与上一层的
 * `sync-git.ts`（纯本地、可离线全测）分开。
 *
 * **认证用 PAT（https）而不是 SSH**：SSH key 在移动端的管理成本远高于 token，
 * 而 dsh-go 那类环境正是目标场景之一。
 *
 * **token 不进 profile 配置**：由调用方从既有 credentials 机制取出后传入。本模块只
 * 负责把它放进 http 请求，不负责存。
 *
 * @module dsh-memory/sync-remote
 */

import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 远端操作共用的参数。 */
export interface RemoteOptions {
  /** 镜像仓库目录。 */
  readonly dir: string
  /** 远端地址（https）。 */
  readonly url: string
  /** 分支名；缺省 `main`。 */
  readonly branch?: string
  /** GitHub PAT；缺省时只尝试匿名（私有仓库会失败）。 */
  readonly token?: string
}

/** 一次远端操作的结果。 */
export interface RemoteRun {
  readonly ok: boolean
  /** 失败原因；成功时缺省。 */
  readonly error?: string
  /**
   * 失败分类——排查时最要紧的一件事：「认证错」和「连不上」的正确应对完全不同，
   * 而它们的原始报错常常长得差不多。
   */
  readonly kind?: 'auth' | 'network' | 'unknown'
}

/** 默认分支。 */
const DEFAULT_BRANCH = 'main'

/** 动态载入 isomorphic-git 与它的 Node http 实现。 */
async function loadGit() {
  const [git, http] = await Promise.all([
    import('isomorphic-git'),
    import('isomorphic-git/http/node'),
  ])
  return { git: git.default, http: http.default }
}

/** 把原始错误归到三类之一，便于调用方决定是改凭据还是重试。 */
function classify(error: unknown): RemoteRun {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.toLowerCase()
  // 401/403、authentication failed、invalid credentials、权限不足
  if (/401|403|auth|credential|permission|denied|token/u.test(text)) {
    return { ok: false, error: raw, kind: 'auth' }
  }
  if (/enotfound|econnrefused|etimedout|timeout|network|dns|socket|offline/u.test(text)) {
    return { ok: false, error: raw, kind: 'network' }
  }
  return { ok: false, error: raw, kind: 'unknown' }
}

/** 组装 isomorphic-git 的 onAuth 回调。 */
function authFor(token: string | undefined) {
  return (): { username: string, password?: string } => (
    token === undefined || token === ''
      ? { username: 'git' }
      : { username: 'x-access-token', password: token }
  )
}

/** 镜像目录是不是一个已初始化的仓库。 */
function isRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/**
 * 确保镜像目录是一个**与远端有共同历史**的仓库。
 *
 * 首次同步时如果只 `git init`，本地与远端是两条无关的历史线——push 会被拒
 * （`Push rejected because it was not a simple fast-forward`）。这是 2026-11-11
 * 第一次用真实仓库跑时撞出来的：单元测试里没有真远端，所以永远发现不了。
 *
 * 因此首次必须 clone，而不是 init + push。
 *
 * @param options - 目录、远端地址、分支与 token。
 * @returns 是否执行了 clone；失败时带分类。
 */
export async function ensureMirrorRepo(options: RemoteOptions): Promise<MirrorRepoRun> {
  if (isRepo(options.dir)) return { cloned: false }
  const { git, http } = await loadGit()
  try {
    await git.clone({
      fs: nodeFs,
      http,
      dir: options.dir,
      url: options.url,
      ref: options.branch ?? DEFAULT_BRANCH,
      depth: 1,
      onAuth: authFor(options.token),
    })
    return { cloned: true }
  } catch (error: unknown) {
    return { cloned: false, ...classify(error) }
  }
}

/** {@link ensureMirrorRepo} 的结果。 */
export interface MirrorRepoRun {
  readonly cloned: boolean
  readonly error?: string
  readonly kind?: 'auth' | 'network' | 'unknown'
}

/**
 * 把本地提交推到远端。
 *
 * @param options - 目录、远端地址、分支与 token。
 * @returns 成功与否；失败时带分类。
 */
export async function pushMirror(options: RemoteOptions): Promise<RemoteRun> {
  if (!isRepo(options.dir)) {
    return { ok: false, error: `not a git repository: ${options.dir}`, kind: 'unknown' }
  }
  const { git, http } = await loadGit()
  try {
    await git.push({
      fs: nodeFs,
      http,
      dir: options.dir,
      remote: 'origin',
      ref: options.branch ?? DEFAULT_BRANCH,
      onAuth: authFor(options.token),
    })
    return { ok: true }
  } catch (error: unknown) {
    return classify(error)
  }
}

/**
 * 从远端拉取并快进本地。
 *
 * `fastForwardOnly: true`：合并策略不该由这一层决定。本地有分叉时宁可失败让人看见，
 * 也不要让 isomorphic-git 悄悄造出一个 merge commit。
 *
 * @param options - 目录、远端地址、分支与 token。
 * @returns 成功与否；失败时带分类。
 */
export async function pullMirror(options: RemoteOptions): Promise<RemoteRun> {
  if (!isRepo(options.dir)) {
    return { ok: false, error: `not a git repository: ${options.dir}`, kind: 'unknown' }
  }
  const { git, http } = await loadGit()
  try {
    await git.pull({
      fs: nodeFs,
      http,
      dir: options.dir,
      remote: 'origin',
      ref: options.branch ?? DEFAULT_BRANCH,
      fastForwardOnly: true,
      author: { name: 'dsh-memory', email: 'dsh-memory@localhost' },
      onAuth: authFor(options.token),
    })
    return { ok: true }
  } catch (error: unknown) {
    return classify(error)
  }
}

/**
 * 确保 `origin` 指向给定地址。地址变化时重设（用户换了仓库）。
 *
 * @param dir - 镜像仓库目录。
 * @param url - 期望的远端地址。
 */
export async function ensureRemote(dir: string, url: string): Promise<void> {
  if (!isRepo(dir)) return
  const { git } = await loadGit()
  const remotes = await git.listRemotes({ fs: nodeFs, dir })
  const origin = remotes.find(remote => remote.remote === 'origin')
  if (origin?.url === url) return
  await git.addRemote({ fs: nodeFs, dir, remote: 'origin', url, force: true })
}
