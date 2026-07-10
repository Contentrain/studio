/**
 * Usage aggregation methods for the plain-Postgres DatabaseProvider.
 *
 * Workspace-scoped usage summaries for the billing dashboard. Same contract
 * as the Supabase implementation, including its deliberate error handling:
 * these read paths swallow failures and report 0 rather than breaking the
 * dashboard (the outbox pipeline, not these queries, feeds the provider).
 */
import type { DatabaseProvider } from '../database'
import { getAdmin } from './helpers'

type UsageMethods = Pick<
  DatabaseProvider,
  | 'getWorkspaceMonthlyAIUsage'
  | 'getWorkspaceMonthlyAPIUsage'
  | 'getWorkspaceMonthlyCDNBandwidth'
>

export function usageMethods(): UsageMethods {
  return {
    async getWorkspaceMonthlyAIUsage(workspaceId, month) {
      try {
        const row = await getAdmin()
          .selectFrom('agent_usage')
          .select(eb => eb.fn.coalesce(eb.fn.sum('message_count'), eb.lit(0)).as('total'))
          .where('workspace_id', '=', workspaceId)
          .where('month', '=', month)
          .where('source', '=', 'studio')
          .executeTakeFirst()

        return Number(row?.total ?? 0)
      }
      catch {
        return 0
      }
    },

    async getWorkspaceMonthlyAPIUsage(workspaceId, month) {
      // Conversation API usage is keyed by api_key_id and lives in its own
      // aggregate table — see migration 006.
      try {
        const row = await getAdmin()
          .selectFrom('api_message_usage')
          .select(eb => eb.fn.coalesce(eb.fn.sum('message_count'), eb.lit(0)).as('total'))
          .where('workspace_id', '=', workspaceId)
          .where('month', '=', month)
          .executeTakeFirst()

        return Number(row?.total ?? 0)
      }
      catch {
        return 0
      }
    },

    async getWorkspaceMonthlyCDNBandwidth(workspaceId, month) {
      // Same month-window computation as the Supabase impl, one join instead
      // of its two round-trips (identical semantics).
      const monthStart = `${month}-01`
      const nextMonth = new Date(`${month}-01`)
      nextMonth.setMonth(nextMonth.getMonth() + 1)
      const monthEnd = nextMonth.toISOString().substring(0, 10)

      try {
        const row = await getAdmin()
          .selectFrom('cdn_usage as cu')
          .innerJoin('projects as pr', 'pr.id', 'cu.project_id')
          .select(eb => eb.fn.coalesce(eb.fn.sum('cu.bandwidth_bytes'), eb.lit(0)).as('total'))
          .where('pr.workspace_id', '=', workspaceId)
          .where('cu.period_start', '>=', monthStart)
          .where('cu.period_start', '<', monthEnd)
          .executeTakeFirst()

        return Number(row?.total ?? 0)
      }
      catch {
        return 0
      }
    },
  }
}
