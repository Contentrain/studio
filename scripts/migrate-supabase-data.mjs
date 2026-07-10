#!/usr/bin/env node
/**
 * Data migration: Supabase → plain Postgres (managed pair cutover).
 *
 * Copies auth.users (mapped onto the 000_auth_shim schema) and every
 * public.* table from a source database into a target that already carries
 * the migration lineage (scripts/migrate-postgres.mjs).
 *
 * Safety model:
 *   - DRY RUN by default — prints the plan + row counts; --yes executes.
 *   - Refuses a non-empty target (profiles > 0) unless --force.
 *   - The whole copy runs with session_replication_role=replica on the
 *     target: FK ordering doesn't matter and NO triggers fire (the
 *     handle_new_user bootstrap must not re-run — profiles/workspaces
 *     arrive from the source).
 *   - Values are read with identity type-parsers (raw Postgres text) and
 *     inserted as text parameters — jsonb/arrays/timestamps round-trip
 *     byte-for-byte, no JS (de)serialization traps.
 *   - Verification pass compares per-table row counts at the end.
 *
 * Deliberately NOT copied:
 *   - auth.refresh_tokens / auth.one_time_tokens (sessions start clean —
 *     no passwords exist, everyone re-logins via OAuth/magic link)
 *   - storage.* / realtime.* and other Supabase-internal schemas
 *
 * Cutover invariant: NUXT_SESSION_SECRET must stay identical across the
 * move — it keys the AES-GCM encryption on oauth_provider_tokens.
 *
 * Usage:
 *   node scripts/migrate-supabase-data.mjs \
 *     --source postgres://postgres:...@db.<ref>.supabase.co:5432/postgres \
 *     --target postgres://postgres:...@<railway-host>:<port>/railway \
 *     [--yes] [--force]
 */
/* eslint-disable no-console */

import process from 'node:process'
import pg from 'pg'

const BATCH_SIZE = 500

/** Identity parsers: every value arrives as raw Postgres text. */
const rawTypes = {
  getTypeParser: () => value => value,
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 ? process.argv[index + 1] : undefined
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

async function connect(url, label) {
  const client = new pg.Client({ connectionString: url, types: rawTypes })
  try {
    await client.connect()
  }
  catch (error) {
    console.error(`✗ ${label} connection failed: ${error.message}`)
    process.exit(1)
  }
  return client
}

async function scalar(client, sql, params = []) {
  const { rows } = await client.query(sql, params)
  return rows[0] ? Object.values(rows[0])[0] : null
}

async function columnsOf(client, schema, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, table],
  )
  return rows.map(r => r.column_name)
}

async function publicTables(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  )
  return rows.map(r => r.table_name)
}

/** Copy rows of one fully-qualified table using the shared column set. */
async function copyTable(source, target, schema, table, selectSql, columns) {
  const quotedCols = columns.map(c => `"${c}"`).join(', ')
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
  const insertSql = `INSERT INTO ${schema}."${table}" (${quotedCols}) VALUES (${placeholders})`

  let copied = 0
  let offset = 0
  for (;;) {
    const { rows } = await source.query(`${selectSql} LIMIT ${BATCH_SIZE} OFFSET ${offset}`)
    if (rows.length === 0) break

    for (const row of rows)
      await target.query(insertSql, columns.map(c => row[c]))

    copied += rows.length
    offset += rows.length
  }
  return copied
}

async function main() {
  const sourceUrl = arg('source')
  const targetUrl = arg('target')
  if (!sourceUrl || !targetUrl) {
    console.error('✗ --source and --target connection strings are required')
    process.exit(1)
  }

  const execute = flag('yes')
  const force = flag('force')

  const source = await connect(sourceUrl, 'source')
  const target = await connect(targetUrl, 'target')

  try {
    // ─── Preflight ───
    const lineage = await scalar(target, `SELECT count(*) FROM public.schema_migrations`).catch(() => null)
    if (lineage === null) {
      console.error('✗ target has no schema_migrations — run scripts/migrate-postgres.mjs first')
      process.exit(1)
    }
    console.log(`target lineage : ${lineage} migrations applied`)

    const targetProfiles = Number(await scalar(target, 'SELECT count(*) FROM public.profiles'))
    if (targetProfiles > 0 && !force) {
      console.error(`✗ target is not empty (${targetProfiles} profiles) — pass --force to append anyway`)
      process.exit(1)
    }

    // Source auth flavor: GoTrue (Supabase) vs 000_auth_shim (plain PG).
    const sourceAuthCols = await columnsOf(source, 'auth', 'users')
    const isGoTrue = sourceAuthCols.includes('raw_app_meta_data')
    console.log(`source auth    : ${isGoTrue ? 'Supabase GoTrue' : 'auth shim'} (${sourceAuthCols.length} columns)`)

    // auth.users mapping onto the shim schema. GoTrue: provider/account come
    // from auth.identities (prefer the non-email identity); shim: passthrough.
    const authSelect = isGoTrue
      ? `SELECT u.id, u.email, u.raw_user_meta_data,
                i.provider, i.provider_id AS provider_account_id,
                u.email_confirmed_at AS email_verified_at,
                u.last_sign_in_at, u.created_at, u.updated_at
         FROM auth.users u
         LEFT JOIN LATERAL (
           SELECT provider, provider_id FROM auth.identities
           WHERE user_id = u.id
           ORDER BY (provider = 'email') ASC
           LIMIT 1
         ) i ON true
         ORDER BY u.created_at`
      : `SELECT id, email, raw_user_meta_data, provider, provider_account_id,
                email_verified_at, last_sign_in_at, created_at, updated_at
         FROM auth.users ORDER BY created_at`
    const authColumns = ['id', 'email', 'raw_user_meta_data', 'provider', 'provider_account_id', 'email_verified_at', 'last_sign_in_at', 'created_at', 'updated_at']

    // Public tables: the intersection present on BOTH sides (the target
    // lineage is the contract; Supabase-only leftovers are skipped loudly).
    const sourceTables = await publicTables(source)
    const targetTables = new Set(await publicTables(target))
    const skipped = sourceTables.filter(t => !targetTables.has(t) || t === 'schema_migrations')
    const tables = sourceTables.filter(t => targetTables.has(t) && t !== 'schema_migrations')

    const authCount = Number(await scalar(source, 'SELECT count(*) FROM auth.users'))
    console.log(`\nplan           : auth.users (${authCount} rows) + ${tables.length} public tables`)
    if (skipped.length) console.log(`skipped        : ${skipped.join(', ')}`)

    for (const table of tables) {
      const count = await scalar(source, `SELECT count(*) FROM public."${table}"`)
      console.log(`  public.${table.padEnd(28)} ${count} rows`)
    }

    if (!execute) {
      console.log('\nDRY RUN — re-run with --yes to execute.')
      return
    }

    // ─── Copy ───
    console.log('\ncopying…')
    // replica mode: no FK checks, no triggers (bootstrap must not re-fire).
    await target.query(`SET session_replication_role = replica`)

    const copiedAuth = await copyTable(source, target, 'auth', 'users', authSelect, authColumns)
    console.log(`✓ auth.users ${copiedAuth}`)

    for (const table of tables) {
      const sourceCols = await columnsOf(source, 'public', table)
      const targetCols = new Set(await columnsOf(target, 'public', table))
      const shared = sourceCols.filter(c => targetCols.has(c))
      const copied = await copyTable(
        source,
        target,
        'public',
        table,
        `SELECT ${shared.map(c => `"${c}"`).join(', ')} FROM public."${table}"`,
        shared,
      )
      console.log(`✓ public.${table} ${copied}`)
    }

    await target.query(`SET session_replication_role = DEFAULT`)

    // ─── Verify ───
    console.log('\nverifying…')
    let mismatches = 0
    const checks = [['auth', 'users'], ...tables.map(t => ['public', t])]
    for (const [schema, table] of checks) {
      const expected = Number(await scalar(source, `SELECT count(*) FROM ${schema}."${table}"`))
      const actual = Number(await scalar(target, `SELECT count(*) FROM ${schema}."${table}"`))
      if (expected !== actual) {
        mismatches += 1
        console.error(`✗ ${schema}.${table}: source=${expected} target=${actual}`)
      }
    }

    if (mismatches > 0) {
      console.error(`\n${mismatches} table(s) mismatched — inspect before flipping env.`)
      process.exitCode = 1
      return
    }

    console.log('\nAll row counts match. Reminders:')
    console.log('  - keep NUXT_SESSION_SECRET identical (oauth_provider_tokens AES key)')
    console.log('  - sessions were not copied: every user re-logins')
    console.log('  - point NUXT_POSTGRES_URL at the target and flip the provider pair')
  }
  finally {
    await source.end()
    await target.end()
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})
