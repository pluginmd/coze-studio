import type { Env } from '../env'

export type EmbedTask = 'retrieval.query' | 'retrieval.passage'

// Jina AI embeddings — replaces the self-hosted embedding pipeline.
export async function embedTexts(env: Env, texts: string[], task: EmbedTask): Promise<number[][]> {
  if (!texts.length) return []
  const base = (env.JINA_BASE_URL ?? 'https://api.jina.ai').replace(/\/+$/, '')
  const res = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.EMBEDDING_MODEL ?? 'jina-embeddings-v3',
      task,
      dimensions: Number(env.EMBEDDING_DIM ?? 1024),
      input: texts,
    }),
  })
  if (!res.ok) {
    throw new Error(`jina embeddings failed: ${res.status} ${(await res.text()).slice(0, 500)}`)
  }
  const json = (await res.json()) as { data: { index: number; embedding: number[] }[] }
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

// Jina reranker — model-based rerank option on top of RRF hybrid search.
export async function rerankDocs(
  env: Env,
  query: string,
  documents: string[],
  topN: number
): Promise<{ index: number; score: number }[]> {
  if (!documents.length) return []
  const base = (env.JINA_BASE_URL ?? 'https://api.jina.ai').replace(/\/+$/, '')
  const res = await fetch(`${base}/v1/rerank`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.RERANK_MODEL ?? 'jina-reranker-v2-base-multilingual',
      query,
      documents,
      top_n: topN,
    }),
  })
  if (!res.ok) {
    throw new Error(`jina rerank failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as { results: { index: number; relevance_score: number }[] }
  return json.results.map((r) => ({ index: r.index, score: r.relevance_score }))
}
