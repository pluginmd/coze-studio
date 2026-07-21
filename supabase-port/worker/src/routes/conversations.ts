import { Hono } from 'hono'
import type { AppEnv } from '../env'

export const conversations = new Hono<AppEnv>()

conversations.get('/', async (c) => {
  let query = c
    .get('supabase')
    .from('conversations')
    .select('id, agent_id, user_id, title, created_at, updated_at')
    .eq('workspace_id', c.req.param('wid')!)
    .order('updated_at', { ascending: false })
    .limit(100)
  const agentId = c.req.query('agent_id')
  if (agentId) query = query.eq('agent_id', agentId)
  if (c.get('authKind') === 'user') query = query.eq('user_id', c.get('userId'))
  const { data } = await query
  return c.json(data ?? [])
})

conversations.get('/:id/messages', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!conv) return c.json({ error: 'conversation not found' }, 404)
  const { data } = await supabase
    .from('messages')
    .select('id, role, content, tool_calls, meta, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: true })
    .limit(200)
  return c.json(data ?? [])
})

// Clear history but keep the conversation (workflow/agent "clear context").
conversations.post('/:id/clear', async (c) => {
  const supabase = c.get('supabase')
  const { data: conv } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!conv) return c.json({ error: 'conversation not found' }, 404)
  const { error } = await supabase.from('messages').delete().eq('conversation_id', conv.id)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

conversations.delete('/:id', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('conversations')
    .delete()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})
