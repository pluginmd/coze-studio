import type { SupabaseClient } from '@supabase/supabase-js'

// Memory domain: agent databases — declared columns, JSONB rows. Filtering is
// evaluated in the Worker on a bounded fetch, which keeps types correct
// (numeric gt/lt etc.) without generating SQL from model output.

export interface DbColumn {
  name: string
  type: 'text' | 'number' | 'boolean' | 'date'
  required?: boolean
  description?: string
}

export interface DbFilter {
  column: string
  op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt'
  value: unknown
}

export interface DbRow {
  id: string
  data: Record<string, unknown>
  created_by: string
  created_at: string
  updated_at: string
}

const FETCH_CAP = 500

export function validateRow(
  columns: DbColumn[],
  data: Record<string, unknown>,
  { partial = false } = {}
): Record<string, unknown> {
  const known = new Map(columns.map((c) => [c.name, c]))
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(data ?? {})) {
    const col = known.get(key)
    if (!col) throw new Error(`unknown column: ${key}`)
    if (raw === null || raw === undefined) {
      out[key] = null
      continue
    }
    switch (col.type) {
      case 'number': {
        const n = Number(raw)
        if (Number.isNaN(n)) throw new Error(`column ${key} expects a number`)
        out[key] = n
        break
      }
      case 'boolean':
        out[key] = raw === true || raw === 'true' || raw === 1
        break
      case 'date': {
        const d = new Date(String(raw))
        if (Number.isNaN(d.getTime())) throw new Error(`column ${key} expects a date`)
        out[key] = d.toISOString()
        break
      }
      default:
        out[key] = String(raw)
    }
  }
  if (!partial) {
    for (const col of columns) {
      if (col.required && (out[col.name] === undefined || out[col.name] === null)) {
        throw new Error(`column ${col.name} is required`)
      }
    }
  }
  return out
}

export function applyFilters(rows: DbRow[], filters: DbFilter[]): DbRow[] {
  if (!filters?.length) return rows
  return rows.filter((row) =>
    filters.every((f) => {
      const value = row.data[f.column]
      switch (f.op) {
        case 'neq':
          return String(value ?? '') !== String(f.value ?? '')
        case 'contains':
          return String(value ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase())
        case 'gt':
          return Number(value) > Number(f.value)
        case 'lt':
          return Number(value) < Number(f.value)
        default:
          return String(value ?? '') === String(f.value ?? '')
      }
    })
  )
}

export async function queryRows(
  supabase: SupabaseClient,
  workspaceId: string,
  databaseId: string,
  filters: DbFilter[] = [],
  limit = 100
): Promise<DbRow[]> {
  const { data, error } = await supabase
    .from('agent_database_rows')
    .select('id, data, created_by, created_at, updated_at')
    .eq('database_id', databaseId)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(FETCH_CAP)
  if (error) throw new Error(`database query failed: ${error.message}`)
  return applyFilters((data ?? []) as DbRow[], filters).slice(0, Math.min(limit, FETCH_CAP))
}
