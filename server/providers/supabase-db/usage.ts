/**
 * Usage aggregation methods for the Supabase DatabaseProvider.
 *
 * Workspace-scoped usage summaries used by the billing dashboard to
 * render current-period consumption. These queries read from existing
 * usage tables (`agent_usage`, `cdn_usage`) and are independent of the
 * outbox pipeline — the outbox handles provider ingestion while these
 * queries power the UI and the quota checks. A failed read throws rather
 * than reading as 0, which would let a quota path through (AI-15).
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
      const { data, error } = await getAdmin()
        .from('agent_usage')
        .select('message_count')
        .eq('workspace_id', workspaceId)
        .eq('month', month)
        .eq('source', source)
      if (error) throw createError({ statusCode: 500, message: error.message })

      return (data ?? []).reduce(
        (sum: number, r: Record<string, unknown>) => sum + ((r.message_count as number) ?? 0),
        0,
      )
    },

    async getWorkspaceMonthlyAPIUsage(workspaceId, month) {
      // Conversation API usage is keyed by `api_key_id`, not `user_id`,
      // and lives in its own aggregate table — see migration 006.
      const { data, error } = await getAdmin()
        .from('api_message_usage')
        .select('message_count')
        .eq('workspace_id', workspaceId)
        .eq('month', month)
      if (error) throw createError({ statusCode: 500, message: error.message })

      return (data ?? []).reduce(
        (sum: number, r: Record<string, unknown>) => sum + ((r.message_count as number) ?? 0),
        0,
      )
    },

    async getWorkspaceMonthlyCDNBandwidth(workspaceId, month) {
      const admin = getAdmin()

      const { data: projects, error } = await admin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspaceId)
      if (error) throw createError({ statusCode: 500, message: error.message })

      if (!projects || projects.length === 0) return 0

      const projectIds = projects.map((p: Record<string, unknown>) => p.id as string)

      const monthStart = `${month}-01`
      const nextMonth = new Date(`${month}-01`)
      nextMonth.setMonth(nextMonth.getMonth() + 1)
      const monthEnd = nextMonth.toISOString().substring(0, 10)

      const { data, error: usageError } = await admin
        .from('cdn_usage')
        .select('bandwidth_bytes')
        .in('project_id', projectIds)
        .gte('period_start', monthStart)
        .lt('period_start', monthEnd)
      if (usageError) throw createError({ statusCode: 500, message: usageError.message })

      return (data ?? []).reduce(
        (sum: number, r: Record<string, unknown>) => sum + ((r.bandwidth_bytes as number) ?? 0),
        0,
      )
    },

    async listWorkspaceCDNBandwidthForDay(day) {
      // A failure propagates — the meter job must not record "no usage"
      // for a day it could not read.
      const admin = getAdmin()
      const { data: usage, error } = await admin
        .from('cdn_usage')
        .select('project_id, bandwidth_bytes')
        .eq('period_start', day)
      if (error) throw error
      if (!usage || usage.length === 0) return []

      const projectIds = [...new Set(usage.map((r: Record<string, unknown>) => r.project_id as string))]
      const { data: projects, error: projectError } = await admin
        .from('projects')
        .select('id, workspace_id')
        .in('id', projectIds)
      if (projectError) throw projectError
      const workspaceOf = new Map((projects ?? []).map((p: Record<string, unknown>) => [p.id as string, p.workspace_id as string]))

      const totals = new Map<string, number>()
      for (const row of usage as Array<Record<string, unknown>>) {
        const workspaceId = workspaceOf.get(row.project_id as string)
        if (!workspaceId) continue
        totals.set(workspaceId, (totals.get(workspaceId) ?? 0) + Number(row.bandwidth_bytes ?? 0))
      }
      return [...totals].map(([workspaceId, bytes]) => ({ workspaceId, bytes })).filter(r => r.bytes > 0)
    },
  }
}
