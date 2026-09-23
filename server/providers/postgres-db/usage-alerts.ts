/**
 * Usage alert persistence for the plain-Postgres DatabaseProvider
 * (`supabase/migrations/033_usage_alerts.sql`). Same contract as the Supabase
 * implementation: the primary key is the claim.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin, throwDbError } from './helpers'

type UsageAlertMethods = Pick<
  DatabaseProvider,
  | 'listWorkspacesForUsageAlerts'
  | 'claimUsageAlert'
  | 'releaseUsageAlert'
>

export function usageAlertMethods(): UsageAlertMethods {
  return {
    async listWorkspacesForUsageAlerts() {
      try {
        const rows = await getAdmin()
          .selectFrom('workspaces')
          .innerJoin('payment_accounts', 'payment_accounts.workspace_id', 'workspaces.id')
          .select([
            'workspaces.id',
            'workspaces.name',
            'workspaces.slug',
            'workspaces.type',
            'workspaces.plan',
            'workspaces.owner_id',
            'workspaces.overage_settings',
            'workspaces.media_storage_bytes',
          ])
          .where('payment_accounts.is_active', '=', true)
          .execute()
        return rows as unknown as DatabaseRow[]
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async claimUsageAlert({ workspaceId, meter, periodKey, threshold }) {
      try {
        const inserted = await getAdmin()
          .insertInto('usage_alerts')
          .values({ workspace_id: workspaceId, meter, period_key: periodKey, threshold })
          .onConflict(oc => oc.doNothing())
          .returning('workspace_id')
          .executeTakeFirst()
        return !!inserted
      }
      catch (error) {
        throwDbError(error)
      }
    },

    async releaseUsageAlert({ workspaceId, meter, periodKey, threshold }) {
      try {
        await getAdmin()
          .deleteFrom('usage_alerts')
          .where('workspace_id', '=', workspaceId)
          .where('meter', '=', meter)
          .where('period_key', '=', periodKey)
          .where('threshold', '=', threshold)
          .execute()
      }
      catch (error) {
        throwDbError(error)
      }
    },
  }
}
