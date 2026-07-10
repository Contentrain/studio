/**
 * Workspace member, AI key, and project/webhook query methods for the
 * plain-Postgres DatabaseProvider.
 *
 * Behavior parity with supabase-db/members.ts, with one deliberate upgrade:
 * acceptPendingInvitations flips workspace + project memberships inside one
 * transaction (non-atomic across PostgREST calls in the Supabase impl).
 *
 * PostgREST's `profiles:user_id(…)` embeds are reproduced with a LEFT JOIN
 * + JS shaping so both providers return identical row structures.
 */
import { sql } from 'kysely'
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, pickColumns, requireRole, throwDbError, withUser } from './helpers'

type MemberMethods = Pick<
  DatabaseProvider,
  | 'listWorkspaceMembers'
  | 'getWorkspaceMember'
  | 'createWorkspaceMember'
  | 'createWorkspaceMemberIfAllowed'
  | 'updateWorkspaceMemberRole'
  | 'deleteWorkspaceMember'
  | 'updateWorkspaceMemberInvitedAt'
  | 'ensureWorkspaceMember'
  | 'listUserAIKeys'
  | 'upsertUserAIKey'
  | 'deleteUserAIKey'
  | 'getProjectForWorkspace'
  | 'acceptPendingInvitations'
  | 'listWorkspaceAdminEmails'
  | 'countProjectWebhooks'
  | 'createWebhook'
>

type MemberShape = 'full' | 'detail' | 'compact'

interface JoinedMemberRow {
  workspace_id: string
  id: string
  role: string
  user_id: string | null
  invited_email: string | null
  invited_at: string | null
  accepted_at: string | null
  profile_id: string | null
  profile_display_name: string | null
  profile_email: string | null
  profile_avatar_url: string | null
}

function shapeMemberRow(row: JoinedMemberRow, shape: MemberShape): DatabaseRow {
  const profiles = row.profile_id
    ? {
        id: row.profile_id,
        display_name: row.profile_display_name,
        email: row.profile_email,
        avatar_url: row.profile_avatar_url,
      }
    : null

  const base: DatabaseRow = {
    workspace_id: row.workspace_id,
    id: row.id,
    role: row.role,
    user_id: row.user_id,
    profiles,
  }
  if (shape !== 'compact') {
    base.invited_email = row.invited_email
    base.accepted_at = row.accepted_at
  }
  if (shape === 'full')
    base.invited_at = row.invited_at

  return base
}

function joinedMemberQuery() {
  return getAdmin()
    .selectFrom('workspace_members as wm')
    .leftJoin('profiles as p', 'p.id', 'wm.user_id')
    .select([
      'wm.workspace_id as workspace_id',
      'wm.id as id',
      'wm.role as role',
      'wm.user_id as user_id',
      'wm.invited_email as invited_email',
      'wm.invited_at as invited_at',
      'wm.accepted_at as accepted_at',
      'p.id as profile_id',
      'p.display_name as profile_display_name',
      'p.email as profile_email',
      'p.avatar_url as profile_avatar_url',
    ])
}

/**
 * Profile-embedded member rows for a set of workspaces. Rows carry
 * workspace_id for grouping — callers strip it when the PostgREST-parity
 * shape doesn't include it.
 */
export async function memberRowsForWorkspaces(workspaceIds: string[], shape: MemberShape): Promise<DatabaseRow[]> {
  if (!workspaceIds.length) return []

  const rows = await joinedMemberQuery()
    .where('wm.workspace_id', 'in', workspaceIds)
    .orderBy('wm.invited_at', 'asc')
    .execute()

  return rows.map(row => shapeMemberRow(row as JoinedMemberRow, shape))
}

/** Single profile-embedded member row (WORKSPACE_MEMBER_SELECT parity). */
async function fetchMemberRow(memberId: string, workspaceId: string): Promise<DatabaseRow | null> {
  const row = await joinedMemberQuery()
    .where('wm.id', '=', memberId)
    .where('wm.workspace_id', '=', workspaceId)
    .executeTakeFirst()

  if (!row) return null

  const { workspace_id: _wsId, ...shaped } = shapeMemberRow(row as JoinedMemberRow, 'full')
  return shaped as DatabaseRow
}

export function memberMethods(): MemberMethods {
  return {
    async listWorkspaceMembers(accessToken, userId, workspaceId) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      try {
        const rows = await memberRowsForWorkspaces([workspaceId], 'full')
        return rows.map(({ workspace_id: _wsId, ...rest }) => rest as DatabaseRow)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getWorkspaceMember(accessToken, userId, workspaceId, memberId) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      try {
        return await fetchMemberRow(memberId, workspaceId)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createWorkspaceMember(accessToken, userId, input) {
      await requireRole(accessToken, userId, input.workspaceId, ['owner', 'admin'])

      try {
        const inserted = await getAdmin()
          .insertInto('workspace_members')
          .values({
            workspace_id: input.workspaceId,
            user_id: input.memberUserId,
            role: input.role,
            invited_email: input.invitedEmail,
            accepted_at: input.acceptedAt ?? null,
          })
          .returning('id')
          .executeTakeFirst()

        const row = inserted ? await fetchMemberRow(inserted.id, input.workspaceId) : null
        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createWorkspaceMemberIfAllowed(input) {
      await requireRole(input.accessToken, input.callerUserId, input.workspaceId, ['owner', 'admin'])

      let result: { allowed: boolean, current_count: number, member_id?: string, already_existed?: boolean }
      try {
        const outcome = await sql<{ result: typeof result }>`
          SELECT public.create_workspace_member_if_allowed(
            p_workspace_id => ${input.workspaceId},
            p_member_user_id => ${input.memberUserId},
            p_role => ${input.role},
            p_invited_email => ${input.invitedEmail},
            p_accepted_at => ${input.acceptedAt ?? null},
            p_limit => ${input.limit}
          ) AS result
        `.execute(getAdmin())

        result = outcome.rows[0]!.result
      }
      catch (error) {
        throw createError({
          statusCode: 500,
          message: `Atomic member check failed: ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }

      if (!result.allowed)
        return { allowed: false, currentCount: result.current_count }

      // Profile-enriched row to match createWorkspaceMember's response format.
      let member: DatabaseRow | null = null
      try {
        member = result.member_id ? await fetchMemberRow(result.member_id, input.workspaceId) : null
      }
      catch (error) {
        throwDbError(error)
      }

      return {
        allowed: true,
        currentCount: result.current_count,
        member: member ?? undefined,
        alreadyExisted: result.already_existed ?? false,
      }
    },

    async updateWorkspaceMemberRole(accessToken, userId, workspaceId, memberId, role) {
      await requireRole(accessToken, userId, workspaceId, ['owner'])

      let target: { role: string } | undefined
      try {
        target = await getAdmin()
          .selectFrom('workspace_members')
          .select('role')
          .where('id', '=', memberId)
          .where('workspace_id', '=', workspaceId)
          .executeTakeFirst()
      }
      catch (error) {
        throwDbError(error)
      }

      if (!target)
        throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
      if (target.role === 'owner')
        throw createError({ statusCode: 400, message: errorMessage('members.cannot_change_owner_role') })

      try {
        await getAdmin()
          .updateTable('workspace_members')
          .set({ role })
          .where('id', '=', memberId)
          .where('workspace_id', '=', workspaceId)
          .execute()

        const row = await fetchMemberRow(memberId, workspaceId)
        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async deleteWorkspaceMember(accessToken, userId, workspaceId, memberId) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      let target: { role: string } | undefined
      try {
        target = await getAdmin()
          .selectFrom('workspace_members')
          .select('role')
          .where('id', '=', memberId)
          .where('workspace_id', '=', workspaceId)
          .executeTakeFirst()
      }
      catch (error) {
        throwDbError(error)
      }

      if (!target)
        throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
      if (target.role === 'owner')
        throw createError({ statusCode: 400, message: errorMessage('members.cannot_remove_owner') })

      try {
        await getAdmin()
          .deleteFrom('workspace_members')
          .where('id', '=', memberId)
          .where('workspace_id', '=', workspaceId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateWorkspaceMemberInvitedAt(accessToken, userId, workspaceId, memberId, invitedAt) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      try {
        await getAdmin()
          .updateTable('workspace_members')
          .set({ invited_at: invitedAt })
          .where('id', '=', memberId)
          .where('workspace_id', '=', workspaceId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async ensureWorkspaceMember(accessToken, workspaceId, userId, email, role = 'member') {
      // The Supabase impl swallows the existence-check error entirely —
      // mirror that: any failure reads as "not a member yet".
      let existing: { id: string } | undefined
      try {
        existing = await withUser(accessToken, trx =>
          trx.selectFrom('workspace_members')
            .select('id')
            .where('workspace_id', '=', workspaceId)
            .where('user_id', '=', userId)
            .executeTakeFirst())
      }
      catch {
        existing = undefined
      }

      if (existing) return

      try {
        await getAdmin()
          .insertInto('workspace_members')
          .values({
            workspace_id: workspaceId,
            user_id: userId,
            role,
            invited_email: email,
            invited_at: new Date().toISOString(),
            accepted_at: null,
          })
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async acceptPendingInvitations(userId, workspaceId) {
      // One transaction — workspace + project membership acceptance can't
      // diverge (deliberate upgrade over the two-call PostgREST impl).
      try {
        return await getAdmin().transaction().execute(async (trx) => {
          const now = new Date().toISOString()

          const accepted = await trx
            .updateTable('workspace_members')
            .set({ accepted_at: now })
            .where('user_id', '=', userId)
            .where('workspace_id', '=', workspaceId)
            .where('accepted_at', 'is', null)
            .returning('id')
            .execute()

          if (!accepted.length) return false

          const projects = await trx
            .selectFrom('projects')
            .select('id')
            .where('workspace_id', '=', workspaceId)
            .execute()

          if (projects.length) {
            await trx
              .updateTable('project_members')
              .set({ accepted_at: now })
              .where('user_id', '=', userId)
              .where('project_id', 'in', projects.map(p => p.id))
              .where('accepted_at', 'is', null)
              .execute()
          }

          return true
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listWorkspaceAdminEmails(workspaceId) {
      try {
        const rows = await getAdmin()
          .selectFrom('workspace_members as wm')
          .leftJoin('profiles as p', 'p.id', 'wm.user_id')
          .select(['p.email as email', 'p.display_name as display_name'])
          .where('wm.workspace_id', '=', workspaceId)
          .where('wm.role', 'in', ['owner', 'admin'])
          .where('wm.accepted_at', 'is not', null)
          .execute()

        return rows
          .filter(row => row.email)
          .map(row => ({ email: row.email as string, displayName: row.display_name ?? null }))
      }
      catch (error) {
        throwDbError(error)
      }
    },

    // ─── AI Keys ───

    async listUserAIKeys(accessToken, workspaceId, userId) {
      try {
        return await withUser(accessToken, async trx =>
          await trx
            .selectFrom('ai_keys')
            .select(['id', 'provider', 'key_hint', 'created_at'])
            .where('workspace_id', '=', workspaceId)
            .where('user_id', '=', userId)
            .execute() as DatabaseRow[])
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async upsertUserAIKey(accessToken, input) {
      try {
        return await withUser(accessToken, async (trx) => {
          const row = await trx
            .insertInto('ai_keys')
            .values({
              workspace_id: input.workspaceId,
              user_id: input.userId,
              provider: input.provider,
              encrypted_key: input.encryptedKey,
              key_hint: input.keyHint,
            })
            .onConflict(oc => oc
              .columns(['workspace_id', 'user_id', 'provider'])
              .doUpdateSet({ encrypted_key: input.encryptedKey, key_hint: input.keyHint }))
            .returning(['id', 'provider', 'key_hint', 'created_at'])
            .executeTakeFirst()

          if (!row)
            throw createError({ statusCode: 500, message: 'Invalid database response' })

          return row as DatabaseRow
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async deleteUserAIKey(accessToken, workspaceId, keyId, userId) {
      try {
        await withUser(accessToken, trx =>
          trx.deleteFrom('ai_keys')
            .where('id', '=', keyId)
            .where('workspace_id', '=', workspaceId)
            .where('user_id', '=', userId)
            .execute())
      }
      catch (error) {
        throwDbError(error)
      }
    },

    // ─── Project / Webhook helpers ───

    async getProjectForWorkspace(accessToken, workspaceId, projectId, fields = 'id') {
      try {
        return await withUser(accessToken, async (trx) => {
          const row = await trx
            .selectFrom('projects')
            .selectAll()
            .where('id', '=', projectId)
            .where('workspace_id', '=', workspaceId)
            .executeTakeFirst()

          return row ? pickColumns(row as DatabaseRow, fields) : null
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async countProjectWebhooks(projectId, workspaceId) {
      try {
        const row = await getAdmin()
          .selectFrom('webhooks')
          .select(eb => eb.fn.countAll().as('count'))
          .where('project_id', '=', projectId)
          .where('workspace_id', '=', workspaceId)
          .executeTakeFirst()

        return Number(row?.count ?? 0)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createWebhook(input) {
      try {
        const row = await getAdmin()
          .insertInto('webhooks')
          .values({
            project_id: input.projectId,
            workspace_id: input.workspaceId,
            name: input.name,
            url: input.url,
            events: input.events,
            secret: input.secret,
            active: true,
          })
          .returning(['id', 'name', 'url', 'events', 'active', 'created_at'])
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row as DatabaseRow
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
