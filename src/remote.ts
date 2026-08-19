/**
 * `MemoryGateway` — Typert Remote projection of the memory service, so a Web
 * client can browse, search, confirm, and forget memories through `remote.memory`.
 *
 * Read-only except for the two human-owned mutations (`confirm` promotes a
 * `suggested` record to `auto`; `forget` deletes one). It owns no storage or
 * state — every call delegates to the process-local `ctx.memory` engine.
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { MemoryFilter, MemoryHit, MemoryRecord } from './engine.ts'
import { MemoryId } from './engine.ts'

/** Client-callable memory surface; registered as the `memory` Typert namespace. */
export class MemoryGateway extends TypertRemoteService {
  static inject = ['memory']

  constructor(ctx: Context) {
    // Service key 'memoryRemote' avoids colliding with MemoryEngine's 'memory';
    // the wire namespace stays 'memory' so clients call `remote.memory.*`.
    super(ctx, 'memoryRemote', { namespace: 'memory' })
  }

  /** List every stored memory, optionally filtered by namespace or status. */
  @Remote('list')
  list(filter?: MemoryFilter): MemoryRecord[] {
    return this.ctx.memory.list(filter)
  }

  /** Recall memories by keyword; deterministic literal matching. */
  @Remote('search')
  search(query: string, filter?: MemoryFilter): MemoryHit[] {
    return this.ctx.memory.search(query, filter)
  }

  /** Approve a suggested memory (review status `suggested` → `approved`); does not change injection. */
  @Remote('confirm')
  confirm(id: string): Promise<MemoryRecord> {
    return this.ctx.memory.setStatus(MemoryId(id), 'approved')
  }

  /**
   * Toggle the persistent-injection switch (`injected`) — the UI panel's
   * 「常驻注入」 switch; does not change the review status.
   */
  @Remote('setInjected')
  setInjected(id: string, injected: boolean): Promise<MemoryRecord> {
    return this.ctx.memory.setInjected(MemoryId(id), injected)
  }

  /** Delete one stored memory by id. */
  @Remote('forget')
  forget(id: string): Promise<boolean> {
    return this.ctx.memory.forget(MemoryId(id))
  }

  /** Force-reload storage files (external edits; JsonStorageBackend has no watch). */
  @Remote('reload')
  async reload(): Promise<MemoryRecord[]> {
    await this.ctx.memory.reload()
    return this.ctx.memory.list()
  }
}

export default MemoryGateway
