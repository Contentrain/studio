/**
 * Usage alert persistence for the Supabase DatabaseProvider
 * (`supabase/migrations/033_usage_alerts.sql`). The primary key is the claim:
 * an insert that hits it means the alert was already sent.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type UsageAlertMethods = Pick<
  DatabaseProvider,
  | 'listWorkspacesForUsageAlerts'
  | 'claimUsageAlert'
  | 'releaseUsageAlert'
>

/** Rows per request when listing; below PostgREST's default `max-rows` (1000). */
const PAGE_SIZE = 500

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505'

export function usageAlertMethods(): UsageAlertMethods {
  return {
    async listWorkspacesForUsageAlerts() {
      // Paged: PostgREST caps a response at `max-rows`, so one select would silently stop there.
      const rows: DatabaseRow[] = []
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await getAdmin()
          .from('payment_accounts')
          .select('workspaces:workspace_id!inner(id, name, slug, type, plan, owner_id, overage_settings, media_storage_bytes)')
          .eq('is_active', true)
          .order('workspace_id')
          .range(from, from + PAGE_SIZE - 1)

        if (error) throw createError({ statusCode: 500, message: error.message })
        const page = ((data ?? []) as unknown as Array<{ workspaces: DatabaseRow }>).map(r => r.workspaces)
        rows.push(...page)
        if (page.length < PAGE_SIZE) return rows
      }
    },

    async claimUsageAlert({ workspaceId, meter, periodKey, threshold }) {
      const { error } = await getAdmin()
        .from('usage_alerts')
        .insert({ workspace_id: workspaceId, meter, period_key: periodKey, threshold })

      if (!error) return true
      if (error.code === UNIQUE_VIOLATION) return false
      throw createError({ statusCode: 500, message: error.message })
    },

    async releaseUsageAlert({ workspaceId, meter, periodKey, threshold }) {
      const { error } = await getAdmin()
        .from('usage_alerts')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('meter', meter)
        .eq('period_key', periodKey)
        .eq('threshold', threshold)

      if (error) throw createError({ statusCode: 500, message: error.message })
    },
  }
}
