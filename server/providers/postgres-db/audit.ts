/**
 * Audit log methods for the plain-Postgres DatabaseProvider.
 *
 * Same contract as the Supabase implementation: writes never break the
 * caller (log-and-continue), reads throw 500 on failure, retention cleanup
 * goes through the shared cleanup_audit_logs() SQL function.
 */
import { sql } from 'kysely'
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

type AuditMethods = Pick<DatabaseProvider, 'createAuditLog' | 'listAuditLogs' | 'cleanupAuditLogs'>

export function auditMethods(): AuditMethods {
  return {
    async createAuditLog(entry) {
      try {
        await getAdmin()
          .insertInto('audit_logs')
          .values({
            workspace_id: entry.workspaceId ?? null,
            actor_id: entry.actorId ?? null,
            action: entry.action,
            table_name: entry.tableName,
            record_id: entry.recordId,
            record_snapshot: entry.recordSnapshot ? JSON.stringify(entry.recordSnapshot) : null,
            source_ip: entry.sourceIp ?? null,
            user_agent: entry.userAgent ?? null,
            origin: entry.origin ?? 'app',
          })
          .execute()
      }
      catch (error) {
        // Audit log failure must never break the user's request.
        // Log and continue — the DB trigger is the safety net.
        // eslint-disable-next-line no-console
        console.error('[audit] Failed to write audit log:', error instanceof Error ? error.message : error)
      }
    },

    async listAuditLogs(workspaceId, options) {
      const page = options?.page ?? 1
      const limit = Math.min(options?.limit ?? 20, 100)
      const offset = (page - 1) * limit

      try {
        let base = getAdmin()
          .selectFrom('audit_logs')
          .where('workspace_id', '=', workspaceId)

        if (options?.action)
          base = base.where('action', '=', options.action)

        const totalRow = await base
          .select(eb => eb.fn.countAll().as('total'))
          .executeTakeFirst()

        const rows = await base
          .select(['id', 'workspace_id', 'actor_id', 'action', 'table_name', 'record_id', 'origin', 'created_at'])
          .orderBy('created_at', options?.sort === 'oldest' ? 'asc' : 'desc')
          .limit(limit)
          .offset(offset)
          .execute()

        return { data: rows as DatabaseRow[], total: Number(totalRow?.total ?? 0) }
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async cleanupAuditLogs(retentionDays) {
      try {
        const result = await sql<{ purged: number }>`
          SELECT public.cleanup_audit_logs(${retentionDays ?? 90}) AS purged
        `.execute(getAdmin())

        return Number(result.rows[0]?.purged ?? 0)
      }
      catch (error) {
        // Retention cleanup failure is not critical — the next cycle retries.
        // eslint-disable-next-line no-console
        console.error('[audit] Retention cleanup failed:', error instanceof Error ? error.message : error)
        return 0
      }
    },
  }
}
