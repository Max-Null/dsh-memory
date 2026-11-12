/**
 * 云同步 token 的存放与读取（2026-11-13）。
 *
 * 两个约束值得锁住：
 * ① **不进 profile 配置**——patch 文件会被复制、分享、提交，令牌进去等于泄露；
 * ② **环境变量优先于文件**——前者是调用方显式注入的那一层。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearSyncTokenFile, readSyncTokenFile, syncTokenPath, writeSyncTokenFile } from '../src/sync-token.ts'
import { resolveSyncConfig } from '../src/index.ts'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 临时 DSH_HOME 作为 env 来源。 */
function tempHome(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-token-'))
  roots.push(dir)
  return { DSH_HOME: dir }
}

describe('同步 token 文件', () => {
  it('落在 $DSH_HOME 下，写进去能读回来', () => {
    const env = tempHome()
    writeSyncTokenFile('ghp_test_value', env)
    expect(syncTokenPath(env)).toBe(join(env.DSH_HOME as string, 'memory-sync-token'))
    expect(readSyncTokenFile(env)).toBe('ghp_test_value')
  })

  it('文件不存在时视同未设置', () => {
    expect(readSyncTokenFile(tempHome())).toBeUndefined()
  })

  it('写空白等于清除', () => {
    const env = tempHome()
    writeSyncTokenFile('ghp_test_value', env)
    writeSyncTokenFile('   ', env)
    expect(readSyncTokenFile(env)).toBeUndefined()
  })

  it('清除不存在的文件不报错（幂等）', () => {
    const env = tempHome()
    expect(() => { clearSyncTokenFile(env) }).not.toThrow()
    expect(readSyncTokenFile(env)).toBeUndefined()
  })

  it('读的时候去掉首尾空白', () => {
    const env = tempHome()
    writeFileSync(syncTokenPath(env), '  ghp_test_value  \n')
    expect(readSyncTokenFile(env)).toBe('ghp_test_value')
  })
})

describe('resolveSyncConfig 的 token 来源', () => {
  it('文件 token 生效', () => {
    const cfg = resolveSyncConfig({}, {}, 'from-file')
    expect(cfg.token).toBe('from-file')
  })

  it('环境变量优先于文件', () => {
    const cfg = resolveSyncConfig({}, { DSH_MEMORY_SYNC_TOKEN: 'from-env' }, 'from-file')
    expect(cfg.token).toBe('from-env')
  })

  it('两者都没有时不给 token', () => {
    const cfg = resolveSyncConfig({}, {}, '')
    expect('token' in cfg).toBe(false)
  })
})
