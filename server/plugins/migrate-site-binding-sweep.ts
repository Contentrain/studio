/**
 * Migrate site-binding sweep — Nitro plugin, the same pattern as `migrate-bundle-reconciler.ts`.
 *
 * Every 15 minutes, binds the "Migrate with Studio" sites that are connected to a project but whose studio.json was
 * never written, retries the failed ones when their backoff is due, and raises the ops alarm once per grant after
 * three failed attempts or on a conflict (`sweepMigrateSiteBindings`). Does nothing when no grant needs it.
 */
import { SITE_BINDING_MAX_ATTEMPTS } from '../utils/migrate-site-binding'
import { sweepMigrateSiteBindings } from '../utils/migrate-site-binding-run'
import { useDatabaseProvider } from '../utils/providers'

const INTERVAL_MS = 15 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  setTimeout(() => runSweep().catch(logFailure), 90_000)
  const interval = setInterval(() => {
    runSweep().catch(logFailure)
  }, INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(interval))
})

function logFailure(err: unknown) {
  // eslint-disable-next-line no-console -- scheduled background job; failure must surface somewhere
  console.error('[migrate-site-binding] Scheduled sweep failed:', err)
}

async function runSweep(): Promise<void> {
  const db = useDatabaseProvider()
  // Cheap guard first: no grant waiting (capped and already-alarmed ones are not listed), no GitHub call.
  if ((await db.listMigrateSiteBindingWork(1, SITE_BINDING_MAX_ATTEMPTS)).length === 0) return
  const summary = await sweepMigrateSiteBindings({ db })
  if (summary.bound || summary.failed || summary.alarms) {
    // eslint-disable-next-line no-console -- scheduled job summary
    console.info('[migrate-site-binding] sweep', summary)
  }
}
