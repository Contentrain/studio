/**
 * MCP Cloud API key + usage persistence methods for the Supabase
 * DatabaseProvider. Parallel to the conversation-key methods but
 * lives in its own module so the two SKUs can evolve independently.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type McpCloudMethods = Pick<
  DatabaseProvider,
  | 'getMcpCloudKeyByHash'
  | 'touchMcpCloudKey'
  | 'listMcpCloudKeys'
  | 'createMcpCloudKey'
  | 'revokeMcpCloudKey'
  | 'countActiveMcpCloudKeys'
  | 'incrementMcpCloudUsageIfAllowed'
  | 'getWorkspaceMonthlyMcpCloudUsage'
>

export function mcpCloudMethods(): McpCloudMethods {
  return {
    async getMcpCloudKeyByHash(keyHash) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('mcp_cloud_keys')
        .select('*')
        .eq('key_hash', keyHash)
        .maybeSingle()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? null) as DatabaseRow | null
    },

    async touchMcpCloudKey(keyId) {
      const admin = getAdmin()
      await admin
        .from('mcp_cloud_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyId)
    },

    async listMcpCloudKeys(workspaceId, projectId) {
      const admin = getAdmin()
      let query = admin
        .from('mcp_cloud_keys')
        .select('id, name, key_prefix, project_id, allowed_tools, rate_limit_per_minute, monthly_call_limit, last_used_at, created_at, created_by, revoked_at')
        .eq('workspace_id', workspaceId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false })

      if (projectId) query = query.eq('project_id', projectId)

      const { data, error } = await query
      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []) as unknown as DatabaseRow[]
    },

    async createMcpCloudKey(input) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('mcp_cloud_keys')
        .insert({
          workspace_id: input.workspaceId,
          project_id: input.projectId,
          name: input.name,
          key_hash: input.keyHash,
          key_prefix: input.keyPrefix,
          allowed_tools: input.allowedTools,
          rate_limit_per_minute: input.rateLimitPerMinute ?? 60,
          monthly_call_limit: input.monthlyCallLimit ?? null,
          created_by: input.createdBy ?? null,
        })
        .select('*')
        .single()

      if (error) throw createError({ statusCode: 500, message: error.message })
      return data as DatabaseRow
    },

    async revokeMcpCloudKey(keyId, workspaceId) {
      const admin = getAdmin()
      const { error } = await admin
        .from('mcp_cloud_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', keyId)
        .eq('workspace_id', workspaceId)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },

    async countActiveMcpCloudKeys(workspaceId, projectId) {
      const admin = getAdmin()
      let query = admin
        .from('mcp_cloud_keys')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .is('revoked_at', null)

      if (projectId) query = query.eq('project_id', projectId)

      const { count, error } = await query
      if (error) throw createError({ statusCode: 500, message: error.message })
      return count ?? 0
    },

    async incrementMcpCloudUsageIfAllowed(input) {
      const admin = getAdmin()
      const { data, error } = await admin.rpc('increment_mcp_cloud_usage_if_allowed', {
        p_workspace_id: input.workspaceId,
        p_month: input.month,
        p_key_id: input.keyId,
        p_limit: input.limit,
      })

      if (error) throw createError({ statusCode: 500, message: error.message })
      const row = data as { allowed: boolean, used: number }
      return { allowed: !!row.allowed, used: Number(row.used ?? 0) }
    },

    async getWorkspaceMonthlyMcpCloudUsage(workspaceId, month) {
      const admin = getAdmin()
      const { data, error } = await admin
        .from('mcp_cloud_usage')
        .select('call_count')
        .eq('workspace_id', workspaceId)
        .eq('month', month)

      if (error) throw createError({ statusCode: 500, message: error.message })
      return (data ?? []).reduce((sum, row) => sum + ((row as { call_count?: number }).call_count ?? 0), 0)
    },
  }
}
