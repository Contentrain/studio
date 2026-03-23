/**
 * CDN per-key rate limiter.
 *
 * In-memory sliding window, same pattern as chat rate limiter.
 * Each API key has its own rate limit (stored in cdn_api_keys.rate_limit_per_hour).
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

interface RateWindow {
  timestamps: number[]
}

const store = new Map<string, RateWindow>()

const DEFAULT_WINDOW_MS = 3600_000 // 1 hour

/**
 * Check CDN rate limit for an API key.
 */
export function checkCDNRateLimit(
  keyId: string,
  maxRequests: number = 1000,
): { allowed: boolean, remaining: number, resetAt: number } {
  const now = Date.now()
  const cutoff = now - DEFAULT_WINDOW_MS

  let window = store.get(keyId)
  if (!window) {
    window = { timestamps: [] }
    store.set(keyId, window)
  }

  // Remove expired timestamps
  window.timestamps = window.timestamps.filter(t => t > cutoff)

  const resetAt = Math.ceil((now + DEFAULT_WINDOW_MS) / 1000)

  if (window.timestamps.length >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt }
  }

  window.timestamps.push(now)
  return { allowed: true, remaining: maxRequests - window.timestamps.length, resetAt }
}
