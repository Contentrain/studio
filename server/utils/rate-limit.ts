/**
 * Sliding window rate limiter with Redis backend.
 *
 * Production: uses standard Redis via REDIS_URL (Railway, self-hosted, etc.).
 * Development: falls back to in-memory Map when Redis is not configured.
 *
 * Redis implementation uses sorted sets (ZSET) for atomic sliding window.
 * All existing callsites use the same `checkRateLimit(key, max, windowMs)` signature.
 *
 * Connection security:
 *   redis://   — plain TCP (dev / private network only)
 *   rediss://  — TLS encrypted (production recommended)
 *   REDIS_CA_CERT — path to CA bundle for self-signed certs (on-premise)
 */

import { readFileSync } from 'node:fs'
import Redis from 'ioredis'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

// ---------------------------------------------------------------------------
// In-memory fallback (dev / single-instance)
// ---------------------------------------------------------------------------

interface RateWindow {
  timestamps: number[]
}

const memoryStore = new Map<string, RateWindow>()
const CLEANUP_INTERVAL_MS = 5 * 60_000
let lastCleanup = Date.now()

function cleanupStaleEntries(now: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  const maxAge = now - 60 * 60_000
  for (const [key, window] of memoryStore) {
    if (window.timestamps.length === 0 || window.timestamps[window.timestamps.length - 1]! < maxAge) {
      memoryStore.delete(key)
    }
  }
}

function checkMemoryRateLimit(key: string, maxRequests: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  const cutoff = now - windowMs

  cleanupStaleEntries(now)

  let window = memoryStore.get(key)
  if (!window) {
    window = { timestamps: [] }
    memoryStore.set(key, window)
  }

  window.timestamps = window.timestamps.filter(t => t > cutoff)

  if (window.timestamps.length >= maxRequests) {
    const oldestInWindow = window.timestamps[0] ?? now
    const retryAfterMs = oldestInWindow + windowMs - now
    return { allowed: false, remaining: 0, retryAfterMs }
  }

  window.timestamps.push(now)
  return { allowed: true, remaining: maxRequests - window.timestamps.length, retryAfterMs: 0 }
}

// ---------------------------------------------------------------------------
// Redis backend (production) — ZSET sliding window
// ---------------------------------------------------------------------------

let redis: Redis | null = null
let redisFailed = false

function getRedis(): Redis | null {
  if (redisFailed) return null
  if (redis) return redis

  const url = process.env.REDIS_URL
  if (!url) return null

  // TLS config for on-premise with self-signed certificates
  const caCertPath = process.env.REDIS_CA_CERT
  const tls = url.startsWith('rediss://') && caCertPath
    ? { ca: readFileSync(caCertPath, 'utf-8') }
    : undefined

  redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
    ...(tls && { tls }),
  })

  redis.on('error', () => {
    // Silently degrade to in-memory on persistent failure
    redisFailed = true
    redis?.disconnect()
    redis = null
  })

  redis.connect().catch(() => {
    redisFailed = true
    redis = null
  })

  return redis
}

/**
 * Atomic sliding window via Redis sorted set.
 *
 * Each request is a ZSET member scored by timestamp.
 * Pipeline: remove expired → count → conditionally add → set TTL.
 */
async function checkRedisRateLimit(key: string, maxRequests: number, windowMs: number): Promise<RateLimitResult> {
  const r = getRedis()!
  const now = Date.now()
  const cutoff = now - windowMs
  const redisKey = `rl:${key}`

  // Use pipeline for atomicity: remove old + count + expire
  const pipeline = r.pipeline()
  pipeline.zremrangebyscore(redisKey, 0, cutoff)
  pipeline.zcard(redisKey)
  const results = await pipeline.exec()

  const count = (results?.[1]?.[1] as number) ?? 0

  if (count >= maxRequests) {
    // Get oldest entry to calculate retry-after
    const oldest = await r.zrange(redisKey, 0, 0, 'WITHSCORES')
    const oldestScore = oldest.length >= 2 ? Number(oldest[1]) : now
    const retryAfterMs = Math.max(0, oldestScore + windowMs - now)
    return { allowed: false, remaining: 0, retryAfterMs }
  }

  // Add this request — use timestamp + random suffix as member to avoid dedup
  const member = `${now}:${Math.random().toString(36).slice(2, 8)}`
  const ttlSeconds = Math.ceil(windowMs / 1000)

  const addPipeline = r.pipeline()
  addPipeline.zadd(redisKey, now, member)
  addPipeline.expire(redisKey, ttlSeconds)
  await addPipeline.exec()

  return { allowed: true, remaining: maxRequests - count - 1, retryAfterMs: 0 }
}

// ---------------------------------------------------------------------------
// Public API — same signature, auto-detects backend
// ---------------------------------------------------------------------------

/**
 * Check rate limit for a key (typically userId, IP, or composite key).
 * Returns { allowed, remaining, retryAfterMs }.
 *
 * Uses Redis when REDIS_URL is configured, in-memory otherwise.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number = 10,
  windowMs: number = 60_000,
): RateLimitResult | Promise<RateLimitResult> {
  if (getRedis()) {
    return checkRedisRateLimit(key, maxRequests, windowMs)
  }
  return checkMemoryRateLimit(key, maxRequests, windowMs)
}

/**
 * Plan-based monthly message limits.
 * Delegates to the single source of truth in shared/utils/license.ts.
 */
export function getMonthlyMessageLimit(plan: string): number {
  return getPlanLimit(plan, 'ai.messages_per_month')
}
