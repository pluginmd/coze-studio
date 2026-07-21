// MCP (Model Context Protocol) client — Streamable HTTP transport.
// The original Coze Studio declares an MCP plugin type but its runtime is a
// stub; this is a working implementation: initialize -> tools/list ->
// tools/call, with session-id handling and SSE-or-JSON responses.

export interface McpTool {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, { type?: string; description?: string }>
    required?: string[]
  }
}

interface RpcResponse {
  result?: any
  error?: { code: number; message: string }
}

export class McpClient {
  private sessionId: string | null = null
  private nextId = 1

  constructor(
    private baseUrl: string,
    private headers: Record<string, string> = {}
  ) {}

  private async post(body: unknown): Promise<Response> {
    return fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    const res = await this.post({ jsonrpc: '2.0', id, method, params })
    if (!res.ok) {
      throw new Error(`mcp ${method} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
    const session = res.headers.get('mcp-session-id')
    if (session) this.sessionId = session

    const contentType = res.headers.get('content-type') ?? ''
    let payload: RpcResponse | null = null
    if (contentType.includes('text/event-stream')) {
      const text = await res.text()
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const parsed = JSON.parse(line.slice(5).trim())
          if (parsed.id === id) {
            payload = parsed
            break
          }
        } catch {
          // skip non-JSON SSE lines
        }
      }
    } else {
      payload = (await res.json()) as RpcResponse
    }
    if (!payload) throw new Error(`mcp ${method}: no response for request id ${id}`)
    if (payload.error) throw new Error(`mcp ${method}: ${payload.error.message}`)
    return payload.result
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'coze-supabase-port', version: '0.1.0' },
    })
    // best-effort initialized notification (no id, no response expected)
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined)
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc('tools/list', {})
    return (result?.tools ?? []) as McpTool[]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.rpc('tools/call', { name, arguments: args })
    const parts = Array.isArray(result?.content) ? result.content : []
    const text = parts
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p.text ?? ''))
      .join('\n')
    const body = text || JSON.stringify(result ?? null)
    return result?.isError ? `[tool error] ${body}` : body
  }
}

// Maps MCP tool definitions onto plugin_tools rows: the MCP tool name lives
// in `path` (tool `name` may be sanitized for display/LLM use).
export function mapMcpTools(tools: McpTool[]): {
  name: string
  description: string
  method: string
  path: string
  parameters: { name: string; in: 'body'; required?: boolean; description?: string; schema?: Record<string, unknown> }[]
}[] {
  return tools.map((t) => {
    const props = t.inputSchema?.properties ?? {}
    const required = t.inputSchema?.required ?? []
    return {
      name: t.name.replace(/[^\w-]+/g, '_').slice(0, 60) || 'tool',
      description: (t.description ?? '').slice(0, 2000),
      method: 'POST',
      path: t.name,
      parameters: Object.entries(props).map(([name, prop]) => ({
        name,
        in: 'body' as const,
        required: required.includes(name),
        description: prop.description,
        schema: { type: prop.type ?? 'string' },
      })),
    }
  })
}
