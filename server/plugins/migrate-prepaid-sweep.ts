/**
 * Prepaid Studio year sweep — Nitro plugin.
 *
 * Every 6 hours: the T-30 / T-7 mails before a prepaid Studio year ends, and the end itself
 * (`runPrepaidSweep`). Mails are skipped silently when no email provider is configured; the end
 * of a year still runs.
 */
import { runPrepaidSweep } from '../utils/migrate-prepaid-sweep'
import { useAuthProvider, useDatabaseProvider, useEmailProvider } from '../utils/providers'

const INTERVAL_MS = 6 * 60 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  setTimeout(() => runSweep().catch(logFailure), 90_000)
  const interval = setInterval(() => {
    runSweep().catch(logFailure)
  }, INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(interval))
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- scheduled background job; failure must surface somewhere
  console.error('[prepaid-sweep] Scheduled run failed:', err)
}

async function runSweep(): Promise<void> {
  const auth = useAuthProvider()
  const siteUrl = (useRuntimeConfig().public as { siteUrl?: string } | null)?.siteUrl ?? ''
  const summary = await runPrepaidSweep({
    db: useDatabaseProvider(),
    email: useEmailProvider(),
    ownerEmail: async ownerId => (await auth.getUserById(ownerId).catch(() => null))?.email ?? null,
    siteUrl,
  })
  if (summary.reminded + summary.ended + summary.renewed > 0) {
    // eslint-disable-next-line no-console -- scheduled job summary
    console.info('[prepaid-sweep]', summary)
  }
}
