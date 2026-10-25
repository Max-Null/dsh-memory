/**
 * 定时备份：把 `memory.json`（global）、`memory_project_*.json`（project）与
 * `<DSH_HOME>/diary` 下的日记复制到 `DSH_HOME` 之外。
 *
 * 存在的理由（2026-10-18 事故）：`.dsh` 下的 storages 被外部整目录删除后，dsh-memory 的
 * 写入路径是「reload → 合并 → 写」——空磁盘让 reload 得到空库，写入把内存里的 global
 * 记忆覆盖成一条；而当时 `memory.json` 没有任何一份存在于 `.dsh` 之外，无从恢复。
 *
 * 两类数据在同一个备份根下、用两种保留策略：记忆是**快照**（时间戳目录、只留最近 N 份），
 * 日记是**归档**（固定目录、只增不删）——理由见 {@link archiveDiary}。
 *
 * 备份能力属于本插件而非宿主壳：上面两类数据都由本插件产生，换个宿主编排它同样该成立。
 *
 * 铁律：这里**只读文件、只复制**，绝不复用引擎的写入路径、不碰内存状态。备份失败只记
 * 日志，绝不影响记忆本身的读写与启动。
 *
 * @module dsh-memory/backup
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  /** 日记的根（`$DSH_HOME/diary`）；缺省不备份日记。 */
  diaryRoot?: string
  /** 备份根目录。 */
  targetRoot: string
  /** 保留份数（≥1）。 */
  keep: number
  /** 当前时间；测试可注入。 */
  now?: Date
  /** 日志出口；缺省丢弃。 */
  log?: (text: string) => void
}

/** 日记归档的结果。 */
export interface DiaryArchiveRun {
  /** 本次复制进归档的篇数（含内容变化后的覆盖）。 */
  readonly copied: number
  /** 归档里已存在且与日记逐字节相同的篇数。 */
  readonly kept: number
}

/** 一次备份的结果。 */
export interface MemoryBackupRun {
  /** 本次写入的目录；没有可备份文件时为 `null`。 */
  readonly dir: string | null
  /** 实际复制的文件名。 */
  readonly files: readonly string[]
  /** 本次清理掉的旧目录名。 */
  readonly pruned: readonly string[]
  /**
   * 日记归档的结果；入参没给 `diaryRoot` 时为 `undefined`（视为「不备份日记」）。
   *
   * 与 `files` 分开记：日记**不**落进本次的快照目录，它在固定的 `diary-archive/` 里
   * 保持一份持续累积的副本，不做时间点切片。
   */
  readonly diary?: DiaryArchiveRun
  /** 失败原因；成功时缺省。 */
  readonly error?: string
}

/** 参与备份的名字：global 的 `memory.json` 与 project 的 `memory_project_*.json`。 */
const BACKUP_FILE = /^(?:memory\.json|memory_project_[A-Za-z0-9_-]+\.json)$/u

/** 参与归档的日记篇目：与 `diary.ts` 的按天分文件一致（`YYYY-MM-DD.md`）。 */
const DIARY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/u

/**
 * 日记归档目录名，固定在备份根下。
 *
 * 之所以是固定名而不是时间戳：它**必须不匹配** {@link pruneBackups} 的
 * `^\d{8}-\d{6}(?:-\d+)?$`。记忆快照丢一份还有别的份（同一份数据的多个时间点副本），
 * 日记归档里每一篇都是**唯一**的备份——丢了没有任何地方能重建它。只增不删因此是硬要求，
 * 而靠这个名字天然躲开轮转，不必再给清理逻辑开白名单。
 */
const DIARY_ARCHIVE_DIR = 'diary-archive'

/** 从 `unknown` 错误里取可读信息（`catch` 绑定的类型是 `unknown`）。 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
    log(`memory backup: 无法读取 ${root}: ${reason(error)}`)
    return []
  }
}

/**
 * 把日记镜像进 `<targetRoot>/diary-archive/`。
 *
 * 保留策略与记忆快照相反：快照按时间戳分目录、只留最近 `keep` 份；归档**只增不删**，
 * 理由见 {@link DIARY_ARCHIVE_DIR}。
 *
 * 三档处理：
 * - 归档里没有 → 复制，计入 `copied`
 * - 两边逐字节相同 → 跳过，计入 `kept`（绝大多数情况：日记写到归档之间没有变化）
 * - 不同 → **以日记为准覆盖**，计入 `copied`：人可能在事后改过错字，日记那一侧才是当前的；
 *   归档不是版本库，它只为「原件没了」这一件事存在
 *
 * 归档里独有、日记里已经没有的篇目**一律保留**——那正是归档的全部价值。
 * 逐篇独立处理，单篇失败只告警、不抛出（模块头的铁律）。
 *
 * @param diaryRoot - 日记根（`$DSH_HOME/diary`）。
 * @param targetRoot - 备份根；归档落在其下的 `diary-archive/`。
 * @param log - 日志出口。
 * @returns 写入与跳过的篇数；没有日记可归档时两项都是 0，且不创建任何目录。
 */
function archiveDiary(diaryRoot: string, targetRoot: string, log: (text: string) => void): DiaryArchiveRun {
  const nothing: DiaryArchiveRun = { copied: 0, kept: 0 }
  if (!existsSync(diaryRoot)) return nothing
  let names: string[]
  try {
    names = readdirSync(diaryRoot).filter((name) => DIARY_FILE.test(name))
  } catch (error: unknown) {
    log(`memory backup: 无法读取日记目录 ${diaryRoot}: ${reason(error)}`)
    return nothing
  }
  if (names.length === 0) return nothing

  const archiveDir = join(targetRoot, DIARY_ARCHIVE_DIR)
  let copied = 0
  let kept = 0
  for (const name of names) {
    const from = join(diaryRoot, name)
    const to = join(archiveDir, name)
    try {
      // 比字节而不是比 mtime：复制与编辑都会动 mtime，内容才是「是否已经备份过」的事实。
      if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) {
        kept += 1
        continue
      }
      mkdirSync(archiveDir, { recursive: true })
      copyFileSync(from, to)
      copied += 1
    } catch (error: unknown) {
      log(`memory backup: 归档日记 ${name} 失败: ${reason(error)}`)
    }
  }
  return { copied, kept }
}

/**
 * 备份一次：记忆走时间戳快照，日记走 {@link archiveDiary} 的累积归档。
 *
 * 目标目录按 `now` 命名；同名目录已存在时追加 `-1`、`-2`……每个文件独立复制，单个失败
 * 只告警、不中断其余文件；`manifest.json` 记录本次来源与文件清单，便于事后核对。
 * 没有可复制文件时返回 `dir: null`，不创建空目录。
 *
 * 日记归档先于「记忆文件是否存在」的判断执行：它落在固定的 `diary-archive/`，不依赖本次
 * 快照目录，所以只剩日记可备份时照样该归档。
 *
 * @param options - 两个来源根、日记根、目标根、保留份数与时间注入点。
 * @returns 本次目录、复制清单、清理清单、日记归档结果与失败原因。
 */
export function runMemoryBackup(options: MemoryBackupOptions): MemoryBackupRun {
  const log = options.log ?? ((): void => {})
  const now = options.now ?? new Date()
  const diary = options.diaryRoot === undefined
    ? undefined
    : archiveDiary(options.diaryRoot, options.targetRoot, log)
  const globalFiles = candidateFiles(options.globalRoot, log).map(name => ({ name, from: join(options.globalRoot, name) }))
  const projectFiles = candidateFiles(options.projectRoot, log).map(name => ({ name, from: join(options.projectRoot, name) }))
  const sources = [...globalFiles, ...projectFiles]
  if (sources.length === 0) {
    log('memory backup: 没有可备份的记忆文件')
    return diary === undefined
      ? { dir: null, files: [], pruned: [] }
      : { dir: null, files: [], pruned: [], diary }
  }

  let base = join(options.targetRoot, stamp(now))
  let dir = base
  for (let suffix = 1; existsSync(dir); suffix += 1) dir = `${base}-${String(suffix)}`

  try {
    mkdirSync(dir, { recursive: true })
  } catch (error: unknown) {
    const message = reason(error)
    log(`memory backup: 无法创建 ${dir}: ${message}`)
    return { dir: null, files: [], pruned: [], error: message }
  }

  const files: string[] = []
  for (const source of sources) {
    try {
      copyFileSync(source.from, join(dir, source.name))
      files.push(source.name)
    } catch (error: unknown) {
      log(`memory backup: 复制 ${source.name} 失败: ${reason(error)}`)
    }
  }

  try {
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({
      createdAt: now.toISOString(),
      globalRoot: options.globalRoot,
      projectRoot: options.projectRoot,
      files,
      // 日记不在本次快照目录里，manifest 只记「这一轮归档做了什么」，不列篇名。
      ...(diary === undefined ? {} : { diary: { root: options.diaryRoot, ...diary } }),
    }, null, 2)}\n`, 'utf8')
  } catch (error: unknown) {
    log(`memory backup: 写 manifest 失败: ${reason(error)}`)
  }

  const pruned = pruneBackups(options.targetRoot, options.keep, log)
  return diary === undefined ? { dir, files, pruned } : { dir, files, pruned, diary }
}

/**
 * 只保留最近 `keep` 份时间戳快照目录（按名字排序即时间序），多余的删除。
 *
 * 只认 `YYYYMMDD-HHmmss`（含 `-1` 这类冲突后缀）：`diary-archive` 等固定名目录因此永远
 * 不在清理范围内——日记只增不删是硬要求，不是配置项。
 */
function pruneBackups(targetRoot: string, keep: number, log: (text: string) => void): string[] {
  if (!existsSync(targetRoot)) return []
  let entries: string[]
  try {
    entries = readdirSync(targetRoot).filter((name) => /^\d{8}-\d{6}(?:-\d+)?$/u.test(name))
  } catch (error: unknown) {
    log(`memory backup: 无法读取 ${targetRoot}: ${reason(error)}`)
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
      log(`memory backup: 清理 ${name} 失败: ${reason(error)}`)
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
