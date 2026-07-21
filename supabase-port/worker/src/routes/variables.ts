import { Hono } from 'hono'
import type { AppEnv } from '../env'

// Memory domain: long-term user variables. `user_key` defaults to the caller
// (auth uid); API-key callers pass an explicit end-user key for multi-tenant
// SaaS scenarios.
export const variables = new Hono<AppEnv>()

function callerKey(c: any, explicit?: string): string {
  if (explicit) return explicit
  return c.get('authKind') === 'user' ? c.get('userId') : 'api'
}

variables.get('/', async (c) => {
  const userKey = callerKey(c, c.req.query('user_key'))
  let query = c
    .get('supabase')
    .from('user_variables')
    .select('id, agent_id, user_key, name, value, updated_at')
    .eq('workspace_id', c.req.param('wid')!)
    .eq('user_key', userKey)
    .limit(200)
  const agentId = c.req.query('agent_id')
  if (agentId) query = query.eq('agent_id', agentId)
  const { data } = await query
  return c.json(data ?? [])
})

variables.put('/', async (c) => {
  const body = await c.req
    .json<{ name?: string; value?: unknown; agent_id?: string; user_key?: string }>()
    .catch(() => ({}) as any)
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('user_variables')
    .upsert(
      {
        workspace_id: c.req.param('wid')!,
        agent_id: body.agent_id ?? null,
        user_key: callerKey(c, body.user_key),
        name: body.name.trim(),
        value: body.value ?? null,
      },
      { onConflict: 'workspace_id,agent_id,user_key,name' }
    )
    .select('id, agent_id, user_key, name, value, updated_at')
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data)
})

variables.delete('/:id', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('user_variables')
    .delete()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})
