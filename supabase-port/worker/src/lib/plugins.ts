export interface PluginAuth {
  type: 'none' | 'api_key' | 'oauth2' | 'vault'
  in?: 'header' | 'query'
  name?: string
  value?: string
  vault_id?: string // type 'vault': real auth JSON encrypted in Supabase Vault
  [key: string]: unknown
}

export interface PluginRow {
  id: string
  name: string
  base_url: string
  auth: PluginAuth | null
  kind?: 'http' | 'mcp'
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

export interface ToolInvokeResult {
  status: number
  body: string
}

export async function invokeTool(
  plugin: PluginRow,
  tool: ToolRow,
  args: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<ToolInvokeResult> {
  // MCP plugins: tool.path holds the MCP tool name; auth carries headers.
  if (plugin.kind === 'mcp') {
    const { McpClient } = await import('./mcp')
    const headers = ((plugin.auth as { headers?: Record<string, string> } | null)?.headers ?? {}) as Record<string, string>
    const client = new McpClient(plugin.base_url, { ...headers, ...extraHeaders })
    await client.initialize()
    const body = await client.callTool(tool.path, args)
    return { status: 200, body: body.slice(0, 20_000) }
  }

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

  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders }
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
