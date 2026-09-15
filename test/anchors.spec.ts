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
