/**
 * Daily CDN origin-transfer meter — Nitro plugin.
 *
 * Once a day's `cdn_usage` rows are final (the UTC day has ended), each
 * workspace's total goes to the payment meter as one `cdn_origin_gb` event
 * (`recordCDNOriginUsage`). Runs hourly; the event is keyed by workspace +
 * day, so re-runs and several instances record each day once.
 *
 * Off unless `NUXT_CDN_ORIGIN_METER` is set — the meter has to exist in the
 * payment provider first (polar-sync). Self-hosted deployments without
 * billing record nothing either way (`recordUsage`).
 */
import { useDatabaseProvider } from '../utils/providers'
import { recordCDNOriginUsage } from '../utils/usage-metering'

const INTERVAL_MS = 60 * 60 * 1000
/** How many finished days each run covers — a missed day is picked up. */
const LOOKBACK_DAYS = 2

export default defineNitroPlugin((nitroApp) => {
  if (!useRuntimeConfig().cdn?.originMeter) return

  const timeout = setTimeout(() => {
    meterCdnOriginDays().catch(logFailure)
  }, 60_000)
  const interval = setInterval(() => {
    meterCdnOriginDays().catch(logFailure)
  }, INTERVAL_MS)

  nitroApp.hooks.hook('close', () => {
    clearTimeout(timeout)
    clearInterval(interval)
  })
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- background job; failure must surface somewhere
  console.error('[cdn-origin-meter] Run failed:', err)
}

/** The last `count` finished UTC days, oldest first (`YYYY-MM-DD`). */
export function finishedDays(now: Date, count: number): string[] {
  const days: string[] = []
  for (let back = count; back >= 1; back--) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back))
    days.push(day.toISOString().substring(0, 10))
  }
  return days
}

export async function meterCdnOriginDays(now: Date = new Date()): Promise<number> {
  const db = useDatabaseProvider()
  let recorded = 0
  for (const day of finishedDays(now, LOOKBACK_DAYS)) {
    const totals = await db.listWorkspaceCDNBandwidthForDay(day)
    for (const { workspaceId, bytes } of totals) {
      await recordCDNOriginUsage({ workspaceId, day, bytes })
      recorded++
    }
  }
  return recorded
}
