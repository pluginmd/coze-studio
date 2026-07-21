// Fixed-window in-memory rate limiter. Per-isolate only (Workers may run
// many isolates), so treat limits as best-effort abuse damping — pair with
// Cloudflare WAF rules for hard guarantees.
interface Window {
  count: number
  resetAt: number
}

const windows = new Map<string, Window>()
const MAX_KEYS = 10_000

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const win = windows.get(key)
  if (!win || win.resetAt <= now) {
    if (windows.size > MAX_KEYS) windows.clear()
    windows.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (win.count >= limit) return false
  win.count++
  return true
}
