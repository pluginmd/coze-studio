import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { chatComplete } from '../lib/openai'
import { retrieve } from '../lib/retrieval'
import { invokeTool, type PluginRow, type ToolRow } from '../lib/plugins'

export interface WfNode {
  id: string
  type: 'start' | 'end' | 'llm' | 'knowledge' | 'plugin' | 'condition' | 'template'
  data: Record<string, any>
}

export interface WfEdge {
  source: string
  target: string
  label?: string // condition branches: 'true' | 'false'
}

export interface WfGraph {
  nodes: WfNode[]
  edges: WfEdge[]
}

export interface WfRunResult {
  output: unknown
  nodeResults: Record<string, unknown>
}

// `{{nodeId.field.path}}` template resolution against prior node results.
export function renderTemplate(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, path: string) => {
    const value = path
      .split('.')
      .reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as any)[key]), scope)
    if (value == null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

function renderArgs(args: Record<string, unknown>, scope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = typeof v === 'string' ? renderTemplate(v, scope) : v
  }
  return out
}

// Minimal sequential workflow engine (single active path, condition
// branching). Replaces the Go workflow execution domain for lean deployments.
export async function runWorkflow(
  env: Env,
  supabase: SupabaseClient,
  workspaceId: string,
  graph: WfGraph,
  input: Record<string, unknown>
): Promise<WfRunResult> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
  let current = graph.nodes.find((n) => n.type === 'start')
  if (!current) throw new Error('workflow has no start node')

  const results: Record<string, unknown> = { input }
  let output: unknown = null
  let steps = 0

  while (current) {
    if (++steps > 50) throw new Error('workflow exceeded 50 steps')
    const result = await execNode(env, supabase, workspaceId, current, input, results)
    results[current.id] = result

    if (current.type === 'end') {
      output = result
      break
    }

    let edge: WfEdge | undefined
    if (current.type === 'condition') {
      const branch = String((result as { result: boolean }).result)
      edge = graph.edges.find((e) => e.source === current!.id && (e.label ?? 'true') === branch)
    } else {
      edge = graph.edges.find((e) => e.source === current!.id)
    }
    current = edge ? nodesById.get(edge.target) : undefined
  }

  return { output, nodeResults: results }
}

async function execNode(
  env: Env,
  supabase: SupabaseClient,
  workspaceId: string,
  node: WfNode,
  input: Record<string, unknown>,
  scope: Record<string, unknown>
): Promise<unknown> {
  const data = node.data ?? {}
  switch (node.type) {
    case 'start':
      return input

    case 'template':
      return { text: renderTemplate(String(data.template ?? ''), scope) }

    case 'llm': {
      const messages = [
        ...(data.system ? [{ role: 'system' as const, content: renderTemplate(String(data.system), scope) }] : []),
        { role: 'user' as const, content: renderTemplate(String(data.prompt ?? ''), scope) },
      ]
      const result = await chatComplete(env, {
        model: data.model,
        temperature: data.temperature,
        messages,
      })
      return { text: result.message.content ?? '', usage: result.usage }
    }

    case 'knowledge': {
      const chunks = await retrieve(
        env,
        supabase,
        workspaceId,
        (data.dataset_ids ?? []) as string[],
        renderTemplate(String(data.query ?? ''), scope),
        Number(data.top_k ?? 6)
      )
      return { chunks, text: chunks.map((c) => c.content).join('\n\n') }
    }

    case 'plugin': {
      const { data: tool } = await supabase
        .from('plugin_tools')
        .select('*')
        .eq('id', data.tool_id)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (!tool) throw new Error(`plugin tool not found: ${data.tool_id}`)
      const { data: plugin } = await supabase
        .from('plugins')
        .select('*')
        .eq('id', tool.plugin_id)
        .maybeSingle()
      if (!plugin) throw new Error(`plugin not found for tool: ${data.tool_id}`)
      const result = await invokeTool(
        plugin as PluginRow,
        tool as ToolRow,
        renderArgs(data.args ?? {}, scope)
      )
      let parsed: unknown = result.body
      try {
        parsed = JSON.parse(result.body)
      } catch {
        // keep raw text body
      }
      return { status: result.status, body: parsed }
    }

    case 'condition': {
      const left = renderTemplate(String(data.left ?? ''), scope)
      const right = renderTemplate(String(data.right ?? ''), scope)
      const op = String(data.op ?? 'eq')
      const ln = Number(left)
      const rn = Number(right)
      let result: boolean
      switch (op) {
        case 'neq': result = left !== right; break
        case 'contains': result = left.includes(right); break
        case 'gt': result = !Number.isNaN(ln) && !Number.isNaN(rn) && ln > rn; break
        case 'lt': result = !Number.isNaN(ln) && !Number.isNaN(rn) && ln < rn; break
        case 'empty': result = left.trim() === ''; break
        default: result = left === right
      }
      return { result }
    }

    case 'end':
      return data.template != null
        ? { text: renderTemplate(String(data.template), scope) }
        : { results: scope }

    default:
      throw new Error(`unknown node type: ${(node as WfNode).type}`)
  }
}
