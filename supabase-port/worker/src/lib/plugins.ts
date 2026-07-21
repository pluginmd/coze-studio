import type { ToolDef } from './openai'

export interface PluginAuth {
  type: 'none' | 'api_key'
  in?: 'header' | 'query'
  name?: string
  value?: string
}

export interface PluginRow {
  id: string
  name: string
  base_url: string
  auth: PluginAuth | null
}

export interface ToolParameter {
  name: string
  in: 'query' | 'path' | 'body'
  required?: boolean
  description?: string
  schema?: Record<string, unknown>
}

export interface ToolRow {
  id: string
  plugin_id: string
  name: string
  description: string
  method: string
  path: string
  parameters: ToolParameter[] | null
}

export interface ToolBinding {
  def: ToolDef
  plugin: PluginRow
  tool: ToolRow
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
  return cleaned || 'tool'
}

// Builds OpenAI function definitions from stored HTTP tools; names are
// sanitized and de-duplicated so the model can address each one uniquely.
export function buildToolBindings(
  tools: ToolRow[],
  pluginsById: Map<string, PluginRow>
): ToolBinding[] {
  const used = new Set<string>()
  const bindings: ToolBinding[] = []
  for (const tool of tools) {
    const plugin = pluginsById.get(tool.plugin_id)
    if (!plugin) continue
    let name = sanitizeName(tool.name)
    while (used.has(name)) name = `${name.slice(0, 40)}_${tool.id.slice(0, 6)}`
    used.add(name)

    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const p of tool.parameters ?? []) {
      properties[p.name] = {
        ...(p.schema ?? { type: 'string' }),
        ...(p.description ? { description: p.description } : {}),
      }
      if (p.required) required.push(p.name)
    }

    bindings.push({
      plugin,
      tool,
      def: {
        type: 'function',
        function: {
          name,
          description: tool.description || `${tool.method} ${tool.path} on ${plugin.name}`,
          parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
        },
      },
    })
  }
  return bindings
}

export interface ToolInvokeResult {
  status: number
  body: string
}

export async function invokeTool(
  plugin: PluginRow,
  tool: ToolRow,
  args: Record<string, unknown>
): Promise<ToolInvokeResult> {
  let path = tool.path.startsWith('/') ? tool.path : `/${tool.path}`
  const query = new URLSearchParams()
  const body: Record<string, unknown> = {}

  for (const p of tool.parameters ?? []) {
    const value = args[p.name]
    if (value === undefined || value === null) continue
    if (p.in === 'path') {
      path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)))
    } else if (p.in === 'query') {
      query.set(p.name, String(value))
    } else {
      body[p.name] = value
    }
  }

  const url = new URL(plugin.base_url.replace(/\/+$/, '') + path)
  query.forEach((v, k) => url.searchParams.set(k, v))

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = plugin.auth ?? { type: 'none' }
  if (auth.type === 'api_key' && auth.name && auth.value) {
    if (auth.in === 'query') url.searchParams.set(auth.name, auth.value)
    else headers[auth.name] = auth.value
  }

  const method = (tool.method || 'GET').toUpperCase()
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text.slice(0, 20_000) }
}
