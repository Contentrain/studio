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
import type { DatabaseRow } from '../database'
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

/** Postgres unique-violation → the Supabase impl's 409 contract. */
export function throwOnUniqueViolation(error: unknown, message: string): void {
  if (error && typeof error === 'object' && (error as { code?: string }).code === '23505')
    throw createError({ statusCode: 409, message })
}

/**
 * Subset a full row to a PostgREST-style flat `fields` list ('*' = all).
 * The dynamic-`fields` DatabaseProvider methods (getWorkspaceById,
 * getProjectForWorkspace, …) only ever receive flat comma-separated column
 * lists (verified across call sites), so the postgres port selects the full
 * row and projects it here instead of interpolating identifiers into SQL.
 */
export function pickColumns(row: DatabaseRow, fields: string): DatabaseRow {
  const spec = fields.trim()
  if (spec === '' || spec === '*') return row

  const picked: DatabaseRow = {}
  for (const field of spec.split(',')) {
    const key = field.trim()
    if (key in row) picked[key] = row[key]
  }
  return picked
}

/**
 * Verify the caller has one of the required workspace roles — the same
 * app-layer guard the Supabase impl's requireRole performs: an RLS-scoped
 * read of the caller's own membership row, then a 403 on mismatch.
 */
export async function requireRole(
  accessToken: string,
  userId: string,
  workspaceId: string,
  requiredRoles: string[],
): Promise<string> {
  let role: string | undefined
  try {
    role = await withUser(accessToken, async (trx) => {
      const row = await trx
        .selectFrom('workspace_members')
        .select('role')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', userId)
        .executeTakeFirst()
      return row?.role
    })
  }
  catch (error) {
    throwDbError(error)
  }

  if (!role || !requiredRoles.includes(role)) {
    throw createError({
      statusCode: 403,
      message: errorMessage('members.requires_role', { roles: requiredRoles.join(' or ') }),
    })
  }

  return role
}

/** Columns from payment_accounts returned to clients (no server-only fields). */
const PAYMENT_ACCOUNT_PUBLIC_COLUMNS = [
  'provider',
  'customer_id',
  'subscription_id',
  'subscription_status',
  'current_period_end',
  'trial_ends_at',
  'cancel_at_period_end',
  'grace_period_ends_at',
  'plan',
] as const

/**
 * Attach the active `payment_account` field to each workspace row.
 * Batch-fetches all active accounts in a single query.
 */
export async function attachActivePaymentAccounts(
  workspaces: Record<string, unknown>[],
): Promise<DatabaseRow[]> {
  if (workspaces.length === 0) return []
  const ids = workspaces
    .map(w => w.id as string | undefined)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0)
    return workspaces.map(w => ({ ...w, payment_account: null })) as DatabaseRow[]

  let rows
  try {
    rows = await getAdmin()
      .selectFrom('payment_accounts')
      .select(['workspace_id', ...PAYMENT_ACCOUNT_PUBLIC_COLUMNS])
      .where('workspace_id', 'in', ids)
      .where('is_active', '=', true)
      .execute()
  }
  catch (error) {
    throw createError({
      statusCode: 500,
      message: `Failed to load payment accounts: ${error instanceof Error ? error.message : 'unknown'}`,
    })
  }

  const map = new Map<string, DatabaseRow>()
  for (const row of rows) {
    const { workspace_id: wsId, ...rest } = row
    map.set(wsId, rest as DatabaseRow)
  }
  return workspaces.map(w => ({
    ...w,
    payment_account: map.get(w.id as string) ?? null,
  })) as DatabaseRow[]
}

/** Attach the active payment account to a single workspace row. */
export async function attachActivePaymentAccount(
  workspace: DatabaseRow | null,
): Promise<DatabaseRow | null> {
  if (!workspace) return null
  const [attached] = await attachActivePaymentAccounts([workspace])
  return attached ?? null
}
