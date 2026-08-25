import { describe, expect, it } from 'vitest'
import { bm25FieldScores, bm25Scores, cosineSimilarity, rrfFuse, tokenize } from '../src/bm25.ts'

describe('tokenize (0.5.2 中文单字 + 2-gram)', () => {
  it('keeps english/number runs whole', () => {
    expect(tokenize('Vue3 setup')) .toEqual(['vue3', 'setup'])
  })

  it('splits cjk runs into chars plus adjacent bigrams', () => {
    const terms = tokenize('编码规范')
    expect(terms).toHaveLength(7) // 4 单字 + 3 bigram
    for (const term of ['编', '码', '规', '范', '编码', '码规', '规范']) {
      expect(terms).toContain(term)
    }
  })

  it('mixed text keeps latin runs and cjk terms apart', () => {
    const terms = tokenize('用 vue 写 script')
    for (const term of ['用', 'vue', '写', 'script']) expect(terms).toContain(term)
  })
})

describe('bm25Scores (0.5.2 中文检索精度)', () => {
  it('two-char query hits its exact bigram and misses unrelated docs', () => {
    const scores = bm25Scores('编码', ['中文编码规范', '无关内容'])
    expect(scores[0]!).toBeGreaterThan(0)
    expect(scores[1]!).toBe(0)
  })

  it('contiguous phrase scores above loose char overlap', () => {
    const scores = bm25Scores('编码规范', ['编码规范优先', '编码与规范无关'])
    expect(scores[0]!).toBeGreaterThan(0)
    expect(scores[1]!).toBeGreaterThan(0)
    expect(scores[0]!).toBeGreaterThan(scores[1]!)
  })
})

describe('bm25FieldScores (0.5.2 keywords 加权)', () => {
  it('a tag hit outranks a single body hit', () => {
    const scores = bm25FieldScores('vue', [
      { body: 'vue 相关说明', tags: '' },
      { body: '无关内容', tags: 'vue' },
    ])
    expect(scores[1]!).toBeGreaterThan(scores[0]!)
  })

  it('tags never leak into docs without the tag', () => {
    const scores = bm25FieldScores('vue', [{ body: '无关内容', tags: '' }])
    expect(scores[0]!).toBe(0)
  })
})

describe('rrfFuse (0.5.2 混合检索融合)', () => {
  it('aggregates shared ids across channels and ranks by fused score', () => {
    const fused = rrfFuse([['a', 'b'], ['b', 'c']])
    expect(fused.map(([id]) => id)).toEqual(['b', 'a', 'c'])
  })

  it('single channel equals its own ranking', () => {
    const fused = rrfFuse([['a', 'b']])
    expect(fused.map(([id]) => id)).toEqual(['a', 'b'])
  })
})

describe('cosineSimilarity', () => {
  it('scores aligned vectors high and orthogonal ones zero', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0) // 零向量/空向量不参与
  })
})
