import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../env'
import { runChatTurn, ChatError } from '../lib/chatservice'

interface ChatBody {
  agent_id?: string
  conversation_id?: string
  message?: string
  stream?: boolean
  user_key?: string // end-user identity for API-key callers (memory/oauth scoping)
}

export const chat = new Hono<AppEnv>()

// POST /v1/workspaces/:wid/chat — the main agent invocation endpoint.
// SSE by default (`stream: false` for a single JSON response).
chat.post('/', async (c) => {
  const wid = c.req.param('wid')!
  const supabase = c.get('supabase')
  const body = await c.req.json<ChatBody>().catch(() => ({}) as ChatBody)
  if (!body.agent_id || !body.message?.trim()) {
    return c.json({ error: 'agent_id and message are required' }, 400)
  }

  const { data: agent } = await supabase
    .from('agents')
    .select()
    .eq('id', body.agent_id)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const isUser = c.get('authKind') === 'user'
  const params = {
    workspaceId: wid,
    agent,
    conversationId: body.conversation_id,
    userId: isUser ? c.get('userId') : null,
    userKey: isUser ? c.get('userId') : (body.user_key ?? 'api'),
    message: body.message,
  }

  if (body.stream === false) {
    try {
      const result = await runChatTurn(c.env, supabase, params)
      return c.json({
        conversation_id: result.conversationId,
        message_id: result.messageId,
        content: result.content,
        tool_calls: result.toolLog,
        usage: result.usage,
      })
    } catch (e) {
      if (e instanceof ChatError) return c.json({ error: e.message }, e.status as 400)
      throw e
    }
  }

  return streamSSE(c, async (stream) => {
    try {
      const result = await runChatTurn(c.env, supabase, params, async (ev) => {
        await stream.writeSSE({ event: String(ev.type), data: JSON.stringify(ev) })
      })
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          conversation_id: result.conversationId,
          message_id: result.messageId,
          usage: result.usage,
        }),
      })
    } catch (e) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 500) }),
      })
    }
  })
})
