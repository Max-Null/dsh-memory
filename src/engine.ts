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
/** `suggested` is model-written; only a human confirmation promotes it. */
export type MemoryStatus = 'suggested' | 'auto' | 'suggest'

export interface MemoryRecord {
  id: MemoryId
  namespace: MemoryNamespace
  status: MemoryStatus
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryEngine
  }
  interface Events {
    /** A memory record was created, deleted, or promoted/demoted. */
    'memory/changed'(change: MemoryChange): void
  }
}

interface StoredBlock {
  namespace: MemoryNamespace
  status: MemoryStatus
  content: string
  keywords: string[]
  createdAt: number
  updatedAt: number
}

const blockSchema = z.object({
  namespace: z.enum(['global', 'project']),
  status: z.enum(['suggested', 'auto', 'suggest']),
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

function toRecord(id: string, block: StoredBlock): MemoryRecord {
  return { id: MemoryId(id), ...block }
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
 * `global` lives in the harness home, `project` in the project folder.
 */
export class MemoryEngine extends Service {
  static inject = ['storage']

  private globalTable?: KvTable<string, StoredBlock>
  private projectTable?: KvTable<string, StoredBlock>
  private facility?: DomainFacility

  constructor(ctx: import('@deepseek-ai/cordis').Context, private readonly config: MemoryConfig = {}) {
    super(ctx, 'memory')
  }

  protected async [Service.init](): Promise<void> {
    // backend 只注册一次：registry 对重名注册抛 duplicate-backend
    // （storage/tests/registry.spec 实测），reload 不得重复注册。
    const globalBackend = new JsonStorageBackend(this.config.globalRoot ?? globalRoot())
    const projectBackend = new JsonStorageBackend(this.config.projectRoot ?? projectRoot())
    this.ctx.storage.backend.register('memory-global', globalBackend)
    this.ctx.storage.backend.register('memory-project', projectBackend)
    await this.openFacility()
    this.ctx.effect(() => () => { void this.facility?.closeAll() }, 'memory.domainsClose')
  }

  /** 打开存储域（init 与 reload 共用；backend 复用已注册实例）。 */
  private async openFacility(): Promise<void> {
    const facility = new DomainFacility(this.ctx, {
      backend: 'memory-global',
      routes: { memory_project: 'memory-project' },
    })
    const globalDomain = await facility.open(memorySpec('memory'))
    const projectDomain = await facility.open(memorySpec('memory_project'))
    this.facility = facility

    this.globalTable = globalDomain.table('blocks')
    this.projectTable = projectDomain.table('blocks')
  }

  /**
   * 强制重载存储：关闭两域后重开（unit 释放后 backend 重读文件），
   * 放弃内存缓存。供外部编辑记忆文件后刷新（JsonStorageBackend 打开时
   * 加载一次，无 watch——2026-08-19 用户实测面板不感知外部编辑）。
   */
  async reload(): Promise<void> {
    await this.facility?.closeAll()
    await this.openFacility()
  }

  /** Create one record in `suggested` status — never self-promoting. */
  async remember(input: MemoryWrite): Promise<MemoryRecord> {
    const namespace = input.namespace ?? 'global'
    const table = this.tableFor(namespace)
    const id = randomUUID()
    const now = Date.now()
    const block: StoredBlock = {
      namespace,
      status: 'suggested',
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

  list(filter?: MemoryFilter): MemoryRecord[] {
    const records = this.allRecords(filter?.namespace)
    return records.filter(record =>
      (filter?.status === undefined || record.status === filter.status))
  }

  search(query: string, filter?: MemoryFilter): MemoryHit[] {
    const records = this.list(filter)
    const docs = records.map(record => `${record.content} ${record.keywords.join(' ')}`)
    const scores = bm25Scores(query, docs)
    return records
      .map((record, index) => ({ record, score: scores[index] ?? 0 }))
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score)
  }

  async forget(id: MemoryId): Promise<boolean> {
    if (await this.requireTable('global').delete(id)) {
      this.ctx.emit('memory/changed', { operation: 'forgotten', id })
      return true
    }
    if (await this.requireTable('project').delete(id)) {
      this.ctx.emit('memory/changed', { operation: 'forgotten', id })
      return true
    }
    return false
  }

  async setStatus(id: MemoryId, status: MemoryStatus): Promise<MemoryRecord> {
    const global = this.requireTable('global').get(id)
    if (global !== undefined) {
      const updated: StoredBlock = { ...global, status, updatedAt: Date.now() }
      await this.requireTable('global').put(id, updated)
      const record = toRecord(id, updated)
      this.ctx.emit('memory/changed', { operation: 'status', id, status })
      return record
    }
    const project = this.requireTable('project').get(id)
    if (project !== undefined) {
      const updated: StoredBlock = { ...project, status, updatedAt: Date.now() }
      await this.requireTable('project').put(id, updated)
      const record = toRecord(id, updated)
      this.ctx.emit('memory/changed', { operation: 'status', id, status })
      return record
    }
    throw new Error(`cannot set status of unknown memory '${id}'`)
  }

  private allRecords(namespace?: MemoryNamespace): MemoryRecord[] {
    if (namespace === 'project') return this.recordsOf(this.requireTable('project'))
    if (namespace === 'global') return this.recordsOf(this.requireTable('global'))
    return [
      ...this.recordsOf(this.requireTable('global')),
      ...this.recordsOf(this.requireTable('project')),
    ]
  }

  private recordsOf(table: KvTable<string, StoredBlock>): MemoryRecord[] {
    return [...table.entries()].map(([id, block]) => toRecord(id, block))
  }

  private tableFor(namespace: MemoryNamespace): KvTable<string, StoredBlock> {
    return this.requireTable(namespace)
  }

  private requireTable(namespace: MemoryNamespace): KvTable<string, StoredBlock> {
    const table = namespace === 'global' ? this.globalTable : this.projectTable
    if (table === undefined) throw new Error('memory engine is not started yet')
    return table
  }
}
