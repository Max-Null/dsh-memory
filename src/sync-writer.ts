/**
 * 同步写盘层：把 {@link exportRecords} 的输出落到磁盘上的镜像目录。
 *
 * **三条硬要求**（2026-11-14 改，见 `docs/设计/2026-11-14-云同步多端删除-修复设计.md`）：
 *
 * 1. **增量**：内容相同的文件不重写。不做这件事的后果不是"慢"，是每次写盘都产生
 *    一批 mtime 变动——git 看起来像全量改动，`git log` 与 `git diff` 随即失去意义。
 * 2. **默认不删**：本端这次没收集到的记录，可能是**另一端**的——删掉就是互删。
 *    只有调用方明确列入 `remove` 的才删。
 * 3. **删除只认显式清单**：`remove` 由调用方从「本端上次同步有、这次没有」的差集得出
 *    （配合按端分片的 state），不是从磁盘现状反推。
 *
 * **只管 `records/`**：`conflicts/`（§3.3 的留证）与 `index.json`（§3.2 的派生品）
 * 都不归这里管。写盘层负责的是"把记忆库投影成一条一文件"，不是"维护整个同步仓库"。
 *
 * @module dsh-memory/sync-writer
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SyncRecordFile } from './sync-export.ts'

/** {@link writeMirror} 的入参。 */
export interface MirrorWriteOptions {
  /** 镜像仓库的根（`records/` 就在它下面）。 */
  readonly targetDir: string
  /** 待写入的记录文件；路径相对 `targetDir`。 */
  readonly files: readonly SyncRecordFile[]
  /**
   * 本次要删的相对路径（`records/...`）。缺省空 = 一个都不删。
   *
   * 只删 `records/` 下的文件；越界路径（`../`、`conflicts/`、state 文件）一律忽略。
   */
  readonly remove?: readonly string[]
}

/** 一次写盘的结果。 */
export interface MirrorWriteRun {
  /** 真正写了的文件数（内容有变化的）。 */
  readonly written: number
  /** 内容与磁盘一致的、跳过的文件数。 */
  readonly unchanged: number
  /** 被删掉的文件数。 */
  readonly removed: number
  /** 被删掉的相对路径（便于日志与测试断言）。 */
  readonly removedPaths: readonly string[]
}

/** 记录文件所在的顶层目录名。 */
const RECORDS_DIR = 'records'

/** 路径规范成 `/` 分隔——`exportRecords` 用 `join()` 产出，在 Windows 上是反斜杠。 */
function normalize(path: string): string {
  return path.replace(/\\/gu, '/')
}

/**
 * 把记录文件镜像到磁盘。**纯 IO，不读写任何记忆状态**。
 *
 * 顺序固定：先写（内容有变的）、再删（显式清单里的）。先删会让"写失败 + 删成功"
 * 变成净损失。
 *
 * 单文件失败不会中断整批：记忆镜像少一份总比整次同步失败好，缺的那份下次写盘会补上。
 *
 * @param options - 目标目录、待写文件、要删的路径。
 * @returns 写入 / 跳过 / 删除的统计。
 */
export function writeMirror(options: MirrorWriteOptions): MirrorWriteRun {
  // 待写集合：normalize 之后的相对路径 → 内容
  const wanted = new Map<string, string>()
  for (const file of options.files) wanted.set(normalize(file.path), file.content)

  let written = 0
  let unchanged = 0
  for (const [relativePath, content] of wanted) {
    const absolute = join(options.targetDir, relativePath)
    try {
      if (existsSync(absolute) && readFileSync(absolute, 'utf8') === content) {
        unchanged += 1
        continue
      }
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, content, 'utf8')
      written += 1
    } catch {
      // 单个文件写失败不中断整批；缺的那份下次写盘会补。
    }
  }

  // 只删显式清单里的，且必须在 records/ 下——`remove` 由调用方给，但不能信它。
  const removable = new Set<string>()
  for (const path of options.remove ?? []) {
    const relativePath = normalize(path)
    if (!relativePath.startsWith(`${RECORDS_DIR}/`)) continue
    if (relativePath.includes('../')) continue
    removable.add(relativePath)
  }

  const removedPaths: string[] = []
  for (const relativePath of removable) {
    try {
      rmSync(join(options.targetDir, relativePath), { force: true })
      removedPaths.push(relativePath)
    } catch {
      // 同上：删除失败留到下次。
    }
  }

  return { written, unchanged, removed: removedPaths.length, removedPaths }
}
