import { describe, expect, it } from 'vitest'
import { detectSensitive } from '../src/quarantine.ts'

describe('detectSensitive：危险内容硬拦（2026-09-15 静默记忆机制）', () => {
  it('命中常见密钥形态', () => {
    expect(detectSensitive('key: sk-abcdefghijklmnopqrstuvwx').quarantined).toBe(true)
    expect(detectSensitive('AKIAIOSFODNN7EXAMPLE').reason).toBe('aws-access-key')
    expect(detectSensitive('-----BEGIN RSA PRIVATE KEY-----').reason).toBe('private-key-block')
    expect(detectSensitive('password: hunter2xyz').quarantined).toBe(true)
    expect(detectSensitive('Authorization: Bearer abcdefghijklmnopqrstuvwxyz01').quarantined).toBe(true)
    expect(detectSensitive('postgres://user:pass@db.example.com/app').reason).toBe('credential-url')
    expect(detectSensitive('xoxb-1234567890-abcdefghijkl').quarantined).toBe(true)
  })

  it('普通记忆不误报', () => {
    expect(detectSensitive('提交前先跑一遍测试再交付').quarantined).toBe(false)
    expect(detectSensitive('用户偏好简洁回答，避免长篇解释').quarantined).toBe(false)
    // 「token」作为普通词出现不算秘密：缺少赋值形态
    expect(detectSensitive('token 这个词本身不是秘密').quarantined).toBe(false)
    expect(detectSensitive('细节见 https://example.com/a/b?x=1').quarantined).toBe(false)
  })

  it('多片段判定：关键词里塞密钥同样隔离', () => {
    expect(detectSensitive('一条普通记忆', 'sk-abcdefghijklmnopqrstuvwx').quarantined).toBe(true)
  })

  it('空输入不隔离', () => {
    expect(detectSensitive().quarantined).toBe(false)
    expect(detectSensitive('', '').quarantined).toBe(false)
  })
})
