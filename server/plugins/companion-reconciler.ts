/**
 * Companion usage subscription reconciler — Nitro plugin.
 *
 * Every 6 hours, opens the monthly usage subscription for every active yearly plan that lacks one: a webhook
 * that failed to open it, or a subscription that predates the flag (`reconcileCompanionSubscriptions`). Does
 * nothing unless the provider has companions configured (its `ensureCompanionSubscription` returns null).
 */
import { reconcileCompanionSubscriptions } from '../utils/companion-subscription'
import { useDatabaseProvider, usePaymentProvider } from '../utils/providers'

const INTERVAL_MS = 6 * 60 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  setTimeout(() => runReconcile().catch(logFailure), 120_000)
  const interval = setInterval(() => {
    runReconcile().catch(logFailure)
  }, INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(interval))
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- scheduled background job; failure must surface somewhere
  console.error('[companion] Scheduled reconcile failed:', err)
}

async function runReconcile(): Promise<void> {
  const payment = usePaymentProvider()
  if (!payment?.ensureCompanionSubscription) return
  const summary = await reconcileCompanionSubscriptions(payment, useDatabaseProvider(), 'polar')
  if (summary.checked > 0) {
    // eslint-disable-next-line no-console -- scheduled job summary
    console.info('[companion] reconcile', summary)
  }
}
