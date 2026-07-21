import { Hono } from 'hono'
import type { AppEnv } from '../env'

// Workspace-wide resource search (search domain): name match across agents,
// workflows, datasets, plugins, prompts.
export const search = new Hono<AppEnv>()

search.get('/', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'q is required' }, 400)
  const wid = c.req.param('wid')!
  const supabase = c.get('supabase')
  const like = `%${q.replace(/[%_]/g, '\\$&')}%`

  const [agents, workflows, datasets, plugins, prompts] = await Promise.all([
    supabase
      .from('agents')
      .select('id, name, description, status')
      .eq('workspace_id', wid)
      .ilike('name', like)
      .limit(10),
    supabase
      .from('workflows')
      .select('id, name, description, status')
      .eq('workspace_id', wid)
      .ilike('name', like)
      .limit(10),
    supabase
      .from('datasets')
      .select('id, name, description')
      .eq('workspace_id', wid)
      .ilike('name', like)
      .limit(10),
    supabase
      .from('plugins')
      .select('id, name, description')
      .eq('workspace_id', wid)
      .ilike('name', like)
      .limit(10),
    supabase
      .from('prompt_resources')
      .select('id, name, description')
      .eq('workspace_id', wid)
      .ilike('name', like)
      .limit(10),
  ])

  return c.json({
    agents: agents.data ?? [],
    workflows: workflows.data ?? [],
    datasets: datasets.data ?? [],
    plugins: plugins.data ?? [],
    prompts: prompts.data ?? [],
  })
})
