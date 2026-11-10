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
import { SYNC_STATE_FILE, TOMBSTONE_DIR, dropTombstoned, planTombstones } from './sync-tombstone.ts'
import type { SyncState, Tombstone } from './sync-tombstone.ts'
import { ensureRemote, pullMirror, pushMirror } from './sync-remote.ts'
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

/** 读上一次同步留下的状态；没有时返回 `undefined`（首次同步）。 */
function readState(dir: string): SyncState | undefined {
  const file = join(dir, SYNC_STATE_FILE)
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

/** 写状态文件。 */
function writeState(dir: string, state: SyncState): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SYNC_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
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
  const files = await collectMirror(memory)
  const write = writeMirror({ targetDir: config.mirrorDir, files })

  // 墓碑：用「上次状态」与「本次要写的 id」对比。首次同步没有上次状态 → 不产生墓碑。
  const previous = readState(config.mirrorDir)
  const current = stateOfFiles(files)
  const tombstones = planTombstones({ previous, current, at: now })
  writeTombstones(config.mirrorDir, tombstones)
  writeState(config.mirrorDir, dropTombstoned(current, tombstones))

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
    await ensureRemote(config.mirrorDir, config.remote)
    const remote = await pullMirror({
      dir: config.mirrorDir,
      url: config.remote,
      ...config.branch === undefined ? {} : { branch: config.branch },
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

  return {
    pulled: true,
    imported,
    conflicts: plan.conflicts.length,
    orphaned: plan.orphaned.length,
  }
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

export type { ImportConflict }
