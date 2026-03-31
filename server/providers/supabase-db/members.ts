/**
 * Workspace member, AI key, and project/webhook query methods
 * for the Supabase DatabaseProvider.
 */
import type { DatabaseProvider } from '../database'
import {
  getAdmin,
  getUser,
  requireRole,
  toDatabaseRow,
  toDatabaseRowOrNull,
  WORKSPACE_MEMBER_SELECT,
} from './helpers'

type MemberMethods = Pick<
  DatabaseProvider,
  | 'listWorkspaceMembers'
  | 'getWorkspaceMember'
  | 'createWorkspaceMember'
  | 'updateWorkspaceMemberRole'
  | 'deleteWorkspaceMember'
  | 'updateWorkspaceMemberInvitedAt'
  | 'ensureWorkspaceMember'
  | 'listUserAIKeys'
  | 'upsertUserAIKey'
  | 'deleteUserAIKey'
  | 'getProjectForWorkspace'
  | 'countProjectWebhooks'
  | 'createWebhook'
>

export function memberMethods(): MemberMethods {
  return {
    async listWorkspaceMembers(accessToken, userId, workspaceId) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const { data, error } = await getAdmin()
        .from('workspace_members')
        .select(WORKSPACE_MEMBER_SELECT)
        .eq('workspace_id', workspaceId)
        .order('invited_at', { ascending: true })

      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []).map(toDatabaseRow)
    },

    async getWorkspaceMember(accessToken, userId, workspaceId, memberId) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const { data, error } = await getAdmin()
        .from('workspace_members')
        .select(WORKSPACE_MEMBER_SELECT)
        .eq('id', memberId)
        .eq('workspace_id', workspaceId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }
      return toDatabaseRowOrNull(data)
    },

    async createWorkspaceMember(accessToken, userId, input) {
      await requireRole(accessToken, userId, input.workspaceId, ['owner', 'admin'])

      const { data, error } = await getAdmin()
        .from('workspace_members')
        .insert({
          workspace_id: input.workspaceId,
          user_id: input.memberUserId,
          role: input.role,
          invited_email: input.invitedEmail,
          accepted_at: input.acceptedAt ?? null,
        })
        .select(WORKSPACE_MEMBER_SELECT)
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return toDatabaseRow(data)
    },

    async updateWorkspaceMemberRole(accessToken, userId, workspaceId, memberId, role) {
      await requireRole(accessToken, userId, workspaceId, ['owner'])

      const admin = getAdmin()
      const { data: target, error: targetError } = await admin
        .from('workspace_members').select('role').eq('id', memberId).eq('workspace_id', workspaceId).single()

      if (targetError) {
        if (targetError.code === 'PGRST116') throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
        throw createError({ statusCode: 500, message: targetError.message })
      }
      if (!target) throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
      if ((target as Record<string, unknown>).role === 'owner') {
        throw createError({ statusCode: 400, message: errorMessage('members.cannot_change_owner_role') })
      }

      const { data, error } = await admin
        .from('workspace_members').update({ role }).eq('id', memberId).eq('workspace_id', workspaceId)
        .select(WORKSPACE_MEMBER_SELECT).single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return toDatabaseRow(data)
    },

    async deleteWorkspaceMember(accessToken, userId, workspaceId, memberId) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const admin = getAdmin()
      const { data: target, error: targetError } = await admin
        .from('workspace_members').select('role').eq('id', memberId).eq('workspace_id', workspaceId).single()

      if (targetError) {
        if (targetError.code === 'PGRST116') throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
        throw createError({ statusCode: 500, message: targetError.message })
      }
      if (!target) throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
      if ((target as Record<string, unknown>).role === 'owner') {
        throw createError({ statusCode: 400, message: errorMessage('members.cannot_remove_owner') })
      }

      const { error } = await admin.from('workspace_members').delete().eq('id', memberId).eq('workspace_id', workspaceId)
      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async updateWorkspaceMemberInvitedAt(accessToken, userId, workspaceId, memberId, invitedAt) {
      await requireRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const { error } = await getAdmin()
        .from('workspace_members').update({ invited_at: invitedAt }).eq('id', memberId).eq('workspace_id', workspaceId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async ensureWorkspaceMember(accessToken, workspaceId, userId, email, role = 'member') {
      const client = getUser(accessToken)
      const { data: existing } = await client
        .from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).single()

      if (existing) return

      await getAdmin().from('workspace_members').insert({
        workspace_id: workspaceId,
        user_id: userId,
        role,
        invited_email: email,
        invited_at: new Date().toISOString(),
        accepted_at: null,
      })
    },

    // ─── AI Keys ───

    async listUserAIKeys(accessToken, workspaceId, userId) {
      const { data, error } = await getUser(accessToken)
        .from('ai_keys').select('id, provider, key_hint, created_at').eq('workspace_id', workspaceId).eq('user_id', userId)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data ?? []
    },

    async upsertUserAIKey(accessToken, input) {
      const { data, error } = await getUser(accessToken)
        .from('ai_keys')
        .upsert({
          workspace_id: input.workspaceId,
          user_id: input.userId,
          provider: input.provider,
          encrypted_key: input.encryptedKey,
          key_hint: input.keyHint,
        }, { onConflict: 'workspace_id,user_id,provider' })
        .select('id, provider, key_hint, created_at')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data
    },

    async deleteUserAIKey(accessToken, workspaceId, keyId, userId) {
      const { error } = await getUser(accessToken)
        .from('ai_keys').delete().eq('id', keyId).eq('workspace_id', workspaceId).eq('user_id', userId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    // ─── Project / Webhook helpers ───

    async getProjectForWorkspace(accessToken, workspaceId, projectId, fields = 'id') {
      const { data, error } = await getUser(accessToken)
        .from('projects').select(fields).eq('id', projectId).eq('workspace_id', workspaceId).maybeSingle()

      if (error && error.code !== 'PGRST116') throw createError({ statusCode: 500, message: error.message })
      return toDatabaseRowOrNull(data)
    },

    async countProjectWebhooks(projectId, workspaceId) {
      const { count, error } = await getAdmin()
        .from('webhooks').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('workspace_id', workspaceId)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return count ?? 0
    },

    async createWebhook(input) {
      const { data, error } = await getAdmin()
        .from('webhooks')
        .insert({
          project_id: input.projectId,
          workspace_id: input.workspaceId,
          name: input.name,
          url: input.url,
          events: input.events,
          secret: input.secret,
          active: true,
        })
        .select('id, name, url, events, active, created_at')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data
    },
  }
}
