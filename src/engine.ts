/**
 * The memory service (`ctx.memory`): durable plaintext records over
 * `ctx.storage.domain` with BM25 retrieval. A record is always created
 * `suggested` and becomes effective only through `setStatus` — the human gate.
 */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
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

const memorySpec = defineDomain({
  name: 'memory',
  version: 1,
  tables: {
    blocks: domainTable<string, StoredBlock>(blockSchema),
  },
})

function toRecord(id: string, block: StoredBlock): MemoryRecord {
  return { id: MemoryId(id), ...block }
}

/** Cross-session plaintext memory over the storage hub's domain form. */
export class MemoryEngine extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, StoredBlock>

  constructor(ctx: import('@deepseek-ai/cordis').Context) {
    super(ctx, 'memory')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(memorySpec)
    this.ctx.effect(() => () => domain.close(), 'memory.domainClose')
    this.table = domain.table('blocks')
  }

  /** Create one record in `suggested` status — never self-promoting. */
  async remember(input: MemoryWrite): Promise<MemoryRecord> {
    const table = this.requireTable()
    const id = randomUUID()
    const now = Date.now()
    const block: StoredBlock = {
      namespace: input.namespace ?? 'global',
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
    const records = [...this.requireTable().entries()].map(([id, block]) => toRecord(id, block))
    return records.filter(record =>
      (filter?.namespace === undefined || record.namespace === filter.namespace)
      && (filter?.status === undefined || record.status === filter.status))
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
    const existed = await this.requireTable().delete(id)
    if (existed) this.ctx.emit('memory/changed', { operation: 'forgotten', id })
    return existed
  }

  async setStatus(id: MemoryId, status: MemoryStatus): Promise<MemoryRecord> {
    const table = this.requireTable()
    const block = table.get(id)
    if (block === undefined) {
      throw new Error(`cannot set status of unknown memory '${id}'`)
    }
    const updated: StoredBlock = { ...block, status, updatedAt: Date.now() }
    await table.put(id, updated)
    const record = toRecord(id, updated)
    this.ctx.emit('memory/changed', { operation: 'status', id, status })
    return record
  }

  private requireTable(): KvTable<string, StoredBlock> {
    if (this.table === undefined) throw new Error('memory engine is not started yet')
    return this.table
  }
}
