/**
 * 云同步的代理与连接测试（2026-11-13）。
 *
 * 背景：用户机器上 **系统 git 走代理能通、插件的 node 直连 GitHub 超时**，
 * 于是 push 一路报 `Request timed out`。这里锁两件事：
 * ① 代理来源优先级（配置 > 环境变量）；
 * ② 「测试连接」在缺地址时给出明确原因，而不是发一次注定失败的请求。
 */
import { describe, expect, it } from 'vitest'
import { resolveProxy } from '../src/sync-http.ts'
import { syncTest } from '../src/sync-service.ts'

describe('resolveProxy', () => {
  it('配置的代理优先', () => {
    expect(resolveProxy('http://127.0.0.1:7897', { HTTPS_PROXY: 'http://env:1111' })).toBe('http://127.0.0.1:7897')
  })

  it('没配时回退到环境变量（大写在前）', () => {
    expect(resolveProxy('', { HTTPS_PROXY: 'http://env:1111', HTTP_PROXY: 'http://env:2222' })).toBe('http://env:1111')
  })

  it('小写环境变量也认', () => {
    expect(resolveProxy(undefined, { https_proxy: 'http://env:3333' })).toBe('http://env:3333')
  })

  it('都没有时返回 undefined（表示直连）', () => {
    expect(resolveProxy('', {})).toBeUndefined()
  })

  it('空白字符串不算配置', () => {
    expect(resolveProxy('   ', {})).toBeUndefined()
  })
})

describe('syncTest', () => {
  it('没填远端地址时直接说明原因，不去发请求', async () => {
    const result = await syncTest({ mirrorDir: 'H:/tmp/mirror' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('仓库地址')
  })
})
