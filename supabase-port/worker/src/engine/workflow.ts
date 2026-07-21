import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { chatComplete, contentText, type Usage } from '../lib/openai'
import { retrieve } from '../lib/retrieval'
import { invokeTool, type PluginRow, type ToolRow } from '../lib/plugins'
import { isOAuthConfig, getAccessToken } from '../lib/oauth'
import { queryRows, validateRow, type DbColumn, type DbFilter } from '../lib/database'
import { evalExpression } from '../lib/expr'
import { indexDocument } from '../indexer'

// ============================================================================
// Workflow engine v2 — parallel DAG executor.
//
// Nodes with no unresolved inbound edges run concurrently (wave-based).
// condition/selector/intent nodes activate only their matching outbound edge;
// unreached paths are pruned transitively. Loops and batches execute
// sub-workflows per item (sequentially / concurrently).
// ============================================================================

export interface WfNode {
  id: string
  type: string
  data: Record<string, any>
}

export interface WfEdge {
  source: string
  target: string
  label?: string // condition: 'true'|'false'; selector/intent: branch name
}

export interface WfGraph {
  nodes: WfNode[]
  edges: WfEdge[]
}

export interface WfRunResult {
  output: unknown
  nodeResults: Record<string, unknown>
  usage: Usage
}

interface EngineCtx {
  env: Env
  supabase: SupabaseClient
  workspaceId: string
  userKey: string
  usage: Usage
  executed: { count: number }
  depth: number
}

const NODE_ALIASES: Record<string, string> = {
  knowledge: 'knowledge_retrieve',
  entry: 'start',
  exit: 'end',
}

const MAX_NODES_PER_RUN = 500
const MAX_WAVES = 100
const MAX_SUB_DEPTH = 3

// ---------------------------------------------------------------------------
// templating: `{{nodeId.field.path}}` string interpolation + raw path access
// ---------------------------------------------------------------------------
export function resolvePath(scope: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as any)[key]), scope)
}

export function renderTemplate(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
    const value = resolvePath(scope, path)
    if (value == null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

function renderDeep(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    // A lone `{{path}}` keeps its raw type (array/object/number)
    const lone = value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/)
    if (lone) {
      const raw = resolvePath(scope, lone[1])
      return raw === undefined ? '' : raw
    }
    return renderTemplate(value, scope)
  }
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, scope)
    return out
  }
  return value
}

function evalCondition(
  scope: Record<string, unknown>,
  left: unknown,
  op: string,
  right: unknown
): boolean {
  const l = renderTemplate(String(left ?? ''), scope)
  const r = renderTemplate(String(right ?? ''), scope)
  switch (op) {
    case 'neq':
      return l !== r
    case 'contains':
      return l.includes(r)
    case 'gt':
      return Number(l) > Number(r)
    case 'lt':
      return Number(l) < Number(r)
    case 'empty':
      return l.trim() === ''
    case 'not_empty':
      return l.trim() !== ''
    default:
      return l === r
  }
}

// ---------------------------------------------------------------------------
// public entry
// ---------------------------------------------------------------------------
export async function runWorkflow(
  env: Env,
  supabase: SupabaseClient,
  workspaceId: string,
  graph: WfGraph,
  input: Record<string, unknown>,
  opts: { userKey?: string; depth?: number } = {}
): Promise<WfRunResult> {
  const ctx: EngineCtx = {
    env,
    supabase,
    workspaceId,
    userKey: opts.userKey ?? '',
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    executed: { count: 0 },
    depth: opts.depth ?? 0,
  }
  const { output, nodeResults } = await execGraph(ctx, graph, input)
  return { output, nodeResults, usage: ctx.usage }
}

async function runSubWorkflow(
  ctx: EngineCtx,
  workflowId: string,
  input: Record<string, unknown>
): Promise<{ output: unknown; nodeResults: Record<string, unknown> }> {
  if (ctx.depth >= MAX_SUB_DEPTH) throw new Error(`sub-workflow depth limit (${MAX_SUB_DEPTH}) exceeded`)
  const { data: wf } = await ctx.supabase
    .from('workflows')
    .select('graph')
    .eq('id', workflowId)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle()
  if (!wf) throw new Error(`workflow not found: ${workflowId}`)
  return execGraph({ ...ctx, depth: ctx.depth + 1 }, wf.graph as WfGraph, input)
}

async function execGraph(
  ctx: EngineCtx,
  graph: WfGraph,
  input: Record<string, unknown>
): Promise<{ output: unknown; nodeResults: Record<string, unknown> }> {
  const nodes = graph.nodes ?? []
  const edges = graph.edges ?? []
  if (!nodes.length) throw new Error('workflow graph has no nodes')

  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  for (const e of edges) {
    if (!nodesById.has(e.source) || !nodesById.has(e.target)) {
      throw new Error(`edge references unknown node: ${e.source} -> ${e.target}`)
    }
  }

  const inbound = new Map<string, WfEdge[]>()
  const outbound = new Map<string, WfEdge[]>()
  for (const e of edges) {
    inbound.set(e.target, [...(inbound.get(e.target) ?? []), e])
    outbound.set(e.source, [...(outbound.get(e.source) ?? []), e])
  }

  const status = new Map<string, 'pending' | 'done' | 'skipped'>(nodes.map((n) => [n.id, 'pending']))
  const edgeState = new Map<WfEdge, 'unresolved' | 'active' | 'inactive'>(
    edges.map((e) => [e, 'unresolved'])
  )
  const results: Record<string, unknown> = { input }
  let output: unknown = null

  const isResolvable = (n: WfNode) =>
    (inbound.get(n.id) ?? []).every((e) => edgeState.get(e) !== 'unresolved')
  const hasActiveInput = (n: WfNode) => {
    const ins = inbound.get(n.id) ?? []
    return ins.length === 0 || ins.some((e) => edgeState.get(e) === 'active')
  }

  let waves = 0
  while (true) {
    const ready = nodes.filter((n) => status.get(n.id) === 'pending' && isResolvable(n))
    if (!ready.length) break
    if (++waves > MAX_WAVES) throw new Error(`workflow exceeded ${MAX_WAVES} execution waves`)

    await Promise.all(
      ready.map(async (node) => {
        const outs = outbound.get(node.id) ?? []
        if (!hasActiveInput(node)) {
          status.set(node.id, 'skipped')
          for (const e of outs) edgeState.set(e, 'inactive')
          return
        }
        if (++ctx.executed.count > MAX_NODES_PER_RUN) {
          throw new Error(`workflow exceeded ${MAX_NODES_PER_RUN} node executions`)
        }
        const type = NODE_ALIASES[node.type] ?? node.type
        let result: unknown
        try {
          result = await execNode(ctx, type, node, input, results)
        } catch (e) {
          const err = new Error(`node ${node.id} (${type}) failed: ${String(e).slice(0, 500)}`)
          ;(err as any).nodeResults = results
          throw err
        }
        results[node.id] = result
        status.set(node.id, 'done')

        if (type === 'condition') {
          const branch = String((result as any).result)
          for (const e of outs) edgeState.set(e, (e.label ?? 'true') === branch ? 'active' : 'inactive')
        } else if (type === 'selector' || type === 'intent') {
          const branch = String((result as any).branch ?? (result as any).intent ?? '')
          const matched = outs.some((e) => e.label === branch)
          for (const e of outs) {
            const active = matched ? e.label === branch : e.label === 'default'
            edgeState.set(e, active ? 'active' : 'inactive')
          }
        } else {
          for (const e of outs) edgeState.set(e, 'active')
        }
        if (type === 'end' && output == null) output = result
      })
    )
  }

  return { output, nodeResults: results }
}

// ---------------------------------------------------------------------------
// node implementations
// ---------------------------------------------------------------------------
async function execNode(
  ctx: EngineCtx,
  type: string,
  node: WfNode,
  input: Record<string, unknown>,
  scope: Record<string, unknown>
): Promise<unknown> {
  const data = node.data ?? {}
  switch (type) {
    case 'start':
      return input

    case 'end':
      if (data.template != null) return { text: renderTemplate(String(data.template), scope) }
      if (data.outputs && typeof data.outputs === 'object') return renderDeep(data.outputs, scope)
      return { done: true }

    case 'template':
      return { text: renderTemplate(String(data.template ?? ''), scope) }

    case 'llm': {
      const messages = [
        ...(data.system
          ? [{ role: 'system' as const, content: renderTemplate(String(data.system), scope) }]
          : []),
        { role: 'user' as const, content: renderTemplate(String(data.prompt ?? ''), scope) },
      ]
      const result = await chatComplete(ctx.env, {
        model: data.model,
        temperature: data.temperature,
        max_tokens: data.max_tokens,
        messages,
      })
      addUsage(ctx, result.usage)
      return { text: contentText(result.message.content), usage: result.usage }
    }

    case 'intent': {
      const intents = (data.intents ?? []) as { name: string; description?: string }[]
      if (!intents.length) throw new Error('intent node has no intents configured')
      const catalog = intents.map((i) => `- ${i.name}: ${i.description ?? ''}`).join('\n')
      const result = await chatComplete(ctx.env, {
        model: data.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Classify the user input into exactly one intent. Respond with only a JSON object ' +
              `{"intent": "<name>"}. Available intents:\n${catalog}`,
          },
          { role: 'user', content: renderTemplate(String(data.input ?? ''), scope) },
        ],
      })
      addUsage(ctx, result.usage)
      const raw = contentText(result.message.content)
      let intent = 'unknown'
      try {
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
        if (intents.some((i) => i.name === parsed.intent)) intent = parsed.intent
      } catch {
        // fall through to 'unknown'
      }
      return { intent, branch: intent, raw }
    }

    case 'knowledge_retrieve': {
      const chunks = await retrieve(
        ctx.env,
        ctx.supabase,
        ctx.workspaceId,
        (data.dataset_ids ?? []) as string[],
        renderTemplate(String(data.query ?? ''), scope),
        {
          topK: Number(data.top_k ?? 6),
          minScore: data.min_score != null ? Number(data.min_score) : undefined,
          searchType: data.search_type,
        }
      )
      return { chunks, text: chunks.map((c) => c.content).join('\n\n') }
    }

    case 'knowledge_index': {
      const datasetId = renderTemplate(String(data.dataset_id ?? ''), scope)
      const text = renderTemplate(String(data.text ?? ''), scope)
      if (!datasetId || !text.trim()) throw new Error('knowledge_index requires dataset_id and text')
      const docId = crypto.randomUUID()
      const name = (renderTemplate(String(data.name ?? ''), scope) || `wf-${docId.slice(0, 8)}.txt`)
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 80)
      const storagePath = `${ctx.workspaceId}/${datasetId}/${docId}/${name}`
      const { error: upErr } = await ctx.supabase.storage
        .from('knowledge')
        .upload(storagePath, new TextEncoder().encode(text), {
          contentType: 'text/plain; charset=utf-8',
          upsert: true,
        })
      if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)
      const { error: insErr } = await ctx.supabase.from('documents').insert({
        id: docId,
        dataset_id: datasetId,
        workspace_id: ctx.workspaceId,
        name,
        source_type: 'text',
        storage_path: storagePath,
        size_bytes: text.length,
        status: 'pending',
      })
      if (insErr) throw new Error(insErr.message)
      await indexDocument(ctx.env, docId)
      const { data: doc } = await ctx.supabase
        .from('documents')
        .select('status, chunk_count, error')
        .eq('id', docId)
        .maybeSingle()
      if (doc?.status !== 'ready') throw new Error(`indexing failed: ${doc?.error ?? 'unknown'}`)
      return { document_id: docId, status: doc.status, chunk_count: doc.chunk_count }
    }

    case 'knowledge_delete': {
      const documentId = renderTemplate(String(data.document_id ?? ''), scope)
      const { data: doc } = await ctx.supabase
        .from('documents')
        .select('id, storage_path')
        .eq('id', documentId)
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle()
      if (!doc) return { deleted: false }
      if (doc.storage_path) await ctx.supabase.storage.from('knowledge').remove([doc.storage_path])
      await ctx.supabase.from('documents').delete().eq('id', doc.id)
      return { deleted: true }
    }

    case 'plugin': {
      const { data: tool } = await ctx.supabase
        .from('plugin_tools')
        .select()
        .eq('id', data.tool_id)
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle()
      if (!tool) throw new Error(`plugin tool not found: ${data.tool_id}`)
      const { data: plugin } = await ctx.supabase
        .from('plugins')
        .select()
        .eq('id', tool.plugin_id)
        .maybeSingle()
      if (!plugin) throw new Error(`plugin not found for tool: ${data.tool_id}`)
      let extraHeaders: Record<string, string> | undefined
      if (isOAuthConfig(plugin.auth)) {
        const token = await getAccessToken(
          ctx.supabase,
          plugin.id,
          ctx.workspaceId,
          ctx.userKey,
          plugin.auth
        )
        if (!token) throw new Error('plugin requires oauth connection for this user')
        extraHeaders = { authorization: `Bearer ${token}` }
      }
      const result = await invokeTool(
        plugin as PluginRow,
        tool as ToolRow,
        renderDeep(data.args ?? {}, scope) as Record<string, unknown>,
        extraHeaders
      )
      let parsed: unknown = result.body
      try {
        parsed = JSON.parse(result.body)
      } catch {
        // keep raw text body
      }
      return { status: result.status, body: parsed }
    }

    case 'http': {
      const url = renderTemplate(String(data.url ?? ''), scope)
      if (!/^https?:\/\//i.test(url)) throw new Error('http node requires an http(s) url')
      const method = String(data.method ?? 'GET').toUpperCase()
      const headers = renderDeep(data.headers ?? {}, scope) as Record<string, string>
      const bodyValue = data.body != null ? renderDeep(data.body, scope) : undefined
      const res = await fetch(url, {
        method,
        headers,
        body:
          bodyValue === undefined || method === 'GET' || method === 'HEAD'
            ? undefined
            : typeof bodyValue === 'string'
              ? bodyValue
              : JSON.stringify(bodyValue),
        signal: AbortSignal.timeout(Number(data.timeout_ms ?? 20_000)),
      })
      const text = (await res.text()).slice(0, 50_000)
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // keep raw text body
      }
      return { status: res.status, body: parsed }
    }

    case 'database_query': {
      const filters = (renderDeep(data.filters ?? [], scope) ?? []) as DbFilter[]
      const rows = await queryRows(
        ctx.supabase,
        ctx.workspaceId,
        String(data.database_id),
        filters,
        Number(data.limit ?? 100)
      )
      return { rows: rows.map((r) => ({ id: r.id, ...r.data })), count: rows.length }
    }

    case 'database_insert': {
      const db = await loadDatabase(ctx, String(data.database_id))
      const row = validateRow(db.columns, renderDeep(data.row ?? {}, scope) as Record<string, unknown>)
      const { data: inserted, error } = await ctx.supabase
        .from('agent_database_rows')
        .insert({
          database_id: db.id,
          workspace_id: ctx.workspaceId,
          data: row,
          created_by: ctx.userKey,
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return { id: inserted.id }
    }

    case 'database_update': {
      const db = await loadDatabase(ctx, String(data.database_id))
      const filters = (renderDeep(data.filters ?? [], scope) ?? []) as DbFilter[]
      const set = validateRow(db.columns, renderDeep(data.set ?? {}, scope) as Record<string, unknown>, {
        partial: true,
      })
      const rows = (await queryRows(ctx.supabase, ctx.workspaceId, db.id, filters, 50))
      for (const row of rows) {
        await ctx.supabase
          .from('agent_database_rows')
          .update({ data: { ...row.data, ...set } })
          .eq('id', row.id)
      }
      return { updated: rows.length }
    }

    case 'database_delete': {
      const filters = (renderDeep(data.filters ?? [], scope) ?? []) as DbFilter[]
      const rows = await queryRows(ctx.supabase, ctx.workspaceId, String(data.database_id), filters, 50)
      if (rows.length) {
        await ctx.supabase
          .from('agent_database_rows')
          .delete()
          .in('id', rows.map((r) => r.id))
      }
      return { deleted: rows.length }
    }

    case 'condition':
      return { result: evalCondition(scope, data.left, String(data.op ?? 'eq'), data.right) }

    case 'selector': {
      const branches = (data.branches ?? []) as { label: string; left: unknown; op?: string; right: unknown }[]
      for (const b of branches) {
        if (evalCondition(scope, b.left, String(b.op ?? 'eq'), b.right)) return { branch: b.label }
      }
      return { branch: String(data.default ?? 'default') }
    }

    case 'loop': {
      const items = resolveItems(data.items, scope)
      const outputs: unknown[] = []
      for (let i = 0; i < items.length; i++) {
        const run = await runSubWorkflow(ctx, String(data.workflow_id), { item: items[i], index: i })
        outputs.push(run.output)
      }
      return { results: outputs, count: outputs.length }
    }

    case 'batch': {
      const items = resolveItems(data.items, scope)
      const concurrency = Math.max(1, Math.min(Number(data.concurrency ?? 5), 10))
      const outputs: unknown[] = new Array(items.length)
      for (let i = 0; i < items.length; i += concurrency) {
        const slice = items.slice(i, i + concurrency)
        const settled = await Promise.all(
          slice.map((item, j) =>
            runSubWorkflow(ctx, String(data.workflow_id), { item, index: i + j })
          )
        )
        settled.forEach((run, j) => (outputs[i + j] = run.output))
      }
      return { results: outputs, count: outputs.length }
    }

    case 'sub_workflow': {
      const run = await runSubWorkflow(
        ctx,
        String(data.workflow_id),
        (renderDeep(data.input ?? {}, scope) ?? {}) as Record<string, unknown>
      )
      return { output: run.output }
    }

    case 'text_processor': {
      const op = String(data.operation ?? 'concat')
      const text = renderTemplate(String(data.text ?? ''), scope)
      switch (op) {
        case 'concat':
          return {
            text: ((data.texts ?? []) as unknown[])
              .map((t) => renderTemplate(String(t), scope))
              .join(String(data.separator ?? '')),
          }
        case 'split':
          return { parts: text.split(String(data.separator ?? '\n')) }
        case 'replace':
          return { text: text.replaceAll(String(data.search ?? ''), String(data.replacement ?? '')) }
        case 'substring':
          return { text: text.slice(Number(data.start ?? 0), data.end != null ? Number(data.end) : undefined) }
        case 'lower':
          return { text: text.toLowerCase() }
        case 'upper':
          return { text: text.toUpperCase() }
        case 'trim':
          return { text: text.trim() }
        default:
          throw new Error(`unknown text operation: ${op}`)
      }
    }

    case 'json_parse': {
      const text = renderTemplate(String(data.text ?? ''), scope)
      return { value: JSON.parse(text) }
    }

    case 'json_stringify': {
      const value = data.path ? resolvePath(scope, String(data.path)) : renderDeep(data.value, scope)
      return { text: JSON.stringify(value ?? null) }
    }

    case 'variable_aggregator': {
      const values = (renderDeep(data.values ?? {}, scope) ?? {}) as Record<string, unknown>
      for (const [key, path] of Object.entries((data.paths ?? {}) as Record<string, string>)) {
        values[key] = resolvePath(scope, path)
      }
      return values
    }

    // Safe expression evaluation (Workers forbid eval — AST-interpreted subset).
    // data.args maps variable names to templates/paths; `input` and `nodes`
    // (full scope) are always available.
    case 'code': {
      const vars = {
        ...((renderDeep(data.args ?? {}, scope) ?? {}) as Record<string, unknown>),
        input,
        nodes: scope,
      }
      return { value: evalExpression(String(data.expression ?? ''), vars) }
    }

    case 'conversation_create': {
      const agentId = renderTemplate(String(data.agent_id ?? ''), scope)
      const { data: agent } = await ctx.supabase
        .from('agents')
        .select('id')
        .eq('id', agentId)
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle()
      if (!agent) throw new Error(`agent not found: ${agentId}`)
      const { data: conv, error } = await ctx.supabase
        .from('conversations')
        .insert({
          workspace_id: ctx.workspaceId,
          agent_id: agent.id,
          title: renderTemplate(String(data.title ?? 'workflow'), scope).slice(0, 80),
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return { conversation_id: conv.id }
    }

    case 'message_create': {
      const conversationId = renderTemplate(String(data.conversation_id ?? ''), scope)
      const role = String(data.role ?? 'assistant')
      if (!['system', 'user', 'assistant'].includes(role)) throw new Error(`invalid role: ${role}`)
      const { data: conv } = await ctx.supabase
        .from('conversations')
        .select('id')
        .eq('id', conversationId)
        .eq('workspace_id', ctx.workspaceId)
        .maybeSingle()
      if (!conv) throw new Error(`conversation not found: ${conversationId}`)
      const { data: msg, error } = await ctx.supabase
        .from('messages')
        .insert({
          conversation_id: conv.id,
          workspace_id: ctx.workspaceId,
          role,
          content: renderTemplate(String(data.content ?? ''), scope),
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return { message_id: msg.id }
    }

    case 'message_list': {
      const conversationId = renderTemplate(String(data.conversation_id ?? ''), scope)
      const { data: rows } = await ctx.supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('conversation_id', conversationId)
        .eq('workspace_id', ctx.workspaceId)
        .order('created_at', { ascending: true })
        .limit(Math.min(Number(data.limit ?? 50), 200))
      return { messages: rows ?? [], count: rows?.length ?? 0 }
    }

    default:
      throw new Error(`unknown node type: ${node.type}`)
  }
}

function addUsage(ctx: EngineCtx, usage: Usage | null): void {
  if (!usage) return
  ctx.usage.prompt_tokens += usage.prompt_tokens ?? 0
  ctx.usage.completion_tokens += usage.completion_tokens ?? 0
}

function resolveItems(spec: unknown, scope: Record<string, unknown>): unknown[] {
  let items = renderDeep(spec, scope)
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items)
    } catch {
      throw new Error('loop/batch items did not resolve to an array')
    }
  }
  if (!Array.isArray(items)) throw new Error('loop/batch items did not resolve to an array')
  if (items.length > 100) throw new Error('loop/batch supports at most 100 items')
  return items
}

async function loadDatabase(
  ctx: EngineCtx,
  databaseId: string
): Promise<{ id: string; columns: DbColumn[] }> {
  const { data } = await ctx.supabase
    .from('agent_databases')
    .select('id, columns')
    .eq('id', databaseId)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle()
  if (!data) throw new Error(`database not found: ${databaseId}`)
  return { id: data.id, columns: (data.columns ?? []) as DbColumn[] }
}
