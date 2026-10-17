/**
 * 记忆定时备份：把 `memory.json`（global）与 `memory_project_*.json`（project）复制到
 * `DSH_HOME` 之外。
 *
 * 存在的理由（2026-10-18 事故）：`.dsh` 下的 storages 被外部整目录删除后，dsh-memory 的
 * 写入路径是「reload → 合并 → 写」——空磁盘让 reload 得到空库，写入把内存里的 global
 * 记忆覆盖成一条；而当时 `memory.json` 没有任何一份存在于 `.dsh` 之外，无从恢复。
 *
 * 铁律：这里**只读文件、只复制**，绝不复用引擎的写入路径、不碰内存状态。备份失败只记
 * 日志，绝不影响记忆本身的读写与启动。
 *
 * @module dsh-memory/backup
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 定时备份的配置（`MemoryConfig.backup`）。 */
export interface MemoryBackupConfig {
  /** 是否启用；缺省启用。 */
  enabled?: boolean
  /** 备份间隔（分钟）；默认 60。 */
  intervalMinutes?: number
  /** 保留最近多少份；默认 14。 */
  keep?: number
  /** 备份根目录；默认 `~/.dsh-backups/memory`（必须在 `DSH_HOME` 之外）。 */
  targetRoot?: string
}

/** {@link runMemoryBackup} 的入参。 */
export interface MemoryBackupOptions {
  /** global 记忆的根（`$DSH_HOME/storages`）。 */
  globalRoot: string
  /** project 记忆的根（`<cwd>/.dsh/storages`）。 */
  projectRoot: string
  /** 备份根目录。 */
  targetRoot: string
  /** 保留份数（≥1）。 */
  keep: number
  /** 当前时间；测试可注入。 */
  now?: Date
  /** 日志出口；缺省丢弃。 */
  log?: (text: string) => void
}

/** 一次备份的结果。 */
export interface MemoryBackupRun {
  /** 本次写入的目录；没有可备份文件时为 `null`。 */
  readonly dir: string | null
  /** 实际复制的文件名。 */
  readonly files: readonly string[]
  /** 本次清理掉的旧目录名。 */
  readonly pruned: readonly string[]
  /** 失败原因；成功时缺省。 */
  readonly error?: string
}

/** 参与备份的名字：global 的 `memory.json` 与 project 的 `memory_project_*.json`。 */
const BACKUP_FILE = /^(?:memory\.json|memory_project_[A-Za-z0-9_-]+\.json)$/u

/** 备份目录名：`YYYYMMDD-HHmmss`，可排序、可读。 */
function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 列出根目录下参与备份的文件名；根不存在或不可读时返回空数组。 */
function candidateFiles(root: string, log: (text: string) => void): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root).filter((name) => BACKUP_FILE.test(name))
  } catch (error: unknown) {
    log(`memory backup: 无法读取 ${root}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/**
 * 把两个根下的记忆文件复制进一份新目录。
 *
 * 目标目录按 `now` 命名；同名目录已存在时追加 `-1`、`-2`……每个文件独立复制，单个失败
 * 只告警、不中断其余文件；`manifest.json` 记录本次来源与文件清单，便于事后核对。
 * 没有可复制文件时返回 `dir: null`，不创建空目录。
 *
 * @param options - 两个来源根、目标根、保留份数与时间注入点。
 * @returns 本次目录、复制清单、清理清单与失败原因。
 */
export function runMemoryBackup(options: MemoryBackupOptions): MemoryBackupRun {
  const log = options.log ?? ((): void => {})
  const now = options.now ?? new Date()
  const globalFiles = candidateFiles(options.globalRoot, log).map(name => ({ name, from: join(options.globalRoot, name) }))
  const projectFiles = candidateFiles(options.projectRoot, log).map(name => ({ name, from: join(options.projectRoot, name) }))
  const sources = [...globalFiles, ...projectFiles]
  if (sources.length === 0) {
    log('memory backup: 没有可备份的记忆文件')
    return { dir: null, files: [], pruned: [] }
  }

  let base = join(options.targetRoot, stamp(now))
  let dir = base
  for (let suffix = 1; existsSync(dir); suffix += 1) dir = `${base}-${String(suffix)}`

  try {
    mkdirSync(dir, { recursive: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    log(`memory backup: 无法创建 ${dir}: ${message}`)
    return { dir: null, files: [], pruned: [], error: message }
  }

  const files: string[] = []
  for (const source of sources) {
    try {
      copyFileSync(source.from, join(dir, source.name))
      files.push(source.name)
    } catch (error: unknown) {
      log(`memory backup: 复制 ${source.name} 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({
      createdAt: now.toISOString(),
      globalRoot: options.globalRoot,
      projectRoot: options.projectRoot,
      files,
    }, null, 2)}\n`, 'utf8')
  } catch (error: unknown) {
    log(`memory backup: 写 manifest 失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  return { dir, files, pruned: pruneBackups(options.targetRoot, options.keep, log) }
}

/** 只保留最近 `keep` 份备份目录（按名字排序即时间序），多余的删除。 */
function pruneBackups(targetRoot: string, keep: number, log: (text: string) => void): string[] {
  if (!existsSync(targetRoot)) return []
  let entries: string[]
  try {
    entries = readdirSync(targetRoot).filter((name) => /^\d{8}-\d{6}(?:-\d+)?$/u.test(name))
  } catch (error: unknown) {
    log(`memory backup: 无法读取 ${targetRoot}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  entries.sort()
  const pruned: string[] = []
  const excess = entries.length - Math.max(1, keep)
  for (let index = 0; index < excess; index += 1) {
    const name = entries[index]
    if (name === undefined) break
    try {
      rmSync(join(targetRoot, name), { recursive: true, force: true })
      pruned.push(name)
    } catch (error: unknown) {
      log(`memory backup: 清理 ${name} 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return pruned
}

/** 备份目录是否像一个已存在的备份树（测试与自检用）。 */
export function isBackupDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
