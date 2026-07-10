/**
 * Contract-suite global setup: bring the target database to the current
 * migration lineage head before any spec runs. Idempotent — re-runs skip
 * already-applied files via schema_migrations.
 */
import { execFileSync } from 'node:child_process'
import { contractPgUrl } from './env'

export default function globalSetup() {
  execFileSync('node', ['scripts/migrate-postgres.mjs', '--url', contractPgUrl()], {
    stdio: 'inherit',
  })
}
