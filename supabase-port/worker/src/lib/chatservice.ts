import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { runAgentLoop, type EmitFn, type ToolLogEntry } from './agentloop'
import { buildAgentTools } from './agenttools'
import { retrieve, contextBlock } from './retrieval'
import { renderTemplate } from '../engine/workflow'
import type { ChatMessage, Usage } from './openai'

export class ChatError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export interface ChatParams {
  workspaceId: string
  agent: Record<string, any>
  conversationId?: string
  userId?: string | null // auth user owning the conversation (null for api/share)
  userKey: string // end-user identity for memory + oauth scoping
  message: string
}

export interface ChatTurnResult {
  conversationId: string
  messageId?: string
  content: string
  toolLog: ToolLogEntry[]
  usage: Usage
}

// One full agent turn: conversation resolution, history, RAG, memory
// variables, tool loop, persistence, usage metering. Shared by the
// authenticated chat route and the public share-link chat route.
export async function runChatTurn(
  env: Env,
  supabase: SupabaseClient,
  params: ChatParams,
  emit?: EmitFn
): Promise<ChatTurnResult> {
  const { workspaceId: wid, agent, userKey } = params
  const userMessage = params.message.trim()
  if (!userMessage) throw new ChatError(400, 'message is required')

  let conversationId = params.conversationId
  if (conversationId) {
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('workspace_id', wid)
      .eq('agent_id', agent.id)
      .maybeSingle()
    if (!conv) throw new ChatError(404, 'conversation not found')
  } else {
    const { data: conv, error } = await supabase
      .from('conversations')
      .insert({
        workspace_id: wid,
        agent_id: agent.id,
        user_id: params.userId ?? null,
        title: userMessage.slice(0, 80),
      })
      .select('id')
      .single()
    if (error) throw new ChatError(500, error.message)
    conversationId = conv.id as string
  }
  if (emit) await emit({ type: 'start', conversation_id: conversationId })

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
    ? await retrieve(env, supabase, wid, datasetIds, userMessage).catch(() => [])
    : []

  // Tools: HTTP plugins (+OAuth), agent databases, workflows-as-tools.
  const tools = await buildAgentTools(env, supabase, wid, userKey, agent)

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
  const systemPrompt = renderTemplate(agent.prompt ?? '', {
    var: { ...(agent.variables ?? {}), ...userVars },
  })

  const messages: ChatMessage[] = [
    ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...(chunks.length ? [{ role: 'system' as const, content: contextBlock(chunks) }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userMessage },
  ]

  const modelConfig = (agent.model ?? {}) as {
    model?: string
    temperature?: number
    max_tokens?: number
  }
  const result = await runAgentLoop(
    env,
    {
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.max_tokens,
      messages,
      tools,
    },
    emit
  )

  const { data: assistantMsg } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      workspace_id: wid,
      role: 'assistant',
      content: result.content,
      meta: { usage: result.usage, tool_log: result.toolLog, retrieved_chunks: chunks.length },
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
    model: modelConfig.model ?? env.CHAT_MODEL ?? 'gpt-4o-mini',
    prompt_tokens: result.usage.prompt_tokens,
    completion_tokens: result.usage.completion_tokens,
    meta: { agent_id: agent.id, conversation_id: conversationId },
  })

  return {
    conversationId,
    messageId: assistantMsg?.id as string | undefined,
    content: result.content,
    toolLog: result.toolLog,
    usage: result.usage,
  }
}
