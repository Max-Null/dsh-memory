/**
 * BM25 keyword scoring over plaintext memory records. A pure function of the
 * store — no model call — so recall is deterministic and a miss is explainable
 * as "no keyword match".
 */

/** Split text into lowercase terms: English/number runs stay whole, each CJK ideograph its own term. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]/g) ?? []
}

const K1 = 1.2
const B = 0.75

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
  const totalLength = tokenized.reduce((sum, doc) => sum + doc.length, 0)
  const averageLength = n === 0 ? 0 : totalLength / n
  return tokenized.map((doc) => {
    let score = 0
    for (const term of queryTerms) {
      let termFrequency = 0
      for (const candidate of doc) {
        if (candidate === term) termFrequency++
      }
      if (termFrequency === 0) continue
      const frequency = documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (n - frequency + 0.5) / (frequency + 0.5))
      const denominator = termFrequency + K1 * (1 - B + B * (doc.length / (averageLength || 1)))
      score += idf * (termFrequency * (K1 + 1)) / denominator
    }
    return score
  })
}
