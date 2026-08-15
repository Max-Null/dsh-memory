// Verification: load the plugin through the Cordis Loader the same way a real
// `cordis.yml` composition does, then exercise the memory service and tools.
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


const ctx = new Context()
await ctx.plugin(Loader)

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-verify-'))

// Published DSH plugins, resolved by package name (as `cordis.yml` does).
await ctx.loader.create({ id: 'storage', name: '@deepseek-ai/dsh-storage' })
await ctx.loader.create({ id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root } })
await ctx.loader.create({ id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } })
await ctx.loader.create({ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' })
await ctx.loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })

// The plugin under test, by file URL (a published consumer uses its package name).
await ctx.loader.create({ id: 'memory', name: new URL('../dist/index.js', import.meta.url).href })

await ctx.loader.await()

const memory = ctx.get('memory')
if (!memory) throw new Error('memory engine not registered via the loader')

const record = await memory.remember({ content: 'loaded via cordis.yml loader', keywords: ['verify'] })
console.log('remembered:', record.status, '|', record.content)

const tools = ['memory_save', 'memory_list', 'memory_search', 'memory_forget'].map(n => ctx.tools.get(n)?.name)
console.log('tools:', tools.join(', '))

const assembly = await ctx.systemPrompt.assemble()
console.log('section tool:memory:', assembly.sections.some(s => s.name === 'tool:memory'))
console.log('context memory:recall:', assembly.contexts.some(c => c.name === 'memory:recall'))

console.log('VERIFY OK — plugin loads and runs through the Cordis Loader')
process.exit(0)
