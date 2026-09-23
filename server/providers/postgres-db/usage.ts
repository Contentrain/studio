/**
 * Usage aggregation methods for the plain-Postgres DatabaseProvider.
 *
 * Workspace-scoped usage totals. A failed read throws: these numbers gate
 * quota and metering paths (which must fail closed) as well as the billing
 * dashboard (which shows the meter as unavailable), and a 0 in place of an
 * error would let a quota path through (AI-15).
 */
import type { DatabaseProvider } from '../database'
import { getAdmin } from './helpers'

type UsageMethods = Pick<
  DatabaseProvider,
  | 'getWorkspaceMonthlyAIUsage'
  | 'getWorkspaceMonthlyAPIUsage'
  | 'getWorkspaceMonthlyCDNBandwidth'
  | 'listWorkspaceCDNBandwidthForDay'
>

export function usageMethods(): UsageMethods {
  return {
    async getWorkspaceMonthlyAIUsage(workspaceId, month, source = 'studio') {
      const row = await getAdmin()
        .selectFrom('agent_usage')
        .select(eb => eb.fn.coalesce(eb.fn.sum('message_count'), eb.lit(0)).as('total'))
        .where('workspace_id', '=', workspaceId)
        .where('month', '=', month)
        .where('source', '=', source)
        .executeTakeFirst()

      return Number(row?.total ?? 0)
    },

    async getWorkspaceMonthlyAPIUsage(workspaceId, month) {
      // Conversation API usage is keyed by api_key_id and lives in its own
      // aggregate table — see migration 006.
      const row = await getAdmin()
        .selectFrom('api_message_usage')
        .select(eb => eb.fn.coalesce(eb.fn.sum('message_count'), eb.lit(0)).as('total'))
        .where('workspace_id', '=', workspaceId)
        .where('month', '=', month)
        .executeTakeFirst()

      return Number(row?.total ?? 0)
    },

    async getWorkspaceMonthlyCDNBandwidth(workspaceId, month) {
      // Same month-window computation as the Supabase impl, one join instead
      // of its two round-trips (identical semantics).
      const monthStart = `${month}-01`
      const nextMonth = new Date(`${month}-01`)
      nextMonth.setMonth(nextMonth.getMonth() + 1)
      const monthEnd = nextMonth.toISOString().substring(0, 10)

      const row = await getAdmin()
        .selectFrom('cdn_usage as cu')
        .innerJoin('projects as pr', 'pr.id', 'cu.project_id')
        .select(eb => eb.fn.coalesce(eb.fn.sum('cu.bandwidth_bytes'), eb.lit(0)).as('total'))
        .where('pr.workspace_id', '=', workspaceId)
        .where('cu.period_start', '>=', monthStart)
        .where('cu.period_start', '<', monthEnd)
        .executeTakeFirst()

      return Number(row?.total ?? 0)
    },

    async listWorkspaceCDNBandwidthForDay(day) {
      // Unlike the dashboard reads above, a failure here propagates: the
      // meter job must not record "no usage" for a day it could not read.
      const rows = await getAdmin()
        .selectFrom('cdn_usage as cu')
        .innerJoin('projects as pr', 'pr.id', 'cu.project_id')
        .select(eb => ['pr.workspace_id as workspace_id', eb.fn.sum('cu.bandwidth_bytes').as('total')])
        .where('cu.period_start', '=', day)
        .groupBy('pr.workspace_id')
        .execute()

      return rows
        .map(r => ({ workspaceId: String(r.workspace_id), bytes: Number(r.total ?? 0) }))
        .filter(r => r.bytes > 0)
    },
  }
}
