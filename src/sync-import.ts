/**
 * 同步导入层：把 `records/` 里的记录**规划**成一组待写入的操作。
 *
 * **这一层只出计划，不写任何东西。** 真正落库由调用方走引擎已有的写入路径完成，
 * 理由：直接改 `memory.json` 会与内存缓存打架（引擎的写路径是「读—改—写全量覆盖」，
 * 绕过它等于让两边各持一份真相）。分层之后，这一层是纯函数，可以在不碰数据的前提下
 * 穷举冲突场景。
 *
 * 冲突策略见设计 §3.3：**同一条被两边改时不自动裁决**，两个版本都交出去让调用方写进
 * `conflicts/`。记忆是长期资产，被静默覆盖的那份就没了。
 *
 * @module dsh-memory/sync-import
 */

import type { z } from 'zod'
import type { blockSchema } from './schema.ts'

/** 与存储层同构的一条记录。 */
export type ImportedBlock = z.infer<typeof blockSchema>

/** 一条来自 `records/` 的记录及其归属。 */
export interface IncomingRecord {
  /** 记录 id（文件名去 `.json`）。 */
  readonly id: string
  /** `global` 或 `project`。 */
  readonly scope: 'global' | 'project'
  /** `project` 作用域下的项目名；`global` 时缺省。 */
  readonly projectName?: string
  /** 解析后的记录体。 */
  readonly block: ImportedBlock
}

/** 本地某一层现有的记录。 */
export interface LocalLayer {
  /** 该层现有的记录：id → block。 */
  readonly blocks: Readonly<Record<string, ImportedBlock>>
}

/** {@link planImport} 的入参。 */
export interface ImportPlanOptions {
  readonly incoming: readonly IncomingRecord[]
  /** 本地 global 层。 */
  readonly localGlobal: LocalLayer
  /** 本地的项目层：项目名（已小写）→ 该项目的记录。 */
  readonly localProjects: Readonly<Record<string, LocalLayer>>
}

/** 一条待写入的操作。 */
export interface ImportUpsert {
  readonly id: string
  readonly scope: 'global' | 'project'
  readonly projectName?: string
  readonly block: ImportedBlock
}

/** 一条需要人工裁决的冲突。 */
export interface ImportConflict {
  readonly id: string
  readonly scope: 'global' | 'project'
  readonly projectName?: string
  /** 本地版本。 */
  readonly mine: ImportedBlock
  /** 远端版本。 */
  readonly theirs: ImportedBlock
  /** 判据：哪一边的 `updatedAt` 更新（仅作参考，决定写不写 `upserts`）。 */
  readonly newer: 'mine' | 'theirs'
}

/** 一次导入规划的结果。 */
export interface ImportPlan {
  /** 需要新增或覆盖的条目。 */
  readonly upserts: readonly ImportUpsert[]
  /** 两边都改过、需要人裁决的条目。 */
  readonly conflicts: readonly ImportConflict[]
  /** 本地没有对应项目、无法落地的条目（留在远端等它出现）。 */
  readonly orphaned: readonly string[]
  /** 本地已一致、无需动作的条数。 */
  readonly unchanged: number
}

/** 把一条记录投影成可比较的形状：只比内容，不比本地瞬态字段。 */
function comparable(block: ImportedBlock): string {
  return JSON.stringify([
    block.content,
    block.keywords,
    block.namespace,
    block.status,
    block.injected ?? null,
    block.topic ?? null,
    block.kind ?? null,
    block.stale ?? null,
    block.staleReason ?? null,
    block.anchor ?? null,
  ])
}

/** 本地层里找一条。 */
function findLocal(layer: LocalLayer | undefined, id: string): ImportedBlock | undefined {
  return layer?.blocks[id]
}

/**
 * 规划一次导入。**不读写磁盘、不碰引擎状态。**
 *
 * 三种归属分别处理：
 * - `global`：永远有落点。
 * - `project` 且本地有同名项目：落到该项目。
 * - `project` 但本地没有该项目 → 进 `orphaned`，**不丢**（留在远端等它出现）。
 *
 * @param options - 远端记录、本地各层、项目映射。
 * @returns 计划：要写的、要裁决的、落不了的、不需要动的。
 */
export function planImport(options: ImportPlanOptions): ImportPlan {
  const upserts: ImportUpsert[] = []
  const conflicts: ImportConflict[] = []
  const orphaned: string[] = []
  let unchanged = 0

  for (const record of options.incoming) {
    const { id, scope, projectName, block } = record

    let localLayer: LocalLayer | undefined
    if (scope === 'global') {
      localLayer = options.localGlobal
    } else {
      const key = projectName?.toLowerCase() ?? ''
      localLayer = key === '' ? undefined : options.localProjects[key]
      if (localLayer === undefined) {
        // 本机没有这个项目：记下来但不导入，也不报错。
        orphaned.push(id)
        continue
      }
    }

    const local = findLocal(localLayer, id)
    if (local === undefined) {
      upserts.push({ id, scope, ...projectName === undefined ? {} : { projectName }, block })
      continue
    }

    if (comparable(local) === comparable(block)) {
      unchanged += 1
      continue
    }

    // 两边内容不同：不自动裁决，两边都交出去。
    const newer = (block.updatedAt ?? 0) > (local.updatedAt ?? 0) ? 'theirs' as const : 'mine' as const
    conflicts.push({ id, scope, ...projectName === undefined ? {} : { projectName }, mine: local, theirs: block, newer })
    // 远端更新的那份仍然写进去（否则用户看到的永远是旧内容），但冲突记录同时留下。
    if (newer === 'theirs') {
      upserts.push({ id, scope, ...projectName === undefined ? {} : { projectName }, block })
    }
  }

  return { upserts, conflicts, orphaned, unchanged }
}
