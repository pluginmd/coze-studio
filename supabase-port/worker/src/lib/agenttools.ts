import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import type { AgentTool } from './agentloop'
import { invokeTool, type PluginRow, type ToolRow } from './plugins'
import { isOAuthConfig, getAccessToken } from './oauth'
import { queryRows, validateRow, type DbColumn, type DbFilter } from './database'
import { runWorkflow, type WfGraph } from '../engine/workflow'

interface AgentRow {
  plugin_tool_ids?: string[] | null
  database_ids?: string[] | null
  workflow_ids?: string[] | null
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'tool'
}

const JSON_TYPES: Record<string, string> = {
  text: 'string',
  number: 'number',
  boolean: 'boolean',
  date: 'string',
}

// Builds the full callable tool set for one agent: HTTP plugin tools
// (api_key or per-user OAuth2), attached databases (query/insert), and
// attached workflows exposed as functions.
export async function buildAgentTools(
  env: Env,
  supabase: SupabaseClient,
  workspaceId: string,
  userKey: string,
  agent: AgentRow
): Promise<AgentTool[]> {
  const tools: AgentTool[] = []
  const used = new Set<string>()
  const claim = (base: string, id: string) => {
    let name = sanitizeName(base)
    while (used.has(name)) name = `${name.slice(0, 40)}_${id.slice(0, 6)}`
    used.add(name)
    return name
  }

  // --- plugin tools -------------------------------------------------------
  const toolIds = agent.plugin_tool_ids ?? []
  if (toolIds.length) {
    const { data: toolRows } = await supabase
      .from('plugin_tools')
      .select()
      .in('id', toolIds)
      .eq('workspace_id', workspaceId)
    const pluginIds = [...new Set((toolRows ?? []).map((t: any) => t.plugin_id as string))]
    const pluginsById = new Map<string, PluginRow>()
    if (pluginIds.length) {
      const { data: pluginRows } = await supabase
        .from('plugins')
        .select()
        .in('id', pluginIds)
        .eq('workspace_id', workspaceId)
      for (const p of (pluginRows ?? []) as PluginRow[]) pluginsById.set(p.id, p)
    }
    for (const tool of (toolRows ?? []) as ToolRow[]) {
      const plugin = pluginsById.get(tool.plugin_id)
      if (!plugin) continue
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const p of tool.parameters ?? []) {
        properties[p.name] = {
          ...(p.schema ?? { type: 'string' }),
          ...(p.description ? { description: p.description } : {}),
        }
        if (p.required) required.push(p.name)
      }
      tools.push({
        def: {
          type: 'function',
          function: {
            name: claim(tool.name, tool.id),
            description: tool.description || `${tool.method} ${tool.path} on ${plugin.name}`,
            parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
          },
        },
        execute: async (args) => {
          let extraHeaders: Record<string, string> | undefined
          if (isOAuthConfig(plugin.auth)) {
            const token = await getAccessToken(supabase, plugin.id, workspaceId, userKey, plugin.auth)
            if (!token) {
              return JSON.stringify({
                error: 'user has not connected this plugin — OAuth authorization required',
                connect_url: `/v1/workspaces/${workspaceId}/plugins/${plugin.id}/oauth/url`,
              })
            }
            extraHeaders = { authorization: `Bearer ${token}` }
          }
          return JSON.stringify(await invokeTool(plugin, tool, args, extraHeaders))
        },
      })
    }
  }

  // --- agent databases (memory domain) ------------------------------------
  const databaseIds = agent.database_ids ?? []
  if (databaseIds.length) {
    const { data: dbs } = await supabase
      .from('agent_databases')
      .select('id, name, description, columns')
      .in('id', databaseIds)
      .eq('workspace_id', workspaceId)
    for (const db of dbs ?? []) {
      const columns = (db.columns ?? []) as DbColumn[]
      const columnList = columns
        .map((c) => `${c.name} (${c.type}${c.description ? `: ${c.description}` : ''})`)
        .join(', ')

      tools.push({
        def: {
          type: 'function',
          function: {
            name: claim(`query_${db.name}`, db.id),
            description: `Query rows from the "${db.name}" table. ${db.description ?? ''} Columns: ${columnList}`,
            parameters: {
              type: 'object',
              properties: {
                filters: {
                  type: 'array',
                  description: 'Conditions combined with AND. Empty for all rows.',
                  items: {
                    type: 'object',
                    properties: {
                      column: { type: 'string', enum: columns.map((c) => c.name) },
                      op: { type: 'string', enum: ['eq', 'neq', 'contains', 'gt', 'lt'] },
                      value: { type: 'string' },
                    },
                    required: ['column', 'op', 'value'],
                  },
                },
                limit: { type: 'integer', description: 'Max rows to return (default 20)' },
              },
            },
          },
        },
        execute: async (args) => {
          const rows = await queryRows(
            supabase,
            workspaceId,
            db.id,
            (args.filters ?? []) as DbFilter[],
            Number(args.limit ?? 20)
          )
          return JSON.stringify({ count: rows.length, rows: rows.map((r) => ({ id: r.id, ...r.data })) })
        },
      })

      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const col of columns) {
        properties[col.name] = {
          type: JSON_TYPES[col.type] ?? 'string',
          ...(col.description ? { description: col.description } : {}),
        }
        if (col.required) required.push(col.name)
      }
      tools.push({
        def: {
          type: 'function',
          function: {
            name: claim(`insert_${db.name}`, db.id),
            description: `Insert one row into the "${db.name}" table. ${db.description ?? ''}`,
            parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
          },
        },
        execute: async (args) => {
          const row = validateRow(columns, args)
          const { data: inserted, error } = await supabase
            .from('agent_database_rows')
            .insert({ database_id: db.id, workspace_id: workspaceId, data: row, created_by: userKey })
            .select('id')
            .single()
          if (error) return JSON.stringify({ error: error.message })
          return JSON.stringify({ ok: true, id: inserted.id })
        },
      })
    }
  }

  // --- workflows as tools --------------------------------------------------
  const workflowIds = agent.workflow_ids ?? []
  if (workflowIds.length) {
    const { data: wfs } = await supabase
      .from('workflows')
      .select('id, name, description, graph')
      .in('id', workflowIds)
      .eq('workspace_id', workspaceId)
    for (const wf of wfs ?? []) {
      const graph = wf.graph as WfGraph
      const start = (graph?.nodes ?? []).find((n) => n.type === 'start' || n.type === 'entry')
      const inputs = ((start?.data?.inputs ?? []) as {
        name: string
        type?: string
        description?: string
        required?: boolean
      }[])
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const inp of inputs) {
        properties[inp.name] = {
          type: inp.type && ['string', 'number', 'boolean', 'array', 'object'].includes(inp.type)
            ? inp.type
            : 'string',
          ...(inp.description ? { description: inp.description } : {}),
        }
        if (inp.required) required.push(inp.name)
      }
      tools.push({
        def: {
          type: 'function',
          function: {
            name: claim(`wf_${wf.name}`, wf.id),
            description: wf.description || `Run the "${wf.name}" workflow`,
            parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
          },
        },
        execute: async (args) => {
          const run = await runWorkflow(env, supabase, workspaceId, graph, args, { userKey })
          if (run.usage.prompt_tokens || run.usage.completion_tokens) {
            await supabase.from('usage_events').insert({
              workspace_id: workspaceId,
              kind: 'workflow',
              model: env.CHAT_MODEL ?? 'gpt-4o-mini',
              prompt_tokens: run.usage.prompt_tokens,
              completion_tokens: run.usage.completion_tokens,
              meta: { workflow_id: wf.id, via: 'agent_tool' },
            })
          }
          return JSON.stringify({ output: run.output })
        },
      })
    }
  }

  return tools
}
