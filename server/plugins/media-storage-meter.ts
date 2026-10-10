/**
 * Daily media-storage meter — Nitro plugin.
 *
 * Storage is a level (`workspaces.media_storage_bytes`, kept by the upload
 * and delete paths), not a stream of events, so nothing reaches the payment
 * meter unless it is sampled. Once per UTC day each workspace with a paying
 * account gets one `media_storage_gb_months` event: the bytes stored at the
 * sample, in GB, divided by the days in its billing period
 * (`recordMediaStorageDay`). A period's events then sum to the average GB
 * stored over it, which is what "per GB/month" sells, and the plan's GB is
 * the included allowance as is.
 *
 * Runs every six hours; the event is keyed by workspace + day, so the first run of a
 * day samples it and the rest record nothing. A missed day is not filled in
 * afterwards: a past level cannot be read back, and the gap only ever bills
 * less. Workspaces without a payment customer are skipped — nothing would
 * bill them, and the outbox would retry their rows until it dropped them.
 *
 * Off unless `NUXT_CDN_STORAGE_METER` is set — the meter has to exist in
 * the payment provider first (polar-sync). Self-hosted deployments without
 * billing record nothing either way (`recordUsage`).
 */
import { useDatabaseProvider } from '../utils/providers'
import { recordMediaStorageDay } from '../utils/usage-metering'
import { usagePeriodFrom } from '../utils/usage-period'
import type { UsagePeriodAccount } from '../utils/usage-period'

const INTERVAL_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  if (!useRuntimeConfig().cdn?.storageMeter) return

  const timeout = setTimeout(() => {
    meterMediaStorageDay().catch(logFailure)
  }, 90_000)
  const interval = setInterval(() => {
    meterMediaStorageDay().catch(logFailure)
  }, INTERVAL_MS)

  nitroApp.hooks.hook('close', () => {
    clearTimeout(timeout)
    clearInterval(interval)
  })
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- background job; failure must surface somewhere
  console.error('[media-storage-meter] Run failed:', err)
}

/** Days in the period (`startsAt`..`resetsAt`), at least one. */
export function periodDays(period: { startsAt: string, resetsAt: string }): number {
  const span = new Date(period.resetsAt).getTime() - new Date(period.startsAt).getTime()
  return Math.max(1, span / DAY_MS)
}

export async function meterMediaStorageDay(now: Date = new Date()): Promise<number> {
  const db = useDatabaseProvider()
  const day = now.toISOString().substring(0, 10)
  let recorded = 0
  for (const { workspaceId, bytes } of await db.listWorkspaceMediaStorageBytes()) {
    let account: UsagePeriodAccount & { customer_id?: unknown } | null
    try {
      account = await db.getActivePaymentAccount(workspaceId) as UsagePeriodAccount & { customer_id?: unknown } | null
    }
    catch (err) {
      // One unreadable account must not stop the others; the next run retries it.
      logFailure(err)
      continue
    }
    if (!account?.customer_id) continue
    await recordMediaStorageDay({ workspaceId, day, bytes, periodDays: periodDays(usagePeriodFrom(account, now)) })
    recorded++
  }
  return recorded
}
