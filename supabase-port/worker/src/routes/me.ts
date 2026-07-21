import { Hono } from 'hono'
import type { AppEnv } from '../env'

export const me = new Hono<AppEnv>()

me.get('/me', async (c) => {
  if (c.get('authKind') === 'api_key') {
    return c.json({ kind: 'api_key', workspace_id: c.get('apiKeyWorkspaceId') })
  }
  const userId = c.get('userId')
  const { data } = await c
    .get('supabase')
    .from('workspace_members')
    .select('role, workspaces (id, name, slug, plan, created_at)')
    .eq('user_id', userId)
  return c.json({ kind: 'user', user_id: userId, workspaces: data ?? [] })
})
