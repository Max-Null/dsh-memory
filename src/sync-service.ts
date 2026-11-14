/**
 * 同步编排：把导出 / 写盘 / 墓碑 / git / 远端五层串成一次操作。
 *
 * 这一层没有自己的算法，只有**顺序**。顺序在这里是有意义的：
 *
 * push 时先写镜像与墓碑、再提交、最后推送——反过来的话，一次失败会留下
 * 「远端已有、本地没有」的状态，下次 push 会把差异当成删除。
 *
 * pull 时先拉、再规划导入、最后逐条落地——导入是唯一会改本地记忆库的一步，
 * 放在最后意味着前面任何一步失败都不会动数据。
 *
 * @module dsh-memory/sync-service
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEngine, MemoryId, MemoryRecord } from './engine.ts'
import { exportRecords } from './sync-export.ts'
import type { SyncRecordFile } from './sync-export.ts'
import { commitMirror, readHistory } from './sync-git.ts'
import { planImport } from './sync-import.ts'
import type { ImportConflict, ImportedBlock, IncomingRecord } from './sync-import.ts'
import { TOMBSTONE_DIR, dropTombstoned, planTombstones, stateFileName } from './sync-tombstone.ts'
import type { SyncState, Tombstone } from './sync-tombstone.ts'
import { ensureMirrorRepo, ensureRemote, probeRemote, pullMirror, pushMirror } from './sync-remote.ts'
import type { RemoteProbe } from './sync-remote.ts'
import { writeMirror } from './sync-writer.ts'

/** 同步配置。 */
export interface SyncConfig {
  /** 镜像仓库目录。 */
  readonly mirrorDir: string
  /** 远端地址（https）；缺省时只做本地提交。 */
  readonly remote?: string
  /** 分支名；缺省 `main`。 */
  readonly branch?: string
  /** 环境短名，用于冲突留证与提交信息；缺省「本机」。 */
  readonly envName?: string
  /**
   * HTTPS token。**不从配置里读**——由调用方从环境变量或凭据机制取出后传入，
   * 避免它落进 profile 配置或提交历史。
   */
  readonly token?: string
  /**
   * 代理地址（形如 `http://127.0.0.1:7897`）。缺省时直连。
   *
   * 2026-11-13 加：node 的 HTTP 不读 `HTTPS_PROXY`，在必须走代理才能访问 GitHub 的
   * 网络里，push / pull 会一路超时（用户机器实测：系统 git 通、插件超时）。
   */
  readonly proxy?: string
}

/** 一次 push 的结果。 */
export interface SyncPushRun {
  readonly files: number
  readonly written: number
  readonly unchanged: number
  readonly removed: number
  readonly tombstones: number
  readonly committed: boolean
  readonly sha?: string
  readonly pushed: boolean
  readonly error?: string
  readonly errorKind?: 'auth' | 'network' | 'unknown'
}

/** 一次 pull 的结果。 */
export interface SyncPullRun {
  readonly pulled: boolean
  readonly imported: number
  readonly conflicts: number
  readonly orphaned: number
  /** 本次按墓碑删掉的本地记忆条数（2026-11-14）。 */
  readonly deleted?: number
  readonly error?: string
  readonly errorKind?: 'auth' | 'network' | 'unknown'
}

/** 同步状态快照（给 `memory_sync status`）。 */
export interface SyncStatus {
  readonly mirrorDir: string
  readonly initialized: boolean
  readonly remote?: string
  readonly lastCommit?: { sha: string, message: string, at: number }
  readonly commits: number
  readonly conflicts: number
  readonly tombstones: number
}

/** 作者信息——isomorphic-git 没有可读的全局配置，必须显式给。 */
const AUTHOR = { name: 'dsh-memory', email: 'dsh-memory@localhost' }

/** 把一份 unit 文档里的 block 取出来。 */
function blocksOfDocument(document: unknown): Record<string, Record<string, unknown>> {
  const doc = document as { tables?: { blocks?: Record<string, Record<string, unknown>> } } | null
  return doc?.tables?.blocks ?? {}
}

/** 记录数组 → unit 文档形状（`exportRecords` 的入参）。 */
function recordsToDocument(records: readonly MemoryRecord[]): unknown {
  const blocks: Record<string, Record<string, unknown>> = {}
  for (const record of records) {
    const { id, ...rest } = record
    blocks[id] = rest as Record<string, unknown>
  }
  return { tables: { blocks } }
}

/**
 * 收集当前记忆库应有的镜像文件。
 *
 * 空项目不产生目录——`records/project/<name>/` 里一个文件都没有时，那个目录本身
 * 不该出现在仓库里（否则每加一个空项目就多一个空目录）。
 *
 * @param memory - 引擎实例。
 * @returns 待写入的记录文件列表。
 */
export async function collectMirror(memory: MemoryEngine): Promise<readonly SyncRecordFile[]> {
  const global = await memory.list({ namespace: 'global' })
  const projectDocuments: Array<{ cwd: string, document: unknown }> = []
  for (const cwd of memory.projectCwds()) {
    const records = await memory.list({ namespace: 'project' }, cwd)
    if (records.length === 0) continue
    projectDocuments.push({ cwd, document: recordsToDocument(records) })
  }
  return exportRecords({ globalDocument: recordsToDocument(global), projectDocuments }).files
}

/** 从镜像文件列表推出「当前有哪些 id」——墓碑比对的当前态。 */
function stateOfFiles(files: readonly SyncRecordFile[]): SyncState {
  const global: string[] = []
  const project: Record<string, string[]> = {}
  for (const file of files) {
    const parts = file.path.replace(/\\/gu, '/').split('/')
    // records/global/<id>.json 或 records/project/<name>/<id>.json
    if (parts[0] !== 'records' || parts.length < 3) continue
    const id = parts[parts.length - 1]?.replace(/\.json$/u, '') ?? ''
    if (id === '') continue
    if (parts[1] === 'global') global.push(id)
    else if (parts[1] === 'project' && parts.length >= 4) {
      const name = parts[2] ?? ''
      ;(project[name] ??= []).push(id)
    }
  }
  return { global, project }
}

/**
 * 读**本端**上一次同步留下的状态；没有时返回 `undefined`（视为首次）。
 *
 * 2026-11-14：按 `envName` 分片。旧单份文件不读——它记的是别端全集，当基线会误判删除。
 */
function readState(dir: string, envName?: string): SyncState | undefined {
  const file = join(dir, stateFileName(envName))
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SyncState>
    return {
      global: Array.isArray(parsed.global) ? parsed.global : [],
      project: typeof parsed.project === 'object' && parsed.project !== null ? parsed.project : {},
    }
  } catch {
    // 坏了就当没有：宁可这轮不产生墓碑，也不要基于坏数据删东西。
    return undefined
  }
}

/** 写本端的分片状态。 */
function writeState(dir: string, state: SyncState, envName?: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, stateFileName(envName)), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** 把墓碑落成文件（`tombstones/<id>.json`）。 */
function writeTombstones(dir: string, tombstones: readonly Tombstone[]): void {
  if (tombstones.length === 0) return
  const target = join(dir, TOMBSTONE_DIR)
  mkdirSync(target, { recursive: true })
  for (const tombstone of tombstones) {
    writeFileSync(join(target, `${tombstone.id}.json`), `${JSON.stringify(tombstone, null, 2)}\n`, 'utf8')
  }
}

/**
 * 推一次：收集 → 写镜像 → 写墓碑 → 提交 → 推送。
 *
 * @param memory - 引擎实例。
 * @param config - 同步配置。
 * @param now - 时间注入点（测试用）。
 * @returns 各阶段统计；远端失败时保留本地提交已完成的事实。
 */
export async function syncPush(
  memory: MemoryEngine,
  config: SyncConfig,
  now: number = Date.now(),
): Promise<SyncPushRun> {
  // 首次同步**必须先 clone**：本地 `git init` 出来的仓库与远端是两条无关的历史线，
  // push 会被拒（`not a simple fast-forward`）。这一步得在写镜像之前，否则写好的内容
  // 会被随后的 clone 覆盖掉。
  if (config.remote !== undefined && config.remote !== '' && !existsSync(join(config.mirrorDir, '.git'))) {
    const ready = await ensureMirrorRepo({
      dir: config.mirrorDir,
      url: config.remote,
      ...config.branch === undefined ? {} : { branch: config.branch },
      ...config.token === undefined ? {} : { token: config.token },
      ...config.proxy === undefined ? {} : { proxy: config.proxy },
    })
    if (!ready.cloned) {
      return {
        files: 0,
        written: 0,
        unchanged: 0,
        removed: 0,
        tombstones: 0,
        committed: false,
        pushed: false,
        error: `首次同步无法 clone 远端：${ready.error ?? '未知原因'}`,
        ...ready.kind === undefined ? {} : { errorKind: ready.kind },
      }
    }
  }

  const files = await collectMirror(memory)

  // 墓碑：用「**本端**上次状态」与「本次要写的 id」对比。首次同步没有本端状态 → 不产生墓碑。
  // 单份 state 时代这里读的是别端全集，正是多端互删的判定根源（2026-11-14 修复）。
  const previous = readState(config.mirrorDir, config.envName)
  const current = stateOfFiles(files)
  const base = planTombstones({ previous, current, at: now })

  // 补 snapshot 与 env：pull 端消费墓碑前要能兜底，排查时要能看出是谁删的。
  const tombstones: Tombstone[] = []
  for (const tombstone of base) {
    const record = await memory.findBlock(tombstone.id)
    tombstones.push({
      ...tombstone,
      ...record === undefined ? {} : { snapshot: record },
      ...config.envName === undefined ? {} : { env: config.envName },
    })
  }

  // 本端**确认删除**的路径才从镜像里删——A：默认不删差集，不然会删掉别端的记录。
  const remove = tombstones.map(tombstone => (tombstone.scope === 'global'
    ? `records/global/${tombstone.id}.json`
    : `records/project/${tombstone.projectName ?? ''}/${tombstone.id}.json`))

  const write = writeMirror({ targetDir: config.mirrorDir, files, remove })
  writeTombstones(config.mirrorDir, tombstones)
  writeState(config.mirrorDir, dropTombstoned(current, tombstones), config.envName)

  const commit = await commitMirror({
    dir: config.mirrorDir,
    message: `sync: ${files.length} 条记录${tombstones.length > 0 ? `，${tombstones.length} 条墓碑` : ''}`,
    author: AUTHOR,
  })

  if (config.remote === undefined || config.remote === '') {
    return {
      files: files.length,
      written: write.written,
      unchanged: write.unchanged,
      removed: write.removed,
      tombstones: tombstones.length,
      committed: commit.committed,
      ...commit.sha === undefined ? {} : { sha: commit.sha },
      pushed: false,
      error: '未配置远端地址（memory.sync.remote）—— 已完成本地提交',
    }
  }

  await ensureRemote(config.mirrorDir, config.remote)
  const remote = await pushMirror({
    dir: config.mirrorDir,
    url: config.remote,
    ...config.branch === undefined ? {} : { branch: config.branch },
    ...config.token === undefined ? {} : { token: config.token },
  })

  return {
    files: files.length,
    written: write.written,
    unchanged: write.unchanged,
    removed: write.removed,
    tombstones: tombstones.length,
    committed: commit.committed,
    ...commit.sha === undefined ? {} : { sha: commit.sha },
    pushed: remote.ok,
    ...remote.error === undefined ? {} : { error: remote.error },
    ...remote.kind === undefined ? {} : { errorKind: remote.kind },
  }
}

/** 读镜像目录里的记录文件。 */
function readIncoming(mirrorDir: string): IncomingRecord[] {
  const root = join(mirrorDir, 'records')
  if (!existsSync(root)) return []
  const incoming: IncomingRecord[] = []

  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), [...segments, entry.name])
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      const id = entry.name.replace(/\.json$/u, '')
      try {
        const block = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as ImportedBlock
        if (segments[0] === 'global') incoming.push({ id, scope: 'global', block })
        else if (segments[0] === 'project' && segments.length >= 2) {
          incoming.push({ id, scope: 'project', projectName: segments[1] ?? '', block })
        }
      } catch {
        // 坏文件跳过：一条损坏不该挡住整次拉取。
      }
    }
  }

  walk(root, [])
  return incoming
}

/**
 * 拉一次：拉取 → 规划导入 → 逐条落地。
 *
 * 冲突不自动裁决：两边版本都写进 `conflicts/`，本地版本保留（§3.3）。
 *
 * @param memory - 引擎实例。
 * @param config - 同步配置。
 * @param now - 时间注入点。
 * @returns 导入统计。
 */
export async function syncPull(
  memory: MemoryEngine,
  config: SyncConfig,
  now: number = Date.now(),
): Promise<SyncPullRun> {
  if (config.remote !== undefined && config.remote !== '') {
    // 同 push：首次必须先 clone，否则本地 init 出来的仓库与远端没有共同祖先。
    if (!existsSync(join(config.mirrorDir, '.git'))) {
      const ready = await ensureMirrorRepo({
        dir: config.mirrorDir,
        url: config.remote,
        ...config.branch === undefined ? {} : { branch: config.branch },
        ...config.token === undefined ? {} : { token: config.token },
      ...config.proxy === undefined ? {} : { proxy: config.proxy },
      })
      if (!ready.cloned) {
        return {
          pulled: false,
          imported: 0,
          conflicts: 0,
          orphaned: 0,
          error: `首次同步无法 clone 远端：${ready.error ?? '未知原因'}`,
          ...ready.kind === undefined ? {} : { errorKind: ready.kind },
        }
      }
    }
    await ensureRemote(config.mirrorDir, config.remote)
    const remote = await pullMirror({
      dir: config.mirrorDir,
      url: config.remote,
      ...config.branch === undefined ? {} : { branch: config.branch },
      ...config.token === undefined ? {} : { token: config.token },
      ...config.proxy === undefined ? {} : { proxy: config.proxy },
    })
    if (!remote.ok) {
      return {
        pulled: false,
        imported: 0,
        conflicts: 0,
        orphaned: 0,
        ...remote.error === undefined ? {} : { error: remote.error },
        ...remote.kind === undefined ? {} : { errorKind: remote.kind },
      }
    }
  }

  const incoming = readIncoming(config.mirrorDir)

  // 本地各层现状
  const globalRecords = await memory.list({ namespace: 'global' })
  const localGlobal = { blocks: blocksOfDocument(recordsToDocument(globalRecords)) as Record<string, ImportedBlock> }
  const localProjects: Record<string, { blocks: Record<string, ImportedBlock> }> = {}
  for (const cwd of memory.projectCwds()) {
    const name = (cwd.replace(/\\/gu, '/').split('/').pop() ?? '').toLowerCase()
    if (name === '') continue
    const records = await memory.list({ namespace: 'project' }, cwd)
    localProjects[name] = { blocks: blocksOfDocument(recordsToDocument(records)) as Record<string, ImportedBlock> }
  }

  const plan = planImport({ incoming, localGlobal, localProjects })

  // 冲突留证：两边都写进 conflicts/
  if (plan.conflicts.length > 0) {
    const dir = join(config.mirrorDir, 'conflicts')
    mkdirSync(dir, { recursive: true })
    for (const conflict of plan.conflicts) {
      const env = config.envName ?? 'local'
      writeFileSync(
        join(dir, `${conflict.id}.${env}.json`),
        `${JSON.stringify(conflict, null, 2)}\n`,
        'utf8',
      )
    }
  }

  // 逐条落地（唯一会改本地记忆库的一步）
  let imported = 0
  for (const upsert of plan.upserts) {
    const cwd = upsert.scope === 'project' && upsert.projectName !== undefined
      ? memory.projectCwds().find(candidate => (candidate.replace(/\\/gu, '/').split('/').pop() ?? '').toLowerCase() === upsert.projectName?.toLowerCase())
      : undefined
    if (upsert.scope === 'project' && cwd === undefined) continue
    try {
      await memory.adopt(upsert.id as MemoryId, upsert.block as never, cwd)
      imported += 1
    } catch {
      // 单条失败跳过——一条不合规不该挡住整次拉取。
    }
  }

  // 墓碑消费（2026-11-14）：别端明确删掉的记忆，本端也删掉——否则会出现
  // 「我删了它又回来」。只删 id 精确匹配、且本端没在那之后改过的；删前留证据。
  const deleted = await applyTombstones(memory, config)

  return {
    pulled: true,
    imported,
    conflicts: plan.conflicts.length,
    orphaned: plan.orphaned.length,
    deleted,
  }
}

/** 读镜像里的墓碑（坏文件跳过——宁可少删，不可误删）。 */
function readTombstones(mirrorDir: string): Tombstone[] {
  const dir = join(mirrorDir, TOMBSTONE_DIR)
  if (!existsSync(dir)) return []
  const tombstones: Tombstone[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      tombstones.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as Tombstone)
    } catch {
      // 坏墓碑跳过。
    }
  }
  return tombstones
}

/**
 * 应用远端墓碑：把别端明确删掉的记忆在本端也删掉（2026-11-14）。
 *
 * 三条安全边界（设计 §二.C）：
 * 1. 只删 **id 精确匹配** 的记录（记忆 id 是 uuid，不会撞）。
 * 2. 本端 `updatedAt` **晚于** `deletedAt` 的不删——本端在那之后改过，旧删除不该覆盖它；
 *    这类写进 `conflicts/deleted-<id>.json` 等人处理。
 * 3. 删之前同样留一份证据（墓碑自带 snapshot，这里再留本地版本）。
 *
 * @param memory - 引擎实例。
 * @param config - 同步配置。
 * @returns 实际删掉的条数。
 */
async function applyTombstones(memory: MemoryEngine, config: SyncConfig): Promise<number> {
  const tombstones = readTombstones(config.mirrorDir)
  if (tombstones.length === 0) return 0
  const backupDir = join(config.mirrorDir, 'conflicts')
  let deleted = 0
  for (const tombstone of tombstones) {
    const block = await memory.findBlock(tombstone.id)
    if (block === undefined) continue
    const updatedAt = typeof block.updatedAt === 'number' ? block.updatedAt : 0
    if (updatedAt > tombstone.deletedAt) {
      mkdirSync(backupDir, { recursive: true })
      writeFileSync(
        join(backupDir, `deleted-${tombstone.id}.json`),
        `${JSON.stringify({ tombstone, local: block }, null, 2)}\n`,
        'utf8',
      )
      continue
    }
    const cwd = tombstone.scope === 'project' && tombstone.projectName !== undefined
      ? memory.projectCwds().find(candidate =>
        (candidate.replace(/\\/gu, '/').split('/').pop() ?? '').toLowerCase() === tombstone.projectName?.toLowerCase())
      : undefined
    // project 记录落不在地上（本端没这个项目）就跳过——它不是「被删了」，只是不在这台机器。
    if (tombstone.scope === 'project' && cwd === undefined) continue
    try {
      if (await memory.forget(tombstone.id as MemoryId, cwd)) deleted += 1
    } catch {
      // 单条失败跳过，不挡整次拉取。
    }
  }
  return deleted
}

/**
 * 查同步状态。
 *
 * @param config - 同步配置。
 * @returns 镜像目录、最近提交、冲突与墓碑数量。
 */
export async function syncStatus(config: SyncConfig): Promise<SyncStatus> {
  const initialized = existsSync(join(config.mirrorDir, '.git'))
  const history = initialized ? await readHistory(config.mirrorDir) : []
  const conflictsDir = join(config.mirrorDir, 'conflicts')
  const tombstonesDir = join(config.mirrorDir, TOMBSTONE_DIR)
  const countFiles = (dir: string): number => {
    if (!existsSync(dir)) return 0
    return readdirSync(dir).filter(name => name.endsWith('.json')).length
  }

  return {
    mirrorDir: config.mirrorDir,
    initialized,
    ...config.remote === undefined ? {} : { remote: config.remote },
    ...history[0] === undefined ? {} : { lastCommit: history[0] },
    commits: history.length,
    conflicts: countFiles(conflictsDir),
    tombstones: countFiles(tombstonesDir),
  }
}

/** 便于测试：导出一份当前冲突的快照。 */
export function conflictFiles(config: SyncConfig): string[] {
  const dir = join(config.mirrorDir, 'conflicts')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.json'))
}

/**
 * 「测试连接」：用当前配置探一次远端。
 *
 * 面板上填完地址 / 令牌 / 代理后，点一下就能知道三件事里哪一件坏了——地址不通、
 * 令牌无效、还是要走代理。之前没有这个入口时，推不上去只能靠猜（2026-11-13 用户机器：
 * 系统 git 走代理能通、插件 node 直连超时，从面板上完全看不出来）。
 *
 * 只做 `ls-remote` 级别的探测：**不写本地仓库、不推不拉**。
 *
 * @param config - 当前同步配置（`remote` 必须有值）。
 */
export async function syncTest(config: SyncConfig): Promise<RemoteProbe> {
  if (config.remote === undefined || config.remote === '') {
    return { ok: false, error: '还没填仓库地址（上面的「远端地址」）', kind: 'unknown' }
  }
  return probeRemote({
    url: config.remote,
    ...config.token === undefined ? {} : { token: config.token },
    ...config.proxy === undefined ? {} : { proxy: config.proxy },
  })
}


export type { ImportConflict }
