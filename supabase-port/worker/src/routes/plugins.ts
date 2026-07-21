import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pick } from '../lib/util'
import { invokeTool, type PluginRow, type ToolRow } from '../lib/plugins'
import { isOAuthConfig, getAccessToken } from '../lib/oauth'
import { importPluginSpec } from '../lib/pluginimport'

const PLUGIN_FIELDS = ['name', 'description', 'base_url', 'auth']
const TOOL_FIELDS = ['name', 'description', 'method', 'path', 'parameters']

export const plugins = new Hono<AppEnv>()

plugins.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('plugins')
    .select('id, name, description, base_url, created_at, updated_at')
    .eq('workspace_id', c.req.param('wid')!)
    .order('updated_at', { ascending: false })
  return c.json(data ?? [])
})

plugins.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (!body.name || !body.base_url) return c.json({ error: 'name and base_url are required' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('plugins')
    .insert({ ...pick(body, PLUGIN_FIELDS), workspace_id: c.req.param('wid')! })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

// Import a plugin from an OpenAPI 3.x / Swagger 2.x spec (JSON or YAML),
// a curl command, or a Postman collection.
plugins.post('/import', async (c) => {
  const wid = c.req.param('wid')!
  const body = await c.req
    .json<{ data?: string; name?: string; base_url?: string }>()
    .catch(() => ({}) as any)
  if (!body.data?.trim()) return c.json({ error: 'data (spec/curl/collection) is required' }, 400)

  let imported
  try {
    imported = importPluginSpec(body.data)
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400)
  }
  const baseUrl = body.base_url?.trim() || imported.base_url
  if (!baseUrl) {
    return c.json({ error: 'spec has no server URL — pass base_url', warnings: imported.warnings }, 400)
  }

  const supabase = c.get('supabase')
  const { data: plugin, error } = await supabase
    .from('plugins')
    .insert({
      workspace_id: wid,
      name: (body.name?.trim() || imported.name).slice(0, 120),
      description: imported.description.slice(0, 2000),
      base_url: baseUrl,
    })
    .select('id')
    .single()
  if (error) return c.json({ error: error.message }, 400)

  const rows = imported.tools.slice(0, 100).map((t) => ({
    plugin_id: plugin.id,
    workspace_id: wid,
    name: t.name,
    description: t.description.slice(0, 2000),
    method: t.method,
    path: t.path,
    parameters: t.parameters,
  }))
  const { error: toolsError } = await supabase.from('plugin_tools').insert(rows)
  if (toolsError) return c.json({ error: toolsError.message, plugin_id: plugin.id }, 500)
  if (imported.tools.length > 100) imported.warnings.push('spec had >100 operations; first 100 imported')

  return c.json(
    { plugin_id: plugin.id, tools_imported: rows.length, warnings: imported.warnings },
    201
  )
})

// Connect an MCP server: initialize, list its tools, create the plugin.
plugins.post('/mcp', async (c) => {
  const wid = c.req.param('wid')!
  const body = await c.req
    .json<{ name?: string; base_url?: string; headers?: Record<string, string> }>()
    .catch(() => ({}) as any)
  if (!body.base_url?.trim()) return c.json({ error: 'base_url (MCP server URL) is required' }, 400)

  const { McpClient, mapMcpTools } = await import('../lib/mcp')
  const client = new McpClient(body.base_url, body.headers ?? {})
  let mcpTools
  try {
    await client.initialize()
    mcpTools = await client.listTools()
  } catch (e) {
    return c.json({ error: `mcp connection failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` }, 502)
  }
  if (!mcpTools.length) return c.json({ error: 'mcp server exposes no tools' }, 400)

  const supabase = c.get('supabase')
  const { data: plugin, error } = await supabase
    .from('plugins')
    .insert({
      workspace_id: wid,
      name: (body.name?.trim() || `MCP: ${new URL(body.base_url).hostname}`).slice(0, 120),
      description: `MCP server at ${body.base_url}`,
      base_url: body.base_url,
      kind: 'mcp',
      auth: { type: 'none', headers: body.headers ?? {} },
    })
    .select('id')
    .single()
  if (error) return c.json({ error: error.message }, 400)

  const rows = mapMcpTools(mcpTools).map((t) => ({ ...t, plugin_id: plugin.id, workspace_id: wid }))
  const { error: toolsError } = await supabase.from('plugin_tools').insert(rows)
  if (toolsError) return c.json({ error: toolsError.message, plugin_id: plugin.id }, 500)
  return c.json({ plugin_id: plugin.id, tools_imported: rows.length }, 201)
})

// Re-sync tools from the MCP server (add new, update changed, drop removed).
plugins.post('/:pid/mcp/sync', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: plugin } = await supabase
    .from('plugins')
    .select()
    .eq('id', c.req.param('pid')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!plugin) return c.json({ error: 'plugin not found' }, 404)
  if (plugin.kind !== 'mcp') return c.json({ error: 'not an mcp plugin' }, 400)

  const { McpClient, mapMcpTools } = await import('../lib/mcp')
  const client = new McpClient(plugin.base_url, (plugin.auth?.headers ?? {}) as Record<string, string>)
  let mapped
  try {
    await client.initialize()
    mapped = mapMcpTools(await client.listTools())
  } catch (e) {
    return c.json({ error: `mcp sync failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` }, 502)
  }

  const { data: existing } = await supabase
    .from('plugin_tools')
    .select('id, path')
    .eq('plugin_id', plugin.id)
  const byPath = new Map((existing ?? []).map((t) => [t.path, t.id]))
  let added = 0
  let updated = 0
  for (const t of mapped) {
    const id = byPath.get(t.path)
    if (id) {
      await supabase
        .from('plugin_tools')
        .update({ name: t.name, description: t.description, parameters: t.parameters })
        .eq('id', id)
      byPath.delete(t.path)
      updated++
    } else {
      await supabase.from('plugin_tools').insert({ ...t, plugin_id: plugin.id, workspace_id: wid })
      added++
    }
  }
  const stale = [...byPath.values()]
  if (stale.length) await supabase.from('plugin_tools').delete().in('id', stale)
  return c.json({ ok: true, added, updated, removed: stale.length })
})

// Publish: snapshot plugin + tools as a version. All active tools must have
// passed a debug invocation unless force=true (original publish gate).
plugins.post('/:pid/publish', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: plugin } = await supabase
    .from('plugins')
    .select()
    .eq('id', c.req.param('pid')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!plugin) return c.json({ error: 'plugin not found' }, 404)
  const { data: tools } = await supabase
    .from('plugin_tools')
    .select()
    .eq('plugin_id', plugin.id)
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({}) as any)
  const undebugged = (tools ?? []).filter((t) => t.debug_status !== 'passed')
  if (undebugged.length && !body.force) {
    return c.json(
      {
        error: 'all tools must pass a debug invocation before publish (or pass force: true)',
        undebugged: undebugged.map((t) => t.name),
      },
      400
    )
  }
  const { data: last } = await supabase
    .from('plugin_releases')
    .select('version')
    .eq('plugin_id', plugin.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const version = (last?.version ?? 0) + 1
  const { auth: _auth, ...pluginSnapshot } = plugin as Record<string, unknown>
  const { error } = await supabase.from('plugin_releases').insert({
    plugin_id: plugin.id,
    workspace_id: wid,
    version,
    snapshot: { plugin: pluginSnapshot, tools }, // auth secrets excluded
    created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
  })
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true, version })
})

plugins.get('/:pid/releases', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('plugin_releases')
    .select('id, version, created_by, created_at')
    .eq('plugin_id', c.req.param('pid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .order('version', { ascending: false })
  return c.json(data ?? [])
})

plugins.get('/:pid', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('plugins')
    .select()
    .eq('id', c.req.param('pid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'plugin not found' }, 404)
  return c.json(data)
})

plugins.patch('/:pid', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, PLUGIN_FIELDS)
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('plugins')
    .update(updates)
    .eq('id', c.req.param('pid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select()
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'plugin not found' }, 404)
  return c.json(data)
})

plugins.delete('/:pid', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('plugins')
    .delete()
    .eq('id', c.req.param('pid')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

plugins.get('/:pid/tools', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('plugin_tools')
    .select()
    .eq('plugin_id', c.req.param('pid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .order('created_at', { ascending: true })
  return c.json(data ?? [])
})

plugins.post('/:pid/tools', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: plugin } = await supabase
    .from('plugins')
    .select('id')
    .eq('id', c.req.param('pid')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!plugin) return c.json({ error: 'plugin not found' }, 404)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (!body.name || !body.path) return c.json({ error: 'name and path are required' }, 400)
  const { data, error } = await supabase
    .from('plugin_tools')
    .insert({ ...pick(body, TOOL_FIELDS), plugin_id: plugin.id, workspace_id: wid })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

plugins.patch('/:pid/tools/:tid', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, TOOL_FIELDS)
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  // schema changes invalidate the previous debug pass
  if (updates.method !== undefined || updates.path !== undefined || updates.parameters !== undefined) {
    updates.debug_status = 'waiting'
  }
  const { data, error } = await c
    .get('supabase')
    .from('plugin_tools')
    .update(updates)
    .eq('id', c.req.param('tid')!)
    .eq('plugin_id', c.req.param('pid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select()
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'tool not found' }, 404)
  return c.json(data)
})

plugins.delete('/:pid/tools/:tid', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('plugin_tools')
    .delete()
    .eq('id', c.req.param('tid')!)
    .eq('plugin_id', c.req.param('pid')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

// Manual test invocation of one tool.
plugins.post('/:pid/tools/:tid/invoke', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: tool } = await supabase
    .from('plugin_tools')
    .select()
    .eq('id', c.req.param('tid')!)
    .eq('plugin_id', c.req.param('pid')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!tool) return c.json({ error: 'tool not found' }, 404)
  const { data: plugin } = await supabase
    .from('plugins')
    .select()
    .eq('id', tool.plugin_id)
    .maybeSingle()
  if (!plugin) return c.json({ error: 'plugin not found' }, 404)
  const body = await c.req
    .json<{ args?: Record<string, unknown>; user_key?: string }>()
    .catch(() => ({}) as any)
  let extraHeaders: Record<string, string> | undefined
  if (isOAuthConfig(plugin.auth)) {
    const userKey =
      c.get('authKind') === 'user' ? c.get('userId') : (body.user_key ?? 'api')
    const token = await getAccessToken(supabase, plugin.id, wid, userKey, plugin.auth)
    if (!token) {
      return c.json(
        {
          error: 'oauth connection required for this user',
          connect_url: `/v1/workspaces/${wid}/plugins/${plugin.id}/oauth/url`,
        },
        400
      )
    }
    extraHeaders = { authorization: `Bearer ${token}` }
  }
  try {
    const result = await invokeTool(plugin as PluginRow, tool as ToolRow, body.args ?? {}, extraHeaders)
    if (result.status < 500 && tool.debug_status !== 'passed') {
      await supabase.from('plugin_tools').update({ debug_status: 'passed' }).eq('id', tool.id)
    }
    return c.json({ ...result, debug_status: result.status < 500 ? 'passed' : tool.debug_status })
  } catch (e) {
    return c.json({ error: String(e).slice(0, 500) }, 502)
  }
})
