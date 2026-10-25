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

    // 日记根由 `$DSH_HOME` 推出，且不像 `globalRoot` 那样有配置项能覆盖——把它指到临时目录，
    // 否则这条用例会去读真实的 `~/.dsh/diary`。
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(base, 'home')
    try {
      const ctx = new Context()
      await ctx.plugin(Storage)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry)
      ctx.provide('webServer' as never, { register: () => () => {} } as never)
      ctx.provide('webStartup' as never, { trustedHosts: [] } as never)
      const fiber = await ctx.plugin(plugin, { globalRoot, backup: { targetRoot, intervalMinutes: 60 } })
      await fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }

    const dirs = existsSync(targetRoot) ? readdirSync(targetRoot) : []
    expect(dirs).toHaveLength(1)
    expect(existsSync(join(targetRoot, dirs[0] ?? '', 'memory.json'))).toBe(true)
  })
})

describe('diary archive', () => {
  /** 一次调用所需的三个根；日记根按需建。 */
  function layout(): { globalRoot: string, projectRoot: string, diaryRoot: string, targetRoot: string } {
    const base = tempRoot()
    const globalRoot = join(base, 'g')
    const projectRoot = join(base, 'p')
    const diaryRoot = join(base, 'diary')
    mkdirSync(globalRoot, { recursive: true })
    mkdirSync(diaryRoot, { recursive: true })
    return { globalRoot, projectRoot, diaryRoot, targetRoot: join(base, 'b') }
  }

  it('archives diary entries beside the snapshot and records them in the manifest', () => {
    const { globalRoot, projectRoot, diaryRoot, targetRoot } = layout()
    writeFileSync(join(globalRoot, 'memory.json'), '{"a":1}')
    writeFileSync(join(diaryRoot, '2026-10-24.md'), '# 2026-10-24\n')
    writeFileSync(join(diaryRoot, '2026-10-25.md'), '# 2026-10-25\n')
    writeFileSync(join(diaryRoot, 'notes.txt'), '不是日记')

    const run = runMemoryBackup({ globalRoot, projectRoot, diaryRoot, targetRoot, keep: 3, now: new Date(2026, 9, 25, 12, 0, 0) })

    expect(run.diary).toEqual({ copied: 2, kept: 0 })
    expect(readdirSync(join(targetRoot, 'diary-archive')).sort()).toEqual(['2026-10-24.md', '2026-10-25.md'])
    const manifest = JSON.parse(readFileSync(join(targetRoot, '20261025-120000', 'manifest.json'), 'utf8'))
    expect(manifest.diary).toEqual({ root: diaryRoot, copied: 2, kept: 0 })
    // 日记不进快照目录：它只有累积归档这一份，不做时间点切片。
    expect(readdirSync(join(targetRoot, '20261025-120000')).sort()).toEqual(['manifest.json', 'memory.json'])
  })

  it('keeps unchanged entries and overwrites changed ones from the diary', () => {
    const { globalRoot, projectRoot, diaryRoot, targetRoot } = layout()
    writeFileSync(join(globalRoot, 'memory.json'), '{}')
    writeFileSync(join(diaryRoot, '2026-10-24.md'), '# 旧\n')
    writeFileSync(join(diaryRoot, '2026-10-25.md'), '# 不变\n')
    runMemoryBackup({ globalRoot, projectRoot, diaryRoot, targetRoot, keep: 3, now: new Date(2026, 9, 25, 12, 0, 0) })

    // 人回去改了一篇的错字——日记那一侧才是当前的。
    writeFileSync(join(diaryRoot, '2026-10-24.md'), '# 改过\n')
    const second = runMemoryBackup({ globalRoot, projectRoot, diaryRoot, targetRoot, keep: 3, now: new Date(2026, 9, 25, 13, 0, 0) })

    expect(second.diary).toEqual({ copied: 1, kept: 1 })
    expect(readFileSync(join(targetRoot, 'diary-archive', '2026-10-24.md'), 'utf8')).toBe('# 改过\n')
  })

  it('keeps entries that only exist in the archive and never prunes it', () => {
    const { globalRoot, projectRoot, diaryRoot, targetRoot } = layout()
    writeFileSync(join(globalRoot, 'memory.json'), '{}')
    writeFileSync(join(diaryRoot, '2026-10-25.md'), '# x\n')
    // 日记里已经没有的一篇：归档的全部价值就在这一份，绝不能跟着轮转走。
    const orphan = join(targetRoot, 'diary-archive', '2026-01-01.md')
    mkdirSync(join(targetRoot, 'diary-archive'), { recursive: true })
    writeFileSync(orphan, '# 只剩归档里有\n')

    for (const minute of [0, 1, 2, 3]) {
      runMemoryBackup({ globalRoot, projectRoot, diaryRoot, targetRoot, keep: 1, now: new Date(2026, 9, 25, 12, minute, 0) })
    }

    expect(existsSync(orphan)).toBe(true)
    // 轮转只对时间戳快照生效：keep=1 时只剩一份快照，归档原封不动。
    expect(readdirSync(targetRoot).filter(name => /^\d{8}-\d{6}/u.test(name))).toHaveLength(1)
  })

  it('archives the diary even when there is no memory file to snapshot', () => {
    const { projectRoot, diaryRoot, targetRoot } = layout()
    writeFileSync(join(diaryRoot, '2026-10-25.md'), '# 只有日记\n')

    const run = runMemoryBackup({ globalRoot: join(targetRoot, 'none'), projectRoot, diaryRoot, targetRoot, keep: 2 })

    expect(run.dir).toBeNull()
    expect(run.diary).toEqual({ copied: 1, kept: 0 })
    expect(existsSync(join(targetRoot, 'diary-archive', '2026-10-25.md'))).toBe(true)
  })

  it('does not create an archive directory when there is nothing to archive', () => {
    const { globalRoot, projectRoot, diaryRoot, targetRoot } = layout()
    writeFileSync(join(globalRoot, 'memory.json'), '{}')

    const run = runMemoryBackup({ globalRoot, projectRoot, diaryRoot, targetRoot, keep: 2 })

    expect(run.diary).toEqual({ copied: 0, kept: 0 })
    expect(existsSync(join(targetRoot, 'diary-archive'))).toBe(false)
  })

  it('logs instead of throwing when the diary root cannot be read', () => {
    const { globalRoot, projectRoot, targetRoot } = layout()
    writeFileSync(join(globalRoot, 'memory.json'), '{}')
    const notADirectory = join(targetRoot, 'diary-as-file')
    mkdirSync(targetRoot, { recursive: true })
    writeFileSync(notADirectory, '不是目录')
    const logs: string[] = []

    const run = runMemoryBackup({
      globalRoot, projectRoot, diaryRoot: notADirectory, targetRoot, keep: 2, log: text => logs.push(text),
    })

    expect(run.diary).toEqual({ copied: 0, kept: 0 })
    expect(logs.some(text => text.includes('无法读取日记目录'))).toBe(true)
  })
})
