import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pick } from '../lib/util'
import { queryRows, validateRow, type DbColumn, type DbFilter } from '../lib/database'
import { parseTable } from '../lib/docparse'

const DATABASE_FIELDS = ['name', 'description', 'columns']

export const databases = new Hono<AppEnv>()

databases.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('agent_databases')
    .select()
    .eq('workspace_id', c.req.param('wid')!)
    .order('updated_at', { ascending: false })
  return c.json(data ?? [])
})

databases.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (!body.name || typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('agent_databases')
    .insert({ ...pick(body, DATABASE_FIELDS), workspace_id: c.req.param('wid')! })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

// Table-mode import (xlsx/csv/tsv): header row becomes columns, remaining
// rows become data. Creates a new database, with types inferred per column.
databases.post('/import', async (c) => {
  const wid = c.req.param('wid')!
  const body = await c.req
    .json<{ name?: string; filename?: string; content?: string; content_base64?: string }>()
    .catch(() => ({}) as any)
  if (!body.name || !body.filename || (!body.content && !body.content_base64)) {
    return c.json({ error: 'name, filename and content (or content_base64) are required' }, 400)
  }

  const bytes = body.content_base64
    ? Uint8Array.from(atob(body.content_base64), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode(body.content)
  let rows: string[][]
  try {
    rows = parseTable(bytes, body.filename)
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400)
  }
  if (rows.length < 2) return c.json({ error: 'file needs a header row and at least one data row' }, 400)
  if (rows.length > 5001) return c.json({ error: 'import supports at most 5000 data rows' }, 400)

  const header = rows[0].map((h, i) => (h.trim() || `col_${i + 1}`).replace(/[^\w]+/g, '_').slice(0, 40))
  const dataRows = rows.slice(1)
  const columns: DbColumn[] = header.map((name, i) => {
    const values = dataRows.map((r) => r[i]).filter((v) => v != null && v.trim() !== '')
    const numeric = values.length > 0 && values.every((v) => !Number.isNaN(Number(v)))
    return { name, type: numeric ? 'number' : 'text' }
  })

  const supabase = c.get('supabase')
  const { data: db, error } = await supabase
    .from('agent_databases')
    .insert({ workspace_id: wid, name: body.name, description: `Imported from ${body.filename}`, columns })
    .select('id')
    .single()
  if (error) return c.json({ error: error.message }, 400)

  const createdBy = c.get('authKind') === 'user' ? c.get('userId') : 'api'
  let inserted = 0
  let skipped = 0
  for (let i = 0; i < dataRows.length; i += 500) {
    const batch = dataRows.slice(i, i + 500).flatMap((r) => {
      try {
        const data: Record<string, unknown> = {}
        header.forEach((name, j) => (data[name] = r[j] ?? null))
        return [{ database_id: db.id, workspace_id: wid, data: validateRow(columns, data), created_by: createdBy }]
      } catch {
        skipped++
        return []
      }
    })
    if (batch.length) {
      const { error: insErr } = await supabase.from('agent_database_rows').insert(batch)
      if (insErr) return c.json({ error: insErr.message, database_id: db.id, inserted }, 500)
      inserted += batch.length
    }
  }
  return c.json({ database_id: db.id, columns, inserted, skipped }, 201)
})

databases.get('/:dbid', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('agent_databases')
    .select()
    .eq('id', c.req.param('dbid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'database not found' }, 404)
  return c.json(data)
})

databases.patch('/:dbid', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, DATABASE_FIELDS)
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('agent_databases')
    .update(updates)
    .eq('id', c.req.param('dbid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select()
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'database not found' }, 404)
  return c.json(data)
})

databases.delete('/:dbid', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('agent_databases')
    .delete()
    .eq('id', c.req.param('dbid')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

async function loadColumns(c: any, dbid: string): Promise<DbColumn[] | null> {
  const { data } = await c
    .get('supabase')
    .from('agent_databases')
    .select('columns')
    .eq('id', dbid)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  return data ? ((data.columns ?? []) as DbColumn[]) : null
}

databases.post('/:dbid/rows/query', async (c) => {
  const dbid = c.req.param('dbid')!
  const columns = await loadColumns(c, dbid)
  if (!columns) return c.json({ error: 'database not found' }, 404)
  const body = await c.req
    .json<{ filters?: DbFilter[]; limit?: number }>()
    .catch(() => ({}) as any)
  const rows = await queryRows(
    c.get('supabase'),
    c.req.param('wid')!,
    dbid,
    body.filters ?? [],
    body.limit ?? 100
  )
  return c.json({ count: rows.length, rows })
})

databases.post('/:dbid/rows', async (c) => {
  const dbid = c.req.param('dbid')!
  const columns = await loadColumns(c, dbid)
  if (!columns) return c.json({ error: 'database not found' }, 404)
  const body = await c.req
    .json<{ data?: Record<string, unknown> }>()
    .catch(() => ({}) as any)
  let row: Record<string, unknown>
  try {
    row = validateRow(columns, body.data ?? {})
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400)
  }
  const { data, error } = await c
    .get('supabase')
    .from('agent_database_rows')
    .insert({
      database_id: dbid,
      workspace_id: c.req.param('wid')!,
      data: row,
      created_by: c.get('authKind') === 'user' ? c.get('userId') : 'api',
    })
    .select('id, data, created_at')
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

databases.patch('/:dbid/rows/:rowid', async (c) => {
  const dbid = c.req.param('dbid')!
  const columns = await loadColumns(c, dbid)
  if (!columns) return c.json({ error: 'database not found' }, 404)
  const body = await c.req
    .json<{ data?: Record<string, unknown> }>()
    .catch(() => ({}) as any)
  const supabase = c.get('supabase')
  const { data: existing } = await supabase
    .from('agent_database_rows')
    .select('id, data')
    .eq('id', c.req.param('rowid')!)
    .eq('database_id', dbid)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!existing) return c.json({ error: 'row not found' }, 404)
  let patch: Record<string, unknown>
  try {
    patch = validateRow(columns, body.data ?? {}, { partial: true })
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400)
  }
  const { data, error } = await supabase
    .from('agent_database_rows')
    .update({ data: { ...existing.data, ...patch } })
    .eq('id', existing.id)
    .select('id, data, updated_at')
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data)
})

databases.delete('/:dbid/rows/:rowid', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('agent_database_rows')
    .delete()
    .eq('id', c.req.param('rowid')!)
    .eq('database_id', c.req.param('dbid')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})
