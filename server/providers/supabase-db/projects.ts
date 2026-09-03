/**
 * Project and project member methods for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, getUser, PROJECT_MEMBER_SELECT, toDatabaseRowOrNull } from './helpers'

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

export function projectMethods(): ProjectMethods {
  return {
    async getProjectById(projectId, fields = '*') {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('projects')
        .select(fields)
        .eq('id', projectId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }
      return toDatabaseRowOrNull(data)
    },

    async getProjectWithMembers(accessToken, workspaceId, projectId) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('projects')
        .select(`
          *,
          project_members(
            id, role, user_id, specific_models, allowed_models, invited_email, accepted_at,
            profiles:user_id(id, display_name, email, avatar_url)
          )
        `)
        .eq('id', projectId)
        .eq('workspace_id', workspaceId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }
      return toDatabaseRowOrNull(data)
    },

    async checkDuplicateProject(workspaceId, repoFullName) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('repo_full_name', repoFullName)
        .single()

      if (error && error.code === 'PGRST116') return false
      if (error) throw createError({ statusCode: 500, message: error.message })
      return !!data
    },

    async createProject(accessToken, input) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('projects')
        .insert(input)
        .select()
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async updateProject(projectId, updates, fields = '*') {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('projects')
        .update(updates)
        .eq('id', projectId)
        .select(fields)
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as unknown as DatabaseRow
    },

    async setProjectMigrationHandoff(projectId, handoff) {
      const { error } = await getAdmin()
        .from('projects')
        .update({ migration_handoff: handoff, migration_handoff_synced_at: handoff ? new Date().toISOString() : null })
        .eq('id', projectId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async deleteProject(projectId, workspaceId) {
      const admin = getAdmin()
      const { error } = await admin
        .from('projects')
        .delete()
        .eq('id', projectId)
        .eq('workspace_id', workspaceId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async getProjectMediaStorageSum(projectId) {
      const admin = getAdmin()
      const { data } = await admin
        .from('media_assets')
        .select('size_bytes')
        .eq('project_id', projectId)

      if (!data?.length) return 0
      return data.reduce((sum: number, a: { size_bytes: number | null }) => sum + (a.size_bytes ?? 0), 0)
    },

    async listWorkspaceProjects(accessToken, workspaceId) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('projects')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async listWorkspaceProjectsAdmin(workspaceId) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('projects')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async listWorkspaceProjectsByIds(workspaceId, projectIds) {
      if (projectIds.length === 0) return []

      const admin = getAdmin()
      const { data, error } = await admin
        .from('projects')
        .select('*')
        .eq('workspace_id', workspaceId)
        .in('id', projectIds)
        .order('created_at', { ascending: false })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async listUserAssignedProjectIds(userId) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('project_members')
        .select('project_id')
        .eq('user_id', userId)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []).map(r => r.project_id as string)
    },

    async listUserAssignedProjects(accessToken, userId) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('project_members')
        .select('project_id')
        .eq('user_id', userId)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async updateProjectContentTimestamp(repoFullName) {
      const admin = getAdmin()
      await admin
        .from('projects')
        .update({ content_updated_at: new Date().toISOString() })
        .eq('repo_full_name', repoFullName)
    },

    async updateProjectAccessStatus(target, status) {
      const admin = getAdmin()
      // Resolve workspaces matching the installation_id, then UPDATE
      // projects whose workspace_id is in that set AND whose
      // repo_full_name matches. Two-step instead of a JOIN because
      // PostgREST doesn't expose join updates via the supabase-js
      // builder; a direct SQL function would be cleaner but pulls
      // in migration churn.
      const { data: wsRows, error: wsErr } = await admin
        .from('workspaces')
        .select('id')
        .eq('github_installation_id', target.installationId)
      if (wsErr) throw createError({ statusCode: 500, message: wsErr.message })
      const workspaceIds = (wsRows ?? []).map(w => w.id as string)
      if (workspaceIds.length === 0) return

      const { error } = await admin
        .from('projects')
        .update({ access_status: status })
        .in('workspace_id', workspaceIds)
        .eq('repo_full_name', target.repoFullName)
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async renameProjectRepo(target, newFullName) {
      const admin = getAdmin()
      const { data: wsRows, error: wsErr } = await admin
        .from('workspaces')
        .select('id')
        .eq('github_installation_id', target.installationId)
      if (wsErr) throw createError({ statusCode: 500, message: wsErr.message })
      const workspaceIds = (wsRows ?? []).map(w => w.id as string)
      if (workspaceIds.length === 0) return

      const { error } = await admin
        .from('projects')
        .update({ repo_full_name: newFullName })
        .in('workspace_id', workspaceIds)
        .eq('repo_full_name', target.oldFullName)
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async listCDNEnabledProjects(repoFullName) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('projects')
        .select('id, workspace_id, content_root, cdn_enabled, cdn_branch, default_branch')
        .eq('repo_full_name', repoFullName)
        .eq('cdn_enabled', true)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async listAllActiveProjects(fields = 'id, repo_full_name, content_root, workspace_id') {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('projects')
        .select(fields as '*')
        .eq('status', 'active')
        .order('created_at', { ascending: false })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    // ─── Project Members ───

    async listProjectMembers(projectId) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('project_members')
        .select(PROJECT_MEMBER_SELECT)
        .eq('project_id', projectId)
        .order('invited_at', { ascending: true })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async getProjectMember(projectId, userId) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('project_members')
        .select('id, role, specific_models, allowed_models')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }
      return toDatabaseRowOrNull(data)
    },

    async createProjectMember(input) {
      const admin = getAdmin()
      // `project_members` is keyed by project_id only — the workspace is
      // derived via projects.workspace_id (see the membership lookup in
      // members.ts). There is no `workspace_id` column on this table, so
      // writing one made PostgREST reject the insert with "Could not find
      // the 'workspace_id' column of 'project_members' in the schema cache".
      // `input.workspaceId` stays in the signature for the caller's
      // authorization context but is intentionally not persisted here.
      const { data, error } = await admin
        .from('project_members')
        .insert({
          project_id: input.projectId,
          user_id: input.userId,
          role: input.role,
          invited_email: input.invitedEmail,
          specific_models: input.specificModels ?? false,
          allowed_models: input.allowedModels ?? [],
        })
        .select(PROJECT_MEMBER_SELECT)
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async deleteProjectMember(projectId, memberId) {
      const admin = getAdmin()
      const { error } = await admin
        .from('project_members')
        .delete()
        .eq('id', memberId)
        .eq('project_id', projectId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },
  }
}
