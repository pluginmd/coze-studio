import type { SupabaseClient } from '@supabase/supabase-js'

// OAuth2 authorization-code support for plugins (openauth domain).
// plugins.auth shape: { type: 'oauth2', client_id, client_secret,
//                       auth_url, token_url, scopes }

export interface OAuthConfig {
  type: 'oauth2'
  client_id: string
  client_secret: string
  auth_url: string
  token_url: string
  scopes?: string
}

export function isOAuthConfig(auth: unknown): auth is OAuthConfig {
  const a = auth as OAuthConfig | null
  return !!a && a.type === 'oauth2' && !!a.client_id && !!a.token_url && !!a.auth_url
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

async function tokenRequest(config: OAuthConfig, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(config.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      ...params,
    }).toString(),
  })
  if (!res.ok) {
    throw new Error(`oauth token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.json()) as TokenResponse
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  return tokenRequest(config, { grant_type: 'authorization_code', code, redirect_uri: redirectUri })
}

// Returns a valid access token for (plugin, user), refreshing when expired.
export async function getAccessToken(
  supabase: SupabaseClient,
  pluginId: string,
  workspaceId: string,
  userKey: string,
  config: OAuthConfig
): Promise<string | null> {
  const { data: row } = await supabase
    .from('plugin_user_tokens')
    .select('id, access_token, refresh_token, expires_at')
    .eq('plugin_id', pluginId)
    .eq('user_key', userKey)
    .maybeSingle()
  if (!row) return null

  const expired = row.expires_at && new Date(row.expires_at).getTime() < Date.now() + 30_000
  if (!expired) return row.access_token

  if (!row.refresh_token) return null
  const refreshed = await tokenRequest(config, {
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
  })
  if (!refreshed.access_token) return null
  await supabase
    .from('plugin_user_tokens')
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? row.refresh_token,
      expires_at: refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        : null,
    })
    .eq('id', row.id)
  return refreshed.access_token
}

export async function storeToken(
  supabase: SupabaseClient,
  pluginId: string,
  workspaceId: string,
  userKey: string,
  token: TokenResponse
): Promise<void> {
  if (!token.access_token) throw new Error('oauth provider returned no access_token')
  const { error } = await supabase.from('plugin_user_tokens').upsert(
    {
      plugin_id: pluginId,
      workspace_id: workspaceId,
      user_key: userKey,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : null,
    },
    { onConflict: 'plugin_id,user_key' }
  )
  if (error) throw new Error(`failed to store oauth token: ${error.message}`)
}
