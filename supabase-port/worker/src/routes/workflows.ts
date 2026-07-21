import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppEnv, Env } from '../env'
import { pick } from '../lib/util'
import { runWorkflow, SuspendError, type WfGraph, type RunOptions } from '../engine/workflow'
import { broadcast } from '../lib/realtime'

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

workflows.post('/:id/duplicate', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: wf } = await supabase
    .from('workflows')
    .select('name, description, graph')
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!wf) return c.json({ error: 'workflow not found' }, 404)
  const { data, error } = await supabase
    .from('workflows')
    .insert({
      name: `${wf.name} (copy)`.slice(0, 120),
      description: wf.description,
      graph: wf.graph,
      workspace_id: wid,
      created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
    })
    .select('id, name')
    .single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json(data, 201)
})

// Publish: snapshot the draft graph as an immutable version.
workflows.post('/:id/publish', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const { data: wf } = await supabase
    .from('workflows')
    .select('id, graph')
    .eq('id', c.req.param('id')!)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!wf) return c.json({ error: 'workflow not found' }, 404)
  const { data: last } = await supabase
    .from('workflow_releases')
    .select('version')
    .eq('workflow_id', wf.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const version = (last?.version ?? 0) + 1
  const { error } = await supabase.from('workflow_releases').insert({
    workflow_id: wf.id,
    workspace_id: wid,
    version,
    graph: wf.graph,
    created_by: c.get('authKind') === 'user' ? c.get('userId') : null,
  })
  if (error) return c.json({ error: error.message }, 400)
  await supabase.from('workflows').update({ status: 'published' }).eq('id', wf.id)
  return c.json({ ok: true, version })
})

workflows.get('/:id/releases', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('workflow_releases')
    .select('id, version, created_by, created_at')
    .eq('workflow_id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .order('version', { ascending: false })
  return c.json(data ?? [])
})

async function resolveGraph(
  supabase: SupabaseClient,
  workflowId: string,
  workspaceId: string,
  version?: number | null
): Promise<WfGraph | null> {
  if (version) {
    const { data } = await supabase
      .from('workflow_releases')
      .select('graph')
      .eq('workflow_id', workflowId)
      .eq('workspace_id', workspaceId)
      .eq('version', version)
      .maybeSingle()
    return (data?.graph as WfGraph) ?? null
  }
  const { data } = await supabase
    .from('workflows')
    .select('graph')
    .eq('id', workflowId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data?.graph as WfGraph) ?? null
}

interface ExecOutcome {
  status: 'succeeded' | 'failed' | 'suspended'
  body: Record<string, unknown>
}

// Shared execution: runs the graph, persists the run row, records usage.
// Handles suspension (question/input nodes) by storing resumable state.
async function executeRun(
  env: Env,
  supabase: SupabaseClient,
  wid: string,
  runId: string,
  workflowId: string,
  graph: WfGraph,
  input: Record<string, unknown>,
  opts: RunOptions
): Promise<ExecOutcome> {
  const outcome = await executeRunInner(env, supabase, wid, runId, workflowId, graph, input, opts)
  await broadcast(env, wid, 'workflow_run', {
    run_id: runId,
    workflow_id: workflowId,
    status: outcome.status,
  })
  return outcome
}

async function executeRunInner(
  env: Env,
  supabase: SupabaseClient,
  wid: string,
  runId: string,
  workflowId: string,
  graph: WfGraph,
  input: Record<string, unknown>,
  opts: RunOptions
): Promise<ExecOutcome> {
  try {
    const result = await runWorkflow(env, supabase, wid, graph, input, opts)
    await supabase
      .from('workflow_runs')
      .update({
        status: 'succeeded',
        output: result.output,
        node_results: result.nodeResults,
        suspended: null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)
    if (result.usage.prompt_tokens || result.usage.completion_tokens) {
      await supabase.from('usage_events').insert({
        workspace_id: wid,
        kind: 'workflow',
        model: env.CHAT_MODEL ?? 'gpt-4o-mini',
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        meta: { workflow_id: workflowId, run_id: runId },
      })
    }
    return {
      status: 'succeeded',
      body: {
        run_id: runId,
        status: 'succeeded',
        output: result.output,
        node_results: result.nodeResults,
        usage: result.usage,
      },
    }
  } catch (e) {
    if (e instanceof SuspendError) {
      const suspended = {
        node_id: e.nodeId,
        question: e.question,
        options: e.options,
        results: e.results,
        input,
      }
      await supabase
        .from('workflow_runs')
        .update({ status: 'suspended', suspended, node_results: e.results })
        .eq('id', runId)
      return {
        status: 'suspended',
        body: {
          run_id: runId,
          status: 'suspended',
          node_id: e.nodeId,
          question: e.question,
          options: e.options,
        },
      }
    }
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
      .eq('id', runId)
    return { status: 'failed', body: { run_id: runId, status: 'failed', error: message } }
  }
}

// Run: sync (default), `stream: true` (SSE node events), or `async: true`
// (background execution polled via GET /runs/:id). `version` pins a release.
workflows.post('/:id/run', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const workflowId = c.req.param('id')!
  const body = await c.req
    .json<{ input?: Record<string, unknown>; version?: number; stream?: boolean; async?: boolean }>()
    .catch(() => ({}) as any)
  const input = body.input ?? {}

  const graph = await resolveGraph(supabase, workflowId, wid, body.version)
  if (!graph) return c.json({ error: body.version ? 'release not found' : 'workflow not found' }, 404)

  const { data: run, error: runError } = await supabase
    .from('workflow_runs')
    .insert({
      workflow_id: workflowId,
      workspace_id: wid,
      input,
      version: body.version ?? null,
      status: body.async ? 'queued' : 'running',
    })
    .select('id')
    .single()
  if (runError) return c.json({ error: runError.message }, 500)

  const userKey = c.get('authKind') === 'user' ? c.get('userId') : 'api'

  if (body.async) {
    c.executionCtx.waitUntil(
      executeRun(c.env, supabase, wid, run.id, workflowId, graph, input, { userKey }).then(() => undefined)
    )
    return c.json({ run_id: run.id, status: 'queued' }, 202)
  }

  if (body.stream) {
    return streamSSE(c, async (stream) => {
      const outcome = await executeRun(c.env, supabase, wid, run.id, workflowId, graph, input, {
        userKey,
        emit: async (ev) => {
          await stream.writeSSE({ event: String(ev.type), data: JSON.stringify(ev) })
        },
      })
      await stream.writeSSE({ event: outcome.status, data: JSON.stringify(outcome.body) })
    })
  }

  const outcome = await executeRun(c.env, supabase, wid, run.id, workflowId, graph, input, { userKey })
  return c.json(outcome.body, outcome.status === 'failed' ? 500 : 200)
})

workflows.get('/:id/runs', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('workflow_runs')
    .select('id, status, version, input, output, error, started_at, finished_at')
    .eq('workflow_id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .order('started_at', { ascending: false })
    .limit(50)
  return c.json(data ?? [])
})

workflows.get('/:id/runs/:runid', async (c) => {
  const { data } = await c
    .get('supabase')
    .from('workflow_runs')
    .select()
    .eq('id', c.req.param('runid')!)
    .eq('workflow_id', c.req.param('id')!)
    .eq('workspace_id', c.req.param('wid')!)
    .maybeSingle()
  if (!data) return c.json({ error: 'run not found' }, 404)
  return c.json(data)
})

// Resume a suspended run with the user's answer.
workflows.post('/:id/runs/:runid/resume', async (c) => {
  const supabase = c.get('supabase')
  const wid = c.req.param('wid')!
  const workflowId = c.req.param('id')!
  const { data: run } = await supabase
    .from('workflow_runs')
    .select('id, status, suspended, version')
    .eq('id', c.req.param('runid')!)
    .eq('workflow_id', workflowId)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!run) return c.json({ error: 'run not found' }, 404)
  if (run.status !== 'suspended' || !run.suspended) {
    return c.json({ error: `run is not suspended (status: ${run.status})` }, 400)
  }

  const body = await c.req.json<{ value?: unknown }>().catch(() => ({}) as any)
  if (body.value === undefined) return c.json({ error: 'value is required' }, 400)

  const graph = await resolveGraph(supabase, workflowId, wid, run.version)
  if (!graph) return c.json({ error: 'workflow graph not found' }, 404)

  const suspended = run.suspended as {
    node_id: string
    results: Record<string, unknown>
    input: Record<string, unknown>
  }
  await supabase.from('workflow_runs').update({ status: 'running' }).eq('id', run.id)

  const userKey = c.get('authKind') === 'user' ? c.get('userId') : 'api'
  const outcome = await executeRun(
    c.env,
    supabase,
    wid,
    run.id,
    workflowId,
    graph,
    suspended.input ?? {},
    {
      userKey,
      preset: suspended.results ?? {},
      resume: { nodeId: suspended.node_id, value: body.value },
    }
  )
  return c.json(outcome.body, outcome.status === 'failed' ? 500 : 200)
})
