import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pick } from '../lib/util'

const AGENT_FIELDS = [
  'name',
  'description',
  'icon_url',
  'prompt',
  'model',
  'welcome_message',
  'suggested_questions',
  'dataset_ids',
  'plugin_tool_ids',
  'workflow_ids',
  'variables',
]

export const agents = new Hono<AppEnv>()

agents.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('agents')
    .select('id, name, description, icon_url, status, published_at, updated_at')
    .eq('workspace_id', c.req.param('wid')!)
    .order('updated_at', { ascending: false })
  return c.json(data ?? [])
})

agents.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (!body.name || typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('agents')
    .insert({
      ...pick(body, AGENT_FIELDS),
      workspace_id: c.req.param('wid')!,
      created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
    })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

agents.get('/:id', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('agents')
    .select()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'agent not found' }, 404)
  return c.json(data)
})

agents.patch('/:id', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, AGENT_FIELDS)
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('agents')
    .update(updates)
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select()
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'agent not found' }, 404)
  return c.json(data)
})

agents.delete('/:id', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('agents')
    .delete()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

// Publish: snapshot the current draft into agent_releases and mark published.
agents.post('/:id/publish', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: agent } = await supabase
    .from('agents')
    .select()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const { data: last } = await supabase
    .from('agent_releases')
    .select('version')
    .eq('agent_id', agent.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const version = (last?.version ?? 0) + 1

  const { error } = await supabase.from('agent_releases').insert({
    agent_id: agent.id,
    workspace_id: wid,
    version,
    snapshot: agent,
    created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
  })
  if (error) return c.json({ error: error.message }, 400)

  await supabase
    .from('agents')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', agent.id)
  return c.json({ ok: true, version })
})

agents.get('/:id/releases', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('agent_releases')
    .select('id, version, created_by, created_at')
    .eq('agent_id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .order('version', { ascending: false })
  return c.json(data ?? [])
})
