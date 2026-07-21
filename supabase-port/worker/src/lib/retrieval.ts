import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { embedTexts } from './jina'
import { chatComplete, contentText } from './openai'

export type SearchType = 'semantic' | 'fulltext' | 'hybrid'

export interface RetrieveOptions {
  topK?: number
  minScore?: number
  searchType?: SearchType
}

export interface RetrievedChunk {
  chunk_id: number
  document_id: string
  dataset_id: string
  content: string
  score: number
  similarity: number
}

// Hybrid retrieval over pgvector + Postgres FTS. Search type, top-k and
// min-score are per-call (agents carry their own recall config).
export async function retrieve(
  env: Env,
  supabase: SupabaseClient,
  workspaceId: string,
  datasetIds: string[],
  query: string,
  opts: RetrieveOptions = {}
): Promise<RetrievedChunk[]> {
  if (!datasetIds.length || !query.trim()) return []
  const searchType: SearchType = opts.searchType ?? 'hybrid'
  const embedding =
    searchType === 'fulltext'
      ? new Array(Number(env.EMBEDDING_DIM ?? 1024)).fill(0)
      : (await embedTexts(env, [query], 'retrieval.query'))[0]
  const { data, error } = await supabase.rpc('match_chunks', {
    p_workspace_id: workspaceId,
    p_dataset_ids: datasetIds,
    p_query: query,
    p_embedding: embedding,
    p_limit: opts.topK ?? 6,
    p_search_type: searchType,
    p_min_score: opts.minScore ?? 0,
  })
  if (error) throw new Error(`retrieval failed: ${error.message}`)
  return (data ?? []) as RetrievedChunk[]
}

// Multi-turn query rewrite: condense chat history + latest message into a
// standalone search query (original messages2query pipeline).
export async function rewriteQuery(
  env: Env,
  history: { role: string; content: string }[],
  query: string
): Promise<string> {
  if (!history.length) return query
  const transcript = history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join('\n')
  try {
    const result = await chatComplete(env, {
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Rewrite the latest user message into ONE standalone search query that captures ' +
            'its full intent given the conversation. Same language as the user. ' +
            'Output only the query, no quotes or explanations.',
        },
        { role: 'user', content: `Conversation:\n${transcript}\n\nLatest message: ${query}` },
      ],
    })
    const rewritten = contentText(result.message.content).trim()
    return rewritten && rewritten.length < 500 ? rewritten : query
  } catch {
    return query
  }
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
