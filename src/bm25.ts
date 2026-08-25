/**
 * BM25 keyword scoring over plaintext memory records. A pure function of the
 * store — no model call — so recall is deterministic and a miss is explainable
 * as "no keyword match".
 */

/**
 * Split text into lowercase terms: English/number runs stay whole; each CJK
 * ideograph its own term AND each adjacent pair its own bigram (0.5.2) —
 * bigram raises Chinese multi-char hit precision, single chars keep
 * single-character queries working.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const terms: string[] = []
  const runs = lower.match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? []
  for (const run of runs) {
    if (/^[a-z0-9]/.test(run)) {
      terms.push(run)
      continue
    }
    for (let i = 0; i < run.length; i++) terms.push(run[i]!)
    for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2))
  }
  return terms
}

const K1 = 1.2
const B = 0.75
/** 命中 tags（keywords）的 term 频率权重（0.5.2：人工关键词比正文更可检索）。 */
const TAG_BOOST = 2

/** 单文档 BM25 打分（tags 命中 ×TAG_BOOST；文档长度按同一加权核算）。 */
function scoreDoc(
  queryTerms: string[],
  body: string[],
  tags: string[],
  documentFrequency: Map<string, number>,
  n: number,
  averageLength: number,
): number {
  let score = 0
  const length = body.length + tags.length * TAG_BOOST
  for (const term of queryTerms) {
    let bodyTf = 0
    for (const candidate of body) if (candidate === term) bodyTf++
    let tagTf = 0
    for (const candidate of tags) if (candidate === term) tagTf++
    if (bodyTf + tagTf === 0) continue
    const frequency = documentFrequency.get(term) ?? 0
    const idf = Math.log(1 + (n - frequency + 0.5) / (frequency + 0.5))
    const weightedTf = bodyTf + tagTf * TAG_BOOST
    const denominator = weightedTf + K1 * (1 - B + B * (length / (averageLength || 1)))
    score += idf * (weightedTf * (K1 + 1)) / denominator
  }
  return score
}

/** Score one query against each document with BM25, in document order. */
export function bm25Scores(query: string, docs: readonly string[]): number[] {
  const queryTerms = tokenize(query)
  const tokenized = docs.map(tokenize)
  const documentFrequency = new Map<string, number>()
  for (const doc of tokenized) {
    for (const term of new Set(doc)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  const n = docs.length
  const averageLength = n === 0 ? 0 : tokenized.reduce((sum, doc) => sum + doc.length, 0) / n
  return tokenized.map(doc => scoreDoc(queryTerms, doc, [], documentFrequency, n, averageLength))
}

/**
 * 字段加权 BM25（0.5.2）：body（记忆内容）与 tags（人工关键词）分离打分，
 * tags 命中 ×TAG_BOOST；用于 memory_search，人工关键词比正文更可检索。
 */
export function bm25FieldScores(query: string, docs: readonly { body: string, tags?: string }[]): number[] {
  const queryTerms = tokenize(query)
  const bodies = docs.map(doc => tokenize(doc.body))
  const tags = docs.map(doc => doc.tags === undefined || doc.tags === '' ? [] : tokenize(doc.tags))
  const documentFrequency = new Map<string, number>()
  for (let i = 0; i < bodies.length; i++) {
    for (const term of new Set([...bodies[i]!, ...tags[i]!])) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  const n = docs.length
  const averageLength = n === 0
    ? 0
    : bodies.reduce((sum, body, i) => sum + body.length + tags[i]!.length * TAG_BOOST, 0) / n
  return bodies.map((body, i) => scoreDoc(queryTerms, body, tags[i]!, documentFrequency, n, averageLength))
}

/**
 * RRF（Reciprocal Rank Fusion，0.5.2 混合检索）：按各通道排名倒数融合。
 * 只依赖排名不依赖分数，两个异构打分通道（BM25 / 余弦相似度）可直接合流。
 * @param rankings - 每通道一个 id → 排名（0 = 第一）；同一 id 在多个通道的
 *   分数累加。
 * @param k - RRF 常数（惯例 60）。
 * @returns id → 融合分数（按降序排序的数组）。
 */
export function rrfFuse(rankings: readonly (readonly string[])[], k = 60): Array<[string, number]> {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return [...scores.entries()].sort((left, right) => right[1] - left[1])
}

/** 余弦相似度（默认 similarity；向量维度不一致返回 0）。 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i++) {
    dot += left[i]! * right[i]!
    leftNorm += left[i]! * left[i]!
    rightNorm += right[i]! * right[i]!
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}
