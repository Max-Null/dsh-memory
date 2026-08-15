import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(await mkdtemp(join(tmpdir(), 'dsh-memory-')))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  const fiber = await ctx.plugin(plugin)
  return { ctx, fiber }
}

describe('dsh-memory plugin', () => {
  it('registers the memory service, four tools, guidance, and recall context', async () => {
    const { ctx, fiber } = await setup()

    expect(ctx.memory.list()).toEqual([])
    for (const name of ['memory_save', 'memory_list', 'memory_search', 'memory_forget']) {
      expect(ctx.tools.get(name)?.name).toBe(name)
    }
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'tool:memory')).toBe(true)
    expect(assembly.contexts.some(context => context.name === 'memory:recall')).toBe(true)

    await fiber.dispose()
    expect(ctx.tools.get('memory_save')).toBeUndefined()
  })

  it('persists, recalls, promotes, and forgets across engine calls', async () => {
    const { ctx } = await setup()

    const record = await ctx.memory.remember({ content: 'Vue3 用 <script setup>', keywords: ['vue', 'vue3'] })
    expect(record.status).toBe('suggested')

    expect(ctx.memory.search('vue').map(hit => hit.record.content)).toEqual(['Vue3 用 <script setup>'])

    const promoted = await ctx.memory.setStatus(record.id, 'auto')
    expect(promoted.status).toBe('auto')

    const assembly = await ctx.systemPrompt.assemble()
    const recall = assembly.contexts.find(context => context.name === 'memory:recall')
    expect(recall?.text).toContain('[memory:')
    expect(recall?.text).toContain('Vue3 用 <script setup>')

    expect(await ctx.memory.forget(record.id)).toBe(true)
    expect(ctx.memory.list()).toEqual([])
  })
})
