import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pick } from '../lib/util'

const PROMPT_FIELDS = ['name', 'description', 'prompt']

export const prompts = new Hono<AppEnv>()

prompts.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('prompt_resources')
    .select('id, name, description, created_at, updated_at')
    .eq('workspace_id', c.req.param('wid')!)
    .order('updated_at', { ascending: false })
  return c.json(data ?? [])
})

prompts.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (!body.name || typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('prompt_resources')
    .insert({
      ...pick(body, PROMPT_FIELDS),
      workspace_id: c.req.param('wid')!,
      created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
    })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

prompts.get('/:id', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('prompt_resources')
    .select()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'prompt not found' }, 404)
  return c.json(data)
})

prompts.patch('/:id', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, PROMPT_FIELDS)
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('prompt_resources')
    .update(updates)
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select()
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'prompt not found' }, 404)
  return c.json(data)
})

prompts.delete('/:id', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('prompt_resources')
    .delete()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})
