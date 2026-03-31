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
