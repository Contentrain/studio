/**
 * In-memory sliding window rate limiter.
 *
 * Simple per-user rate limiting for chat messages.
 * Includes periodic cleanup to prevent unbounded memory growth.
 *
 * For production at scale, replace with Redis-backed limiter.
 */

interface RateWindow {
  timestamps: number[]
}

const store = new Map<string, RateWindow>()

// Defaults: 10 messages per minute
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_REQUESTS = 10

// Cleanup stale entries every 5 minutes to prevent memory leak
const CLEANUP_INTERVAL_MS = 5 * 60_000
let lastCleanup = Date.now()

function cleanupStaleEntries(now: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  for (const [key, window] of store) {
    // Remove entries where all timestamps are expired (oldest window is 1 hour)
    const maxAge = now - 60 * 60_000
    if (window.timestamps.length === 0 || window.timestamps[window.timestamps.length - 1]! < maxAge) {
      store.delete(key)
    }
  }
}

/**
 * Check rate limit for a key (typically userId or `userId:workspaceId`).
 * Returns { allowed, remaining, retryAfterMs }.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): { allowed: boolean, remaining: number, retryAfterMs: number } {
  const now = Date.now()
  const cutoff = now - windowMs

  cleanupStaleEntries(now)

  let window = store.get(key)
  if (!window) {
    window = { timestamps: [] }
    store.set(key, window)
  }

  // Remove expired timestamps
  window.timestamps = window.timestamps.filter(t => t > cutoff)

  if (window.timestamps.length >= maxRequests) {
    const oldestInWindow = window.timestamps[0] ?? now
    const retryAfterMs = oldestInWindow + windowMs - now
    return { allowed: false, remaining: 0, retryAfterMs }
  }

  window.timestamps.push(now)
  return { allowed: true, remaining: maxRequests - window.timestamps.length, retryAfterMs: 0 }
}

/**
 * Plan-based monthly message limits.
 * Delegates to the single source of truth in shared/utils/license.ts.
 */
export function getMonthlyMessageLimit(plan: string): number {
  return getPlanLimit(plan, 'ai.messages_per_month')
}
