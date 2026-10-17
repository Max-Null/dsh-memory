import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { runMemoryBackup } from '../src/backup.ts'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-backup-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('memory backup', () => {
  it('copies global and project memory files into a stamped directory', () => {
    const base = tempRoot()
    const globalRoot = join(base, 'home', 'storages')
    const projectRoot = join(base, 'proj', '.dsh', 'storages')
    const targetRoot = join(base, 'backups')
    mkdirSync(globalRoot, { recursive: true })
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(join(globalRoot, 'memory.json'), '{"a":1}')
    writeFileSync(join(projectRoot, 'memory_project_x.json'), '{"b":2}')
    writeFileSync(join(globalRoot, 'unrelated.txt'), 'nope')

    const run = runMemoryBackup({ globalRoot, projectRoot, targetRoot, keep: 3, now: new Date(2026, 9, 18, 0, 30, 0) })

    expect(run.dir).toBe(join(targetRoot, '20261018-003000'))
    expect([...run.files].sort()).toEqual(['memory.json', 'memory_project_x.json'])
    expect(readFileSync(join(targetRoot, '20261018-003000', 'memory.json'), 'utf8')).toBe('{"a":1}')
    expect(existsSync(join(targetRoot, '20261018-003000', 'unrelated.txt'))).toBe(false)
  })

  it('does not create a directory when there is nothing to back up', () => {
    const base = tempRoot()
    const run = runMemoryBackup({ globalRoot: join(base, 'g'), projectRoot: join(base, 'p'), targetRoot: join(base, 'b'), keep: 3 })
    expect(run.dir).toBeNull()
    expect(existsSync(join(base, 'b'))).toBe(false)
  })

  it('prunes older backups beyond keep', () => {
    const base = tempRoot()
    const globalRoot = join(base, 'g')
    const targetRoot = join(base, 'b')
    mkdirSync(globalRoot, { recursive: true })
    writeFileSync(join(globalRoot, 'memory.json'), '{}')
    for (const minute of [0, 1, 2, 3]) {
      runMemoryBackup({ globalRoot, projectRoot: join(base, 'p'), targetRoot, keep: 2, now: new Date(2026, 9, 18, 0, minute, 0) })
    }
    expect(readdirSync(targetRoot).sort()).toEqual(['20261018-000200', '20261018-000300'])
  })

  it('reports an error instead of throwing when the target cannot be created', () => {
    const base = tempRoot()
    const globalRoot = join(base, 'g')
    mkdirSync(globalRoot, { recursive: true })
    writeFileSync(join(globalRoot, 'memory.json'), '{}')
    const blocker = join(base, 'blocked')
    writeFileSync(blocker, 'not a directory')
    const run = runMemoryBackup({ globalRoot, projectRoot: join(base, 'p'), targetRoot: blocker, keep: 2 })
    expect(run.dir).toBeNull()
    expect(run.error).toBeDefined()
  })

  it('runs a backup when the plugin disposes (covering the window before the first interval)', async () => {
    const base = tempRoot()
    const globalRoot = join(base, 'global')
    mkdirSync(globalRoot, { recursive: true })
    // 合法 unit 头：引擎打开时会校验 name/version，裸 JSON 会被拒。
    writeFileSync(join(globalRoot, 'memory.json'), JSON.stringify({ unit: { name: 'memory', version: 1 }, global: null, tables: { blocks: {} } }))
    const targetRoot = join(base, 'backups')

    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    ctx.provide('webServer' as never, { register: () => () => {} } as never)
    ctx.provide('webStartup' as never, { trustedHosts: [] } as never)
    const fiber = await ctx.plugin(plugin, { globalRoot, backup: { targetRoot, intervalMinutes: 60 } })
    await fiber.dispose()

    const dirs = existsSync(targetRoot) ? readdirSync(targetRoot) : []
    expect(dirs).toHaveLength(1)
    expect(existsSync(join(targetRoot, dirs[0] ?? '', 'memory.json'))).toBe(true)
  })
})
