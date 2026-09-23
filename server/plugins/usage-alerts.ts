/**
 * Usage alert scheduler — Nitro plugin. The logic lives in
 * `server/utils/usage-alerts.ts`; this only runs it every hour.
 *
 * Hourly, not six-hourly like the trial reminders: a limit that stops a
 * customer's site forms is worth hearing about the same hour. Each run is
 * one pass over subscribed workspaces and sends nothing it already sent
 * (`usage_alerts` claim). No-ops without an email provider (self-hosted
 * deployments without Resend) and without billing (nothing is metered).
 */
import { isBillingConfigured } from '../utils/license'
import { useAuthProvider, useDatabaseProvider, useEmailProvider } from '../utils/providers'
import { runUsageAlerts } from '../utils/usage-alerts'

const INTERVAL_MS = 60 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  setTimeout(() => run().catch(logFailure), 60_000)
  const interval = setInterval(() => run().catch(logFailure), INTERVAL_MS)
  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- scheduled background job; failure must surface somewhere
  console.error('[usage-alerts] Scheduled run failed:', err)
}

async function run(): Promise<void> {
  if (!isBillingConfigured()) return
  const email = useEmailProvider()
  if (!email) return
  const auth = useAuthProvider()
  const config = useRuntimeConfig()
  await runUsageAlerts({
    db: useDatabaseProvider(),
    sendEmail: message => email.sendEmail(message),
    ownerEmail: async ownerId => (await auth.getUserById(ownerId).catch(() => null))?.email ?? null,
    siteUrl: (config.public as { siteUrl?: string } | null)?.siteUrl ?? '',
  })
}
