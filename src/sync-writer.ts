/**
 * 同步写盘层：把 {@link exportRecords} 的输出落到磁盘上的镜像目录。
 *
 * **两条硬要求**（见设计文档 §9.2 第 1 步）：
 *
 * 1. **增量**：内容相同的文件不重写。不做这件事的后果不是"慢"，是每次写盘都产生
 *    一批 mtime 变动——git 看起来像全量改动，`git log` 与 `git diff` 随即失去意义。
 * 2. **删除先算差集**：现有文件里不在待写列表的才算该删。不能边扫边删——边扫边删
 *    在目录枚举顺序变化时会漏删或错删。
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

/** 递归列出 `root` 下的文件，返回相对 `relBase` 的路径（`/` 分隔）。 */
function scan(root: string, relBase: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
    if (entry.isDirectory()) found.push(...scan(join(root, entry.name), rel))
    else found.push(rel)
  }
  return found
}

/**
 * 把记录文件镜像到磁盘。**纯 IO，不读写任何记忆状态**。
 *
 * 三个步骤按固定顺序：先算差集（该删哪些）、再写（内容有变的）、最后删。
 * 顺序不能调换——先删会让"写失败 + 删成功"变成净损失。
 *
 * 单文件失败不会中断整批：记忆镜像少一份总比整次同步失败好，缺的那份下次写盘会补上。
 *
 * @param options - 目标目录与待写文件。
 * @returns 写入 / 跳过 / 删除的统计。
 */
export function writeMirror(options: MirrorWriteOptions): MirrorWriteRun {
  const recordsRoot = join(options.targetDir, RECORDS_DIR)

  // 待写集合：normalize 之后的相对路径 → 内容
  const wanted = new Map<string, string>()
  for (const file of options.files) wanted.set(normalize(file.path), file.content)

  // 差集先算：磁盘上有、但这次不该存在的，才是要删的
  const stale = scan(recordsRoot, RECORDS_DIR).filter(path => !wanted.has(path))

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

  const removedPaths: string[] = []
  for (const relativePath of stale) {
    try {
      rmSync(join(options.targetDir, relativePath), { force: true })
      removedPaths.push(relativePath)
    } catch {
      // 同上：删除失败留到下次。
    }
  }

  return { written, unchanged, removed: removedPaths.length, removedPaths }
}
