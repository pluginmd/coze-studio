import type { Env } from './env'
import { adminClient } from './lib/supabase'
import { chunkText } from './lib/chunking'
import { parseDocument } from './lib/docparse'
import { embedTexts } from './lib/jina'

// Document ingestion pipeline: Storage download -> extract -> chunk ->
// Jina embed -> pgvector insert. Runs from a Cloudflare Queue consumer when
// available, otherwise inline via ctx.waitUntil (replaces the NSQ pipeline).
export async function indexDocument(env: Env, documentId: string): Promise<void> {
  const supabase = adminClient(env)
  const { data: doc } = await supabase
    .from('documents')
    .select('id, dataset_id, workspace_id, name, storage_path')
    .eq('id', documentId)
    .maybeSingle()
  if (!doc) return

  try {
    await supabase.from('documents').update({ status: 'processing', error: null }).eq('id', doc.id)

    if (!doc.storage_path) throw new Error('document has no storage_path')
    const { data: blob, error: dlError } = await supabase.storage
      .from('knowledge')
      .download(doc.storage_path)
    if (dlError || !blob) throw new Error(`storage download failed: ${dlError?.message ?? 'no data'}`)

    const text = await parseDocument(new Uint8Array(await blob.arrayBuffer()), doc.name, env)
    const { data: dataset } = await supabase
      .from('datasets')
      .select('chunk_size, chunk_overlap, chunk_strategy')
      .eq('id', doc.dataset_id)
      .maybeSingle()

    const chunks = chunkText(text, {
      ...(dataset?.chunk_strategy ?? {}),
      size: dataset?.chunk_size ?? 1000,
      overlap: dataset?.chunk_overlap ?? 150,
    })
    if (!chunks.length) throw new Error('document produced no text chunks')

    await supabase.from('chunks').delete().eq('document_id', doc.id)

    let embeddingTokens = 0
    for (let i = 0; i < chunks.length; i += 32) {
      const batch = chunks.slice(i, i + 32)
      const embeddings = await embedTexts(env, batch, 'retrieval.passage')
      embeddingTokens += batch.reduce((n, c) => n + Math.ceil(c.length / 4), 0)
      const rows = batch.map((content, j) => ({
        document_id: doc.id,
        dataset_id: doc.dataset_id,
        workspace_id: doc.workspace_id,
        seq: i + j,
        content,
        embedding: embeddings[j],
      }))
      const { error } = await supabase.from('chunks').insert(rows)
      if (error) throw new Error(`chunk insert failed: ${error.message}`)
    }

    await supabase
      .from('documents')
      .update({ status: 'ready', chunk_count: chunks.length })
      .eq('id', doc.id)
    await supabase.from('usage_events').insert({
      workspace_id: doc.workspace_id,
      kind: 'embedding',
      model: env.EMBEDDING_MODEL ?? 'jina-embeddings-v3',
      prompt_tokens: embeddingTokens,
      meta: { document_id: doc.id, chunks: chunks.length },
    })
  } catch (e) {
    await supabase
      .from('documents')
      .update({ status: 'failed', error: String(e).slice(0, 2000) })
      .eq('id', doc.id)
  }
}
