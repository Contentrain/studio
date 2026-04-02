/**
 * Audit log writer — Nitro plugin.
 *
 * Hooks into afterResponse to persist audit logs after successful DELETE
 * responses. Reads the snapshot stored by 04.audit.ts middleware in
 * event.context._audit.
 *
 * Also sets up a daily retention cleanup (purges logs older than 90 days).
 */
import type { AuditSnapshot } from '../utils/audit'

export default defineNitroPlugin((nitroApp) => {
  // ─── After response: persist audit log ───
  nitroApp.hooks.hook('afterResponse', async (event) => {
    const audit = event.context._audit as AuditSnapshot | undefined
    if (!audit) return

    // Only log successful deletions (2xx)
    const statusCode = event.node.res.statusCode
    if (statusCode >= 400) return

    try {
      const db = useDatabaseProvider()
      await db.createAuditLog({
        workspaceId: audit.workspaceId,
        actorId: audit.actorId,
        action: audit.action,
        tableName: audit.entity,
        recordId: audit.recordId,
        recordSnapshot: audit.snapshot as Record<string, unknown> | null,
        sourceIp: audit.sourceIp,
        userAgent: audit.userAgent,
        origin: 'app',
      })
    }
    catch {
      // Audit log failure must never affect the user.
      // DB trigger on form_submissions is the safety net.
      // eslint-disable-next-line no-console
      console.error('[audit] Failed to persist audit log for', audit.action, audit.recordId)
    }
  })

  // ─── Retention cleanup: daily purge of logs older than 90 days ───
  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000 // 24 hours
  const interval = setInterval(async () => {
    try {
      const { createSupabaseAdminClient } = await import('../providers/supabase-db/index')
      const admin = createSupabaseAdminClient()
      const { data } = await admin.rpc('cleanup_audit_logs', { retention_days: 90 })
      if (data && Number(data) > 0) {
        // eslint-disable-next-line no-console
        console.info(`[audit] Retention cleanup: purged ${data} logs older than 90 days`)
      }
    }
    catch {
      // Cleanup failure is not critical — will retry next cycle
    }
  }, CLEANUP_INTERVAL)

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})
