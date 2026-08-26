/**
 * The memory service (`ctx.memory`): durable plaintext records over two
 * storage roots — `global` in the harness home, `project` in the current
 * project folder (`.dsh/`), so project memory follows the repository. A record
 * is always created `suggested` and becomes effective only through `setStatus`.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { bm25FieldScores, cosineSimilarity, rrfFuse } from './bm25.ts'
import { parsePromptFile, scanPromptDir, writePromptFile, type PromptFile } from './prompt-files.ts'

declare const memoryIdBrand: unique symbol
/** Opaque identity of one stored memory record. */
export type MemoryId = string & { readonly [memoryIdBrand]: never }
/** Brand a string as a {@link MemoryId} (compile-time only). */
export function MemoryId(id: string): MemoryId {
  return id as MemoryId
}

export type MemoryNamespace = 'global' | 'project'
/**
 * 审核维度（0.3.0）：`suggested` 待审核（模型写入）；`approved` 已人工
 * 审核通过。注入与否由独立维度 `injected` 控制（见 MemoryRecord）。
 */
export type MemoryStatus = 'suggested' | 'approved'

/**
 * 记录类别（0.6.0 模板库）：'fact' = 常规记忆（缺省，旧数据即此）；
 * 'prompt' = 提示词模板索引记录（文件是事实源，见 prompt-files.ts）。
 */
export type MemoryKind = 'fact' | 'prompt'

/** prompt 索引记录的附加元数据（与 md 文件 frontmatter 对齐，工具/UI 直接取用）。 */
export interface PromptMetaIndex {
  seq?: number
  name: string
  dimension?: string
  difficulty?: string
  tags: string[]
  /** 索引摘要（正文前 200 字）。 */
  summary: string
  /** md 文件绝对路径（引擎内部使用；工具输出不暴露）。 */
  path: string
  /** 索引时的文件 mtime（惰性刷新比对）。 */
  mtime: number
  /** user=用户创建；agent=模型新增（UI 角标）。 */
  source: 'user' | 'agent'
}

export interface MemoryRecord {
  id: MemoryId
  namespace: MemoryNamespace
  status: MemoryStatus
  /** 注入维度：true = 每轮全量注入 system prompt（常驻）；false = 仅检索。 */
  injected: boolean
  content: string
  keywords: string[]
  createdAt: number
  updatedAt: number
  /** 最近一次被 memory_search 命中的时间（0.5.3 冷热追踪）；无则未命中过。 */
  lastUsedAt?: number
  /** 记录类别（缺省 'fact'）。 */
  kind?: MemoryKind
  /** prompt 记录元数据（仅 kind==='prompt'）。 */
  meta?: PromptMetaIndex
}

export interface MemoryWrite {
  content: string
  namespace?: MemoryNamespace
  keywords?: string[]
}

export interface MemoryFilter {
  namespace?: MemoryNamespace
  status?: MemoryStatus
  injected?: boolean
  /** 记录类别过滤（0.6.0）；缺省不过滤（工具层显式传 kind='fact' 保持旧行为）。 */
  kind?: MemoryKind
}

export interface MemoryHit {
  record: MemoryRecord
  score: number
}

/** One durable memory change, emitted after the backend acknowledges the write. */
export type MemoryChange =
  | { operation: 'remembered'; record: MemoryRecord }
  | { operation: 'forgotten'; id: MemoryId }
  | { operation: 'status'; id: MemoryId; status: MemoryStatus }
  | { operation: 'injected'; id: MemoryId; injected: boolean }

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryEngine
  }
  interface Events {
    /** A memory record was created, deleted, or promoted/demoted. */
    'memory/changed'(change: MemoryChange): void
  }
}

/**
 * 存储层状态保留旧枚举（auto/suggest）+ injected 可选——旧文件必须能
 * 过 schema 校验，读时由 normalizeBlock 迁移（一次性兼容转换，不重写文件）。
 */
type StoredStatus = MemoryStatus | 'auto' | 'suggest'

interface StoredBlock {
  namespace: MemoryNamespace
  status: StoredStatus
  injected?: boolean
  content: string
  keywords: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  /** 混合检索向量（0.5.2，仅有 embeddings 配置时生成；明文可读）。 */
  vector?: number[]
  /** 记录类别（0.6.0 模板库；缺省 fact）。 */
  kind?: MemoryKind
  /** prompt 索引元数据（仅 kind==='prompt'）。 */
  meta?: PromptMetaIndex
}

const blockSchema = z.object({
  namespace: z.enum(['global', 'project']),
  status: z.enum(['suggested', 'approved', 'auto', 'suggest']),
  injected: z.boolean().optional(),
  content: z.string(),
  keywords: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
  vector: z.array(z.number()).optional(),
  kind: z.enum(['fact', 'prompt']).optional(),
  meta: z.object({
    seq: z.number().optional(),
    name: z.string(),
    dimension: z.string().optional(),
    difficulty: z.string().optional(),
    tags: z.array(z.string()),
    summary: z.string(),
    path: z.string(),
    mtime: z.number(),
    source: z.enum(['user', 'agent']),
  }).optional(),
})

/** Shared table shape; the two domains differ only by name and backend route. */
function memorySpec(name: string) {
  return defineDomain({
    name,
    version: 1,
    tables: { blocks: domainTable<string, StoredBlock>(blockSchema) },
  })
}

/** 读 unit 文件头的 name（文件不存在 → undefined；非法 JSON/结构异常抛错）。 */
function unitHeaderName(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  const document = JSON.parse(readFileSync(path, 'utf8')) as { unit?: { name?: unknown } }
  return typeof document.unit?.name === 'string' ? document.unit.name : undefined
}

/** 改写 unit 文件头的 name（保持 2 空格缩进 + 尾换行，与 storage-json/format 一致）。 */
function rewriteUnitName(path: string, name: string): void {
  const document = JSON.parse(readFileSync(path, 'utf8')) as { unit?: { name?: unknown } }
  if (document.unit === undefined) throw new Error(`unit '${path}': missing unit header`)
  document.unit.name = name
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
}

/** 迁移旧 unit 文件：校验头名 → 改写为新名并落位规范路径 → 删除旧文件。 */
function migrateUnit(legacyPath: string, canonicalPath: string, legacyName: string, canonicalName: string): void {
  const document = JSON.parse(readFileSync(legacyPath, 'utf8')) as { unit?: { name?: unknown } }
  if (document.unit?.name !== legacyName) throw new Error(`unit '${legacyPath}': unexpected unit header`)
  document.unit.name = canonicalName
  writeFileSync(canonicalPath, `${JSON.stringify(document, null, 2)}\n`)
  rmSync(legacyPath)
}

/**
 * 旧 schema 迁移（0.3.0，设计文档「迁移规则」）：
 * - 旧 `auto` → approved + injected:true（行为不变：仍常驻注入）
 * - 旧 `suggest` → suggested + injected:false
 * - 缺 injected 的 approved → injected:false（新写路径兜底）
 * - 其余 → suggested + injected:false
 */
function normalizeBlock(block: StoredBlock): { status: MemoryStatus; injected: boolean } {
  if (block.status === 'auto') return { status: 'approved', injected: true }
  if (block.status === 'suggest') return { status: 'suggested', injected: false }
  return { status: block.status, injected: block.injected ?? false }
}

function toRecord(id: string, block: StoredBlock): MemoryRecord {
  const base: MemoryRecord = {
    id: MemoryId(id),
    namespace: block.namespace,
    ...normalizeBlock(block),
    content: block.content,
    keywords: block.keywords,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    ...block.lastUsedAt === undefined ? {} : { lastUsedAt: block.lastUsedAt },
  }
  // 0.6.0 模板库字段（缺省 fact；prompt 元数据透传）
  return {
    ...base,
    ...block.kind === undefined ? {} : { kind: block.kind },
    ...block.meta === undefined ? {} : { meta: block.meta },
  }
}

/** Harness-home root for `global` memories. */
function globalRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages')
}

/** Project-folder root for `project` memories — follows the repository. */
function projectRoot(): string {
  return join(process.cwd(), '.dsh', 'storages')
}

/**
 * 嵌入能力（0.5.2 混合检索）：缺省不配置 = 纯 BM25（行为不变）；
 * 配置后 memory_search 以 BM25 与语义结果做 RRF 融合，向量持久化到
 * 存储文件（vector 字段，外部可读），失败自动降级回纯 BM25。
 */
export interface MemoryEmbeddings {
  /** 文本 → 向量（与输入等长，一维浮点数组）。 */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>
  /** 相似度函数（缺省余弦相似度）。 */
  similarity?: (left: readonly number[], right: readonly number[]) => number
}

/** Engine configuration: the two storage roots, defaulted to home and project. */
export interface MemoryConfig {
  /** Root for `global` memories; defaults to `$DSH_HOME/storages`. */
  globalRoot?: string
  /** Root for `project` memories; defaults to `<cwd>/.dsh/storages`. */
  projectRoot?: string
  /**
   * 常驻注入预算（字符，0.5.2）：`memory:recall` 每轮注入的摘要总量上限，
   * 超预算按「最近更新优先」省略（面板提示省略数）。null/0 = 不限制。
   * 默认 DEFAULT_INJECTION_BUDGET（1500 字符，约 400-700 token）。
   */
  injectionBudget?: number | null
  /** 单条注入摘要截断上限（字符）；默认 DEFAULT_SUMMARY_CHARS（80）。 */
  summaryChars?: number
  /** 混合语义检索（0.5.2）：缺省纯 BM25；配置后与 BM25 做 RRF 融合。 */
  embeddings?: MemoryEmbeddings
  /** 语义侧参与融合的 topK（0.5.2）；默认 5。 */
  semanticTopK?: number
  /** 全局提示词模板根目录（0.6.0）；默认 `$DSH_HOME/prompt-library`。
   *  project 模板随工作区（`<workspace>/.dsh/prompt-library`，与记忆同构）。 */
  promptGlobalRoot?: string
}

/**
 * Cross-session plaintext memory over the storage hub, split by namespace:
 * `global` lives in the harness home, `project` in the session's workspace
 * folder (`<workspace>/.dsh/storages`, follows the repository) — 0.3.4:
 * project memory routes by the CALLER's workspace cwd (工具/面板按当前会话
 * 工作区路由), not the process launch dir.
 */
export class MemoryEngine extends Service {
  static inject = ['storage']

  private globalTable?: KvTable<string, StoredBlock>
  /** project 域按工作区 cwd 懒打开 + 缓存（多会话并发各工作区独立）。 */
  private projectTables = new Map<string, KvTable<string, StoredBlock>>()
  private projectFacilities = new Map<string, DomainFacility>()
  /** backend 只注册一次（registry 重名抛 duplicate；reload 清缓存后不得重复注册）。 */
  private registeredProjectBackends = new Set<string>()
  private facility?: DomainFacility

  constructor(ctx: import('@deepseek-ai/cordis').Context, private readonly config: MemoryConfig = {}) {
    super(ctx, 'memory')
  }

  protected async [Service.init](): Promise<void> {
    // backend 只注册一次：registry 对重名注册抛 duplicate-backend
    // （storage/tests/registry.spec 实测），reload 不得重复注册。
    const globalBackend = new JsonStorageBackend(this.config.globalRoot ?? globalRoot())
    this.ctx.storage.backend.register('memory-global', globalBackend)
    await this.openGlobalFacility()
    this.ctx.effect(() => () => {
      void this.facility?.closeAll()
      for (const facility of this.projectFacilities.values()) void facility.closeAll()
    }, 'memory.domainsClose')
  }

  /** 打开全局存储域（init 与 reload 共用；backend 复用已注册实例）。 */
  private async openGlobalFacility(): Promise<void> {
    const facility = new DomainFacility(this.ctx, { backend: 'memory-global', routes: {} })
    const globalDomain = await facility.open(memorySpec('memory'))
    this.facility = facility
    this.globalTable = globalDomain.table('blocks')
  }

  /** 工作区 project 存储根（<workspace>/.dsh/storages，随 git 分享）。 */
  private projectRootFor(cwd: string): string {
    return join(cwd, '.dsh', 'storages')
  }

  /** 稳定 backend 名（registry 重名抛错，按 cwd hash 唯一化；只允许 [a-z0-9_]，domain 名校验）。 */
  private projectBackendName(cwd: string): string {
    let h = 5381
    const text = cwd.toLowerCase() // Windows 路径大小写不敏感
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
    return `memory_project_${Math.abs(h).toString(36)}`
  }

  /**
   * 按工作区 cwd 取 project 表（懒打开 + 缓存）。无 cwd（未选工作区）
   * 返回 undefined——调用方（工具/面板）按此跳过 project 部分。
   */
  private async projectTableFor(projectCwd?: string): Promise<KvTable<string, StoredBlock> | undefined> {
    if (projectCwd === undefined || projectCwd === '') return undefined
    const key = join(projectCwd) // 规范化（Windows 大小写/尾斜杠）
    const cached = this.projectTables.get(key)
    if (cached !== undefined) return cached
    const backendName = this.projectBackendName(key)
    // 0.5.2：旧实现 domain 名多一层 memory_project_ 前缀（文件名双重前缀，
    // 且 unit 文件头 name 同为旧名）。打开前统一迁移到规范名：
    // ①规范名已存在 + 头为旧名（0.5.2 首版只 rename 未改 header 的中间态）→ 改写头；
    // ②旧名文件存在且头匹配 → 改写头并落位规范名；③其他情况回退旧域名（不动数据）。
    const legacyDomainName = `memory_project_${backendName}`
    const root = this.projectRootFor(key)
    const canonicalFile = join(root, `${backendName}.json`)
    const legacyFile = join(root, `${legacyDomainName}.json`)
    let domainName = backendName
    try {
      const canonicalHeader = unitHeaderName(canonicalFile)
      if (canonicalHeader === legacyDomainName) {
        rewriteUnitName(canonicalFile, backendName)
      } else if (canonicalHeader === undefined && unitHeaderName(legacyFile) === legacyDomainName) {
        migrateUnit(legacyFile, canonicalFile, legacyDomainName, backendName)
      } else if (canonicalHeader === undefined && existsSync(legacyFile)) {
        domainName = legacyDomainName // 外域/未知内容：保持旧名路径继续打开，不触碰数据
      }
    } catch {
      domainName = legacyDomainName // 迁移出错：回退旧名打开，数据不动（后续可重试）
    }
    if (!this.registeredProjectBackends.has(backendName)) {
      const backend = new JsonStorageBackend(root)
      this.ctx.storage.backend.register(backendName, backend)
      this.registeredProjectBackends.add(backendName)
    }
    const facility = new DomainFacility(this.ctx, { backend: backendName, routes: {} })
    const domain = await facility.open(memorySpec(domainName))
    const table = domain.table('blocks')
    this.projectFacilities.set(key, facility)
    this.projectTables.set(key, table)
    return table
  }

  /**
   * 强制重载存储：关闭全局域与全部已开工作区域后重开（unit 释放后
   * backend 重读文件），放弃内存缓存。供外部编辑记忆文件后刷新
   * （JsonStorageBackend 打开时加载一次，无 watch——2026-08-19 实测）。
   */
  async reload(): Promise<void> {
    await this.facility?.closeAll()
    for (const facility of this.projectFacilities.values()) await facility.closeAll()
    this.projectTables.clear()
    this.projectFacilities.clear()
    await this.openGlobalFacility()
  }

  /** Create one record in `suggested` status — never self-promoting. */
  async remember(input: MemoryWrite, projectCwd?: string): Promise<MemoryRecord> {
    const namespace = input.namespace ?? 'global'
    const table = namespace === 'project'
      ? await this.projectTableFor(projectCwd)
      : this.tableFor('global')
    if (table === undefined) throw new Error('cannot write project memory without a workspace cwd')
    const id = randomUUID()
    const now = Date.now()
    const block: StoredBlock = {
      namespace,
      status: 'suggested',
      injected: false,
      content: input.content,
      keywords: (input.keywords ?? []).map(keyword => keyword.toLowerCase()),
      createdAt: now,
      updatedAt: now,
    }
    await table.put(id, block)
    const record = toRecord(id, block)
    this.ctx.emit('memory/changed', { operation: 'remembered', record })
    return record
  }

  async list(filter?: MemoryFilter, projectCwd?: string): Promise<MemoryRecord[]> {
    const records = await this.allRecords(filter?.namespace, projectCwd)
    return records.filter(record =>
      (filter?.status === undefined || record.status === filter.status)
      && (filter?.injected === undefined || record.injected === filter.injected)
      && (filter?.kind === undefined || (record.kind ?? 'fact') === filter.kind))
  }

  async search(query: string, filter?: MemoryFilter, projectCwd?: string): Promise<MemoryHit[]> {
    const records = await this.list(filter, projectCwd)
    // 0.5.2：content 与 keywords 分离打加权 BM25（人工关键词命中权重更高）
    const scores = bm25FieldScores(query, records.map(record => ({
      body: record.content,
      tags: record.keywords.join(' '),
    })))
    const bm25Ranked = records
      .map((record, index) => ({ record, score: scores[index] ?? 0 }))
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score)
    // 0.5.3：命中即标记使用（冷热追踪）——写回按命中快照之后执行，不影响本次结果
    await this.markUsed(bm25Ranked.map(hit => hit.record.id), projectCwd)
    // 0.5.2：配置 embeddings 时与语义结果 RRF 融合；缺省/失败降级回纯 BM25
    if (this.config.embeddings === undefined) return bm25Ranked
    try {
      const semantic = await this.semanticRanking(query, records.map(record => record.id), projectCwd)
      if (semantic.length === 0) return bm25Ranked
      const byId = new Map(records.map(record => [String(record.id), record]))
      return rrfFuse([
        bm25Ranked.map(hit => String(hit.record.id)),
        semantic.map(hit => String(hit.id)),
      ]).flatMap(([id, score]) => {
        const record = byId.get(id)
        return record === undefined ? [] : [{ record, score }]
      })
    } catch (error) {
      // 语义通道失败降级：不影响检索可用性（BM25 结果照常返回）
      this.ctx.logger?.warn?.(`dsh-memory: semantic search degraded: ${error instanceof Error ? error.message : String(error)}`)
      return bm25Ranked
    }
  }

  /**
   * 语义排序（0.5.2）：查询向量 + 候选向量的余弦相似度，仅在有
   * embeddings 配置时被调用。缺失向量（新增/更新过的记录）在此补生成
   * 并持久化（vector 字段）；生成失败抛给调用方降级。
   */
  private async semanticRanking(query: string, ids: MemoryId[], projectCwd?: string): Promise<Array<{ id: MemoryId; score: number }>> {
    const config = this.config.embeddings
    if (config === undefined) return []
    const similarity = config.similarity ?? cosineSimilarity
    const topK = this.config.semanticTopK ?? 5
    const queryVector = (await config.embed([query]))?.[0]
    if (queryVector === undefined) return []

    // 缺失向量批量补写（本轮直接用本地生成的向量参与打分，写回不阻塞结果）
    const missing: Array<{ table: KvTable<string, StoredBlock>, id: MemoryId, content: string }> = []
    for (const id of ids) {
      const table = this.tableOf(id, projectCwd)
      const block = table?.get(id)
      if (table === undefined || block === undefined) continue
      if (block.vector === undefined) missing.push({ table, id, content: block.content })
    }
    const fresh = new Map<string, number[]>()
    if (missing.length > 0) {
      const vectors = await config.embed(missing.map(missingRecord => missingRecord.content))
      for (const [index, missingRecord] of missing.entries()) {
        const vector = vectors[index]
        if (vector === undefined) continue
        fresh.set(String(missingRecord.id), [...vector])
        const block = missingRecord.table.get(missingRecord.id)
        if (block !== undefined) {
          await missingRecord.table.put(missingRecord.id, { ...block, vector: [...vector] })
        }
      }
    }

    const scored: Array<{ id: MemoryId; score: number }> = []
    for (const id of ids) {
      const block = this.tableOf(id, projectCwd)?.get(id)
      const vector = fresh.get(String(id)) ?? block?.vector
      if (vector === undefined) continue
      scored.push({ id, score: similarity(queryVector, vector) })
    }
    return scored
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
  }

  /** 按已知 id 定位记录所在表（global 优先，其次当前工作区表）。 */
  private tableOf(id: MemoryId, projectCwd?: string): KvTable<string, StoredBlock> | undefined {
    const global = this.requireTable('global')
    if (global.get(id) !== undefined) return global
    if (projectCwd === undefined || projectCwd === '') return undefined
    const project = this.projectTables.get(join(projectCwd))
    return project !== undefined && project.get(id) !== undefined ? project : undefined
  }

  /** 命中标记：把 lastUsedAt 写回（命中记录不存在时跳过；不 emit 事件——统计性字段）。 */
  private async markUsed(ids: MemoryId[], projectCwd?: string): Promise<void> {
    if (ids.length === 0) return
    const now = Date.now()
    const global = this.requireTable('global')
    const project = projectCwd === undefined || projectCwd === ''
      ? undefined
      : this.projectTables.get(join(projectCwd))
    for (const id of ids) {
      const globalBlock = global.get(id)
      if (globalBlock !== undefined) {
        await global.put(id, { ...globalBlock, lastUsedAt: now })
        continue
      }
      if (project !== undefined) {
        const block = project.get(id)
        if (block !== undefined) await project.put(id, { ...block, lastUsedAt: now })
      }
    }
  }

  async forget(id: MemoryId, projectCwd?: string): Promise<boolean> {
    if (await this.requireTable('global').delete(id)) {
      this.ctx.emit('memory/changed', { operation: 'forgotten', id })
      return true
    }
    const project = await this.projectTableFor(projectCwd)
    if (project !== undefined && await project.delete(id)) {
      this.ctx.emit('memory/changed', { operation: 'forgotten', id })
      return true
    }
    return false
  }

  async setStatus(id: MemoryId, status: MemoryStatus, projectCwd?: string): Promise<MemoryRecord> {
    const global = this.requireTable('global').get(id)
    if (global !== undefined) {
      const updated: StoredBlock = {
        ...global,
        status,
        // 旧数据可能缺 injected，写回时补全（读时迁移值）
        injected: normalizeBlock(global).injected,
        updatedAt: Date.now(),
      }
      await this.requireTable('global').put(id, updated)
      const record = toRecord(id, updated)
      this.ctx.emit('memory/changed', { operation: 'status', id, status })
      return record
    }
    const project = await this.projectTableFor(projectCwd)
    if (project !== undefined) {
      const block = project.get(id)
      if (block !== undefined) {
        const updated: StoredBlock = {
          ...block,
          status,
          injected: normalizeBlock(block).injected,
          updatedAt: Date.now(),
        }
        await project.put(id, updated)
        const record = toRecord(id, updated)
        this.ctx.emit('memory/changed', { operation: 'status', id, status })
        return record
      }
    }
    throw new Error(`cannot set status of unknown memory '${id}'`)
  }

  /**
   * 注入维度开关（0.3.0）：只改 injected，不动审核状态。供 UI 面板
   * 「常驻注入」开关调用（remote.setInjected）。
   */
  async setInjected(id: MemoryId, injected: boolean, projectCwd?: string): Promise<MemoryRecord> {
    const locate = async (): Promise<{ table: KvTable<string, StoredBlock>, block: StoredBlock } | undefined> => {
      const global = this.requireTable('global').get(id)
      if (global !== undefined) return { table: this.requireTable('global'), block: global }
      const project = await this.projectTableFor(projectCwd)
      if (project !== undefined) {
        const block = project.get(id)
        if (block !== undefined) return { table: project, block }
      }
      return undefined
    }
    const found = await locate()
    if (found === undefined) throw new Error(`cannot set injected of unknown memory '${id}'`)
    // 模板永不注入（0.6.0）：prompt 记录拒绝开关（UI 对该类不展示开关，此处兜底）
    if ((found.block.kind ?? 'fact') === 'prompt') {
      throw new Error(`cannot set injected of prompt record '${id}': prompt templates are never injected`)
    }
    const updated: StoredBlock = {
      ...found.block,
      status: normalizeBlock(found.block).status,
      injected,
      updatedAt: Date.now(),
    }
    await found.table.put(id, updated)
    const record = toRecord(id, updated)
    this.ctx.emit('memory/changed', { operation: 'injected', id, injected })
    return record
  }

  /**
   * 修改一条记忆的内容/关键词（0.3.1 整理记忆用）。内容被模型改动后
   * 必须重新人工审核：status 重置为 suggested（自然停止注入——注入仅对
   * approved 生效）；injected 保留原值（审核通过后注入开关原样恢复）。
   */
  async update(id: MemoryId, patch: { content?: string, keywords?: string[] }, projectCwd?: string): Promise<MemoryRecord> {
    const applyPatch = (block: StoredBlock): StoredBlock => {
      const normalized = normalizeBlock(block)
      return {
        ...block,
        status: 'suggested',
        injected: normalized.injected,
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.keywords === undefined ? {} : { keywords: patch.keywords.map(keyword => keyword.toLowerCase()) }),
        updatedAt: Date.now(),
      }
    }
    const global = this.requireTable('global').get(id)
    if (global !== undefined) {
      const updated = applyPatch(global)
      await this.requireTable('global').put(id, updated)
      const record = toRecord(id, updated)
      this.ctx.emit('memory/changed', { operation: 'status', id, status: 'suggested' })
      return record
    }
    const project = await this.projectTableFor(projectCwd)
    if (project !== undefined) {
      const block = project.get(id)
      if (block !== undefined) {
        const updated = applyPatch(block)
        await project.put(id, updated)
        const record = toRecord(id, updated)
        this.ctx.emit('memory/changed', { operation: 'status', id, status: 'suggested' })
        return record
      }
    }
    throw new Error(`cannot update unknown memory '${id}'`)
  }

  /**
   * 预热某工作区的 project 表（异步打开并缓存）。system prompt 的
   * `memory:recall` provider 是同步回调——只读已打开的表；预热让
   * 会话创建/首次请求后本轮或下一轮即可注入工作区记忆。
   */
  async ensureProjectOpen(projectCwd: string): Promise<void> {
    const key = join(projectCwd)
    if (this.projectTables.has(key)) return
    await this.projectTableFor(key)
  }

  /**
   * 注入专用（0.3.4 + 0.5.1）：system prompt 的 `memory:recall` context
   * provider 可经 AssembleContext.agent 拿到当前会话 header.cwd，因此
   * 注入 = global 的 approved+injected + 当前会话工作区的 approved+injected。
   * provider 是同步回调：只读已打开/缓存的表，未打开的工作区本轮为空
   * （`ensureProjectOpen` 提供预热，工具/面板路径也会打开）。
   */
  recallRecords(projectCwd?: string): MemoryRecord[] {
    const injected = (table: KvTable<string, StoredBlock>): MemoryRecord[] =>
      this.recordsOf(table).filter(record => record.status === 'approved' && record.injected)
    const global = injected(this.requireTable('global'))
    if (projectCwd === undefined || projectCwd === '') return global
    const project = this.projectTables.get(join(projectCwd))
    if (project === undefined) return global
    return [...global, ...injected(project)]
  }

  private async allRecords(namespace?: MemoryNamespace, projectCwd?: string): Promise<MemoryRecord[]> {
    if (namespace === 'project') {
      const project = await this.projectTableFor(projectCwd)
      if (project === undefined) return []
      return this.recordsOf(project)
    }
    if (namespace === 'global') return this.recordsOf(this.requireTable('global'))
    const project = await this.projectTableFor(projectCwd)
    return [
      ...this.recordsOf(this.requireTable('global')),
      ...(project === undefined ? [] : this.recordsOf(project)),
    ]
  }

  private recordsOf(table: KvTable<string, StoredBlock>): MemoryRecord[] {
    return [...table.entries()].map(([id, block]) => toRecord(id, block))
  }

  private tableFor(namespace: MemoryNamespace): KvTable<string, StoredBlock> {
    return this.requireTable(namespace)
  }

  private requireTable(namespace: MemoryNamespace): KvTable<string, StoredBlock> {
    const table = namespace === 'global' ? this.globalTable : undefined
    if (table === undefined) throw new Error('memory engine is not started yet')
    return table
  }

  // ── 提示词模板库（0.6.0）：md 文件是事实源，索引记录 kind='prompt' ──────
  /** 全局模板根（默认 `$DSH_HOME/prompt-library`，可配置覆盖）。 */
  private promptGlobalDir(): string {
    return this.config.promptGlobalRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'prompt-library')
  }

  /** project 模板根（随工作区 `<workspace>/.dsh/prompt-library`，与记忆同构）。 */
  private promptProjectDir(projectCwd?: string): string {
    if (projectCwd === undefined || projectCwd === '') return ''
    return join(projectCwd, '.dsh', 'prompt-library')
  }

  /** 稳定索引 id（按路径 hash；文件删除后随刷新清理）。 */
  private promptIdOf(path: string): MemoryId {
    let h = 5381
    const text = path.toLowerCase()
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
    return MemoryId(`prompt-${Math.abs(h).toString(36)}`)
  }

  /**
   * 扫描模板目录并同步索引（mtime 惰性：未变条目零写；目录缺失 = 空库）。
   * @returns 统计（扫描数/变更数/清理数 + 坏文件警告）。
   */
  async refreshPromptIndex(projectCwd?: string): Promise<{ scan: number, changed: number, removed: number, warnings: string[] }> {
    const globalDir = this.promptGlobalDir()
    const projectDir = this.promptProjectDir(projectCwd)
    const globalScan = scanPromptDir(globalDir)
    const projectScan = scanPromptDir(projectDir)
    const scanned = [...globalScan.files, ...projectScan.files]
    const warnings = [...globalScan.warnings, ...projectScan.warnings]
    const globalTable = this.requireTable('global')
    const projectTable = projectCwd !== undefined && projectCwd !== ''
      ? await this.projectTableFor(projectCwd)
      : undefined
    const existing = await this.list({ kind: 'prompt' }, projectCwd)
    const existingById = new Map(existing.map(record => [String(record.id), record]))
    const seen = new Set<string>()
    let changed = 0
    let removed = 0
    const now = Date.now()
    for (const file of scanned) {
      const id = this.promptIdOf(file.path)
      seen.add(String(id))
      const isGlobal = file.path.startsWith(globalDir)
      const table = isGlobal ? globalTable : projectTable
      if (table === undefined) continue
      const prev = existingById.get(String(id))
      if (prev?.meta !== undefined && prev.meta.mtime === file.mtime) continue // mtime 未变：零写
      const keywords = [
        file.meta.name,
        ...(file.meta.dimension !== undefined ? [file.meta.dimension] : []),
        ...(file.meta.difficulty !== undefined ? [file.meta.difficulty] : []),
        ...file.meta.tags,
      ].filter(keyword => keyword !== '').map(keyword => keyword.toLowerCase())
      const block: StoredBlock = {
        namespace: isGlobal ? 'global' : 'project',
        status: 'approved',   // 文件存在即生效（设计文档 §三：模板不做审核流）
        injected: false,      // 模板永不注入
        content: [file.meta.name, file.meta.dimension ?? '', file.meta.difficulty ?? '', file.meta.tags.join(' '), file.summary]
          .filter(part => part !== '').join(' '),
        keywords,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        kind: 'prompt',
        meta: {
          seq: file.meta.seq,
          name: file.meta.name,
          dimension: file.meta.dimension,
          difficulty: file.meta.difficulty,
          tags: file.meta.tags,
          summary: file.summary,
          path: file.path,
          mtime: file.mtime,
          source: file.meta.source,
        },
      }
      await table.put(id, block)
      changed++
    }
    for (const record of existing) {
      if (seen.has(String(record.id))) continue
      if (record.meta === undefined) continue
      const isGlobal = record.meta.path.startsWith(globalDir)
      const table = isGlobal ? globalTable : projectTable
      if (table !== undefined) {
        await table.delete(record.id)
        removed++
      }
    }
    return { scan: scanned.length, changed, removed, warnings }
  }

  /**
   * 取模板（id 或名称/路径片段定位），返回 md 全文（直读文件，忽略索引缓存）。
   * @throws 未命中或文件解析失败（错误信息可读）。
   */
  async promptGet(nameOrId: string, projectCwd?: string): Promise<PromptFile> {
    const records = await this.list({ kind: 'prompt' }, projectCwd)
    const needle = nameOrId.trim()
    const hit = records.find(record => {
      if (record.meta === undefined) return false
      const stem = (record.meta.path.split(/[\\/]/).pop() ?? '').replace(/\.md$/i, '')
      const afterSeq = stem.replace(/^\d+_/, '') // 去掉序号前缀：36_名称 → 名称
      return String(record.id) === needle || afterSeq === needle || afterSeq.includes(needle)
    })
    if (hit === undefined || hit.meta === undefined) {
      throw new Error(`prompt '${nameOrId}' not found（可用 prompt_list 查看全部）`)
    }
    const text = readFileSync(hit.meta.path, 'utf8')
    const parsed = parsePromptFile(hit.meta.path, text)
    if (!parsed.ok) throw new Error(`prompt file ${hit.meta.path} parse failed: ${parsed.error}`)
    return parsed.file
  }

  /**
   * 新增模板：写 md 文件（序号自动分配/文件名安全化/同名防覆盖）+ 刷新索引。
   * 返回索引记录（模型新增 source='agent'，UI 角标提示）。
   */
  async promptAdd(
    input: { name: string, dimension?: string, difficulty?: string, tags?: string[], content: string, fallback?: string, source: 'user' | 'agent', namespace?: MemoryNamespace },
    projectCwd?: string,
  ): Promise<MemoryRecord> {
    const dir = input.namespace === 'project' ? this.promptProjectDir(projectCwd) : this.promptGlobalDir()
    if (dir === '') throw new Error('cannot write project prompt without a workspace cwd')
    const path = writePromptFile(dir, input)
    await this.refreshPromptIndex(projectCwd)
    const found = (await this.list({ kind: 'prompt' }, projectCwd))
      .find(record => String(record.id) === String(this.promptIdOf(path)))
    if (found === undefined) throw new Error('prompt written but index refresh failed')
    return found
  }

  /** 删除模板：md 文件与索引一并删除；未命中返回 false。 */
  async promptRemove(idOrName: string, projectCwd?: string): Promise<boolean> {
    let file: PromptFile | null = null
    try {
      file = await this.promptGet(idOrName, projectCwd)
    } catch {
      return false
    }
    rmSync(file.path, { force: true })
    await this.refreshPromptIndex(projectCwd)
    return true
  }
}
