/**
 * Audit log methods for Supabase DatabaseProvider.
 *
 * Writes to the audit_logs table via admin client (bypasses RLS).
 * Used by the audit-writer Nitro plugin after successful DELETE responses.
 */
import type { DatabaseProvider } from '../database'
import { getAdmin } from './helpers'

type AuditMethods = Pick<DatabaseProvider, 'createAuditLog' | 'listAuditLogs'>

export function auditMethods(): AuditMethods {
  return {
    async createAuditLog(entry) {
      const { error } = await getAdmin()
        .from('audit_logs')
        .insert({
          workspace_id: entry.workspaceId ?? null,
          actor_id: entry.actorId ?? null,
          action: entry.action,
          table_name: entry.tableName,
          record_id: entry.recordId,
          record_snapshot: entry.recordSnapshot ?? null,
          source_ip: entry.sourceIp ?? null,
          user_agent: entry.userAgent ?? null,
          origin: entry.origin ?? 'app',
        })

      if (error) {
        // Audit log failure must never break the user's request.
        // Log and continue — the DB trigger is the safety net.
        // eslint-disable-next-line no-console
        console.error('[audit] Failed to write audit log:', error.message)
      }
    },

    async listAuditLogs(workspaceId, options) {
      const page = options?.page ?? 1
      const limit = Math.min(options?.limit ?? 20, 100)
      const offset = (page - 1) * limit

      let query = getAdmin()
        .from('audit_logs')
        .select('id, workspace_id, actor_id, action, table_name, record_id, origin, created_at', { count: 'exact' })
        .eq('workspace_id', workspaceId)

      if (options?.action) {
        query = query.eq('action', options.action)
      }

      query = options?.sort === 'oldest'
        ? query.order('created_at', { ascending: true })
        : query.order('created_at', { ascending: false })

      const { data, count, error } = await query.range(offset, offset + limit - 1)

      if (error) {
        throw createError({ statusCode: 500, message: `Failed to list audit logs: ${error.message}` })
      }

      return { data: (data ?? []) as Record<string, unknown>[], total: count ?? 0 }
    },
  }
}
