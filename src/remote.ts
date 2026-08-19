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
import { SELF_DESCRIPTION } from './self.ts'

/** Client-callable memory surface; registered as the `memory` Typert namespace. */
export class MemoryGateway extends TypertRemoteService {
  static inject = ['memory']

  constructor(ctx: Context) {
    // Service key 'memoryRemote' avoids colliding with MemoryEngine's 'memory';
    // the wire namespace stays 'memory' so clients call `remote.memory.*`.
    super(ctx, 'memoryRemote', { namespace: 'memory' })
  }

  /** List every stored memory, optionally filtered by namespace/status/injected and workspace cwd. */
  @Remote('list')
  async list(filter?: MemoryFilter, cwd?: string): Promise<MemoryRecord[]> {
    return this.ctx.memory.list(filter, cwd)
  }

  /** Recall memories by keyword; deterministic literal matching. */
  @Remote('search')
  async search(query: string, filter?: MemoryFilter, cwd?: string): Promise<MemoryHit[]> {
    return this.ctx.memory.search(query, filter, cwd)
  }

  /** Approve a suggested memory (review status `suggested` → `approved`); does not change injection. */
  @Remote('confirm')
  confirm(id: string, cwd?: string): Promise<MemoryRecord> {
    return this.ctx.memory.setStatus(MemoryId(id), 'approved', cwd)
  }

  /**
   * Toggle the persistent-injection switch (`injected`) — the UI panel's
   * 「常驻注入」 switch; does not change the review status.
   */
  @Remote('setInjected')
  setInjected(id: string, injected: boolean, cwd?: string): Promise<MemoryRecord> {
    return this.ctx.memory.setInjected(MemoryId(id), injected, cwd)
  }

  /** Delete one stored memory by id. */
  @Remote('forget')
  forget(id: string, cwd?: string): Promise<boolean> {
    return this.ctx.memory.forget(MemoryId(id), cwd)
  }

  /** Force-reload storage files (external edits; JsonStorageBackend has no watch). */
  @Remote('reload')
  async reload(cwd?: string): Promise<MemoryRecord[]> {
    await this.ctx.memory.reload()
    return this.ctx.memory.list({}, cwd)
  }

  /**
   * 注入预览（0.3.5）：开发者查看当前注入到 system prompt 的记忆内容
   * ——self 自述 + 实际注入的 global approved+injected 记忆。
   */
  @Remote('injectionPreview')
  injectionPreview(): { self: string, injected: MemoryRecord[] } {
    return { self: SELF_DESCRIPTION, injected: this.ctx.memory.recallRecords() }
  }
}

export default MemoryGateway
