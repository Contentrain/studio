/**
 * CDN per-key rate limiter.
 *
 * Production: delegates to the shared Redis-backed rate limiter.
 * Development: in-memory fallback via the same shared utility.
 *
 * Each API key has its own rate limit (stored in cdn_api_keys.rate_limit_per_hour).
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import { checkRateLimit } from '../../server/utils/rate-limit'

const DEFAULT_WINDOW_MS = 3600_000 // 1 hour

/**
 * Check CDN rate limit for an API key.
 */
export async function checkCDNRateLimit(
  keyId: string,
  maxRequests: number = 1000,
): Promise<{ allowed: boolean, remaining: number, resetAt: number }> {
  const result = await checkRateLimit(`cdn-key:${keyId}`, maxRequests, DEFAULT_WINDOW_MS)
  const resetAt = Math.ceil((Date.now() + DEFAULT_WINDOW_MS) / 1000)

  return {
    allowed: result.allowed,
    remaining: result.remaining,
    resetAt,
  }
}
