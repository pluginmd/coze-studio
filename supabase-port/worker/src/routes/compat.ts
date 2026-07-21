import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../env'
import { runChatTurn, ChatError } from '../lib/chatservice'

// Coze Open API compatibility shim (/v3/chat, /v1/conversation[s]) so
// existing Coze SDK clients can point at this Worker. Workspace resolution:
// czk_ API keys are workspace-bound; user tokens pass ?workspace_id=.
// Difference vs upstream: non-stream /v3/chat completes inline (no polling).

function resolveWorkspace(c: any): string | null {
  if (c.get('authKind') === 'api_key') return c.get('apiKeyWorkspaceId') ?? null
  return c.req.query('workspace_id') ?? null
}

async function requireMembership(c: any, wid: string): Promise<boolean> {
  if (c.get('authKind') === 'api_key') return c.get('apiKeyWorkspaceId') === wid
  const { data } = await c
    .get('supabase')
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', wid)
    .eq('user_id', c.get('userId'))
    .maybeSingle()
  return !!data
}

interface V3Message {
  role?: string
  content?: string
  content_type?: string
}

export const compatV3 = new Hono<AppEnv>()

compatV3.post('/chat', async (c) => {
  const wid = resolveWorkspace(c)
  if (!wid || !(await requireMembership(c, wid))) {
    return c.json({ code: 4100, msg: 'workspace not resolved (use a workspace API key or ?workspace_id=)' }, 401)
  }
  const body = await c.req
    .json<{
      bot_id?: string
      user_id?: string
      user?: string
      additional_messages?: V3Message[]
      stream?: boolean
    }>()
    .catch(() => ({}) as any)
  const lastUser = [...(body.additional_messages ?? [])].reverse().find((m) => m.role === 'user')
  if (!body.bot_id || !lastUser?.content) {
    return c.json({ code: 4000, msg: 'bot_id and a user message in additional_messages are required' }, 400)
  }

  const supabase = c.get('supabase')
  const { data: agent } = await supabase
    .from('agents')
    .select()
    .eq('id', body.bot_id)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!agent) return c.json({ code: 4004, msg: 'bot not found' }, 404)

  const params = {
    workspaceId: wid,
    agent,
    conversationId: c.req.query('conversation_id') || undefined,
    userId: c.get('authKind') === 'user' ? c.get('userId') : null,
    userKey: body.user_id ?? body.user ?? 'api',
    message: lastUser.content,
  }

  if (!body.stream) {
    try {
      const result = await runChatTurn(c.env, supabase, params)
      return c.json({
        code: 0,
        data: {
          id: result.messageId ?? crypto.randomUUID(),
          conversation_id: result.conversationId,
          bot_id: agent.id,
          status: 'completed',
          usage: {
            token_count: result.usage.prompt_tokens + result.usage.completion_tokens,
            input_count: result.usage.prompt_tokens,
            output_count: result.usage.completion_tokens,
          },
        },
        messages: [
          { role: 'assistant', type: 'answer', content: result.content, content_type: 'text' },
          ...(result.suggestions ?? []).map((s) => ({
            role: 'assistant',
            type: 'follow_up',
            content: s,
            content_type: 'text',
          })),
        ],
      })
    } catch (e) {
      if (e instanceof ChatError) return c.json({ code: 5000, msg: e.message }, e.status as 400)
      throw e
    }
  }

  return streamSSE(c, async (stream) => {
    const chatId = crypto.randomUUID()
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) })
    try {
      const result = await runChatTurn(c.env, supabase, params, async (ev) => {
        if (ev.type === 'start') {
          const base = { id: chatId, conversation_id: ev.conversation_id, bot_id: agent.id }
          await send('conversation.chat.created', { ...base, status: 'created' })
          await send('conversation.chat.in_progress', { ...base, status: 'in_progress' })
        } else if (ev.type === 'delta') {
          await send('conversation.message.delta', {
            role: 'assistant',
            type: 'answer',
            content: ev.content,
            content_type: 'text',
          })
        } else if (ev.type === 'suggestion') {
          for (const s of (ev.suggestions as string[]) ?? []) {
            await send('conversation.message.completed', {
              role: 'assistant',
              type: 'follow_up',
              content: s,
              content_type: 'text',
            })
          }
        }
      })
      await send('conversation.message.completed', {
        id: result.messageId,
        role: 'assistant',
        type: 'answer',
        content: result.content,
        content_type: 'text',
      })
      await send('conversation.chat.completed', {
        id: chatId,
        conversation_id: result.conversationId,
        bot_id: agent.id,
        status: 'completed',
        usage: {
          token_count: result.usage.prompt_tokens + result.usage.completion_tokens,
          input_count: result.usage.prompt_tokens,
          output_count: result.usage.completion_tokens,
        },
      })
      await stream.writeSSE({ event: 'done', data: '"[DONE]"' })
    } catch (e) {
      await send('conversation.chat.failed', {
        id: chatId,
        status: 'failed',
        last_error: { code: 5000, msg: String(e instanceof Error ? e.message : e).slice(0, 300) },
      })
    }
  })
})

// Non-stream chats complete inline, so retrieve always reports the terminal
// state of the conversation's last assistant turn.
compatV3.get('/chat/retrieve', async (c) => {
  const wid = resolveWorkspace(c)
  if (!wid || !(await requireMembership(c, wid))) return c.json({ code: 4100, msg: 'unauthorized' }, 401)
  const conversationId = c.req.query('conversation_id')
  if (!conversationId) return c.json({ code: 4000, msg: 'conversation_id is required' }, 400)
  const { data: last } = await c
    .get('supabase')
    .from('messages')
    .select('id, meta, created_at')
    .eq('conversation_id', conversationId)
    .eq('workspace_id', wid)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const usage = (last?.meta as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage
  return c.json({
    code: 0,
    data: {
      id: last?.id ?? c.req.query('chat_id') ?? '',
      conversation_id: conversationId,
      status: last ? 'completed' : 'in_progress',
      ...(usage
        ? {
            usage: {
              token_count: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
              input_count: usage.prompt_tokens ?? 0,
              output_count: usage.completion_tokens ?? 0,
            },
          }
        : {}),
    },
  })
})

compatV3.get('/chat/message/list', async (c) => {
  const wid = resolveWorkspace(c)
  if (!wid || !(await requireMembership(c, wid))) return c.json({ code: 4100, msg: 'unauthorized' }, 401)
  const conversationId = c.req.query('conversation_id')
  if (!conversationId) return c.json({ code: 4000, msg: 'conversation_id is required' }, 400)
  const { data } = await c
    .get('supabase')
    .from('messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .eq('workspace_id', wid)
    .order('created_at', { ascending: true })
    .limit(100)
  return c.json({
    code: 0,
    data: (data ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      type: m.role === 'assistant' ? 'answer' : 'question',
      content: m.content,
      content_type: 'text',
      created_at: m.created_at,
    })),
  })
})

export const compatV1 = new Hono<AppEnv>()

compatV1.post('/conversation/create', async (c) => {
  const wid = resolveWorkspace(c)
  if (!wid || !(await requireMembership(c, wid))) return c.json({ code: 4100, msg: 'unauthorized' }, 401)
  const body = await c.req.json<{ bot_id?: string }>().catch(() => ({}) as any)
  if (!body.bot_id) return c.json({ code: 4000, msg: 'bot_id is required' }, 400)
  const supabase = c.get('supabase')
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', body.bot_id)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!agent) return c.json({ code: 4004, msg: 'bot not found' }, 404)
  const { data: conv, error } = await supabase
    .from('conversations')
    .insert({
      workspace_id: wid,
      agent_id: agent.id,
      user_id: c.get('authKind') === 'user' ? c.get('userId') : null,
      title: 'api conversation',
    })
    .select('id, created_at')
    .single()
  if (error) return c.json({ code: 5000, msg: error.message }, 500)
  return c.json({ code: 0, data: { id: conv.id, created_at: conv.created_at } })
})

compatV1.get('/conversations', async (c) => {
  const wid = resolveWorkspace(c)
  if (!wid || !(await requireMembership(c, wid))) return c.json({ code: 4100, msg: 'unauthorized' }, 401)
  let query = c
    .get('supabase')
    .from('conversations')
    .select('id, agent_id, title, created_at, updated_at')
    .eq('workspace_id', wid)
    .order('updated_at', { ascending: false })
    .limit(50)
  const botId = c.req.query('bot_id')
  if (botId) query = query.eq('agent_id', botId)
  const { data } = await query
  return c.json({ code: 0, data: { conversations: data ?? [] } })
})
