#!/usr/bin/env node
/**
 * Smoke-verifies a plain-Postgres database migrated by migrate-postgres.mjs.
 *
 * Proves the single migration lineage stands up Supabase-free:
 *   1. Supabase-standard roles + auth shim + representative public tables
 *   2. RPCs are callable (cleanup_audit_logs)
 *   3. The signup bootstrap chain fires on a bare INSERT INTO auth.users
 *      (handle_new_user → profile + primary workspace; handle_new_workspace
 *      → owner membership)
 *   4. RLS isolates rows under SET ROLE authenticated + request.jwt.claim.sub
 *      — the same GUC contract tests/rls/helpers.ts exercises on Supabase.
 *
 * Usage: node scripts/verify-managed-schema.mjs [--url postgres://…]
 * Connection resolution: --url > NUXT_POSTGRES_URL > DATABASE_URL.
 */
/* eslint-disable no-console */

import process from 'node:process'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

function resolveConnectionString() {
  const flagIndex = process.argv.indexOf('--url')
  if (flagIndex !== -1 && process.argv[flagIndex + 1])
    return process.argv[flagIndex + 1]

  return process.env.NUXT_POSTGRES_URL || process.env.DATABASE_URL || ''
}

function assert(condition, label) {
  if (!condition)
    throw new Error(`FAILED: ${label}`)

  console.log(`✓ ${label}`)
}

async function main() {
  const connectionString = resolveConnectionString()
  if (!connectionString) {
    console.error('✗ No connection string. Pass --url or set NUXT_POSTGRES_URL / DATABASE_URL.')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString })
  await client.connect()

  try {
    // ─── 1. Roles + schema surface ───
    const { rows: roles } = await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`,
    )
    assert(roles.length === 3, 'Supabase-standard roles exist (anon, authenticated, service_role)')

    const expectedTables = [
      'auth.users',
      'auth.refresh_tokens',
      'auth.one_time_tokens',
      'auth.oauth_clients',
      'auth.oauth_grants',
      'auth.oauth_authorization_codes',
      'auth.oauth_access_tokens',
      'auth.oauth_refresh_tokens',
      'public.profiles',
      'public.workspaces',
      'public.workspace_members',
      'public.projects',
      'public.payment_accounts',
      'public.usage_events_outbox',
      'public.audit_logs',
      'public.oauth_provider_tokens',
    ]
    for (const table of expectedTables) {
      const { rows } = await client.query('SELECT to_regclass($1) AS reg', [table])
      assert(rows[0].reg !== null, `table ${table} exists`)
    }

    // ─── 2. RPCs are callable ───
    const { rows: cleanup } = await client.query('SELECT public.cleanup_audit_logs(90) AS purged')
    assert(Number.isInteger(cleanup[0].purged), 'cleanup_audit_logs(90) returns an integer')

    // ─── 3. Signup bootstrap chain ───
    const email = `smoke-${Date.now()}@lineage-verify.test`
    const meta = { full_name: 'Lineage Smoke', user_name: 'lineage-smoke', avatar_url: 'https://example.com/a.png' }
    const { rows: inserted } = await client.query(
      'INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, $2) RETURNING id',
      [email, JSON.stringify(meta)],
    )
    const userId = inserted[0].id

    const { rows: profiles } = await client.query('SELECT display_name, email FROM public.profiles WHERE id = $1', [userId])
    assert(profiles.length === 1, 'handle_new_user created the profile row')
    assert(profiles[0].display_name === 'Lineage Smoke', 'profile display_name derives from raw_user_meta_data')

    const { rows: workspaces } = await client.query(
      `SELECT id FROM public.workspaces WHERE owner_id = $1 AND type = 'primary'`,
      [userId],
    )
    assert(workspaces.length === 1, 'handle_new_user created the primary workspace')
    const workspaceId = workspaces[0].id

    const { rows: members } = await client.query(
      `SELECT role FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    )
    assert(members.length === 1 && members[0].role === 'owner', 'handle_new_workspace added the owner membership')

    // ─── 4. RLS behind SET ROLE authenticated ───
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE authenticated')
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])

    const { rows: uid } = await client.query('SELECT auth.uid() AS uid')
    assert(uid[0].uid === userId, 'auth.uid() resolves request.jwt.claim.sub')

    const { rows: own } = await client.query('SELECT count(*)::int AS count FROM public.workspaces WHERE id = $1', [workspaceId])
    assert(own[0].count === 1, 'RLS: owner sees their own workspace')
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE authenticated')
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [randomUUID()])

    const { rows: foreign } = await client.query('SELECT count(*)::int AS count FROM public.workspaces WHERE id = $1', [workspaceId])
    assert(foreign[0].count === 0, 'RLS: a foreign subject sees nothing')
    await client.query('ROLLBACK')

    // ─── Cleanup (service path: connected role, RLS not in play) ───
    await client.query('DELETE FROM auth.users WHERE id = $1', [userId])
    const { rows: gone } = await client.query('SELECT count(*)::int AS count FROM public.profiles WHERE id = $1', [userId])
    assert(gone[0].count === 0, 'auth.users delete cascades to the profile')

    console.log('\nAll managed-schema checks passed.')
  }
  catch (error) {
    console.error(`\n✗ ${error.message}`)
    process.exitCode = 1
  }
  finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})
