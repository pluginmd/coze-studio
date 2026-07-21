import { parse as parseYaml } from 'yaml'
import type { ToolParameter } from './plugins'

// Plugin import: OpenAPI 3.x, Swagger 2.x, curl commands, and Postman
// collections (JSON or YAML) — mirroring the original convert_to_openapi.

export interface ImportedTool {
  name: string
  description: string
  method: string
  path: string
  parameters: ToolParameter[]
}

export interface ImportResult {
  name: string
  description: string
  base_url: string
  tools: ImportedTool[]
  warnings: string[]
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete']

export function importPluginSpec(raw: string): ImportResult {
  const trimmed = raw.trim()
  if (/^curl\s/i.test(trimmed)) return fromCurl(trimmed)

  let doc: any
  try {
    doc = JSON.parse(trimmed)
  } catch {
    try {
      doc = parseYaml(trimmed)
    } catch {
      throw new Error('input is neither valid JSON, YAML, nor a curl command')
    }
  }
  if (!doc || typeof doc !== 'object') throw new Error('unrecognized spec format')

  if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3')) return fromOpenapi3(doc)
  if (typeof doc.swagger === 'string' && doc.swagger.startsWith('2')) return fromSwagger2(doc)
  if (doc.info?._postman_id || (Array.isArray(doc.item) && doc.info)) return fromPostman(doc)
  throw new Error('unsupported spec: expected OpenAPI 3.x, Swagger 2.x, Postman collection, or curl')
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------
function resolveRef(doc: any, node: any, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 5) return node
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const target = node.$ref
      .slice(2)
      .split('/')
      .reduce((acc: any, key: string) => (acc == null ? undefined : acc[key]), doc)
    return resolveRef(doc, target, depth + 1)
  }
  return node
}

function toolName(op: any, method: string, path: string): string {
  const base = op?.operationId || `${method}_${path.replace(/[{}]/g, '').replace(/[^\w]+/g, '_')}`
  return String(base).replace(/[^\w-]+/g, '_').slice(0, 60)
}

function schemaOf(doc: any, node: any): Record<string, unknown> {
  const resolved = resolveRef(doc, node)
  const type = resolved?.type
  if (typeof type === 'string' && ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type)) {
    return { type: type === 'integer' ? 'number' : type }
  }
  return { type: 'string' }
}

function bodyParams(doc: any, schema: any, warnings: string[]): ToolParameter[] {
  const resolved = resolveRef(doc, schema)
  if (!resolved) return []
  if (resolved.type && resolved.type !== 'object') {
    warnings.push('non-object request body flattened to a single "body" parameter')
    return [{ name: 'body', in: 'body', schema: schemaOf(doc, resolved) }]
  }
  const required: string[] = Array.isArray(resolved.required) ? resolved.required : []
  return Object.entries(resolved.properties ?? {}).map(([name, prop]: [string, any]) => ({
    name,
    in: 'body' as const,
    required: required.includes(name),
    description: resolveRef(doc, prop)?.description,
    schema: schemaOf(doc, prop),
  }))
}

// ---------------------------------------------------------------------------
// OpenAPI 3.x
// ---------------------------------------------------------------------------
function fromOpenapi3(doc: any): ImportResult {
  const warnings: string[] = []
  const baseUrl = String(doc.servers?.[0]?.url ?? '').replace(/\/+$/, '')
  if (!baseUrl) warnings.push('no servers[].url found — set base_url manually')

  const tools: ImportedTool[] = []
  for (const [path, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    const shared = Array.isArray(pathItem?.parameters) ? pathItem.parameters : []
    for (const method of HTTP_METHODS) {
      const op = pathItem?.[method]
      if (!op) continue
      const parameters: ToolParameter[] = []
      for (const p of [...shared, ...(op.parameters ?? [])]) {
        const param = resolveRef(doc, p)
        if (!param?.name || !['query', 'path'].includes(param.in)) continue
        parameters.push({
          name: param.name,
          in: param.in,
          required: !!param.required,
          description: param.description,
          schema: schemaOf(doc, param.schema),
        })
      }
      const jsonBody = resolveRef(doc, op.requestBody)?.content?.['application/json']?.schema
      if (jsonBody) parameters.push(...bodyParams(doc, jsonBody, warnings))
      tools.push({
        name: toolName(op, method, path),
        description: op.summary || op.description || '',
        method: method.toUpperCase(),
        path,
        parameters,
      })
    }
  }
  if (!tools.length) throw new Error('spec contains no operations')
  return {
    name: doc.info?.title ?? 'Imported plugin',
    description: doc.info?.description ?? '',
    base_url: baseUrl,
    tools,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Swagger 2.x
// ---------------------------------------------------------------------------
function fromSwagger2(doc: any): ImportResult {
  const warnings: string[] = []
  const scheme = doc.schemes?.[0] ?? 'https'
  const baseUrl = doc.host
    ? `${scheme}://${doc.host}${(doc.basePath ?? '').replace(/\/+$/, '')}`
    : ''
  if (!baseUrl) warnings.push('no host found — set base_url manually')

  const tools: ImportedTool[] = []
  for (const [path, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    const shared = Array.isArray(pathItem?.parameters) ? pathItem.parameters : []
    for (const method of HTTP_METHODS) {
      const op = pathItem?.[method]
      if (!op) continue
      const parameters: ToolParameter[] = []
      for (const p of [...shared, ...(op.parameters ?? [])]) {
        const param = resolveRef(doc, p)
        if (!param?.name) continue
        if (param.in === 'query' || param.in === 'path') {
          parameters.push({
            name: param.name,
            in: param.in,
            required: !!param.required,
            description: param.description,
            schema: { type: param.type === 'integer' ? 'number' : (param.type ?? 'string') },
          })
        } else if (param.in === 'body' && param.schema) {
          parameters.push(...bodyParams(doc, param.schema, warnings))
        } else if (param.in === 'formData') {
          parameters.push({
            name: param.name,
            in: 'body',
            required: !!param.required,
            description: param.description,
            schema: { type: param.type === 'integer' ? 'number' : (param.type ?? 'string') },
          })
        }
      }
      tools.push({
        name: toolName(op, method, path),
        description: op.summary || op.description || '',
        method: method.toUpperCase(),
        path,
        parameters,
      })
    }
  }
  if (!tools.length) throw new Error('spec contains no operations')
  return {
    name: doc.info?.title ?? 'Imported plugin',
    description: doc.info?.description ?? '',
    base_url: baseUrl,
    tools,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// curl
// ---------------------------------------------------------------------------
function tokenizeCurl(cmd: string): string[] {
  const tokens: string[] = []
  const source = cmd.replace(/\\\s*\n/g, ' ')
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    tokens.push(m[1] ?? (m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3]))
  }
  return tokens
}

function fromCurl(cmd: string): ImportResult {
  const tokens = tokenizeCurl(cmd)
  const warnings: string[] = []
  let method = ''
  let urlStr = ''
  let body = ''
  const headers: Record<string, string> = {}

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-X' || t === '--request') method = tokens[++i] ?? ''
    else if (t === '-H' || t === '--header') {
      const h = tokens[++i] ?? ''
      const idx = h.indexOf(':')
      if (idx > 0) headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim()
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--json'].includes(t)) {
      body = tokens[++i] ?? ''
    } else if (t.startsWith('-')) {
      if (['-u', '--user', '-o', '--output', '-A', '--user-agent', '-b', '--cookie'].includes(t)) i++
    } else if (!urlStr && /^https?:\/\//i.test(t)) {
      urlStr = t
    }
  }
  if (!urlStr) throw new Error('curl command has no URL')
  const url = new URL(urlStr)
  if (!method) method = body ? 'POST' : 'GET'

  const parameters: ToolParameter[] = []
  url.searchParams.forEach((_v, k) => parameters.push({ name: k, in: 'query', schema: { type: 'string' } }))
  if (body) {
    try {
      const parsed = JSON.parse(body)
      for (const [k, v] of Object.entries(parsed)) {
        parameters.push({
          name: k,
          in: 'body',
          schema: { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : Array.isArray(v) ? 'array' : typeof v === 'object' && v ? 'object' : 'string' },
        })
      }
    } catch {
      warnings.push('request body is not JSON — exposed as a single "body" string parameter')
      parameters.push({ name: 'body', in: 'body', schema: { type: 'string' } })
    }
  }
  const auth = headers['authorization']
  if (auth) warnings.push(`curl carried an Authorization header — configure plugin auth (value started with "${auth.slice(0, 12)}...")`)

  return {
    name: `curl ${url.hostname}`,
    description: `Imported from curl (${method} ${url.pathname})`,
    base_url: url.origin,
    tools: [
      {
        name: toolName(null, method.toLowerCase(), url.pathname),
        description: `${method} ${url.pathname}`,
        method: method.toUpperCase(),
        path: url.pathname || '/',
        parameters,
      },
    ],
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Postman collection v2
// ---------------------------------------------------------------------------
function fromPostman(doc: any): ImportResult {
  const warnings: string[] = []
  const tools: ImportedTool[] = []
  let baseUrl = ''

  const walk = (items: any[]) => {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) {
        walk(item.item)
        continue
      }
      const req = item.request
      if (!req) continue
      const rawUrl = typeof req.url === 'string' ? req.url : req.url?.raw
      if (!rawUrl) continue
      let url: URL
      try {
        url = new URL(String(rawUrl).replace(/\{\{[^}]+\}\}/g, 'placeholder'))
      } catch {
        warnings.push(`skipped request with unparseable url: ${String(rawUrl).slice(0, 60)}`)
        continue
      }
      if (!baseUrl) baseUrl = url.origin
      const method = String(req.method ?? 'GET')
      const parameters: ToolParameter[] = []
      url.searchParams.forEach((_v, k) =>
        parameters.push({ name: k, in: 'query', schema: { type: 'string' } })
      )
      const rawBody = req.body?.mode === 'raw' ? req.body.raw : null
      if (rawBody) {
        try {
          for (const [k, v] of Object.entries(JSON.parse(rawBody))) {
            parameters.push({
              name: k,
              in: 'body',
              schema: { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' },
            })
          }
        } catch {
          parameters.push({ name: 'body', in: 'body', schema: { type: 'string' } })
        }
      }
      tools.push({
        name: toolName({ operationId: item.name }, method.toLowerCase(), url.pathname),
        description: item.description ?? `${method} ${url.pathname}`,
        method: method.toUpperCase(),
        path: url.pathname || '/',
        parameters,
      })
    }
  }
  walk(doc.item)
  if (!tools.length) throw new Error('postman collection contains no requests')
  return {
    name: doc.info?.name ?? 'Imported collection',
    description: doc.info?.description ?? '',
    base_url: baseUrl,
    tools,
    warnings,
  }
}
