/**
 * MCP Cloud API key + usage persistence methods for the plain-Postgres
 * DatabaseProvider. Parallel to the conversation-key methods but lives in
 * its own module so the two SKUs can evolve independently (same split as
 * the Supabase implementation).
 */
import { sql } from 'kysely'
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

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
  | 'getMcpCloudKeyUsage'
>

export function mcpCloudMethods(): McpCloudMethods {
  return {
    async getMcpCloudKeyByHash(keyHash) {
      try {
        const row = await getAdmin()
          .selectFrom('mcp_cloud_keys')
          .selectAll()
          .where('key_hash', '=', keyHash)
          .executeTakeFirst()

        return (row as DatabaseRow | undefined) ?? null
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async touchMcpCloudKey(keyId) {
      // Fire-and-forget in the Supabase impl — mirror it.
      try {
        await getAdmin()
          .updateTable('mcp_cloud_keys')
          .set({ last_used_at: new Date().toISOString() })
          .where('id', '=', keyId)
          .execute()
      }
      catch {
        // parity: swallowed
      }
    },

    async listMcpCloudKeys(workspaceId, projectId) {
      try {
        let query = getAdmin()
          .selectFrom('mcp_cloud_keys')
          .select(['id', 'name', 'key_prefix', 'project_id', 'allowed_tools', 'rate_limit_per_minute', 'monthly_call_limit', 'last_used_at', 'created_at', 'created_by', 'revoked_at'])
          .where('workspace_id', '=', workspaceId)
          .where('revoked_at', 'is', null)
          .orderBy('created_at', 'desc')

        if (projectId)
          query = query.where('project_id', '=', projectId)

        return await query.execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async createMcpCloudKey(input) {
      try {
        const row = await getAdmin()
          .insertInto('mcp_cloud_keys')
          .values({
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
          .returningAll()
          .executeTakeFirst()

        if (!row)
          throw createError({ statusCode: 500, message: 'Invalid database response' })

        return row as DatabaseRow
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async revokeMcpCloudKey(keyId, workspaceId) {
      try {
        await getAdmin()
          .updateTable('mcp_cloud_keys')
          .set({ revoked_at: new Date().toISOString() })
          .where('id', '=', keyId)
          .where('workspace_id', '=', workspaceId)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async countActiveMcpCloudKeys(workspaceId, projectId) {
      try {
        let query = getAdmin()
          .selectFrom('mcp_cloud_keys')
          .select(eb => eb.fn.countAll().as('count'))
          .where('workspace_id', '=', workspaceId)
          .where('revoked_at', 'is', null)

        if (projectId)
          query = query.where('project_id', '=', projectId)

        const row = await query.executeTakeFirst()
        return Number(row?.count ?? 0)
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async incrementMcpCloudUsageIfAllowed(input) {
      let row: { allowed: boolean, used: number }
      try {
        const outcome = await sql<{ result: typeof row }>`
          SELECT public.increment_mcp_cloud_usage_if_allowed(
            p_workspace_id => ${input.workspaceId},
            p_month => ${input.month},
            p_key_id => ${input.keyId},
            p_limit => ${input.limit}
          ) AS result
        `.execute(getAdmin())

        row = outcome.rows[0]!.result
      }
      catch (error) {
        throwDbError(error)
      }

      return { allowed: !!row.allowed, used: Number(row.used ?? 0) }
    },

    async getMcpCloudKeyUsage(keyIds, month) {
      if (keyIds.length === 0) return []

      try {
        return await getAdmin()
          .selectFrom('mcp_cloud_usage')
          .select(['mcp_key_id', 'call_count'])
          .where('mcp_key_id', 'in', keyIds)
          .where('month', '=', month)
          .execute() as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async getWorkspaceMonthlyMcpCloudUsage(workspaceId, month) {
      try {
        const row = await getAdmin()
          .selectFrom('mcp_cloud_usage')
          .select(eb => eb.fn.coalesce(eb.fn.sum('call_count'), eb.lit(0)).as('total'))
          .where('workspace_id', '=', workspaceId)
          .where('month', '=', month)
          .executeTakeFirst()

        return Number(row?.total ?? 0)
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
