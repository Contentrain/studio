/**
 * CDN origin-transfer budget per workspace (`cdn.bandwidth_gb`).
 *
 * What costs Studio money is what the origin sends (Railway egress). With the
 * Cloudflare CDN host in front (docs/CDN_EDGE.md), edge hits never reach the
 * origin, so counting bytes here counts exactly that — and a cached site
 * rarely comes near its limit.
 *
 * Counter: Redis `INCRBY` per workspace per usage window (`usage-period.ts`: the
 * billing slice of a subscribed workspace, else the calendar month), seeded from the
 * durable `cdn_usage` total when the key is missing (restart, eviction). In-memory
 * without Redis. The counter can trail the durable total by in-flight
 * requests; it only decides when to refuse.
 *
 * Mode (`NUXT_CDN_ORIGIN_LIMIT`):
 * - `enforce` (default) — past the limit delivery continues (the owner is
 *                alerted), and at `CDN_ORIGIN_HARD_STOP_RATIO` of it the origin
 *                answers 429 with Retry-After until the window resets. With
 *                overage on, the limit passed in is the abuse ceiling
 *                (`getEffectiveLimit`, 10× the plan), billed per GB past the
 *                plan, and the stop is at the ceiling itself (`hardStopRatio: 1`).
 * - `observe`  — count and log, never refuse (self-hosters, operators).
 * - `off`      — neither count nor refuse.
 */
import { CDN_ORIGIN_HARD_STOP_RATIO } from '../../shared/utils/cdn-limit'
import { useDatabaseProvider } from './providers'
import { getRedis } from './redis'
import { usagePeriodFrom, usageWindowOf } from './usage-period'
import type { UsagePeriod } from './usage-period'

export type CdnOriginLimitMode = 'off' | 'observe' | 'enforce'

const GIB = 1024 ** 3
const KEY_TTL_SECONDS = 40 * 24 * 3600

const memoryCounters = new Map<string, number>()
const loggedOver = new Set<string>()

export function cdnOriginLimitMode(): CdnOriginLimitMode {
  const raw = String(useRuntimeConfig().cdn?.originLimit ?? 'enforce')
  return raw === 'off' || raw === 'observe' ? raw : 'enforce'
}

/** The window a request is counted in; the calendar month when the caller names none. */
function windowOf(now: Date, period?: UsagePeriod): UsagePeriod {
  return period ?? usagePeriodFrom(null, now)
}

function counterKey(workspaceId: string, month: string): string {
  return `cdnorigin:${workspaceId}:${month}`
}

/** Seconds until the window resets: next calendar month (UTC), or the billing slice's end. */
export function secondsUntilMonthReset(now: Date = new Date(), period?: UsagePeriod): number {
  const next = period ? new Date(period.resetsAt).getTime() : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

async function readUsedBytes(workspaceId: string, now: Date, period?: UsagePeriod): Promise<number> {
  const window = windowOf(now, period)
  const month = window.key
  const key = counterKey(workspaceId, month)
  const redis = getRedis()
  if (redis) {
    const cached = await redis.get(key).catch(() => null)
    if (cached !== null) return Number(cached) || 0
    const seed = await useDatabaseProvider().getWorkspaceMonthlyCDNBandwidth(workspaceId, month, usageWindowOf(window))
    await redis.set(key, String(seed), 'EX', KEY_TTL_SECONDS, 'NX').catch(() => null)
    return seed
  }
  const cached = memoryCounters.get(key)
  if (cached !== undefined) return cached
  const seed = await useDatabaseProvider().getWorkspaceMonthlyCDNBandwidth(workspaceId, month, usageWindowOf(window))
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
  /** The workspace's usage window; absent = calendar month. */
  period?: UsagePeriod
  /**
   * Where, as a multiple of `limitGb`, the origin stops. The plan limit
   * keeps the unbilled 20 % buffer; an overage ceiling stops at itself.
   */
  hardStopRatio?: number
}): Promise<{ allowed: true } | { allowed: false, retryAfterSeconds: number }> {
  const mode = cdnOriginLimitMode()
  if (mode === 'off' || !Number.isFinite(input.limitGb)) return { allowed: true }
  const now = input.now ?? new Date()
  let used: number
  try {
    used = await readUsedBytes(input.workspaceId, now, input.period)
  }
  catch {
    return { allowed: true }
  }
  if (used < input.limitGb * GIB) return { allowed: true }

  const logKey = `${input.workspaceId}:${windowOf(now, input.period).key}`
  if (!loggedOver.has(logKey)) {
    loggedOver.add(logKey)
    // eslint-disable-next-line no-console -- ops signal; the owner is told by the usage alert
    console.warn(`[cdn-origin] workspace=${input.workspaceId} over its ${input.limitGb} GB origin limit (${(used / GIB).toFixed(2)} GB, mode=${mode})`)
  }
  // Past the limit and under the hard stop: keep serving, the owner is alerted.
  const stopRatio = input.hardStopRatio ?? CDN_ORIGIN_HARD_STOP_RATIO
  if (mode === 'observe' || used < input.limitGb * GIB * stopRatio) return { allowed: true }
  return { allowed: false, retryAfterSeconds: secondsUntilMonthReset(now, input.period) }
}

/** Add served bytes to the workspace's counter. Fire-and-forget. */
export async function addCdnOriginBytes(workspaceId: string, bytes: number, now: Date = new Date(), period?: UsagePeriod): Promise<void> {
  if (cdnOriginLimitMode() === 'off' || bytes <= 0) return
  const key = counterKey(workspaceId, windowOf(now, period).key)
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
