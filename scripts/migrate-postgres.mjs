#!/usr/bin/env node
/**
 * Plain-Postgres migration runner — managed (Supabase-free) deployments.
 *
 * Applies postgres/migrations/*.sql (the auth shim) followed by
 * supabase/migrations/*.sql as ONE ordered lineage, sorted by basename
 * (000_… < 001_… < …). Supabase deployments keep using the Supabase CLI,
 * which only ever sees supabase/migrations/ — same migration files, two
 * runners, one lineage.
 *
 * Usage:
 *   node scripts/migrate-postgres.mjs [--url postgres://…]
 *
 * Connection resolution: --url > NUXT_POSTGRES_URL > DATABASE_URL.
 * Notes:
 *   - Each file runs in its own transaction and is recorded in
 *     public.schema_migrations; re-runs are no-ops.
 *   - A Postgres advisory lock serialises concurrent runners (e.g. two
 *     deploy replicas racing at boot).
 *   - The connected role must be able to CREATE ROLE / CREATE EXTENSION
 *     (superuser on CI; see the deployment runbook for production).
 */
/* eslint-disable no-console */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIGRATION_DIRS = ['postgres/migrations', 'supabase/migrations']
// Arbitrary constant key identifying "Contentrain Studio migrations" for
// pg_advisory_lock — any concurrent runner waits here instead of racing.
const ADVISORY_LOCK_KEY = 764213009

function resolveConnectionString() {
  const flagIndex = process.argv.indexOf('--url')
  if (flagIndex !== -1 && process.argv[flagIndex + 1])
    return process.argv[flagIndex + 1]

  return process.env.NUXT_POSTGRES_URL || process.env.DATABASE_URL || ''
}

async function collectMigrations() {
  const files = []

  for (const dir of MIGRATION_DIRS) {
    let names
    try {
      names = await readdir(join(ROOT, dir))
    }
    catch {
      continue // a missing directory is fine (e.g. no postgres/ overrides yet)
    }
    for (const name of names) {
      if (name.endsWith('.sql'))
        files.push({ version: name, path: join(ROOT, dir, name) })
    }
  }

  files.sort((a, b) => a.version.localeCompare(b.version, 'en'))

  const seen = new Set()
  for (const file of files) {
    if (seen.has(file.version))
      throw new Error(`Duplicate migration version across directories: ${file.version}`)
    seen.add(file.version)
  }

  return files
}

async function main() {
  const connectionString = resolveConnectionString()
  if (!connectionString) {
    console.error('✗ No connection string. Pass --url or set NUXT_POSTGRES_URL / DATABASE_URL.')
    process.exit(1)
  }

  const migrations = await collectMigrations()
  if (migrations.length === 0) {
    console.error('✗ No .sql migrations found — is the working directory the repo root?')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString })
  await client.connect()

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const { rows } = await client.query('SELECT version FROM public.schema_migrations')
    const applied = new Set(rows.map(row => row.version))

    let appliedCount = 0
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        console.log(`· ${migration.version} (already applied)`)
        continue
      }

      const sql = await readFile(migration.path, 'utf-8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [migration.version])
        await client.query('COMMIT')
        appliedCount += 1
        console.log(`✓ ${migration.version}`)
      }
      catch (error) {
        await client.query('ROLLBACK')
        console.error(`✗ ${migration.version}: ${error.message}`)
        process.exitCode = 1
        return
      }
      finally {
        // 001_baseline.sql (pg_dump output) sets session-level GUCs such as
        // search_path='' — reset between files so later hand-written
        // migrations run against default settings, exactly as they do under
        // the Supabase CLI (which uses a fresh session per migration).
        await client.query('RESET ALL')
      }
    }

    console.log(`Done — ${appliedCount} applied, ${migrations.length - appliedCount} skipped.`)
  }
  finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
    }
    catch {
      // connection-level failure — the lock dies with the session anyway
    }
    await client.end()
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})
