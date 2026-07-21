import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { indexDocument } from '../indexer'

// Three-tier async indexing: Cloudflare Queue (if bound) -> Supabase Queues
// (pgmq, polled by the Worker cron trigger) -> inline waitUntil fallback.
export async function enqueueIndexJob(
  env: Env,
  supabase: SupabaseClient,
  documentId: string,
  workspaceId: string,
  waitUntil: (p: Promise<unknown>) => void
): Promise<'cf-queue' | 'pgmq' | 'inline'> {
  if (env.INDEX_QUEUE) {
    await env.INDEX_QUEUE.send({ documentId, workspaceId })
    return 'cf-queue'
  }
  const { error } = await supabase.rpc('queue_send_doc_index', {
    p_message: { documentId, workspaceId },
  })
  if (!error) return 'pgmq'
  waitUntil(indexDocument(env, documentId))
  return 'inline'
}

// Cron-trigger consumer for the pgmq tier.
export async function drainIndexQueue(env: Env, supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc('queue_read_doc_index', { p_limit: 5 })
  if (error || !data?.length) return 0
  let processed = 0
  for (const row of data as { msg_id: number; message: { documentId?: string } }[]) {
    const documentId = row.message?.documentId
    if (documentId) {
      await indexDocument(env, documentId)
      processed++
    }
    await supabase.rpc('queue_delete_doc_index', { p_msg_id: row.msg_id })
  }
  return processed
}
