import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { requireAdmin } from '../middleware/auth'
import { pick, slugify, randomHex } from '../lib/util'

// /v1/workspaces — list & create (user tokens only)
export const workspacesRoot = new Hono<AppEnv>()

workspacesRoot.get('/', async (c) => {
  if (c.get('authKind') === 'api_key') {
    return c.json({ error: 'user token required' }, 403)
  }
  const { data } = await c
    .get('supabase')
    .from('workspace_members')
    .select('role, workspaces (id, name, slug, plan, owner_id, created_at)')
    .eq('user_id', c.get('userId'))
  return c.json((data ?? []).map((m: any) => ({ ...m.workspaces, role: m.role })))
})

workspacesRoot.post('/', async (c) => {
  if (c.get('authKind') !== 'user') return c.json({ error: 'user token required' }, 403)
  const body = await c.req.json<{ name?: string; slug?: string }>().catch(() => ({}) as any)
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const slug = body.slug ? slugify(body.slug) : `${slugify(body.name)}-${randomHex(3)}`
  const { data, error } = await c
    .get('supabase')
    .from('workspaces')
    .insert({ name: body.name.trim(), slug, owner_id: c.get('userId') })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

// /v1/workspaces/:wid — scoped detail, members, usage (behind requireWorkspace)
export const workspaceScoped = new Hono<AppEnv>()

workspaceScoped.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('workspaces')
    .select()
    .eq('id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'workspace not found' }, 404)
  return c.json({ ...data, role: c.get('wsRole') })
})

workspaceScoped.patch('/', requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, ['name', 'settings', 'plan'])
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('workspaces')
    .update(updates)
    .eq('id', c.req.param('wid')!)
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data)
})

workspaceScoped.delete('/', async (c) => {
  if (c.get('wsRole') !== 'owner') return c.json({ error: 'owner role required' }, 403)
  const { error } = await c
    .get('supabase')
    .from('workspaces')
    .delete()
    .eq('id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

workspaceScoped.get('/members', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('workspace_members')
    .select('user_id, role, created_at')
    .eq('workspace_id', c.req.param('wid')!)
  return c.json(data ?? [])
})

workspaceScoped.post('/members', requireAdmin, async (c) => {
  const body = await c.req.json<{ user_id?: string; role?: string }>().catch(() => ({}) as any)
  if (!body.user_id) return c.json({ error: 'user_id is required' }, 400)
  const role = body.role === 'admin' ? 'admin' : 'member'
  const { error } = await c
    .get('supabase')
    .from('workspace_members')
    .upsert({ workspace_id: c.req.param('wid')!, user_id: body.user_id, role })
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true }, 201)
})

workspaceScoped.delete('/members/:uid', requireAdmin, async (c) => {
  const wid = c.req.param('wid')!
  const uid = c.req.param('uid')!
  const { data: target } = await c
    .get('supabase')
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', wid)
    .eq('user_id', uid)
    .maybeSingle()
  if (target?.role === 'owner') return c.json({ error: 'cannot remove the owner' }, 400)
  const { error } = await c
    .get('supabase')
    .from('workspace_members')
    .delete()
    .eq('workspace_id', wid)
    .eq('user_id', uid)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

workspaceScoped.get('/usage', async (c) => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data } = await c
    .get('supabase')
    .from('usage_events')
    .select('kind, model, prompt_tokens, completion_tokens')
    .eq('workspace_id', c.req.param('wid')!)
    .gte('created_at', since)
    .limit(10_000)
  const byKey = new Map<string, { kind: string; model: string; prompt_tokens: number; completion_tokens: number; events: number }>()
  for (const row of data ?? []) {
    const key = `${row.kind}:${row.model}`
    const agg = byKey.get(key) ?? {
      kind: row.kind,
      model: row.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      events: 0,
    }
    agg.prompt_tokens += row.prompt_tokens
    agg.completion_tokens += row.completion_tokens
    agg.events += 1
    byKey.set(key, agg)
  }
  return c.json({ since, totals: [...byKey.values()] })
})
