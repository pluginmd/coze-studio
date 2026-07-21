import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Env } from '../env'
import { adminClient } from '../lib/supabase'
import { runChatTurn, ChatError } from '../lib/chatservice'
import { rateLimit } from '../lib/ratelimit'
import { sharePageHtml } from './sharepage'

// Public agent share (connector domain): unauthenticated hosted chat behind an
// unguessable share token. End-users are scoped by a client-generated session
// id (`share:<session>` user_key) for memory/oauth isolation.
export const share = new Hono<{ Bindings: Env }>()

async function loadSharedAgent(env: Env, token: string) {
  const supabase = adminClient(env)
  const { data: agent } = await supabase
    .from('agents')
    .select()
    .eq('share_token', token)
    .maybeSingle()
  return { supabase, agent }
}

share.get('/:token/info', async (c) => {
  const { agent } = await loadSharedAgent(c.env, c.req.param('token')!)
  if (!agent) return c.json({ error: 'invalid share link' }, 404)
  return c.json({
    name: agent.name,
    description: agent.description,
    icon_url: agent.icon_url,
    welcome_message: agent.welcome_message,
    suggested_questions: agent.suggested_questions,
  })
})

share.post('/:token/chat', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  if (!rateLimit(`share:${ip}`, 30, 5 * 60_000)) {
    return c.json({ error: 'rate limit exceeded — try again in a few minutes' }, 429)
  }
  const { supabase, agent } = await loadSharedAgent(c.env, c.req.param('token')!)
  if (!agent) return c.json({ error: 'invalid share link' }, 404)
  const body = await c.req
    .json<{ message?: string; conversation_id?: string; session?: string; attachments?: any[] }>()
    .catch(() => ({}) as any)
  if (!body.message?.trim()) return c.json({ error: 'message is required' }, 400)
  const session = (body.session ?? 'anon').slice(0, 64)

  const params = {
    workspaceId: agent.workspace_id as string,
    agent,
    conversationId: body.conversation_id,
    userId: null,
    userKey: `share:${session}`,
    message: body.message,
    attachments: body.attachments,
  }

  return streamSSE(c, async (stream) => {
    try {
      const result = await runChatTurn(c.env, supabase, params, async (ev) => {
        await stream.writeSSE({ event: String(ev.type), data: JSON.stringify(ev) })
      })
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ conversation_id: result.conversationId, usage: result.usage }),
      })
    } catch (e) {
      const message = e instanceof ChatError ? e.message : String(e).slice(0, 300)
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: message }) })
    }
  })
})

share.get('/:token', (c) => c.html(sharePageHtml))
