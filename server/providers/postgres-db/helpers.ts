/**
 * Shared helpers for the plain-Postgres DatabaseProvider implementation.
 *
 * Mirrors the Supabase implementation's trust model exactly:
 *   - getAdmin()  = service path — RLS bypassed via the connected role
 *     (BYPASSRLS through service_role membership), like the service-role
 *     PostgREST client.
 *   - withUser()  = RLS-enforced path — SET LOCAL ROLE authenticated plus the
 *     request.jwt.claim.sub GUC inside one transaction, the exact contract
 *     auth.uid() (postgres/migrations/000_auth_shim.sql) and
 *     tests/rls/helpers.ts speak.
 *
 * Access tokens on the postgres pair are managed-auth JWTs (HS256). They are
 * verified here — not merely decoded — so a forged token can never select an
 * RLS subject.
 */
import { jwtVerify } from 'jose'
import { sql } from 'kysely'
import type { Kysely, Transaction } from 'kysely'
import type { StudioDatabase } from './types'
import { getDb, getPostgresConfig } from './client'

const encoder = new TextEncoder()

/** Service path — parity with supabase-db's getAdmin(). */
export function getAdmin(): Kysely<StudioDatabase> {
  return getDb()
}

/** Verify a managed-auth access token and return its subject (user id). */
export async function subjectFromToken(accessToken: string): Promise<string> {
  const { authJwtSecret } = getPostgresConfig()
  try {
    const { payload } = await jwtVerify(accessToken, encoder.encode(authJwtSecret))
    if (typeof payload.sub !== 'string' || payload.sub.length === 0)
      throw new Error('missing sub claim')
    return payload.sub
  }
  catch {
    throw createError({ statusCode: 401, message: 'Invalid access token' })
  }
}

/**
 * Run `fn` inside a transaction scoped to the token's subject: RLS enforced
 * under the authenticated role, auth.uid() resolving to the subject.
 */
export async function withUser<T>(
  accessToken: string,
  fn: (trx: Transaction<StudioDatabase>) => Promise<T>,
): Promise<T> {
  const subject = await subjectFromToken(accessToken)

  return getDb().transaction().execute(async (trx) => {
    await sql`SET LOCAL ROLE authenticated`.execute(trx)
    await sql`SELECT set_config('request.jwt.claim.sub', ${subject}, true)`.execute(trx)
    await sql`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`.execute(trx)
    return fn(trx)
  })
}

/**
 * Normalize thrown values at the module boundary: h3 errors (statusCode
 * already set — e.g. the 401 from subjectFromToken or an explicit 403/500)
 * pass through; raw driver/SQL errors become 500s, matching how the
 * Supabase implementation wraps PostgREST failures.
 */
export function throwDbError(error: unknown): never {
  if (error && typeof error === 'object' && 'statusCode' in error)
    throw error

  const message = error instanceof Error ? error.message : 'Database operation failed'
  throw createError({ statusCode: 500, message })
}
