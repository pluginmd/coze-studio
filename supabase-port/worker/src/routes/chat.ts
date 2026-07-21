import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../env'
import { runAgentLoop, type ToolLogEntry } from '../lib/agentloop'
import { buildAgentTools } from '../lib/agenttools'
import { retrieve, contextBlock } from '../lib/retrieval'
import { renderTemplate } from '../engine/workflow'
import type { ChatMessage, Usage } from '../lib/openai'

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
  const userMessage = body.message?.trim()
  if (!body.agent_id || !userMessage) {
    return c.json({ error: 'agent_id and message are required' }, 400)
  }

  const { data: agent } = await supabase
    .from('agents')
    .select()
    .eq('id', body.agent_id)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!agent) return c.json({ error: 'agent not found' }, 404)

  const userKey =
    c.get('authKind') === 'user' ? c.get('userId') : (body.user_key ?? 'api')

  let conversationId = body.conversation_id
  if (conversationId) {
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('workspace_id', wid)
      .eq('agent_id', agent.id)
      .maybeSingle()
    if (!conv) return c.json({ error: 'conversation not found' }, 404)
  } else {
    const { data: conv, error } = await supabase
      .from('conversations')
      .insert({
        workspace_id: wid,
        agent_id: agent.id,
        user_id: c.get('authKind') === 'user' ? c.get('userId') : null,
        title: userMessage.slice(0, 80),
      })
      .select('id')
      .single()
    if (error) return c.json({ error: error.message }, 500)
    conversationId = conv.id
  }

  // History is loaded before inserting the new user message.
  const { data: historyRows } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(20)
  const history = (historyRows ?? []).reverse() as { role: 'user' | 'assistant'; content: string }[]

  await supabase.from('messages').insert({
    conversation_id: conversationId,
    workspace_id: wid,
    role: 'user',
    content: userMessage,
  })

  const datasetIds: string[] = agent.dataset_ids ?? []
  const chunks = datasetIds.length
    ? await retrieve(c.env, supabase, wid, datasetIds, userMessage).catch(() => [])
    : []

  // Tools: HTTP plugins (+OAuth), agent databases, workflows-as-tools.
  const tools = await buildAgentTools(c.env, supabase, wid, userKey, agent)

  // Prompt variables: agent statics overridden by the user's long-term memory.
  const { data: varRows } = await supabase
    .from('user_variables')
    .select('name, value, agent_id')
    .eq('workspace_id', wid)
    .eq('user_key', userKey)
    .or(`agent_id.eq.${agent.id},agent_id.is.null`)
    .limit(100)
  const userVars: Record<string, unknown> = {}
  for (const v of varRows ?? []) userVars[v.name] = v.value
  const promptScope = { var: { ...(agent.variables ?? {}), ...userVars } }
  const systemPrompt = renderTemplate(agent.prompt ?? '', promptScope)

  const messages: ChatMessage[] = [
    ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...(chunks.length ? [{ role: 'system' as const, content: contextBlock(chunks) }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userMessage },
  ]

  const modelConfig = (agent.model ?? {}) as { model?: string; temperature?: number; max_tokens?: number }
  const loopOpts = {
    model: modelConfig.model,
    temperature: modelConfig.temperature,
    maxTokens: modelConfig.max_tokens,
    messages,
    tools,
  }

  const persist = async (content: string, toolLog: ToolLogEntry[], usage: Usage) => {
    const { data: assistantMsg } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        workspace_id: wid,
        role: 'assistant',
        content,
        meta: { usage, tool_log: toolLog, retrieved_chunks: chunks.length },
      })
      .select('id')
      .single()
    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)
    await supabase.from('usage_events').insert({
      workspace_id: wid,
      kind: 'chat',
      model: modelConfig.model ?? c.env.CHAT_MODEL ?? 'gpt-4o-mini',
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      meta: { agent_id: agent.id, conversation_id: conversationId },
    })
    return assistantMsg?.id as string | undefined
  }

  if (body.stream === false) {
    const result = await runAgentLoop(c.env, loopOpts)
    const messageId = await persist(result.content, result.toolLog, result.usage)
    return c.json({
      conversation_id: conversationId,
      message_id: messageId,
      content: result.content,
      tool_calls: result.toolLog,
      usage: result.usage,
    })
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'start',
      data: JSON.stringify({ conversation_id: conversationId }),
    })
    try {
      const result = await runAgentLoop(c.env, loopOpts, async (ev) => {
        await stream.writeSSE({ event: String(ev.type), data: JSON.stringify(ev) })
      })
      const messageId = await persist(result.content, result.toolLog, result.usage)
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          conversation_id: conversationId,
          message_id: messageId,
          usage: result.usage,
        }),
      })
    } catch (e) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: String(e).slice(0, 500) }),
      })
    }
  })
})
