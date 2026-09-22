import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anchorHolds, probeAnchor } from '../src/anchors.ts'

const probes = {
  toolNames: ['beta', 'alpha'],
  selfVersion: '0.7.0',
  env: (name: string): string | undefined => (name === 'DSH_HOME' ? '/home/dsh' : undefined),
}

describe('有效性锚点（2026-09-15 静默记忆机制）', () => {
  it('env 锚点：值一致成立，值变了即失效', () => {
    expect(anchorHolds({ kind: 'env', name: 'DSH_HOME', value: '/home/dsh' }, probes)).toBe(true)
    expect(anchorHolds({ kind: 'env', name: 'DSH_HOME', value: '/old/home' }, probes)).toBe(false)
  })

  it('探测不到时返回 undefined——「未校验」不等于「失效」', () => {
    expect(anchorHolds({ kind: 'env', name: 'NOT_SET', value: 'x' }, probes)).toBeUndefined()
    expect(anchorHolds({ kind: 'env', value: 'x' }, probes)).toBeUndefined()
  })

  it('tool-list 锚点：顺序无关，清单变化即失效', () => {
    expect(anchorHolds({ kind: 'tool-list', value: 'alpha,beta' }, probes)).toBe(true)
    expect(anchorHolds({ kind: 'tool-list', value: 'alpha,gamma' }, probes)).toBe(false)
  })

  it('self-version 锚点：跟随插件自身版本', () => {
    expect(probeAnchor({ kind: 'self-version', value: '' }, probes)).toBe('0.7.0')
    expect(anchorHolds({ kind: 'self-version', value: '0.6.1' }, probes)).toBe(false)
  })
})

describe('path-exists 锚点（0.12.0）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-anchor-'))
  writeFileSync(join(dir, 'present.ts'), 'x', 'utf8')

  it('绝对路径：在 → 成立，不在 → 失效（反向声明同样成立）', () => {
    expect(anchorHolds({ kind: 'path-exists', name: join(dir, 'present.ts'), value: 'present' }, probes)).toBe(true)
    expect(anchorHolds({ kind: 'path-exists', name: join(dir, 'gone.ts'), value: 'present' }, probes)).toBe(false)
    // 声明「这个路径不该存在」而它确实不存在 —— 也是成立的锚点
    expect(anchorHolds({ kind: 'path-exists', name: join(dir, 'gone.ts'), value: 'absent' }, probes)).toBe(true)
  })

  it('相对路径以 workspaceCwd 为基准', () => {
    const scoped = { ...probes, workspaceCwd: dir }
    expect(anchorHolds({ kind: 'path-exists', name: 'present.ts', value: 'present' }, scoped)).toBe(true)
    expect(anchorHolds({ kind: 'path-exists', name: 'gone.ts', value: 'present' }, scoped)).toBe(false)
  })

  it('相对路径但拿不到 workspaceCwd → 未校验（不判失效）', () => {
    // 定位不到与「文件真的不在」是两件事，混起来会让相对路径锚点集体误失效
    expect(anchorHolds({ kind: 'path-exists', name: 'present.ts', value: 'present' }, probes)).toBeUndefined()
  })

  it('缺 name → 未校验', () => {
    expect(anchorHolds({ kind: 'path-exists', value: 'present' }, probes)).toBeUndefined()
  })
})
