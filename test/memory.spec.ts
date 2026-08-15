import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  const globalRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-global-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-project-'))
  const fiber = await ctx.plugin(plugin, { globalRoot, projectRoot })
  return { ctx, fiber, globalRoot, projectRoot }
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

  it('stores global and project memories in physically separate roots', async () => {
    const { ctx, globalRoot, projectRoot } = await setup()

    const globalRecord = await ctx.memory.remember({ content: 'global convention', keywords: ['global'] })
    const projectRecord = await ctx.memory.remember({
      content: 'Vue3 用 <script setup>', keywords: ['vue'], namespace: 'project',
    })

    // Physical separation: global lands in the home root, project in the project root.
    expect(existsSync(join(globalRoot, 'memory.json'))).toBe(true)
    expect(existsSync(join(projectRoot, 'memory_project.json'))).toBe(true)

    expect(globalRecord.namespace).toBe('global')
    expect(projectRecord.namespace).toBe('project')

    expect(ctx.memory.list()).toHaveLength(2)
    expect(ctx.memory.list({ namespace: 'project' }).map(r => r.content))
      .toEqual(['Vue3 用 <script setup>'])
    expect(ctx.memory.list({ namespace: 'global' }).map(r => r.content))
      .toEqual(['global convention'])
  })

  it('recalls, promotes, and forgets across both namespaces', async () => {
    const { ctx } = await setup()

    const record = await ctx.memory.remember({ content: '中文编码规范优先', keywords: ['编码'] })
    expect(ctx.memory.search('编码').map(hit => hit.record.content)).toEqual(['中文编码规范优先'])

    const promoted = await ctx.memory.setStatus(record.id, 'auto')
    expect(promoted.status).toBe('auto')

    expect(await ctx.memory.forget(record.id)).toBe(true)
    expect(await ctx.memory.forget(record.id)).toBe(false)
    expect(ctx.memory.list()).toEqual([])
  })
})
