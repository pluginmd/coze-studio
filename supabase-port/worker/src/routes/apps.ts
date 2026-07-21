import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pick } from '../lib/util'

const APP_FIELDS = [
  'name',
  'description',
  'icon_url',
  'agent_ids',
  'workflow_ids',
  'dataset_ids',
  'database_ids',
  'plugin_ids',
]

// App/project domain: bundle agents, workflows, datasets, databases and
// plugins, then publish immutable versioned snapshots (packaging).
export const apps = new Hono<AppEnv>()

apps.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('apps')
    .select('id, name, description, icon_url, created_at, updated_at')
    .eq('workspace_id', c.req.param('wid')!)
    .order('updated_at', { ascending: false })
  return c.json(data ?? [])
})

apps.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (!body.name || typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('apps')
    .insert({
      ...pick(body, APP_FIELDS),
      workspace_id: c.req.param('wid')!,
      created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
    })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

apps.get('/:id', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('apps')
    .select()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'app not found' }, 404)
  return c.json(data)
})

apps.patch('/:id', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, APP_FIELDS)
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('apps')
    .update(updates)
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select()
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'app not found' }, 404)
  return c.json(data)
})

apps.delete('/:id', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('apps')
    .delete()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

// Publish: deep snapshot of every referenced resource at this version.
apps.post('/:id/publish', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: app } = await supabase
    .from('apps')
    .select()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!app) return c.json({ error: 'app not found' }, 404)

  const fetchByIds = async (table: string, ids: string[], columns = '*') => {
    if (!ids?.length) return []
    const { data } = await supabase.from(table).select(columns).in('id', ids).eq('workspace_id', wid)
    return data ?? []
  }

  const [agents, workflows, datasets, databases, plugins] = await Promise.all([
    fetchByIds('agents', app.agent_ids),
    fetchByIds('workflows', app.workflow_ids),
    fetchByIds('datasets', app.dataset_ids),
    fetchByIds('agent_databases', app.database_ids),
    fetchByIds('plugins', app.plugin_ids, 'id, name, description, base_url'), // auth excluded
  ])
  const pluginIds = (plugins as unknown as { id: string }[]).map((p) => p.id)
  let tools: unknown[] = []
  if (pluginIds.length) {
    const { data } = await supabase
      .from('plugin_tools')
      .select()
      .in('plugin_id', pluginIds)
      .eq('workspace_id', wid)
    tools = data ?? []
  }

  const { data: last } = await supabase
    .from('app_releases')
    .select('version')
    .eq('app_id', app.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const version = (last?.version ?? 0) + 1

  const { error } = await supabase.from('app_releases').insert({
    app_id: app.id,
    workspace_id: wid,
    version,
    snapshot: { app, agents, workflows, datasets, databases, plugins, tools },
    created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
  })
  if (error) return c.json({ error: error.message }, 400)
  return c.json({
    ok: true,
    version,
    packed: {
      agents: agents.length,
      workflows: workflows.length,
      datasets: datasets.length,
      databases: databases.length,
      plugins: plugins.length,
    },
  })
})

apps.get('/:id/releases', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('app_releases')
    .select('id, version, created_by, created_at')
    .eq('app_id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .order('version', { ascending: false })
  return c.json(data ?? [])
})

// Restore/instantiate a release: recreates every packaged resource as fresh
// copies (ids remapped, plugin auth reset to none), enabling app-as-template.
apps.post('/:id/releases/:version/restore', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: release } = await supabase
    .from('app_releases')
    .select('snapshot')
    .eq('app_id', c.req.param('id')!)
    .eq('workspace_id', wid)
    .eq('version', Number(c.req.param('version')))
    .maybeSingle()
  if (!release) return c.json({ error: 'release not found' }, 404)

  const snap = release.snapshot as Record<string, any[]>
  const createdBy = c.get('authKind') === 'user' ? c.get('userId') : null
  const strip = (row: Record<string, unknown>) => {
    const copy = { ...row }
    for (const k of ['id', 'workspace_id', 'created_by', 'created_at', 'updated_at', 'share_token', 'published_at', 'status', 'debug_status']) {
      delete copy[k]
    }
    return copy
  }
  const remap = { datasets: new Map<string, string>(), workflows: new Map<string, string>(), databases: new Map<string, string>(), tools: new Map<string, string>(), plugins: new Map<string, string>() }

  const insertOne = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await supabase
      .from(table)
      .insert({ ...row, workspace_id: wid, created_by: createdBy })
      .select('id')
      .single()
    if (error) throw new Error(`${table}: ${error.message}`)
    return data.id as string
  }

  try {
    for (const ds of snap.datasets ?? []) {
      const { created_by: _cb, ...rest } = strip(ds)
      remap.datasets.set(ds.id, await insertOne('datasets', rest))
    }
    for (const db of snap.databases ?? []) {
      remap.databases.set(db.id, await insertOne('agent_databases', strip(db)))
    }
    for (const wf of snap.workflows ?? []) {
      remap.workflows.set(wf.id, await insertOne('workflows', { ...strip(wf), status: 'draft' }))
    }
    for (const p of snap.plugins ?? []) {
      remap.plugins.set(
        p.id,
        await insertOne('plugins', { ...strip(p), auth: { type: 'none' } }) // secrets never in snapshots
      )
    }
    for (const t of snap.tools ?? []) {
      const pluginId = remap.plugins.get(t.plugin_id)
      if (!pluginId) continue
      remap.tools.set(t.id, await insertOne('plugin_tools', { ...strip(t), plugin_id: pluginId }))
    }
    const remapIds = (ids: unknown, map: Map<string, string>) =>
      (Array.isArray(ids) ? ids : []).map((id) => map.get(String(id))).filter(Boolean)
    const agents: string[] = []
    for (const a of snap.agents ?? []) {
      const row = strip(a)
      row.dataset_ids = remapIds(a.dataset_ids, remap.datasets)
      row.workflow_ids = remapIds(a.workflow_ids, remap.workflows)
      row.database_ids = remapIds(a.database_ids, remap.databases)
      row.plugin_tool_ids = remapIds(a.plugin_tool_ids, remap.tools)
      agents.push(await insertOne('agents', row))
    }
    return c.json({
      ok: true,
      created: {
        agents: agents.length,
        workflows: remap.workflows.size,
        datasets: remap.datasets.size,
        databases: remap.databases.size,
        plugins: remap.plugins.size,
        tools: remap.tools.size,
      },
      note: 'plugin auth reset to none (secrets are never snapshotted) — reconfigure and re-vault',
    }, 201)
  } catch (e) {
    return c.json({ error: `restore failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` }, 500)
  }
})

apps.get('/:id/releases/:version', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('app_releases')
    .select()
    .eq('app_id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .eq('version', Number(c.req.param('version')))
    .maybeSingle()
  if (!data) return c.json({ error: 'release not found' }, 404)
  return c.json(data)
})
