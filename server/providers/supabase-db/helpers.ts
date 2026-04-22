/**
 * Shared helpers for the Supabase DatabaseProvider implementation.
 *
 * Exports client getters, row validators, and cross-domain helpers
 * (requireRole, getWorkspaceById) used by multiple domain modules.
 */
import type { DatabaseRow } from '../database'
import { createSupabaseAdminClient, createSupabaseUserClient } from '../supabase-client'

// ─── Client getters ───

export function getAdmin() {
  return createSupabaseAdminClient()
}

export function getUser(accessToken: string) {
  return createSupabaseUserClient(accessToken)
}

// ─── Row validators ───

export function isDatabaseRow(value: unknown): value is DatabaseRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toDatabaseRow(value: unknown): DatabaseRow {
  if (!isDatabaseRow(value)) {
    throw createError({ statusCode: 500, message: 'Invalid database response' })
  }
  return value
}

export function toDatabaseRowOrNull(value: unknown): DatabaseRow | null {
  if (value == null) return null
  return toDatabaseRow(value)
}

// ─── Shared constants ───

export const WORKSPACE_MEMBER_SELECT = `
  id, role, user_id, invited_email, invited_at, accepted_at,
  profiles:user_id(id, display_name, email, avatar_url)
`

export const PROJECT_MEMBER_SELECT = `
  id, role, user_id, specific_models, allowed_models, invited_email, invited_at, accepted_at,
  profiles:user_id(id, display_name, email, avatar_url)
`

// ─── Cross-domain helpers ───

/**
 * Verify the caller has one of the required workspace roles.
 * Throws 403 if not authorized. Returns the user's role string.
 */
export async function requireRole(
  accessToken: string,
  userId: string,
  workspaceId: string,
  requiredRoles: string[],
): Promise<string> {
  const client = getUser(accessToken)
  const { data, error } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single()

  if (error && error.code !== 'PGRST116') {
    throw createError({ statusCode: 500, message: error.message })
  }

  if (!data || !requiredRoles.includes(data.role)) {
    throw createError({ statusCode: 403, message: errorMessage('members.requires_role', { roles: requiredRoles.join(' or ') }) })
  }

  return data.role
}

/**
 * Get a single workspace by ID via admin client (bypasses RLS).
 */
export async function fetchWorkspaceById(
  workspaceId: string,
  fields: string = '*',
): Promise<DatabaseRow | null> {
  const admin = getAdmin()
  const { data, error } = await admin
    .from('workspaces')
    .select(fields)
    .eq('id', workspaceId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw createError({ statusCode: 500, message: error.message })
  }

  return toDatabaseRowOrNull(data)
}

/** Columns from payment_accounts returned to clients (no server-only fields). */
const PAYMENT_ACCOUNT_PUBLIC_SELECT
  = 'provider, customer_id, subscription_id, subscription_status, current_period_end, trial_ends_at, cancel_at_period_end, grace_period_ends_at, plan'

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
  if (ids.length === 0) {
    return workspaces.map(w => ({ ...w, payment_account: null })) as DatabaseRow[]
  }

  const { data, error } = await getAdmin()
    .from('payment_accounts')
    .select(`workspace_id, ${PAYMENT_ACCOUNT_PUBLIC_SELECT}`)
    .in('workspace_id', ids)
    .eq('is_active', true)

  if (error) {
    throw createError({ statusCode: 500, message: `Failed to load payment accounts: ${error.message}` })
  }

  const map = new Map<string, DatabaseRow>()
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const wsId = row.workspace_id as string
    const { workspace_id: _wsId, ...rest } = row
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
