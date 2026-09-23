/**
 * CDN origin-transfer budget per workspace (`cdn.bandwidth_gb`).
 *
 * What costs Studio money is what the origin sends (Railway egress). With the
 * Cloudflare CDN host in front (docs/CDN_EDGE.md), edge hits never reach the
 * origin, so counting bytes here counts exactly that — and a cached site
 * rarely comes near its limit.
 *
 * Counter: Redis `INCRBY` per workspace per calendar month (the CDN is
 * counted per calendar month, `usage-period.ts`), seeded from the durable
 * `cdn_usage` total when the key is missing (restart, eviction). In-memory
 * without Redis. The counter can trail the durable total by in-flight
 * requests; it only decides when to refuse.
 *
 * Mode (`NUXT_CDN_ORIGIN_LIMIT`):
 * - `off`      — neither count nor refuse.
 * - `observe`  — count, log once when a workspace passes its limit, never refuse.
 * - `enforce`  — at the limit, answer 429 with Retry-After until the month
 *                resets, unless overage is on (`getEffectiveLimit`).
 */
import { useDatabaseProvider } from './providers'
import { getRedis } from './redis'

export type CdnOriginLimitMode = 'off' | 'observe' | 'enforce'

const GIB = 1024 ** 3
const KEY_TTL_SECONDS = 40 * 24 * 3600

const memoryCounters = new Map<string, number>()
const loggedOver = new Set<string>()

export function cdnOriginLimitMode(): CdnOriginLimitMode {
  const raw = String(useRuntimeConfig().cdn?.originLimit ?? 'observe')
  return raw === 'off' || raw === 'enforce' ? raw : 'observe'
}

function monthKey(now: Date): string {
  return now.toISOString().substring(0, 7)
}

function counterKey(workspaceId: string, month: string): string {
  return `cdnorigin:${workspaceId}:${month}`
}

/** Seconds until the first instant of next calendar month (UTC). */
export function secondsUntilMonthReset(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

async function readUsedBytes(workspaceId: string, now: Date): Promise<number> {
  const month = monthKey(now)
  const key = counterKey(workspaceId, month)
  const redis = getRedis()
  if (redis) {
    const cached = await redis.get(key).catch(() => null)
    if (cached !== null) return Number(cached) || 0
    const seed = await useDatabaseProvider().getWorkspaceMonthlyCDNBandwidth(workspaceId, month)
    await redis.set(key, String(seed), 'EX', KEY_TTL_SECONDS, 'NX').catch(() => null)
    return seed
  }
  const cached = memoryCounters.get(key)
  if (cached !== undefined) return cached
  const seed = await useDatabaseProvider().getWorkspaceMonthlyCDNBandwidth(workspaceId, month)
  memoryCounters.set(key, seed)
  return seed
}

/**
 * Whether the origin may serve this request. `limitBytes` is the effective
 * limit in bytes (Infinity = unlimited). Never throws: a counter failure
 * lets the request through.
 */
export async function checkCdnOriginBudget(input: {
  workspaceId: string
  limitGb: number
  now?: Date
}): Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }> {
  const mode = cdnOriginLimitMode()
  if (mode === 'off' || !Number.isFinite(input.limitGb)) return { allowed: true }
  const now = input.now ?? new Date()
  let used: number
  try {
    used = await readUsedBytes(input.workspaceId, now)
  }
  catch {
    return { allowed: true }
  }
  if (used < input.limitGb * GIB) return { allowed: true }

  const logKey = `${input.workspaceId}:${monthKey(now)}`
  if (!loggedOver.has(logKey)) {
    loggedOver.add(logKey)
    // eslint-disable-next-line no-console -- the one signal observe mode exists for
    console.warn(`[cdn-origin] workspace=${input.workspaceId} over its ${input.limitGb} GB origin limit (${(used / GIB).toFixed(2)} GB, mode=${mode})`)
  }
  if (mode === 'observe') return { allowed: true }
  return { allowed: false, retryAfterSeconds: secondsUntilMonthReset(now) }
}

/** Add served bytes to the workspace's counter. Fire-and-forget. */
export async function addCdnOriginBytes(workspaceId: string, bytes: number, now: Date = new Date()): Promise<void> {
  if (cdnOriginLimitMode() === 'off' || bytes <= 0) return
  const key = counterKey(workspaceId, monthKey(now))
  const redis = getRedis()
  if (redis) {
    // A missing key is seeded on the next check; INCRBY on it now would
    // start the month at this request instead of the durable total.
    const exists = await redis.exists(key).catch(() => 0)
    if (exists) await redis.incrby(key, bytes).catch(() => null)
    return
  }
  const current = memoryCounters.get(key)
  if (current !== undefined) memoryCounters.set(key, current + bytes)
}

/** Test helper. */
export function __resetCdnOriginBudget(): void {
  memoryCounters.clear()
  loggedOver.clear()
}
