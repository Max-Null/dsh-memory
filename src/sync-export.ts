/**
 * 同步导出层：把记忆库展开成「一条记忆一个文件」的镜像。
 *
 * **为什么需要它**：整份 `memory.json` 放进 git 会撞。2026-11-06 实测：两端各新增一条
 * 记忆后 merge，`git` 报 `CONFLICT (content)`——两条记录挤在同一个插入点，按「取一边」
 * 解决会静默丢掉另一端那条，而 git 仍报「合并成功」。改成一条一个文件后同一场景是
 * `Merge made by the 'ort' strategy`，0 冲突。
 *
 * **为什么单独成模块**（与 `schema.ts` 同理由）：本模块只依赖 `node:path`，不 import
 * cordis / dsh-storage / engine。这样单元测试与离线 CLI 能直接加载它，不必拉起整套
 * 宿主依赖——否则「用插件自己的能力导出一份镜像」这条在用户环境里跑不起来。
 *
 * **同步面不带什么**（见设计文档 §5）：
 * - `hitCount` / `lastUsedAt`：本地行为统计，每次检索命中都会改。带上它们会让镜像在内容
 *   毫无变化时持续变脏，git 历史被噪声淹没。
 * - `vector`：本地嵌入产物，体积大且可从 `content` 重算。
 * - `quarantined` 的记录**整条不导出**：隔离区的存在理由就是它可能含凭据类内容，
 *   推到远端仓库等于把那层保护绕开。
 *
 * @see docs/设计/2026-11-06-记忆云同步-设计方案.md
 */

import { join } from 'node:path'

/** 一条记录在镜像里的位置与内容。 */
export interface SyncRecordFile {
  /** 相对导出根的路径，如 `records/global/<uuid>.json`。 */
  readonly path: string
  /** 文件内容（JSON + 末尾换行；已剔除同步面之外的字段）。 */
  readonly content: string
}

/** 导出的输入：各层记忆库的**解析后**文档。 */
export interface SyncExportOptions {
  /** `memory.json` 解析后的对象（global 层）。 */
  readonly globalDocument: unknown
  /** 各工作区的记忆库文档；`cwd` 用于算目录名，须与引擎写入时一致。 */
  readonly projectDocuments?: ReadonlyArray<{ readonly cwd: string, readonly document: unknown }>
}

/** 一次导出的结果。 */
export interface SyncExportRun {
  /** 待写入的记录文件（顺序稳定：global 在前，工作区按 cwd 排序）。 */
  readonly files: readonly SyncRecordFile[]
  /** 因处于隔离区而未导出的条数。 */
  readonly skippedQuarantined: number
}

/**
 * 进入同步面的字段白名单。
 *
 * 用白名单而不是黑名单：`StoredBlock` 以后还会长出新字段（`topic` 就是 0.20.0 才加的），
 * 黑名单会让新字段**默认泄漏**进来——而「一个只该存在本地的字段漏进远端仓库」这类事故，
 * 发现的时候内容已经在别人能拉到的地方了。
 */
const SYNCED_FIELDS = [
  'namespace',
  'status',
  'content',
  'keywords',
  'createdAt',
  'updatedAt',
  'injected',
  'injectedAuto',
  'topic',
  'kind',
  'anchor',
  'stale',
  'staleReason',
  'source',
  'meta',
] as const

/** 记录文件的目录名（与清单文件同级）。 */
const RECORDS_DIR = 'records'

/** 把 `unknown` 收窄成对象；不是对象返回 `undefined`。 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 取出一份 unit 文档里的 blocks 表。
 *
 * 文档形状是 DSH storage 的 unit 格式：`{ unit, global, tables: { blocks: {...} } }`。
 * 形状不符时返回空表而不是抛错——镜像导出不该因为一个损坏的库把整个同步卡死，
 * 条数为 0 会被上层当作「没有可导出的东西」处理。
 */
function blocksOf(document: unknown): Record<string, Record<string, unknown>> {
  const doc = asObject(document)
  const tables = asObject(doc?.tables)
  const blocks = asObject(tables?.blocks)
  if (blocks === undefined) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, block] of Object.entries(blocks)) {
    const value = asObject(block)
    if (value !== undefined) out[id] = value
  }
  return out
}

/**
 * 工作区目录名——必须与引擎写记忆文件名时用的口径一致（`engine.ts` 的
 * `projectBackendName`：cwd 小写后过 djb2，取 base36）。
 *
 * 两边算法分叉的后果很隐蔽：镜像会落在另一个目录名下，另一端拉下来后
 * 看起来像「这个项目的记忆凭空少了一批」。
 */
export function workspaceSlug(cwd: string): string {
  let hash = 5381
  const text = cwd.toLowerCase()
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

/** 只保留白名单字段；值为 `undefined` 的键不落进文件（避免 `"x": null` 噪声）。 */
function pickSyncedFields(block: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of SYNCED_FIELDS) {
    const value = block[field]
    if (value !== undefined) out[field] = value
  }
  return out
}

/** 一条记录 → 一个文件；返回 `undefined` 表示这条不该进镜像（隔离区）。 */
function recordFile(id: string, block: Record<string, unknown>, segments: readonly string[]): SyncRecordFile | undefined {
  if (block.quarantined === true) return undefined
  const payload = pickSyncedFields(block)
  return {
    path: join(...segments, `${id}.json`),
    content: `${JSON.stringify(payload, null, 2)}\n`,
  }
}

/**
 * 把记忆库展开成镜像文件列表。**纯函数**：不读写磁盘、不看环境变量。
 *
 * @param options - 各层文档。
 * @returns 待写入的文件与隔离跳过数。
 */
export function exportRecords(options: SyncExportOptions): SyncExportRun {
  const files: SyncRecordFile[] = []
  let skippedQuarantined = 0

  for (const [id, block] of Object.entries(blocksOf(options.globalDocument))) {
    const file = recordFile(id, block, [RECORDS_DIR, 'global'])
    if (file === undefined) {
      skippedQuarantined += 1
      continue
    }
    files.push(file)
  }

  // 工作区按 cwd 排序：让两次导出的文件顺序稳定，git 不必为顺序抖动产生 diff。
  const projects = [...(options.projectDocuments ?? [])].sort((left, right) => left.cwd.localeCompare(right.cwd))
  for (const { cwd, document } of projects) {
    for (const [id, block] of Object.entries(blocksOf(document))) {
      const file = recordFile(id, block, [RECORDS_DIR, 'project', workspaceSlug(cwd)])
      if (file === undefined) {
        skippedQuarantined += 1
        continue
      }
      files.push(file)
    }
  }

  return { files, skippedQuarantined }
}
