/**
 * Usage aggregation methods for the Supabase DatabaseProvider.
 *
 * Workspace-scoped usage summaries used by the billing dashboard to
 * render current-period consumption. These queries read from existing
 * usage tables (`agent_usage`, `cdn_usage`) and are independent of the
 * outbox pipeline — the outbox handles provider ingestion while these
 * queries power the UI.
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
      const { data } = await getAdmin()
        .from('agent_usage')
        .select('message_count')
        .eq('workspace_id', workspaceId)
        .eq('month', month)
        .eq('source', 'studio')

      return (data ?? []).reduce(
        (sum: number, r: Record<string, unknown>) => sum + ((r.message_count as number) ?? 0),
        0,
      )
    },

    async getWorkspaceMonthlyAPIUsage(workspaceId, month) {
      const { data } = await getAdmin()
        .from('agent_usage')
        .select('message_count')
        .eq('workspace_id', workspaceId)
        .eq('month', month)
        .eq('source', 'api')

      return (data ?? []).reduce(
        (sum: number, r: Record<string, unknown>) => sum + ((r.message_count as number) ?? 0),
        0,
      )
    },

    async getWorkspaceMonthlyCDNBandwidth(workspaceId, month) {
      const admin = getAdmin()

      const { data: projects } = await admin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspaceId)

      if (!projects || projects.length === 0) return 0

      const projectIds = projects.map((p: Record<string, unknown>) => p.id as string)

      const monthStart = `${month}-01`
      const nextMonth = new Date(`${month}-01`)
      nextMonth.setMonth(nextMonth.getMonth() + 1)
      const monthEnd = nextMonth.toISOString().substring(0, 10)

      const { data } = await admin
        .from('cdn_usage')
        .select('bandwidth_bytes')
        .in('project_id', projectIds)
        .gte('period_start', monthStart)
        .lt('period_start', monthEnd)

      return (data ?? []).reduce(
        (sum: number, r: Record<string, unknown>) => sum + ((r.bandwidth_bytes as number) ?? 0),
        0,
      )
    },
  }
}
