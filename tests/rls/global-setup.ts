/**
 * RLS-suite global setup — plain-PG leg only.
 *
 * When RLS_DB_URL is set (throwaway postgres:16, or CI's postgres service)
 * the target is a bare database: bring it to the migration lineage head
 * first. Idempotent — re-runs skip already-applied files via
 * public.schema_migrations.
 *
 * Without RLS_DB_URL the suite targets Supabase local (54322), which the
 * Supabase CLI migrates through its own runner — applying our lineage on
 * top would double-apply 001_baseline, so it is deliberately skipped.
 */
import { execFileSync } from 'node:child_process'

export default function globalSetup() {
  const url = process.env.RLS_DB_URL
  if (!url) return

  execFileSync('node', ['scripts/migrate-postgres.mjs', '--url', url], {
    stdio: 'inherit',
  })
}
