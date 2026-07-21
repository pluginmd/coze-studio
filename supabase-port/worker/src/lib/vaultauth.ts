import type { SupabaseClient } from '@supabase/supabase-js'

// Supabase Vault integration: a plugin's auth can be `{type:'vault',
// vault_id}` — the real auth JSON lives encrypted in vault.secrets and is
// resolved server-side (service role) right before use.
export async function resolvePluginAuth(
  supabase: SupabaseClient,
  plugin: { auth?: unknown } & Record<string, unknown>
): Promise<void> {
  const auth = plugin.auth as { type?: string; vault_id?: string } | null
  if (auth?.type !== 'vault' || !auth.vault_id) return
  const { data, error } = await supabase.rpc('vault_get', { p_id: auth.vault_id })
  if (error || typeof data !== 'string') {
    throw new Error('vault secret unavailable (is supabase_vault enabled?)')
  }
  plugin.auth = JSON.parse(data)
}
