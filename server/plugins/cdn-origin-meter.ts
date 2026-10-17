/**
 * Daily CDN origin-transfer meter — Nitro plugin.
 *
 * Once a day's `cdn_usage` rows are final (the UTC day has ended), each
 * workspace's total goes to the payment meter as one `cdn_origin_gb` event
 * (`recordCDNOriginUsage`). Runs hourly; the event is keyed by workspace +
 * day, so re-runs and several instances record each day once.
 *
 * A day is billed in full only when CDN overage was on, and sellable, for all
 * of it (`overageDayGate`). Any other day reports only the part of its bytes
 * that still fits under the plan for the period so far, which the included
 * units absorb: the grace past the plan without overage stays unbilled.
 *
 * Off unless `NUXT_CDN_ORIGIN_METER` is set — the meter has to exist in the
 * payment provider first (polar-sync). Self-hosted deployments without
 * billing record nothing either way (`recordUsage`).
 */
import { bytesUnderLimit, overageDayGate, planLimitBytes } from '../utils/overage-meter-gate'
import { useDatabaseProvider } from '../utils/providers'
import { recordCDNOriginUsage } from '../utils/usage-metering'
import { usagePeriodFrom } from '../utils/usage-period'
import type { UsagePeriodAccount } from '../utils/usage-period'

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
      let billable: number
      try {
        billable = await billableDayBytes(workspaceId, day, bytes, now)
      }
      catch (err) {
        // One unreadable workspace must not stop the others; the lookback retries its day next run.
        logFailure(err)
        continue
      }
      await recordCDNOriginUsage({ workspaceId, day, bytes: billable })
      recorded++
    }
  }
  return recorded
}

/**
 * The bytes of `day` the meter may report: all of them when overage covered
 * the day, else only what fits under the plan given the period's earlier days.
 */
export async function billableDayBytes(workspaceId: string, day: string, bytes: number, now: Date): Promise<number> {
  const db = useDatabaseProvider()
  const dayStart = new Date(`${day}T00:00:00Z`)
  const gate = await overageDayGate({ workspaceId, settingsKey: 'cdn_bandwidth', dayStart, now, db })
  if (gate.covered) return bytes
  const limit = planLimitBytes(gate.plan, 'cdn.bandwidth_gb')
  if (!Number.isFinite(limit)) return bytes
  // The billing slice the day belongs to, read up to the day itself.
  const account = await db.getActivePaymentAccount(workspaceId) as UsagePeriodAccount | null
  const period = usagePeriodFrom(account, new Date(dayStart.getTime() + 12 * 60 * 60 * 1000))
  const before = period.startsAt.substring(0, 10) < day
    ? await db.getWorkspaceMonthlyCDNBandwidth(workspaceId, period.key, { from: period.startsAt, to: dayStart.toISOString() })
    : 0
  return bytesUnderLimit(before, bytes, limit)
}
