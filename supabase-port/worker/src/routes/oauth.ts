import { Hono } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import type { AppEnv, Env } from '../env'
import { adminClient } from '../lib/supabase'
import { isOAuthConfig, exchangeCode, storeToken } from '../lib/oauth'
import { resolvePluginAuth } from '../lib/vaultauth'

function stateSecret(env: Env): Uint8Array {
  return new TextEncoder().encode(env.SUPABASE_JWT_SECRET)
}

// Mounted at /v1/workspaces/:wid/plugins/:pid/oauth (authenticated).
export const oauthWs = new Hono<AppEnv>()

oauthWs.get('/url', async (c) => {
  const wid = c.req.param('wid')!
  const pid = c.req.param('pid')!
  const { data: plugin } = await c
    .get('supabase')
    .from('plugins')
    .select('id, auth')
    .eq('id', pid)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (!plugin) return c.json({ error: 'plugin not found' }, 404)
  await resolvePluginAuth(c.get('supabase'), plugin)
  if (!isOAuthConfig(plugin.auth)) return c.json({ error: 'plugin is not configured for oauth2' }, 400)

  const userKey =
    c.get('authKind') === 'user' ? c.get('userId') : (c.req.query('user_key') ?? 'api')
  const state = await new SignJWT({ wid, pid, uk: userKey })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .sign(stateSecret(c.env))

  const redirectUri = `${new URL(c.req.url).origin}/oauth/callback`
  const url = new URL(plugin.auth.auth_url)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', plugin.auth.client_id)
  url.searchParams.set('redirect_uri', redirectUri)
  if (plugin.auth.scopes) url.searchParams.set('scope', plugin.auth.scopes)
  url.searchParams.set('state', state)
  return c.json({ url: url.toString(), redirect_uri: redirectUri })
})

oauthWs.get('/status', async (c) => {
  const userKey =
    c.get('authKind') === 'user' ? c.get('userId') : (c.req.query('user_key') ?? 'api')
  const { data } = await c
    .get('supabase')
    .from('plugin_user_tokens')
    .select('expires_at, updated_at')
    .eq('plugin_id', c.req.param('pid')!)
    .eq('user_key', userKey)
    .maybeSingle()
  return c.json({ connected: !!data, expires_at: data?.expires_at ?? null })
})

oauthWs.delete('/', async (c) => {
  const userKey =
    c.get('authKind') === 'user' ? c.get('userId') : (c.req.query('user_key') ?? 'api')
  const { error } = await c
    .get('supabase')
    .from('plugin_user_tokens')
    .delete()
    .eq('plugin_id', c.req.param('pid')!)
    .eq('workspace_id', c.req.param('wid')!)
    .eq('user_key', userKey)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ ok: true })
})

// Public callback at /oauth/callback — authorization happens via the signed
// state token, not a bearer header (the provider redirects the browser here).
export const oauthCallback = new Hono<{ Bindings: Env }>()

oauthCallback.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.html('<h3>Missing code or state.</h3>', 400)

  let wid: string, pid: string, userKey: string
  try {
    const { payload } = await jwtVerify(state, stateSecret(c.env))
    wid = String(payload.wid)
    pid = String(payload.pid)
    userKey = String(payload.uk)
  } catch {
    return c.html('<h3>Invalid or expired state token.</h3>', 400)
  }

  const supabase = adminClient(c.env)
  const { data: plugin } = await supabase
    .from('plugins')
    .select('id, auth')
    .eq('id', pid)
    .eq('workspace_id', wid)
    .maybeSingle()
  if (plugin) await resolvePluginAuth(supabase, plugin).catch(() => undefined)
  if (!plugin || !isOAuthConfig(plugin.auth)) {
    return c.html('<h3>Plugin not found or not oauth2.</h3>', 404)
  }

  try {
    const redirectUri = `${new URL(c.req.url).origin}/oauth/callback`
    const token = await exchangeCode(plugin.auth, code, redirectUri)
    await storeToken(supabase, pid, wid, userKey, token)
    return c.html('<h3>✅ Connected. You can close this window.</h3>')
  } catch (e) {
    return c.html(`<h3>OAuth exchange failed.</h3><pre>${String(e).slice(0, 300)}</pre>`, 502)
  }
})
