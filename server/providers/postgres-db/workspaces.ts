/**
 * Workspace CRUD methods for the plain-Postgres DatabaseProvider.
 *
 * Behavior parity with supabase-db/workspaces.ts, with one deliberate
 * upgrade: transferWorkspaceOwnership runs inside a single transaction
 * (the PostgREST implementation cannot span calls and documents the
 * split-brain risk this removes).
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { StudioDatabase } from './types'
import {
  attachActivePaymentAccount,
  attachActivePaymentAccounts,
  getAdmin,
  pickColumns,
  requireRole,
  throwDbError,
  throwOnUniqueViolation,
  withUser,
} from './helpers'
import { memberRowsForWorkspaces } from './members'

type WorkspaceMethods = Pick<
  DatabaseProvider,
  | 'listUserWorkspaces'
  | 'createWorkspace'
  | 'getWorkspaceForUser'
  | 'getWorkspaceDetailForUser'
  | 'getWorkspaceById'
  | 'updateWorkspace'
  | 'markWorkspaceTrialConsumed'
  | 'updateWorkspaceForUser'
  | 'getPrimaryWorkspace'
  | 'requireWorkspaceRole'
  | 'getWorkspaceMemberRole'
  | 'findWorkspaceByGithubInstallation'
  | 'updateWorkspaceGithubInstallation'
  | 'clearWorkspaceGithubInstallation'
  | 'updateWorkspaceInstallationStatus'
  | 'deleteWorkspace'
  | 'incrementWorkspaceStorageBytes'
  | 'reserveStorageIfAllowed'
  | 'transferWorkspaceOwnership'
  | 'listOwnedSecondaryWorkspacesWithMembers'
>

/** Full-row fetch + flat-fields projection (call sites only pass flat lists). */
async function fetchWorkspaceById(workspaceId: string, fields: string = '*'): Promise<DatabaseRow | null> {
  try {
    const row = await getAdmin()
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', workspaceId)
      .executeTakeFirst()

    return row ? pickColumns(row as DatabaseRow, fields) : null
  }
  catch (error) {
    throwDbError(error)
  }
}

export function workspaceMethods(): WorkspaceMethods {
  return {
    async listUserWorkspaces(accessToken, userId) {
      // Filter to the caller's OWN membership rows explicitly — same guard as
      // the Supabase impl: the wm_owner_manage RLS policy would also return
      // other members' rows of owned workspaces and collapse to a wrong role.
      let memberships: Array<{ workspace_id: string, role: string }>
      try {
        memberships = await withUser(accessToken, trx =>
          trx.selectFrom('workspace_members')
            .select(['workspace_id', 'role'])
            .where('user_id', '=', userId)
            .execute())
      }
      catch (error) {
        throwDbError(error)
      }

      try {
        if (!memberships.length) {
          const owned = await getAdmin()
            .selectFrom('workspaces')
            .selectAll()
            .where('owner_id', '=', userId)
            .orderBy('created_at', 'asc')
            .execute()

          const enriched = owned.map(w => ({ ...w, workspace_members: [{ role: 'owner' }] }))
          return await attachActivePaymentAccounts(enriched)
        }

        const roleMap = Object.fromEntries(memberships.map(m => [m.workspace_id, m.role]))
        const rows = await getAdmin()
          .selectFrom('workspaces')
          .selectAll()
          .where('id', 'in', memberships.map(m => m.workspace_id))
          .orderBy('created_at', 'asc')
          .execute()

        const enriched = rows.map(w => ({
          ...w,
          workspace_members: [{ role: roleMap[w.id] ?? 'member' }],
        }))
        return await attachActivePaymentAccounts(enriched)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createWorkspace(accessToken, input) {
      try {
        return await withUser(accessToken, async (trx) => {
          const row = await trx
            .insertInto('workspaces')
            .values({ name: input.name, slug: input.slug, type: input.type, owner_id: input.ownerId })
            .returningAll()
            .executeTakeFirst()

          if (!row)
            throw createError({ statusCode: 500, message: 'Invalid database response' })

          return row as DatabaseRow
        })
      }
      catch (error) {
        throwOnUniqueViolation(error, errorMessage('workspace.slug_taken'))
        throwDbError(error)
      }
    },

    async getWorkspaceForUser(accessToken, userId, workspaceId, requiredRoles = ['owner', 'admin', 'member'], fields = '*') {
      await requireRole(accessToken, userId, workspaceId, requiredRoles)
      return fetchWorkspaceById(workspaceId, fields)
    },

    async getWorkspaceDetailForUser(accessToken, userId, workspaceId) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin', 'member'])
      const workspace = await fetchWorkspaceById(workspaceId)
      if (!workspace) return null

      try {
        const members = (await memberRowsForWorkspaces([workspaceId], 'detail'))
          .map(({ workspace_id: _wsId, ...rest }) => rest as DatabaseRow)
        return await attachActivePaymentAccount({ ...workspace, workspace_members: members })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getWorkspaceById(workspaceId, fields = '*') {
      return fetchWorkspaceById(workspaceId, fields)
    },

    async updateWorkspace(accessToken, workspaceId, updates, fields = '*') {
      // Empty token = admin/system operation (webhooks, triggers) — service
      // path. Non-empty token = RLS-scoped update, same as the Supabase impl.
      const run = async (db: Kysely<StudioDatabase>) => {
        const row = await db
          .updateTable('workspaces')
          .set(updates as never)
          .where('id', '=', workspaceId)
          .returningAll()
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return pickColumns(row as DatabaseRow, fields)
      }

      try {
        return accessToken
          ? await withUser(accessToken, trx => run(trx))
          : await run(getAdmin())
      }
      catch (error) {
        throwOnUniqueViolation(error, errorMessage('workspace.slug_taken'))
        throwDbError(error)
      }
    },

    async markWorkspaceTrialConsumed(workspaceId) {
      // System operation (billing webhook). `IS NULL` guard keeps the first
      // trial date across repeated 'trialing' deliveries (set once).
      try {
        await getAdmin()
          .updateTable('workspaces')
          .set({ trial_consumed_at: new Date().toISOString() })
          .where('id', '=', workspaceId)
          .where('trial_consumed_at', 'is', null)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateWorkspaceForUser(accessToken, userId, workspaceId, updates, fields = '*') {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      try {
        const row = await getAdmin()
          .updateTable('workspaces')
          .set(updates as never)
          .where('id', '=', workspaceId)
          .returningAll()
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return pickColumns(row as DatabaseRow, fields)
      }
      catch (error) {
        throwOnUniqueViolation(error, errorMessage('workspace.slug_taken'))
        throwDbError(error)
      }
    },

    async getPrimaryWorkspace(accessToken, ownerId) {
      try {
        return await withUser(accessToken, async (trx) => {
          const row = await trx
            .selectFrom('workspaces')
            .select(['id', 'slug', 'github_installation_id'])
            .where('owner_id', '=', ownerId)
            .orderBy('created_at', 'asc')
            .limit(1)
            .executeTakeFirst()

          return (row as DatabaseRow | undefined) ?? null
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async requireWorkspaceRole(accessToken, userId, workspaceId, requiredRoles) {
      return requireRole(accessToken, userId, workspaceId, requiredRoles)
    },

    async getWorkspaceMemberRole(accessToken, userId, workspaceId) {
      // Any failure (missing row, bad token) reads as "no role" — parity with
      // the Supabase impl's error → null contract.
      try {
        return await withUser(accessToken, async (trx) => {
          const row = await trx
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', workspaceId)
            .where('user_id', '=', userId)
            .executeTakeFirst()

          return row?.role ?? null
        })
      }
      catch {
        return null
      }
    },

    async findWorkspaceByGithubInstallation(installationId, excludeWorkspaceId) {
      try {
        let query = getAdmin()
          .selectFrom('workspaces')
          .select('id')
          .where('github_installation_id', '=', installationId)

        if (excludeWorkspaceId)
          query = query.where('id', '!=', excludeWorkspaceId)

        const row = await query.executeTakeFirst()
        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateWorkspaceGithubInstallation(workspaceId, installationId) {
      try {
        await getAdmin()
          .updateTable('workspaces')
          .set({ github_installation_id: installationId, github_installation_status: 'active' })
          .where('id', '=', workspaceId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async clearWorkspaceGithubInstallation(installationId) {
      try {
        await getAdmin()
          .updateTable('workspaces')
          .set({ github_installation_id: null, github_installation_status: 'unbound' })
          .where('github_installation_id', '=', installationId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateWorkspaceInstallationStatus(target, status) {
      try {
        let query = getAdmin()
          .updateTable('workspaces')
          .set({ github_installation_status: status })

        query = 'workspaceId' in target
          ? query.where('id', '=', target.workspaceId)
          : query.where('github_installation_id', '=', target.installationId)

        await query.execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async deleteWorkspace(workspaceId) {
      try {
        await getAdmin()
          .deleteFrom('workspaces')
          .where('id', '=', workspaceId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async incrementWorkspaceStorageBytes(workspaceId, deltaBytes) {
      try {
        await sql`
          SELECT public.increment_storage_bytes(
            p_workspace_id => ${workspaceId},
            p_delta => ${deltaBytes}
          )
        `.execute(getAdmin())
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Storage increment failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    },

    async reserveStorageIfAllowed(workspaceId, reserveBytes, limitBytes) {
      let result: { allowed: boolean, current_bytes: number }
      try {
        const outcome = await sql<{ result: { allowed: boolean, current_bytes: number } }>`
          SELECT public.reserve_storage_if_allowed(
            p_workspace_id => ${workspaceId},
            p_reserve_bytes => ${reserveBytes},
            p_limit_bytes => ${limitBytes}
          ) AS result
        `.execute(getAdmin())

        result = outcome.rows[0]!.result
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Atomic storage check failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }

      return { allowed: result.allowed, currentBytes: result.current_bytes }
    },

    async transferWorkspaceOwnership(workspaceId, currentOwnerId, newOwnerId) {
      // Single transaction — a failure between owner_id flip and the member
      // role swaps can no longer leave split-brain ownership (deliberate
      // upgrade over the PostgREST impl, which documents this hole).
      try {
        await getAdmin().transaction().execute(async (trx) => {
          await trx
            .updateTable('workspaces')
            .set({ owner_id: newOwnerId })
            .where('id', '=', workspaceId)
            .where('owner_id', '=', currentOwnerId)
            .execute()

          await trx
            .updateTable('workspace_members')
            .set({ role: 'admin' })
            .where('workspace_id', '=', workspaceId)
            .where('user_id', '=', currentOwnerId)
            .where('role', '=', 'owner')
            .execute()

          await trx
            .updateTable('workspace_members')
            .set({ role: 'owner' })
            .where('workspace_id', '=', workspaceId)
            .where('user_id', '=', newOwnerId)
            .execute()
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listOwnedSecondaryWorkspacesWithMembers(_accessToken, ownerId) {
      try {
        const workspaces = await getAdmin()
          .selectFrom('workspaces')
          .select(['id', 'name', 'slug', 'type', 'owner_id'])
          .where('owner_id', '=', ownerId)
          .where('type', '=', 'secondary')
          .execute()

        if (!workspaces.length) return []

        const members = await memberRowsForWorkspaces(workspaces.map(w => w.id), 'compact')
        const byWorkspace = new Map<string, DatabaseRow[]>()
        for (const member of members) {
          const wsId = member.workspace_id as string
          const { workspace_id: _wsId, ...rest } = member
          const bucket = byWorkspace.get(wsId) ?? []
          bucket.push(rest as DatabaseRow)
          byWorkspace.set(wsId, bucket)
        }

        return workspaces.map(w => ({
          ...w,
          workspace_members: byWorkspace.get(w.id) ?? [],
        })) as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
