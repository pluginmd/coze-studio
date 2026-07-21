import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pick } from '../lib/util'
import { indexDocument } from '../indexer'
import { retrieve } from '../lib/retrieval'

const DATASET_FIELDS = ['name', 'description', 'embedding_model', 'chunk_size', 'chunk_overlap']

export const knowledge = new Hono<AppEnv>()

knowledge.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('datasets')
    .select()
    .eq('workspace_id', c.req.param('wid')!)
    .order('updated_at', { ascending: false })
  return c.json(data ?? [])
})

knowledge.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (!body.name || typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('datasets')
    .insert({ ...pick(body, DATASET_FIELDS), workspace_id: c.req.param('wid')! })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

knowledge.get('/:dsid', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('datasets')
    .select()
    .eq('id', c.req.param('dsid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'dataset not found' }, 404)
  return c.json(data)
})

knowledge.patch('/:dsid', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, DATASET_FIELDS)
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('datasets')
    .update(updates)
    .eq('id', c.req.param('dsid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select()
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'dataset not found' }, 404)
  return c.json(data)
})

knowledge.delete('/:dsid', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const dsid = c.req.param('dsid')!
  const { data: docs } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('dataset_id', dsid)
    .eq('workspace_id', wid)
  const paths = (docs ?? []).map((d) => d.storage_path).filter(Boolean) as string[]
  if (paths.length) await supabase.storage.from('knowledge').remove(paths)
  const { error } = await supabase
    .from('datasets')
    .delete()
    .eq('id', dsid)
    .eq('workspace_id', wid)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

knowledge.get('/:dsid/documents', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('documents')
    .select('id, name, source_type, status, error, size_bytes, chunk_count, created_at, updated_at')
    .eq('dataset_id', c.req.param('dsid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .order('created_at', { ascending: false })
  return c.json(data ?? [])
})

// Upload a document as text or base64 (txt/md/html/json/csv). The file lands
// in Supabase Storage, then indexing runs via CF Queue or inline waitUntil.
knowledge.post('/:dsid/documents', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const dsid = c.req.param('dsid')!
  const body = await c.req
    .json<{ name?: string; content?: string; content_base64?: string }>()
    .catch(() => ({}) as any)
  if (!body.name || (!body.content && !body.content_base64)) {
    return c.json({ error: 'name and content (or content_base64) are required' }, 400)
  }

  const { data: dataset } = await supabase
    .from('datasets')
    .select('id')
    .eq('id', dsid)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!dataset) return c.json({ error: 'dataset not found' }, 404)

  const bytes = body.content_base64
    ? Uint8Array.from(atob(body.content_base64), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode(body.content)
  const safeName = body.name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'document.txt'
  const docId = crypto.randomUUID()
  const storagePath = `${wid}/${dsid}/${docId}/${safeName}`

  const { error: uploadError } = await supabase.storage
    .from('knowledge')
    .upload(storagePath, bytes, {
      contentType: body.content_base64 ? 'application/octet-stream' : 'text/plain; charset=utf-8',
      upsert: true,
    })
  if (uploadError) return c.json({ error: `upload failed: ${uploadError.message}` }, 500)

  const { data: doc, error } = await supabase
    .from('documents')
    .insert({
      id: docId,
      dataset_id: dsid,
      workspace_id: wid,
      name: safeName,
      source_type: 'upload',
      storage_path: storagePath,
      size_bytes: bytes.byteLength,
      status: 'pending',
    })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)

  if (c.env.INDEX_QUEUE) {
    await c.env.INDEX_QUEUE.send({ documentId: docId, workspaceId: wid })
  } else {
    c.executionCtx.waitUntil(indexDocument(c.env, docId))
  }
  return c.json(doc, 201)
})

knowledge.post('/:dsid/documents/:docid/reindex', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const docId = c.req.param('docid')!
  const { data: doc } = await supabase
    .from('documents')
    .select('id')
    .eq('id', docId)
    .eq('dataset_id', c.req.param('dsid')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!doc) return c.json({ error: 'document not found' }, 404)
  await supabase.from('documents').update({ status: 'pending', error: null }).eq('id', docId)
  if (c.env.INDEX_QUEUE) {
    await c.env.INDEX_QUEUE.send({ documentId: docId, workspaceId: wid })
  } else {
    c.executionCtx.waitUntil(indexDocument(c.env, docId))
  }
  return c.json({ ok: true })
})

knowledge.delete('/:dsid/documents/:docid', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: doc } = await supabase
    .from('documents')
    .select('id, storage_path')
    .eq('id', c.req.param('docid')!)
    .eq('dataset_id', c.req.param('dsid')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!doc) return c.json({ error: 'document not found' }, 404)
  if (doc.storage_path) await supabase.storage.from('knowledge').remove([doc.storage_path])
  const { error } = await supabase.from('documents').delete().eq('id', doc.id)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

// Test hybrid retrieval directly against one dataset.
knowledge.post('/:dsid/search', async (c) => {
  const body = await c.req
    .json<{ query?: string; top_k?: number }>()
    .catch(() => ({}) as any)
  if (!body.query?.trim()) return c.json({ error: 'query is required' }, 400)
  const chunks = await retrieve(
    c.env,
    c.get('supabase'),
    c.req.param('wid')!,
    [c.req.param('dsid')!],
    body.query,
    body.top_k ?? 6
  )
  return c.json(chunks)
})
