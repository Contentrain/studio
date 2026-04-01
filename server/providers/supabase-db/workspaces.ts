/**
 * Workspace CRUD methods for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { fetchWorkspaceById, getAdmin, getUser, requireRole, toDatabaseRow } from './helpers'

type WorkspaceMethods = Pick<
  DatabaseProvider,
  | 'listUserWorkspaces'
  | 'createWorkspace'
  | 'getWorkspaceForUser'
  | 'getWorkspaceDetailForUser'
  | 'getWorkspaceById'
  | 'updateWorkspace'
  | 'updateWorkspaceForUser'
  | 'getPrimaryWorkspace'
  | 'requireWorkspaceRole'
  | 'getWorkspaceMemberRole'
  | 'findWorkspaceByGithubInstallation'
  | 'updateWorkspaceGithubInstallation'
  | 'clearWorkspaceGithubInstallation'
  | 'deleteWorkspace'
  | 'incrementWorkspaceStorageBytes'
  | 'transferWorkspaceOwnership'
  | 'listOwnedSecondaryWorkspacesWithMembers'
>

export function workspaceMethods(): WorkspaceMethods {
  return {
    async listUserWorkspaces(accessToken, userId) {
      const client = getUser(accessToken)
      const admin = getAdmin()

      const { data: memberships, error: membershipError } = await client
        .from('workspace_members')
        .select('workspace_id, role')

      if (membershipError) {
        throw createError({ statusCode: 500, message: membershipError.message })
      }

      if (!memberships?.length) {
        const { data, error } = await admin
          .from('workspaces')
          .select('*')
          .eq('owner_id', userId)
          .order('created_at', { ascending: true })

        if (error) throw createError({ statusCode: 500, message: error.message })
        return (data ?? []).map((w: DatabaseRow) => ({ ...w, workspace_members: [{ role: 'owner' }] }))
      }

      const workspaceIds = memberships.map(m => m.workspace_id)
      const roleMap = Object.fromEntries(memberships.map(m => [m.workspace_id, m.role]))

      const { data, error } = await admin
        .from('workspaces')
        .select('*')
        .in('id', workspaceIds)
        .order('created_at', { ascending: true })

      if (error) throw createError({ statusCode: 500, message: error.message })

      return (data ?? []).map((w: DatabaseRow) => ({
        ...w,
        workspace_members: [{ role: roleMap[w.id as string] ?? 'member' }],
      }))
    },

    async createWorkspace(accessToken, input) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('workspaces')
        .insert({ name: input.name, slug: input.slug, type: input.type, owner_id: input.ownerId })
        .select()
        .single()

      if (error) {
        if (error.code === '23505') throw createError({ statusCode: 409, message: errorMessage('workspace.slug_taken') })
        throw createError({ statusCode: 500, message: error.message })
      }
      return data
    },

    async getWorkspaceForUser(accessToken, userId, workspaceId, requiredRoles = ['owner', 'admin', 'member'], fields = '*') {
      await requireRole(accessToken, userId, workspaceId, requiredRoles)
      return fetchWorkspaceById(workspaceId, fields)
    },

    async getWorkspaceDetailForUser(accessToken, userId, workspaceId) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin', 'member'])
      return fetchWorkspaceById(workspaceId, `
        *,
        workspace_members(
          id, role, user_id, invited_email, accepted_at,
          profiles:user_id(id, display_name, email, avatar_url)
        )
      `)
    },

    async getWorkspaceById(workspaceId, fields = '*') {
      return fetchWorkspaceById(workspaceId, fields)
    },

    async updateWorkspace(accessToken, workspaceId, updates, fields = '*') {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('workspaces').update(updates).eq('id', workspaceId).select(fields).single()

      if (error) {
        if (error.code === '23505') throw createError({ statusCode: 409, message: errorMessage('workspace.slug_taken') })
        throw createError({ statusCode: 500, message: error.message })
      }
      return toDatabaseRow(data)
    },

    async updateWorkspaceForUser(accessToken, userId, workspaceId, updates, fields = '*') {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const { data, error } = await getAdmin()
        .from('workspaces').update(updates).eq('id', workspaceId).select(fields).single()

      if (error) {
        if (error.code === '23505') throw createError({ statusCode: 409, message: errorMessage('workspace.slug_taken') })
        throw createError({ statusCode: 500, message: error.message })
      }
      return toDatabaseRow(data)
    },

    async getPrimaryWorkspace(accessToken, ownerId) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('workspaces')
        .select('id, slug, github_installation_id')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data
    },

    async requireWorkspaceRole(accessToken, userId, workspaceId, requiredRoles) {
      return requireRole(accessToken, userId, workspaceId, requiredRoles)
    },

    async getWorkspaceMemberRole(accessToken, userId, workspaceId) {
      const client = getUser(accessToken)
      const { data, error } = await client
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .single()

      if (error) return null
      return (data?.role as string) ?? null
    },

    async findWorkspaceByGithubInstallation(installationId, excludeWorkspaceId) {
      const admin = getAdmin()
      let query = admin.from('workspaces').select('id').eq('github_installation_id', installationId)
      if (excludeWorkspaceId) query = query.neq('id', excludeWorkspaceId)

      const { data, error } = await query.maybeSingle()
      if (error && error.code !== 'PGRST116') throw createError({ statusCode: 500, message: error.message })
      return data
    },

    async updateWorkspaceGithubInstallation(workspaceId, installationId) {
      const { error } = await getAdmin()
        .from('workspaces').update({ github_installation_id: installationId }).eq('id', workspaceId)
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async clearWorkspaceGithubInstallation(installationId) {
      const { error } = await getAdmin()
        .from('workspaces').update({ github_installation_id: null }).eq('github_installation_id', installationId)
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async deleteWorkspace(workspaceId) {
      const admin = getAdmin()
      const { error } = await admin
        .from('workspaces')
        .delete()
        .eq('id', workspaceId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async incrementWorkspaceStorageBytes(workspaceId, deltaBytes) {
      const admin = getAdmin()
      const { error: rpcError } = await admin.rpc('increment_storage_bytes', {
        p_workspace_id: workspaceId,
        p_delta: deltaBytes,
      })
      if (!rpcError) return

      // Fallback to read+write if RPC not deployed
      const { data } = await admin.from('workspaces').select('media_storage_bytes').eq('id', workspaceId).single()
      const current = (data as { media_storage_bytes: number } | null)?.media_storage_bytes ?? 0
      await admin.from('workspaces').update({ media_storage_bytes: Math.max(0, current + deltaBytes) }).eq('id', workspaceId)
    },

    async transferWorkspaceOwnership(workspaceId, currentOwnerId, newOwnerId) {
      const admin = getAdmin()

      // 1. Update workspaces.owner_id
      const { error: ownerError } = await admin
        .from('workspaces')
        .update({ owner_id: newOwnerId })
        .eq('id', workspaceId)
        .eq('owner_id', currentOwnerId)

      if (ownerError) throw createError({ statusCode: 500, message: ownerError.message })

      // 2. Demote old owner to admin in workspace_members
      const { error: demoteError } = await admin
        .from('workspace_members')
        .update({ role: 'admin' })
        .eq('workspace_id', workspaceId)
        .eq('user_id', currentOwnerId)
        .eq('role', 'owner')

      if (demoteError) throw createError({ statusCode: 500, message: demoteError.message })

      // 3. Promote new owner in workspace_members
      const { error: promoteError } = await admin
        .from('workspace_members')
        .update({ role: 'owner' })
        .eq('workspace_id', workspaceId)
        .eq('user_id', newOwnerId)

      if (promoteError) throw createError({ statusCode: 500, message: promoteError.message })
    },

    async listOwnedSecondaryWorkspacesWithMembers(accessToken, ownerId) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('workspaces')
        .select(`
          id, name, slug, type, owner_id,
          workspace_members(
            id, role, user_id,
            profiles:user_id(id, display_name, email, avatar_url)
          )
        `)
        .eq('owner_id', ownerId)
        .eq('type', 'secondary')

      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []).map(toDatabaseRow)
    },
  }
}
