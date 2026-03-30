import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DatabaseProvider, DatabaseRow } from './database'

let _adminClient: SupabaseClient | null = null

const WORKSPACE_MEMBER_SELECT = `
  id, role, user_id, invited_email, invited_at, accepted_at,
  profiles:user_id(id, display_name, email, avatar_url)
`

function getAdminClient(): SupabaseClient {
  if (_adminClient)
    return _adminClient

  const config = useRuntimeConfig()
  _adminClient = createClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )

  return _adminClient
}

function getUserClient(accessToken: string): SupabaseClient {
  const config = useRuntimeConfig()

  return createClient(
    config.supabase.url,
    config.supabase.anonKey,
    {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}

function isDatabaseRow(value: unknown): value is DatabaseRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toDatabaseRow(value: unknown): DatabaseRow {
  if (!isDatabaseRow(value)) {
    throw createError({ statusCode: 500, message: 'Invalid database response' })
  }

  return value
}

function toDatabaseRowOrNull(value: unknown): DatabaseRow | null {
  if (value == null)
    return null

  return toDatabaseRow(value)
}

export function createSupabaseAdminClient(): SupabaseClient {
  return getAdminClient()
}

export function createSupabaseUserClient(accessToken: string): SupabaseClient {
  return getUserClient(accessToken)
}

export function createSupabaseDatabaseProvider(): DatabaseProvider {
  return {
    getAdminClient,
    getUserClient,

    async listUserWorkspaces(accessToken, userId) {
      const client = getUserClient(accessToken)
      const admin = getAdminClient()

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

        if (error) {
          throw createError({ statusCode: 500, message: error.message })
        }

        return (data ?? []).map(w => ({ ...w, workspace_members: [{ role: 'owner' }] }))
      }

      const workspaceIds = memberships.map(m => m.workspace_id)
      const roleMap = Object.fromEntries(memberships.map(m => [m.workspace_id, m.role]))

      const { data, error } = await admin
        .from('workspaces')
        .select('*')
        .in('id', workspaceIds)
        .order('created_at', { ascending: true })

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return (data ?? []).map(w => ({
        ...w,
        workspace_members: [{ role: roleMap[w.id] ?? 'member' }],
      }))
    },

    async createWorkspace(accessToken, input) {
      const client = getUserClient(accessToken)
      const { data, error } = await client
        .from('workspaces')
        .insert({
          name: input.name,
          slug: input.slug,
          type: input.type,
          owner_id: input.ownerId,
        })
        .select()
        .single()

      if (error) {
        if (error.code === '23505') {
          throw createError({ statusCode: 409, message: errorMessage('workspace.slug_taken') })
        }
        throw createError({ statusCode: 500, message: error.message })
      }

      return data
    },

    async getWorkspaceForUser(accessToken, userId, workspaceId, requiredRoles = ['owner', 'admin', 'member'], fields = '*') {
      await this.requireWorkspaceRole(accessToken, userId, workspaceId, requiredRoles)
      return this.getWorkspaceById(workspaceId, fields)
    },

    async getWorkspaceDetailForUser(accessToken, userId, workspaceId) {
      await this.requireWorkspaceRole(accessToken, userId, workspaceId, ['owner', 'admin', 'member'])
      return this.getWorkspaceById(workspaceId, `
        *,
        workspace_members(
          id, role, user_id, invited_email, accepted_at,
          profiles:user_id(id, display_name, email, avatar_url)
        )
      `)
    },

    async getWorkspaceById(workspaceId, fields = '*') {
      const admin = getAdminClient()
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
    },

    async updateWorkspace(accessToken, workspaceId, updates, fields = '*') {
      const client = getUserClient(accessToken)
      const { data, error } = await client
        .from('workspaces')
        .update(updates)
        .eq('id', workspaceId)
        .select(fields)
        .single()

      if (error) {
        if (error.code === '23505') {
          throw createError({ statusCode: 409, message: errorMessage('workspace.slug_taken') })
        }
        throw createError({ statusCode: 500, message: error.message })
      }

      return toDatabaseRow(data)
    },

    async updateWorkspaceForUser(accessToken, userId, workspaceId, updates, fields = '*') {
      await this.requireWorkspaceRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const { data, error } = await getAdminClient()
        .from('workspaces')
        .update(updates)
        .eq('id', workspaceId)
        .select(fields)
        .single()

      if (error) {
        if (error.code === '23505') {
          throw createError({ statusCode: 409, message: errorMessage('workspace.slug_taken') })
        }
        throw createError({ statusCode: 500, message: error.message })
      }

      return toDatabaseRow(data)
    },

    async getPrimaryWorkspace(accessToken, ownerId) {
      const client = getUserClient(accessToken)
      const { data, error } = await client
        .from('workspaces')
        .select('id, slug, github_installation_id')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return data
    },

    async requireWorkspaceRole(accessToken, userId, workspaceId, requiredRoles) {
      const client = getUserClient(accessToken)
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
    },

    async findWorkspaceByGithubInstallation(installationId, excludeWorkspaceId) {
      const admin = getAdminClient()
      let query = admin
        .from('workspaces')
        .select('id')
        .eq('github_installation_id', installationId)

      if (excludeWorkspaceId) {
        query = query.neq('id', excludeWorkspaceId)
      }

      const { data, error } = await query.maybeSingle()
      if (error && error.code !== 'PGRST116') {
        throw createError({ statusCode: 500, message: error.message })
      }

      return data
    },

    async updateWorkspaceGithubInstallation(workspaceId, installationId) {
      const admin = getAdminClient()
      const { error } = await admin
        .from('workspaces')
        .update({ github_installation_id: installationId })
        .eq('id', workspaceId)

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }
    },

    async listWorkspaceMembers(accessToken, userId, workspaceId) {
      await this.requireWorkspaceRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const admin = getAdminClient()
      const { data, error } = await admin
        .from('workspace_members')
        .select(WORKSPACE_MEMBER_SELECT)
        .eq('workspace_id', workspaceId)
        .order('invited_at', { ascending: true })

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return (data ?? []) as DatabaseRow[]
    },

    async getWorkspaceMember(accessToken, userId, workspaceId, memberId) {
      await this.requireWorkspaceRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const admin = getAdminClient()
      const { data, error } = await admin
        .from('workspace_members')
        .select(WORKSPACE_MEMBER_SELECT)
        .eq('id', memberId)
        .eq('workspace_id', workspaceId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null
        throw createError({ statusCode: 500, message: error.message })
      }

      return (data ?? null) as DatabaseRow | null
    },

    async createWorkspaceMember(accessToken, userId, input) {
      await this.requireWorkspaceRole(accessToken, userId, input.workspaceId, ['owner', 'admin'])

      const admin = getAdminClient()
      const { data, error } = await admin
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

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return data as DatabaseRow
    },

    async updateWorkspaceMemberRole(accessToken, userId, workspaceId, memberId, role) {
      await this.requireWorkspaceRole(accessToken, userId, workspaceId, ['owner'])

      const admin = getAdminClient()
      const { data: target, error: targetError } = await admin
        .from('workspace_members')
        .select('role')
        .eq('id', memberId)
        .eq('workspace_id', workspaceId)
        .single()

      if (targetError) {
        if (targetError.code === 'PGRST116') {
          throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
        }
        throw createError({ statusCode: 500, message: targetError.message })
      }

      if (!target) {
        throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
      }

      if ((target as { role?: string }).role === 'owner') {
        throw createError({ statusCode: 400, message: errorMessage('members.cannot_change_owner_role') })
      }

      const { data, error } = await admin
        .from('workspace_members')
        .update({ role })
        .eq('id', memberId)
        .eq('workspace_id', workspaceId)
        .select(WORKSPACE_MEMBER_SELECT)
        .single()

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return data as DatabaseRow
    },

    async deleteWorkspaceMember(accessToken, userId, workspaceId, memberId) {
      await this.requireWorkspaceRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const admin = getAdminClient()
      const { data: target, error: targetError } = await admin
        .from('workspace_members')
        .select('role')
        .eq('id', memberId)
        .eq('workspace_id', workspaceId)
        .single()

      if (targetError) {
        if (targetError.code === 'PGRST116') {
          throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
        }
        throw createError({ statusCode: 500, message: targetError.message })
      }

      if (!target) {
        throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
      }

      if ((target as { role?: string }).role === 'owner') {
        throw createError({ statusCode: 400, message: errorMessage('members.cannot_remove_owner') })
      }

      const { error } = await admin
        .from('workspace_members')
        .delete()
        .eq('id', memberId)
        .eq('workspace_id', workspaceId)

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }
    },

    async updateWorkspaceMemberInvitedAt(accessToken, userId, workspaceId, memberId, invitedAt) {
      await this.requireWorkspaceRole(accessToken, userId, workspaceId, ['owner', 'admin'])

      const admin = getAdminClient()
      const { error } = await admin
        .from('workspace_members')
        .update({ invited_at: invitedAt })
        .eq('id', memberId)
        .eq('workspace_id', workspaceId)

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }
    },

    async listUserAIKeys(accessToken, workspaceId, userId) {
      const client = getUserClient(accessToken)
      const { data, error } = await client
        .from('ai_keys')
        .select('id, provider, key_hint, created_at')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return data ?? []
    },

    async upsertUserAIKey(accessToken, input) {
      const client = getUserClient(accessToken)
      const { data, error } = await client
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

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return data
    },

    async deleteUserAIKey(accessToken, workspaceId, keyId, userId) {
      const client = getUserClient(accessToken)
      const { error } = await client
        .from('ai_keys')
        .delete()
        .eq('id', keyId)
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }
    },

    async getProjectForWorkspace(accessToken, workspaceId, projectId, fields = 'id') {
      const client = getUserClient(accessToken)
      const { data, error } = await client
        .from('projects')
        .select(fields)
        .eq('id', projectId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()

      if (error && error.code !== 'PGRST116') {
        throw createError({ statusCode: 500, message: error.message })
      }

      return toDatabaseRowOrNull(data)
    },

    async countProjectWebhooks(projectId, workspaceId) {
      const admin = getAdminClient()
      const { count, error } = await admin
        .from('webhooks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('workspace_id', workspaceId)

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return count ?? 0
    },

    async createWebhook(input) {
      const admin = getAdminClient()
      const { data, error } = await admin
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

      if (error) {
        throw createError({ statusCode: 500, message: error.message })
      }

      return data
    },
  }
}
