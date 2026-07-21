import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { requireAdmin } from '../middleware/auth'
import { sha256hex } from '../lib/supabase'
import { randomHex } from '../lib/util'

export const apikeys = new Hono<AppEnv>()

apikeys.use('*', requireAdmin)

apikeys.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('api_keys')
    .select('id, name, prefix, created_at, last_used_at, expires_at, revoked_at')
    .eq('workspace_id', c.req.param('wid')!)
    .order('created_at', { ascending: false })
  return c.json(data ?? [])
})

// The plaintext key is returned exactly once at creation time.
apikeys.post('/', async (c) => {
  const body = await c.req
    .json<{ name?: string; expires_at?: string }>()
    .catch(() => ({}) as any)
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)

  const key = `czk_${randomHex(24)}`
  const { data, error } = await c
    .get('supabase')
    .from('api_keys')
    .insert({
      workspace_id: c.req.param('wid')!,
      name: body.name.trim(),
      prefix: key.slice(0, 10),
      key_hash: await sha256hex(key),
      created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
      expires_at: body.expires_at ?? null,
    })
    .select('id, name, prefix, created_at, expires_at')
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ...data, key }, 201)
})

apikeys.delete('/:id', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})
