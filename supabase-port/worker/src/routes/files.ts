import { Hono } from 'hono'
import type { AppEnv } from '../env'

// General-purpose file service (upload domain): icons, chat attachments,
// arbitrary assets — stored under files/<workspace_id>/... with signed URLs.
export const files = new Hono<AppEnv>()

const SIGN_TTL_SECONDS = 7 * 24 * 3600

files.post('/', async (c) => {
  const wid = c.req.param('wid')!
  const body = await c.req
    .json<{ name?: string; content?: string; content_base64?: string; mime?: string }>()
    .catch(() => ({}) as any)
  if (!body.name || (!body.content && !body.content_base64)) {
    return c.json({ error: 'name and content (or content_base64) are required' }, 400)
  }
  const bytes = body.content_base64
    ? Uint8Array.from(atob(body.content_base64), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode(body.content)
  if (bytes.byteLength > 25 * 1024 * 1024) return c.json({ error: 'file exceeds 25MB limit' }, 413)
  const safeName = body.name.replace(/[^\w.-]+/g, '_').slice(0, 100) || 'file'
  const path = `${wid}/${crypto.randomUUID()}/${safeName}`

  const supabase = c.get('supabase')
  const { error } = await supabase.storage.from('files').upload(path, bytes, {
    contentType: body.mime ?? 'application/octet-stream',
    upsert: false,
  })
  if (error) return c.json({ error: error.message }, 500)
  const { data: signed } = await supabase.storage.from('files').createSignedUrl(path, SIGN_TTL_SECONDS)
  return c.json({ path, url: signed?.signedUrl ?? null, size: bytes.byteLength }, 201)
})

// Re-sign an existing path (URLs expire after 7 days). Optional width/
// height/quality use Supabase Storage image transformations (Pro plan).
files.post('/sign', async (c) => {
  const wid = c.req.param('wid')!
  const body = await c.req
    .json<{ path?: string; width?: number; height?: number; quality?: number }>()
    .catch(() => ({}) as any)
  if (!body.path?.startsWith(`${wid}/`)) return c.json({ error: 'path must belong to this workspace' }, 400)
  const transform =
    body.width || body.height || body.quality
      ? {
          transform: {
            ...(body.width ? { width: Number(body.width) } : {}),
            ...(body.height ? { height: Number(body.height) } : {}),
            ...(body.quality ? { quality: Number(body.quality) } : {}),
          },
        }
      : undefined
  const { data: signed, error } = await c
    .get('supabase')
    .storage.from('files')
    .createSignedUrl(body.path, SIGN_TTL_SECONDS, transform)
  if (error || !signed) return c.json({ error: error?.message ?? 'file not found' }, 404)
  return c.json({ path: body.path, url: signed.signedUrl })
})

files.post('/delete', async (c) => {
  const wid = c.req.param('wid')!
  const body = await c.req.json<{ path?: string }>().catch(() => ({}) as any)
  if (!body.path?.startsWith(`${wid}/`)) return c.json({ error: 'path must belong to this workspace' }, 400)
  const { error } = await c.get('supabase').storage.from('files').remove([body.path])
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})
