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
const MAX_ATTEMPTS = 8

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

async function drainUsageOutbox(): Promise<void> {
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
      await db.markUsageEventIngested(id, `Dropped after ${MAX_ATTEMPTS} attempts`)
      continue
    }

    const customerId = accountMap.get(workspaceId)
    if (!customerId) {
      // Workspace has no active payment account — skip silently.
      // The row stays pending and will be retried if/when the workspace
      // subscribes. Very old rows are eventually dropped via MAX_ATTEMPTS.
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
