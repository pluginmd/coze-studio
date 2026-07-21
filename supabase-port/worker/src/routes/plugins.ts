import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pick } from '../lib/util'
import { invokeTool, type PluginRow, type ToolRow } from '../lib/plugins'
import { isOAuthConfig, getAccessToken } from '../lib/oauth'

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
    return c.json(result)
  } catch (e) {
    return c.json({ error: String(e).slice(0, 500) }, 502)
  }
})
