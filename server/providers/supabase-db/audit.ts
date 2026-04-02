/**
 * Audit log methods for Supabase DatabaseProvider.
 *
 * Writes to the audit_logs table via admin client (bypasses RLS).
 * Used by the audit-writer Nitro plugin after successful DELETE responses.
 */
import type { DatabaseProvider } from '../database'
import { getAdmin } from './helpers'

type AuditMethods = Pick<DatabaseProvider, 'createAuditLog'>

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
  }
}
