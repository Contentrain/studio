/**
 * Migration media worker — Nitro plugin (migration 037).
 *
 * Every few seconds, work through claimable import jobs: each tick claims one
 * job under a lease (SKIP LOCKED, so several instances never take the same
 * one), imports a batch of its files and ends the claim. Within one round it
 * keeps going while there is work, up to a time budget, so a large import is
 * not paced by the interval alone. A round never overlaps the previous one on
 * this instance; a crashed round's lease expires and another tick resumes.
 */

import { runMigrationMediaTick } from '../utils/migration-media-import'

const TICK_MS = 10_000
const ROUND_BUDGET_MS = 50_000

export default defineNitroPlugin((nitroApp) => {
  let busy = false
  const interval = setInterval(() => {
    if (busy) return
    busy = true
    runMigrationMediaRound()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[migration-media-worker] round failed', err)
      })
      .finally(() => {
        busy = false
      })
  }, TICK_MS)

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})

export async function runMigrationMediaRound(budgetMs = ROUND_BUDGET_MS): Promise<number> {
  const started = Date.now()
  let ticks = 0
  while (Date.now() - started < budgetMs) {
    const result = await runMigrationMediaTick()
    if (!result.claimed) break
    ticks++
  }
  return ticks
}
