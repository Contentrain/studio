/**
 * Shared Redis client — singleton with graceful degradation.
 *
 * Uses ioredis with lazy connect. Falls back silently when REDIS_URL is not
 * configured or connection fails — callers must handle null return.
 *
 * Connection security:
 *   redis://   — plain TCP (dev / private network)
 *   rediss://  — TLS encrypted (production)
 *   REDIS_CA_CERT — path to CA bundle for self-signed certs (on-premise)
 */
import { readFileSync } from 'node:fs'
import Redis from 'ioredis'

let redis: Redis | null = null
let redisFailed = false

/**
 * Get the shared Redis client instance.
 * Returns null when Redis is not configured or connection has permanently failed.
 */
export function getRedis(): Redis | null {
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
 * Reset Redis state — only for testing.
 */
export function _resetRedisForTest(): void {
  redis?.disconnect()
  redis = null
  redisFailed = false
}
