import type { Env } from '../env'

// Server-side Realtime Broadcast (no websocket needed): pushes events onto
// the private channel `ws:<workspace_id>`. Workspace members subscribe with
// their user JWT; the RLS policy on realtime.messages (migration 0008)
// authorizes them. Fire-and-forget — realtime being disabled never breaks
// the main flow.
export async function broadcast(
  env: Env,
  workspaceId: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        messages: [{ topic: `ws:${workspaceId}`, event, payload, private: true }],
      }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // realtime unavailable — non-fatal
  }
}
