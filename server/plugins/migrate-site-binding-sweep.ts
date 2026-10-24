/**
 * Migrate site-binding sweep — Nitro plugin, the same pattern as `migrate-bundle-reconciler.ts`.
 *
 * Every 15 minutes, binds the "Migrate with Studio" sites that are connected to a project but whose studio.json was
 * never written, retries the failed ones when their backoff is due, and raises the ops alarm once per grant after
 * three failed attempts or on a conflict (`sweepMigrateSiteBindings`). Before that, moves on every connected bundle
 * site whose media is not settled: starts or retries the import, resumes one paused for storage, applies a done grant
 * job, records where it stands (`sweepMigrateGrantMedia`, 053). Does nothing when no grant needs either.
 */
import { GRANT_MEDIA_MAX_ATTEMPTS, sweepMigrateGrantMedia } from '../utils/migrate-grant-media'
import { SITE_BINDING_MAX_ATTEMPTS } from '../utils/migrate-site-binding'
import { sweepMigrateSiteBindings } from '../utils/migrate-site-binding-run'
import { useDatabaseProvider, useMediaProvider } from '../utils/providers'

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
  // Media first: a grant it records is then skipped by a binding pass over the same grant (`media_state` is set), so
  // nothing is started or applied twice in one pass. Cheap guards first: nothing waiting, no GitHub call.
  if ((await db.listMigrateGrantMediaWork(1, GRANT_MEDIA_MAX_ATTEMPTS)).length > 0) {
    const media = await sweepMigrateGrantMedia({ db, mediaStack: !!useMediaProvider() })
    if (media.acted || media.failed) {
      // eslint-disable-next-line no-console -- scheduled job summary
      console.info('[migrate-grant-media] sweep', media)
    }
  }
  if ((await db.listMigrateSiteBindingWork(1, SITE_BINDING_MAX_ATTEMPTS)).length === 0) return
  const summary = await sweepMigrateSiteBindings({ db })
  if (summary.bound || summary.failed || summary.alarms) {
    // eslint-disable-next-line no-console -- scheduled job summary
    console.info('[migrate-site-binding] sweep', summary)
  }
}
