/**
 * The memory service (`ctx.memory`): durable plaintext records over two
 * storage roots — `global` in the harness home, `project` in the current
 * project folder (`.dsh/`), so project memory follows the repository. A record
 * is always created `suggested` and becomes effective only through `setStatus`.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { bm25Scores } from './bm25.ts'

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
}

const blockSchema = z.object({
  namespace: z.enum(['global', 'project']),
  status: z.enum(['suggested', 'approved', 'auto', 'suggest']),
  injected: z.boolean().optional(),
  content: z.string(),
  keywords: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** Shared table shape; the two domains differ only by name and backend route. */
function memorySpec(name: string) {
  return defineDomain({
    name,
    version: 1,
    tables: { blocks: domainTable<string, StoredBlock>(blockSchema) },
  })
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
  return {
    id: MemoryId(id),
    namespace: block.namespace,
    ...normalizeBlock(block),
    content: block.content,
    keywords: block.keywords,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
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

/** Engine configuration: the two storage roots, defaulted to home and project. */
export interface MemoryConfig {
  /** Root for `global` memories; defaults to `$DSH_HOME/storages`. */
  globalRoot?: string
  /** Root for `project` memories; defaults to `<cwd>/.dsh/storages`. */
  projectRoot?: string
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
    const backend = new JsonStorageBackend(this.projectRootFor(key))
    this.ctx.storage.backend.register(backendName, backend)
    const facility = new DomainFacility(this.ctx, { backend: backendName, routes: {} })
    const domain = await facility.open(memorySpec(`memory_project_${backendName}`))
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
      && (filter?.injected === undefined || record.injected === filter.injected))
  }

  async search(query: string, filter?: MemoryFilter, projectCwd?: string): Promise<MemoryHit[]> {
    const records = await this.list(filter, projectCwd)
    const docs = records.map(record => `${record.content} ${record.keywords.join(' ')}`)
    const scores = bm25Scores(query, docs)
    return records
      .map((record, index) => ({ record, score: scores[index] ?? 0 }))
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score)
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
    const global = this.requireTable('global').get(id)
    if (global !== undefined) {
      const updated: StoredBlock = {
        ...global,
        status: normalizeBlock(global).status,
        injected,
        updatedAt: Date.now(),
      }
      await this.requireTable('global').put(id, updated)
      const record = toRecord(id, updated)
      this.ctx.emit('memory/changed', { operation: 'injected', id, injected })
      return record
    }
    const project = await this.projectTableFor(projectCwd)
    if (project !== undefined) {
      const block = project.get(id)
      if (block !== undefined) {
        const updated: StoredBlock = {
          ...block,
          status: normalizeBlock(block).status,
          injected,
          updatedAt: Date.now(),
        }
        await project.put(id, updated)
        const record = toRecord(id, updated)
        this.ctx.emit('memory/changed', { operation: 'injected', id, injected })
        return record
      }
    }
    throw new Error(`cannot set injected of unknown memory '${id}'`)
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
   * 注入专用（0.3.4）：systemPrompt context 是同步回调、无会话 cwd 可及，
   * 只返回 global 的 approved+injected（工作区记忆走检索/面板）。
   */
  recallRecords(): MemoryRecord[] {
    return this.recordsOf(this.requireTable('global'))
      .filter(record => record.status === 'approved' && record.injected)
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
}
