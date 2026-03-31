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
  | 'deleteProject'
  | 'getProjectMediaStorageSum'
  | 'listWorkspaceProjects'
  | 'listWorkspaceProjectsAdmin'
  | 'listUserAssignedProjectIds'
  | 'listWorkspaceProjectsByIds'
  | 'listUserAssignedProjects'
  | 'updateProjectContentTimestamp'
  | 'listCDNEnabledProjects'
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
      const { data, error } = await admin
        .from('project_members')
        .insert({
          project_id: input.projectId,
          workspace_id: input.workspaceId,
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
