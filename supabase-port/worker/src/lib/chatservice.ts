import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { runAgentLoop, type EmitFn, type ToolLogEntry, type AgentTool } from './agentloop'
import { buildAgentTools } from './agenttools'
import { retrieve, rewriteQuery, contextBlock, type SearchType } from './retrieval'
import { renderTemplate, runWorkflow, type WfGraph } from '../engine/workflow'
import { matchShortcut, expandShortcut, type Shortcut } from './shortcuts'
import { chatComplete, contentText, type ChatMessage, type ContentPart, type Usage } from './openai'

export class ChatError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export interface ChatAttachment {
  type: 'image'
  url?: string
  base64?: string
  mime?: string
}

export interface ChatParams {
  workspaceId: string
  agent: Record<string, any>
  conversationId?: string
  userId?: string | null // auth user owning the conversation (null for api/share)
  userKey: string // end-user identity for memory + oauth scoping
  message: string
  attachments?: ChatAttachment[]
}

export interface ChatTurnResult {
  conversationId: string
  messageId?: string
  content: string
  toolLog: ToolLogEntry[]
  usage: Usage
  suggestions?: string[]
}

interface KnowledgeConfig {
  top_k?: number
  min_score?: number
  search_type?: SearchType
  auto?: boolean // false => recall exposed as a tool (on-demand)
  rewrite?: boolean // multi-turn query rewrite (default true)
  rerank?: boolean // Jina reranker on top of RRF
}

function buildUserContent(message: string, attachments: ChatAttachment[]): string | ContentPart[] {
  const images = attachments.filter((a) => a.type === 'image' && (a.url || a.base64))
  if (!images.length) return message
  return [
    { type: 'text', text: message },
    ...images.map((a) => ({
      type: 'image_url' as const,
      image_url: { url: a.url ?? `data:${a.mime ?? 'image/png'};base64,${a.base64}` },
    })),
  ]
}

// One full agent turn: conversation resolution, shortcut expansion,
// multi-agent routing, history, RAG, memory variables, multimodal input,
// tool loop, follow-up suggestions, persistence, metering.
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

  const extraUsage: Usage = { prompt_tokens: 0, completion_tokens: 0 }

  // --- shortcut commands (shortcutcmd domain) ------------------------------
  let effectiveMessage = userMessage
  let shortcutContext = ''
  const matched = matchShortcut((agent.shortcuts ?? []) as Shortcut[], userMessage)
  if (matched) {
    if (emit) await emit({ type: 'shortcut', command: matched.shortcut.command })
    effectiveMessage = expandShortcut(matched) || userMessage
    if (matched.shortcut.workflow_id) {
      const { data: wf } = await supabase
        .from('workflows')
        .select('graph')
        .eq('id', matched.shortcut.workflow_id)
        .eq('workspace_id', wid)
        .maybeSingle()
      if (wf) {
        try {
          const run = await runWorkflow(env, supabase, wid, wf.graph as WfGraph, {
            query: matched.args.input ?? '',
            ...matched.args,
          }, { userKey })
          extraUsage.prompt_tokens += run.usage.prompt_tokens
          extraUsage.completion_tokens += run.usage.completion_tokens
          shortcutContext =
            `Result of the ${matched.shortcut.command} shortcut workflow (use it to answer):\n` +
            JSON.stringify(run.output ?? null).slice(0, 4000)
        } catch (e) {
          shortcutContext = `The ${matched.shortcut.command} shortcut workflow failed: ${String(
            e instanceof Error ? e.message : e
          ).slice(0, 300)}`
        }
      }
    }
  }

  // --- multi-agent routing (host + sub-agents) -----------------------------
  let execAgent = agent
  const ma = (agent.multi_agent ?? {}) as {
    enabled?: boolean
    sub_agents?: { agent_id: string; description?: string }[]
  }
  if (ma.enabled && ma.sub_agents?.length) {
    const routedId = await routeSubAgent(env, ma.sub_agents, effectiveMessage, extraUsage)
    if (routedId) {
      const { data: sub } = await supabase
        .from('agents')
        .select()
        .eq('id', routedId)
        .eq('workspace_id', wid)
        .maybeSingle()
      if (sub) {
        execAgent = sub
        if (emit) await emit({ type: 'route', agent_id: sub.id, name: sub.name })
      }
    }
  }

  const modelConfig = (execAgent.model ?? {}) as {
    model?: string
    temperature?: number
    max_tokens?: number
    top_p?: number
    frequency_penalty?: number
    presence_penalty?: number
    response_format?: 'text' | 'json'
    history_rounds?: number
  }

  // History window is configurable per agent (rounds = user+assistant pairs).
  const historyLimit = Math.min(Math.max(1, modelConfig.history_rounds ?? 10), 20) * 2
  const { data: historyRows } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(historyLimit)
  const history = (historyRows ?? []).reverse() as { role: 'user' | 'assistant'; content: string }[]

  const attachments = params.attachments ?? []
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    workspace_id: wid,
    role: 'user',
    content: userMessage,
    meta: attachments.length
      ? { attachments: attachments.map((a) => ({ type: a.type, url: a.url ?? null, mime: a.mime ?? null })) }
      : {},
  })

  // Knowledge recall — per-agent config; auto (context injection) or
  // on-demand (exposed to the model as a search tool).
  const kb = (execAgent.knowledge ?? {}) as KnowledgeConfig
  const datasetIds: string[] = execAgent.dataset_ids ?? []
  const retrieveOpts = {
    topK: kb.top_k ?? 6,
    minScore: kb.min_score,
    searchType: kb.search_type,
    rerank: kb.rerank,
  }
  let chunksCount = 0
  let ragContext = ''
  const extraTools: AgentTool[] = []
  if (datasetIds.length) {
    if (kb.auto === false) {
      extraTools.push({
        def: {
          type: 'function',
          function: {
            name: 'search_knowledge',
            description:
              'Search the attached knowledge bases. Use when the user asks about topics that may be covered there.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'search query' } },
              required: ['query'],
            },
          },
        },
        execute: async (args) => {
          const found = await retrieve(env, supabase, wid, datasetIds, String(args.query ?? ''), retrieveOpts)
          chunksCount += found.length
          return JSON.stringify(found.map((f) => ({ content: f.content.slice(0, 1500), score: f.score })))
        },
      })
    } else {
      const searchQuery =
        kb.rewrite === false ? effectiveMessage : await rewriteQuery(env, history, effectiveMessage)
      const chunks = await retrieve(env, supabase, wid, datasetIds, searchQuery, retrieveOpts).catch(
        () => []
      )
      chunksCount = chunks.length
      ragContext = contextBlock(chunks)
    }
  }

  const tools = [...(await buildAgentTools(env, supabase, wid, userKey, execAgent)), ...extraTools]

  // Prompt variables: agent statics overridden by the user's long-term memory.
  const { data: varRows } = await supabase
    .from('user_variables')
    .select('name, value, agent_id')
    .eq('workspace_id', wid)
    .eq('user_key', userKey)
    .or(`agent_id.eq.${execAgent.id},agent_id.is.null`)
    .limit(100)
  const userVars: Record<string, unknown> = {}
  for (const v of varRows ?? []) userVars[v.name] = v.value
  const systemPrompt = renderTemplate(execAgent.prompt ?? '', {
    var: { ...(execAgent.variables ?? {}), ...userVars },
  })

  const messages: ChatMessage[] = [
    ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...(ragContext ? [{ role: 'system' as const, content: ragContext }] : []),
    ...(shortcutContext ? [{ role: 'system' as const, content: shortcutContext }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: buildUserContent(effectiveMessage, attachments) },
  ]

  const result = await runAgentLoop(
    env,
    {
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.max_tokens,
      topP: modelConfig.top_p,
      frequencyPenalty: modelConfig.frequency_penalty,
      presencePenalty: modelConfig.presence_penalty,
      responseFormat: modelConfig.response_format,
      messages,
      tools,
    },
    emit
  )
  result.usage.prompt_tokens += extraUsage.prompt_tokens
  result.usage.completion_tokens += extraUsage.completion_tokens

  const { data: assistantMsg } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      workspace_id: wid,
      role: 'assistant',
      content: result.content,
      meta: {
        usage: result.usage,
        tool_log: result.toolLog,
        retrieved_chunks: chunksCount,
        ...(execAgent.id !== agent.id ? { routed_agent_id: execAgent.id } : {}),
        ...(matched ? { shortcut: matched.shortcut.command } : {}),
      },
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

  // Auto follow-up suggestions (suggest-reply graph of the original).
  let suggestions: string[] | undefined
  const suggestConfig = (execAgent.suggest_reply ?? {}) as { mode?: string; prompt?: string }
  if ((suggestConfig.mode === 'auto' || suggestConfig.mode === 'custom') && result.content) {
    suggestions = await generateSuggestions(
      env,
      effectiveMessage,
      result.content,
      suggestConfig.mode === 'custom' ? suggestConfig.prompt : undefined
    )
    if (suggestions.length && emit) await emit({ type: 'suggestion', suggestions })
  }

  return {
    conversationId,
    messageId: assistantMsg?.id as string | undefined,
    content: result.content,
    toolLog: result.toolLog,
    usage: result.usage,
    suggestions,
  }
}

// LLM router: pick the best sub-agent for the message, or null for the host.
async function routeSubAgent(
  env: Env,
  subAgents: { agent_id: string; description?: string }[],
  message: string,
  usageAcc: Usage
): Promise<string | null> {
  const catalog = subAgents
    .map((s, i) => `${i + 1}. id=${s.agent_id} — ${s.description ?? '(no description)'}`)
    .join('\n')
  try {
    const result = await chatComplete(env, {
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Route the user message to the most suitable specialist agent. Respond with only a JSON ' +
            'object {"agent_id": "<id>"} choosing from the list, or {"agent_id": "host"} if none fits.\n' +
            catalog,
        },
        { role: 'user', content: message.slice(0, 1000) },
      ],
    })
    if (result.usage) {
      usageAcc.prompt_tokens += result.usage.prompt_tokens ?? 0
      usageAcc.completion_tokens += result.usage.completion_tokens ?? 0
    }
    const parsed = JSON.parse(contentText(result.message.content).match(/\{[\s\S]*\}/)?.[0] ?? '{}')
    const id = String(parsed.agent_id ?? 'host')
    return subAgents.some((s) => s.agent_id === id) ? id : null
  } catch {
    return null
  }
}

async function generateSuggestions(
  env: Env,
  question: string,
  answer: string,
  customPrompt?: string
): Promise<string[]> {
  try {
    const result = await chatComplete(env, {
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            customPrompt?.trim() ||
            'Based on the conversation, propose 3 short follow-up questions the user might ask next, ' +
              'in the same language as the user. Output exactly 3 lines, one question per line, no numbering.',
        },
        { role: 'user', content: `User: ${question.slice(0, 800)}\nAssistant: ${answer.slice(0, 1200)}` },
      ],
    })
    return contentText(result.message.content)
      .split('\n')
      .map((l: string) => l.replace(/^[\d\-.*)\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 3)
  } catch {
    return []
  }
}
