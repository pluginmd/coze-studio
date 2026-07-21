import { createMiddleware } from 'hono/factory'
import { jwtVerify, createRemoteJWKSet } from 'jose'
import { adminClient, sha256hex } from '../lib/supabase'
import type { AppEnv, Env } from '../env'

// Supabase projects sign access tokens either with the legacy HS256 JWT
// secret or (newer projects) with asymmetric JWT signing keys published at
// /auth/v1/.well-known/jwks.json. Verify against both.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function remoteJwks(env: Env) {
  const url = `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`
  let jwks = jwksCache.get(url)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url))
    jwksCache.set(url, jwks)
  }
  return jwks
}

async function verifySupabaseJwt(env: Env, token: string): Promise<string> {
  if (env.SUPABASE_JWT_SECRET) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(env.SUPABASE_JWT_SECRET))
      if (payload.sub) return payload.sub
    } catch {
      // fall through to JWKS (project may use asymmetric signing keys)
    }
  }
  const { payload } = await jwtVerify(token, remoteJwks(env))
  if (!payload.sub) throw new Error('token has no subject')
  return payload.sub
}

// Accepts either a Supabase Auth user JWT or a workspace API key (`czk_...`).
export const auth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) return c.json({ error: 'missing bearer token' }, 401)

  const supabase = adminClient(c.env)
  c.set('supabase', supabase)

  if (token.startsWith('czk_')) {
    const hash = await sha256hex(token)
    const { data: key } = await supabase
      .from('api_keys')
      .select('id, workspace_id, revoked_at, expires_at')
      .eq('key_hash', hash)
      .maybeSingle()
    const expired = key?.expires_at && new Date(key.expires_at).getTime() < Date.now()
    if (!key || key.revoked_at || expired) return c.json({ error: 'invalid api key' }, 401)
    c.set('authKind', 'api_key')
    c.set('userId', '')
    c.set('apiKeyWorkspaceId', key.workspace_id)
    c.executionCtx.waitUntil(
      Promise.resolve(
        supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id)
      ).then(() => undefined)
    )
    await next()
    return
  }

  try {
    c.set('authKind', 'user')
    c.set('userId', await verifySupabaseJwt(c.env, token))
  } catch {
    return c.json({ error: 'invalid or expired token' }, 401)
  }
  await next()
})

// Guards `/v1/workspaces/:wid/...` — the tenant boundary of every request.
export const requireWorkspace = createMiddleware<AppEnv>(async (c, next) => {
  const wid = c.req.param('wid')
  if (!wid) return c.json({ error: 'workspace id required' }, 400)

  if (c.get('authKind') === 'api_key') {
    if (c.get('apiKeyWorkspaceId') !== wid) {
      return c.json({ error: 'api key does not belong to this workspace' }, 403)
    }
    c.set('wsRole', 'admin')
    await next()
    return
  }

  const { data } = await c
    .get('supabase')
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', wid)
    .eq('user_id', c.get('userId'))
    .maybeSingle()
  if (!data) return c.json({ error: 'not a member of this workspace' }, 403)
  c.set('wsRole', data.role)
  await next()
})

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const role = c.get('wsRole')
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'admin role required' }, 403)
  }
  await next()
})
