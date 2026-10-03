/**
 * Migrate bundle reconciler — Nitro plugin.
 *
 * Every 6 hours, retries the move of bundle subscriptions to the yearly list
 * product that the billing webhook could not complete, and raises the alarm
 * for those within 30 days of renewal (`reconcileMigrateBundles`). Does nothing
 * when the deployment has no payment provider or no bundle grants.
 */
import { reconcileMigrateBundles } from '../utils/migrate-bundle-subscription'
import { useDatabaseProvider, usePaymentProvider } from '../utils/providers'

const INTERVAL_MS = 6 * 60 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  setTimeout(() => runReconcile().catch(logFailure), 60_000)
  const interval = setInterval(() => {
    runReconcile().catch(logFailure)
  }, INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(interval))
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- scheduled background job; failure must surface somewhere
  console.error('[migrate-bundle] Scheduled reconcile failed:', err)
}

async function runReconcile(): Promise<void> {
  const payment = usePaymentProvider()
  if (!payment) return
  // Cheap guard first: no bundle grant waiting, no provider call.
  if ((await useDatabaseProvider().listPendingMigrateBundles(1)).length === 0) return
  const summary = await reconcileMigrateBundles(payment)
  // eslint-disable-next-line no-console -- scheduled job summary
  console.info('[migrate-bundle] reconcile', summary)
}
