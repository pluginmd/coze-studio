import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { pick } from '../lib/util'
import { runWorkflow, type WfGraph } from '../engine/workflow'

const WORKFLOW_FIELDS = ['name', 'description', 'graph', 'status']

export const workflows = new Hono<AppEnv>()

workflows.get('/', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('workflows')
    .select('id, name, description, status, created_at, updated_at')
    .eq('workspace_id', c.req.param('wid')!)
    .order('updated_at', { ascending: false })
  return c.json(data ?? [])
})

workflows.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (!body.name || typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('workflows')
    .insert({
      ...pick(body, WORKFLOW_FIELDS),
      workspace_id: c.req.param('wid')!,
      created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
    })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

workflows.get('/:id', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('workflows')
    .select()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'workflow not found' }, 404)
  return c.json(data)
})

workflows.patch('/:id', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const updates = pick(body, WORKFLOW_FIELDS)
  if (!Object.keys(updates).length) return c.json({ error: 'nothing to update' }, 400)
  const { data, error } = await c
    .get('supabase')
    .from('workflows')
    .update(updates)
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .select()
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'workflow not found' }, 404)
  return c.json(data)
})

workflows.delete('/:id', async (c) => {
  const { error } = await c
    .get('supabase')
    .from('workflows')
    .delete()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

// Synchronous execution; every run is recorded in workflow_runs.
workflows.post('/:id/run', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: wf } = await supabase
    .from('workflows')
    .select()
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!wf) return c.json({ error: 'workflow not found' }, 404)

  const body = await c.req.json<{ input?: Record<string, unknown> }>().catch(() => ({}) as any)
  const input = body.input ?? {}

  const { data: run, error: runError } = await supabase
    .from('workflow_runs')
    .insert({ workflow_id: wf.id, workspace_id: wid, input })
    .select('id')
    .single()
  if (runError) return c.json({ error: runError.message }, 500)

  const userKey = c.get('authKind') === 'user' ? c.get('userId') : 'api'
  try {
    const result = await runWorkflow(c.env, supabase, wid, wf.graph as WfGraph, input, { userKey })
    await supabase
      .from('workflow_runs')
      .update({
        status: 'succeeded',
        output: result.output,
        node_results: result.nodeResults,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id)
    if (result.usage.prompt_tokens || result.usage.completion_tokens) {
      await supabase.from('usage_events').insert({
        workspace_id: wid,
        kind: 'workflow',
        model: c.env.CHAT_MODEL ?? 'gpt-4o-mini',
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        meta: { workflow_id: wf.id, run_id: run.id },
      })
    }
    return c.json({
      run_id: run.id,
      status: 'succeeded',
      output: result.output,
      node_results: result.nodeResults,
      usage: result.usage,
    })
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e).slice(0, 2000)
    const nodeResults = (e as { nodeResults?: Record<string, unknown> }).nodeResults ?? null
    await supabase
      .from('workflow_runs')
      .update({
        status: 'failed',
        error: message,
        node_results: nodeResults,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id)
    return c.json({ run_id: run.id, status: 'failed', error: message }, 500)
  }
})

workflows.get('/:id/runs', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('workflow_runs')
    .select('id, status, input, output, error, started_at, finished_at')
    .eq('workflow_id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .order('started_at', { ascending: false })
    .limit(50)
  return c.json(data ?? [])
})
