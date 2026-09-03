/**
 * Project and project member methods for the plain-Postgres DatabaseProvider.
 *
 * Behavior parity with supabase-db/projects.ts. PostgREST's
 * `project_members(… profiles:user_id(…))` embeds are reproduced with a
 * LEFT JOIN + JS shaping; getProjectWithMembers runs the join inside the
 * caller's RLS transaction so member visibility matches the Supabase
 * implementation exactly.
 */
import type { Kysely, Transaction } from 'kysely'
import type { DatabaseProvider, DatabaseRow } from '../database'
import type { StudioDatabase } from './types'
import { getAdmin, pickColumns, throwDbError, withUser } from './helpers'

type ProjectMethods = Pick<
  DatabaseProvider,
  | 'getProjectById'
  | 'getProjectWithMembers'
  | 'checkDuplicateProject'
  | 'createProject'
  | 'updateProject'
  | 'setProjectMigrationHandoff'
  | 'deleteProject'
  | 'getProjectMediaStorageSum'
  | 'listWorkspaceProjects'
  | 'listWorkspaceProjectsAdmin'
  | 'listUserAssignedProjectIds'
  | 'listWorkspaceProjectsByIds'
  | 'listUserAssignedProjects'
  | 'updateProjectContentTimestamp'
  | 'updateProjectAccessStatus'
  | 'renameProjectRepo'
  | 'listCDNEnabledProjects'
  | 'listAllActiveProjects'
  | 'listProjectMembers'
  | 'getProjectMember'
  | 'createProjectMember'
  | 'deleteProjectMember'
>

interface JoinedProjectMemberRow {
  project_id: string
  id: string
  role: string
  user_id: string | null
  specific_models: boolean
  allowed_models: string[]
  invited_email: string | null
  invited_at: string | null
  accepted_at: string | null
  profile_id: string | null
  profile_display_name: string | null
  profile_email: string | null
  profile_avatar_url: string | null
}

function joinedProjectMemberQuery(db: Kysely<StudioDatabase> | Transaction<StudioDatabase>) {
  return db
    .selectFrom('project_members as pm')
    .leftJoin('profiles as p', 'p.id', 'pm.user_id')
    .select([
      'pm.project_id as project_id',
      'pm.id as id',
      'pm.role as role',
      'pm.user_id as user_id',
      'pm.specific_models as specific_models',
      'pm.allowed_models as allowed_models',
      'pm.invited_email as invited_email',
      'pm.invited_at as invited_at',
      'pm.accepted_at as accepted_at',
      'p.id as profile_id',
      'p.display_name as profile_display_name',
      'p.email as profile_email',
      'p.avatar_url as profile_avatar_url',
    ])
}

/** PROJECT_MEMBER_SELECT parity; the embed variant drops invited_at. */
function shapeProjectMember(row: JoinedProjectMemberRow, options: { includeInvitedAt: boolean }): DatabaseRow {
  const shaped: DatabaseRow = {
    id: row.id,
    role: row.role,
    user_id: row.user_id,
    specific_models: row.specific_models,
    allowed_models: row.allowed_models,
    invited_email: row.invited_email,
    accepted_at: row.accepted_at,
    profiles: row.profile_id
      ? {
          id: row.profile_id,
          display_name: row.profile_display_name,
          email: row.profile_email,
          avatar_url: row.profile_avatar_url,
        }
      : null,
  }
  if (options.includeInvitedAt)
    shaped.invited_at = row.invited_at

  return shaped
}

export function projectMethods(): ProjectMethods {
  return {
    async getProjectById(projectId, fields = '*') {
      try {
        const row = await getAdmin()
          .selectFrom('projects')
          .selectAll()
          .where('id', '=', projectId)
          .executeTakeFirst()

        return row ? pickColumns(row as DatabaseRow, fields) : null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getProjectWithMembers(accessToken, workspaceId, projectId) {
      try {
        return await withUser(accessToken, async (trx) => {
          const project = await trx
            .selectFrom('projects')
            .selectAll()
            .where('id', '=', projectId)
            .where('workspace_id', '=', workspaceId)
            .executeTakeFirst()

          if (!project) return null

          // Same transaction → the member/profile join sees exactly what the
          // caller's RLS lets PostgREST's embed see.
          const members = await joinedProjectMemberQuery(trx)
            .where('pm.project_id', '=', projectId)
            .execute()

          return {
            ...project,
            project_members: members.map(m => shapeProjectMember(m as JoinedProjectMemberRow, { includeInvitedAt: false })),
          } as DatabaseRow
        })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async checkDuplicateProject(workspaceId, repoFullName) {
      try {
        const row = await getAdmin()
          .selectFrom('projects')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('repo_full_name', '=', repoFullName)
          .executeTakeFirst()

        return !!row
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createProject(accessToken, input) {
      try {
        return await withUser(accessToken, async (trx) => {
          const row = await trx
            .insertInto('projects')
            .values(input as never)
            .returningAll()
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

    async updateProject(projectId, updates, fields = '*') {
      try {
        const row = await getAdmin()
          .updateTable('projects')
          .set(updates as never)
          .where('id', '=', projectId)
          .returningAll()
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return pickColumns(row as DatabaseRow, fields)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async setProjectMigrationHandoff(projectId, handoff) {
      try {
        await getAdmin()
          .updateTable('projects')
          .set({
            // jsonb — stringify so node-pg never misreads the object
            migration_handoff: handoff ? JSON.stringify(handoff) : null,
            migration_handoff_synced_at: handoff ? new Date().toISOString() : null,
          } as never)
          .where('id', '=', projectId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async deleteProject(projectId, workspaceId) {
      try {
        await getAdmin()
          .deleteFrom('projects')
          .where('id', '=', projectId)
          .where('workspace_id', '=', workspaceId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getProjectMediaStorageSum(projectId) {
      // The Supabase impl swallows read errors (destructures data only) and
      // returns 0 — keep the same contract.
      try {
        const row = await getAdmin()
          .selectFrom('media_assets')
          .select(eb => eb.fn.coalesce(eb.fn.sum('size_bytes'), eb.lit(0)).as('total'))
          .where('project_id', '=', projectId)
          .executeTakeFirst()

        return Number(row?.total ?? 0)
      }
      catch {
        return 0
      }
    },

    async listWorkspaceProjects(accessToken, workspaceId) {
      try {
        return await withUser(accessToken, async trx =>
          await trx
            .selectFrom('projects')
            .selectAll()
            .where('workspace_id', '=', workspaceId)
            .orderBy('created_at', 'desc')
            .execute() as DatabaseRow[])
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listWorkspaceProjectsAdmin(workspaceId) {
      try {
        return await getAdmin()
          .selectFrom('projects')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .orderBy('created_at', 'desc')
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listWorkspaceProjectsByIds(workspaceId, projectIds) {
      if (projectIds.length === 0) return []

      try {
        return await getAdmin()
          .selectFrom('projects')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .where('id', 'in', projectIds)
          .orderBy('created_at', 'desc')
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listUserAssignedProjectIds(userId) {
      try {
        const rows = await getAdmin()
          .selectFrom('project_members')
          .select('project_id')
          .where('user_id', '=', userId)
          .execute()

        return rows.map(r => r.project_id)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listUserAssignedProjects(accessToken, userId) {
      try {
        return await withUser(accessToken, async trx =>
          await trx
            .selectFrom('project_members')
            .select('project_id')
            .where('user_id', '=', userId)
            .execute() as DatabaseRow[])
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async updateProjectContentTimestamp(repoFullName) {
      // Fire-and-forget in the Supabase impl (no error handling) — mirror it.
      try {
        await getAdmin()
          .updateTable('projects')
          .set({ content_updated_at: new Date().toISOString() })
          .where('repo_full_name', '=', repoFullName)
          .execute()
      }
      catch {
        // parity: swallowed
      }
    },

    async updateProjectAccessStatus(target, status) {
      // Single statement with a workspace subquery — the PostgREST impl
      // needed two round-trips because supabase-js can't express join
      // updates; the semantics (installation-scoped repo match) are identical.
      try {
        await getAdmin()
          .updateTable('projects')
          .set({ access_status: status })
          .where('repo_full_name', '=', target.repoFullName)
          .where('workspace_id', 'in', eb => eb
            .selectFrom('workspaces')
            .select('id')
            .where('github_installation_id', '=', target.installationId))
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async renameProjectRepo(target, newFullName) {
      try {
        await getAdmin()
          .updateTable('projects')
          .set({ repo_full_name: newFullName })
          .where('repo_full_name', '=', target.oldFullName)
          .where('workspace_id', 'in', eb => eb
            .selectFrom('workspaces')
            .select('id')
            .where('github_installation_id', '=', target.installationId))
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listCDNEnabledProjects(repoFullName) {
      try {
        return await getAdmin()
          .selectFrom('projects')
          .select(['id', 'workspace_id', 'content_root', 'cdn_enabled', 'cdn_branch', 'default_branch'])
          .where('repo_full_name', '=', repoFullName)
          .where('cdn_enabled', '=', true)
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async listAllActiveProjects(fields = 'id, repo_full_name, content_root, workspace_id') {
      try {
        const rows = await getAdmin()
          .selectFrom('projects')
          .selectAll()
          .where('status', '=', 'active')
          .orderBy('created_at', 'desc')
          .execute()

        return rows.map(row => pickColumns(row as DatabaseRow, fields))
      }
      catch (error) {
        throwDbError(error)
      }
    },

    // ─── Project Members ───

    async listProjectMembers(projectId) {
      try {
        const rows = await joinedProjectMemberQuery(getAdmin())
          .where('pm.project_id', '=', projectId)
          .orderBy('pm.invited_at', 'asc')
          .execute()

        return rows.map(row => shapeProjectMember(row as JoinedProjectMemberRow, { includeInvitedAt: true }))
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getProjectMember(projectId, userId) {
      try {
        const row = await getAdmin()
          .selectFrom('project_members')
          .select(['id', 'role', 'specific_models', 'allowed_models'])
          .where('project_id', '=', projectId)
          .where('user_id', '=', userId)
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createProjectMember(input) {
      // `project_members` is keyed by project_id only — the workspace is
      // derived via projects.workspace_id. `input.workspaceId` stays in the
      // signature for the caller's authorization context but is not persisted
      // (same contract as the Supabase impl).
      try {
        const inserted = await getAdmin()
          .insertInto('project_members')
          .values({
            project_id: input.projectId,
            user_id: input.userId,
            role: input.role,
            invited_email: input.invitedEmail,
            specific_models: input.specificModels ?? false,
            allowed_models: input.allowedModels ?? [],
          })
          .returning('id')
          .executeTakeFirst()

        const row = inserted
          ? await joinedProjectMemberQuery(getAdmin())
              .where('pm.id', '=', inserted.id)
              .executeTakeFirst()
          : undefined

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return shapeProjectMember(row as JoinedProjectMemberRow, { includeInvitedAt: true })
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async deleteProjectMember(projectId, memberId) {
      try {
        await getAdmin()
          .deleteFrom('project_members')
          .where('id', '=', memberId)
          .where('project_id', '=', projectId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
