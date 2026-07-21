import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { embedTexts } from './jina'

export interface RetrievedChunk {
  chunk_id: number
  document_id: string
  dataset_id: string
  content: string
  score: number
}

// Hybrid retrieval (pgvector + Postgres FTS, fused server-side with RRF).
export async function retrieve(
  env: Env,
  supabase: SupabaseClient,
  workspaceId: string,
  datasetIds: string[],
  query: string,
  topK = 6
): Promise<RetrievedChunk[]> {
  if (!datasetIds.length || !query.trim()) return []
  const [embedding] = await embedTexts(env, [query], 'retrieval.query')
  const { data, error } = await supabase.rpc('match_chunks', {
    p_workspace_id: workspaceId,
    p_dataset_ids: datasetIds,
    p_query: query,
    p_embedding: embedding,
    p_limit: topK,
  })
  if (error) throw new Error(`retrieval failed: ${error.message}`)
  return (data ?? []) as RetrievedChunk[]
}

export function contextBlock(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return ''
  const refs = chunks
    .map((c, i) => `[${i + 1}] ${c.content.replace(/\s+/g, ' ').slice(0, 1500)}`)
    .join('\n\n')
  return (
    'Relevant knowledge base excerpts (use them when they answer the question, ' +
    'cite as [n], and ignore them when irrelevant):\n\n' +
    refs
  )
}
