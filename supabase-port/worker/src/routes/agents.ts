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
  'database_ids',
  'shortcuts',
  'variables',
  'knowledge',
  'suggest_reply',
  'onboarding',
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

// Opening dialog: static prologue, or LLM-generated when onboarding.mode='llm'.
agents.get('/:id/onboarding', async (c) => {
  const { data: agent } = await c
    .get('supabase')
    .from('agents')
    .select('name, prompt, welcome_message, suggested_questions, onboarding')
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!agent) return c.json({ error: 'agent not found' }, 404)
  const onboarding = (agent.onboarding ?? {}) as { mode?: string; prompt?: string }
  let prologue = agent.welcome_message ?? ''
  if (onboarding.mode === 'llm') {
    try {
      const { chatComplete } = await import('../lib/openai')
      const result = await chatComplete(c.env, {
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content:
              onboarding.prompt?.trim() ||
              'Write a short, friendly opening message (2-3 sentences) that this assistant would ' +
                'greet a new user with, based on its persona. Same language as the persona. Output only the message.',
          },
          { role: 'user', content: `Assistant name: ${agent.name}\nPersona:\n${(agent.prompt ?? '').slice(0, 1500)}` },
        ],
      })
      prologue = (result.message.content ?? '').toString().trim() || prologue
    } catch {
      // fall back to the static welcome message
    }
  }
  return c.json({ prologue, suggested_questions: agent.suggested_questions ?? [] })
})

// Publish the agent to a public hosted chat page at /share/<token>.
agents.post('/:id/share', async (c) => {
  const token = crypto.randomUUID()
  const { data, error } = await c
    .get('supabase')
    .from('agents')
    .update({ share_token: token })
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select('id')
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'agent not found' }, 404)
  return c.json({ share_token: token, url: `${new URL(c.req.url).origin}/share/${token}` })
})

agents.delete('/:id/share', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('agents')
    .update({ share_token: null })
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
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
