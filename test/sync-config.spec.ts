/**
 * 云同步运行配置的组装（2026-11-13）。
 *
 * 这一层被抽成纯函数，是因为 **token 链路曾经是断的**：`SyncConfig.token` 与
 * `authFor()` 都在，但 `syncConfig()` 从不传它、也没有任何地方读环境变量，
 * 于是私有仓库必然 401（0.22.2 就是这样发出去的）。
 *
 * 这些用例锁三件事：
 * ① 缺省值回退（mirrorDir）；
 * ② 空字符串视同「没配」（不是空串传给下游）；
 * ③ **token 只从环境变量来**——`raw.token` 即使存在也不采用，因为配置会跟着
 *    patch 文件被复制、分享、提交，而 README 承诺的是「token 不写进配置」。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSyncConfig } from '../src/index.ts'

describe('resolveSyncConfig', () => {
  it('全空时只给 mirrorDir，remote / token 都不出现', () => {
    const cfg = resolveSyncConfig({}, { DSH_HOME: 'H:/tmp/dsh-home' })
    expect(cfg.mirrorDir).toBe(join('H:/tmp/dsh-home', 'memory-sync'))
    expect('remote' in cfg).toBe(false)
    expect('branch' in cfg).toBe(false)
    // envName 总有值（2026-11-14）：缺省用主机名，它是 state 分片的键
    expect(typeof cfg.envName).toBe('string')
    expect((cfg.envName ?? '').length).toBeGreaterThan(0)
    expect('token' in cfg).toBe(false)
  })

  it('没有 DSH_HOME 时回退到 ~/.dsh/memory-sync', () => {
    const cfg = resolveSyncConfig({}, {})
    expect(cfg.mirrorDir).toBe(join(homedir(), '.dsh', 'memory-sync'))
  })

  it('显式 mirrorDir 覆盖回退值', () => {
    const cfg = resolveSyncConfig({ mirrorDir: 'D:/mirror' }, { DSH_HOME: 'H:/tmp/dsh-home' })
    expect(cfg.mirrorDir).toBe('D:/mirror')
  })

  it('remote / branch / envName 原样透传', () => {
    const cfg = resolveSyncConfig({
      remote: 'https://github.com/me/memories.git',
      branch: 'trunk',
      envName: '工作机',
    }, {})
    expect(cfg.remote).toBe('https://github.com/me/memories.git')
    expect(cfg.branch).toBe('trunk')
    expect(cfg.envName).toBe('工作机')
  })

  it('空字符串视同没配，不把空串传给下游', () => {
    const cfg = resolveSyncConfig({ remote: '', branch: '', envName: '', mirrorDir: '' }, {})
    expect('remote' in cfg).toBe(false)
    expect('branch' in cfg).toBe(false)
    expect((cfg.envName ?? '').length).toBeGreaterThan(0)
    expect(cfg.mirrorDir).toBe(join(homedir(), '.dsh', 'memory-sync'))
  })

  it('token 从环境变量 DSH_MEMORY_SYNC_TOKEN 读取', () => {
    const cfg = resolveSyncConfig(
      { remote: 'https://github.com/me/memories.git' },
      { DSH_MEMORY_SYNC_TOKEN: 'ghp_test_token' },
    )
    expect(cfg.token).toBe('ghp_test_token')
  })

  it('环境变量为空串时不给 token（否则 authFor 会拿空密码去认证）', () => {
    const cfg = resolveSyncConfig({}, { DSH_MEMORY_SYNC_TOKEN: '' })
    expect('token' in cfg).toBe(false)
  })

  it('配置里写 token 也不采用——它只认环境变量', () => {
    const cfg = resolveSyncConfig({ token: 'from-config' }, {})
    expect('token' in cfg).toBe(false)
  })
})
