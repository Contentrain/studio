/**
 * Usage event outbox drainer — Nitro plugin.
 *
 * Periodically pulls pending rows from `usage_events_outbox` and
 * dispatches them to the active `PaymentProvider.ingestUsageEvent`.
 * Success clears `ingested_at`; failure bumps `attempt_count` and
 * records `last_error` so follow-up runs retry with backoff visibility.
 *
 * This keeps the request path fast (outbox writes are a single insert)
 * while giving us reliable meter delivery even if Polar is briefly
 * unreachable. Self-hosted deployments without a configured provider
 * skip the drain entirely.
 */

import { useDatabaseProvider, usePaymentProvider } from '../utils/providers'

const INTERVAL_MS = 30 * 1000 // 30 seconds
const BATCH_SIZE = 100
/**
 * Give-up threshold. At one tick per 30s this is ~20 minutes, which has to
 * cover the worst case that is *not* a bug: usage recorded between checkout
 * and the `subscription.created` webhook, when the workspace has no payment
 * account to ingest against yet. The old value of 8 gave that window four
 * minutes and billed nothing for what fell outside it.
 */
const MAX_ATTEMPTS = 40

export default defineNitroPlugin((nitroApp) => {
  // Short boot delay so the DB pool finishes initialising before the first tick.
  setTimeout(() => {
    drainUsageOutbox().catch(logFailure)
  }, 15_000)

  const interval = setInterval(() => {
    drainUsageOutbox().catch(logFailure)
  }, INTERVAL_MS)

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- background job; failure must surface somewhere
  console.error('[usage-drain] Run failed:', err)
}

export async function drainUsageOutbox(): Promise<void> {
  const provider = usePaymentProvider()
  if (!provider) return

  const db = useDatabaseProvider()
  const rows = await db.listPendingUsageEvents(BATCH_SIZE)
  if (rows.length === 0) return

  // Load active accounts once per unique workspace to avoid N×M queries.
  const workspaceIds = [...new Set(rows.map(r => r.workspace_id as string))]
  const accountMap = new Map<string, string>()
  for (const workspaceId of workspaceIds) {
    const account = await db.getActivePaymentAccount(workspaceId)
    const customerId = account?.customer_id as string | undefined
    if (customerId) accountMap.set(workspaceId, customerId)
  }

  for (const row of rows) {
    const id = row.id as string
    const workspaceId = row.workspace_id as string
    const attemptCount = (row.attempt_count as number | undefined) ?? 0

    if (attemptCount >= MAX_ATTEMPTS) {
      // Retire it. Recording this as a failed *attempt* would leave
      // `ingested_at` null, so the row would come back every tick — and
      // because the queue is ordered oldest-first, a handful of such rows
      // permanently occupy the head of every batch and starve deliverable
      // events until metering stops entirely.
      await db.markUsageEventDropped(id, `Dropped after ${MAX_ATTEMPTS} attempts`)
      // eslint-disable-next-line no-console -- a dropped meter event is unbilled revenue; it must be visible
      console.error(`[usage-drain] Dropped usage event ${id} (${row.meter_name}) after ${MAX_ATTEMPTS} attempts:`, row.last_error)
      continue
    }

    const customerId = accountMap.get(workspaceId)
    if (!customerId) {
      // Workspace has no active payment account yet — the checkout webhook
      // may still be in flight. Keep the row pending so it lands once the
      // subscription exists; MAX_ATTEMPTS bounds how long we wait.
      await db.markUsageEventIngested(id, 'No active payment account')
      continue
    }

    try {
      await provider.ingestUsageEvent({
        workspaceId,
        customerId,
        meterName: row.meter_name as string,
        value: Number(row.value),
        idempotencyKey: row.idempotency_key as string,
        occurredAt: row.occurred_at as string,
        metadata: (row.metadata as Record<string, string> | undefined) ?? undefined,
      })
      await db.markUsageEventIngested(id, null)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await db.markUsageEventIngested(id, message)
    }
  }
}
