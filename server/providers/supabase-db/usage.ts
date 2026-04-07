/**
 * Usage aggregation and overage billing log methods for the Supabase DatabaseProvider.
 *
 * Provides workspace-scoped usage summaries for the billing dashboard
 * and overage billing log operations to prevent double-billing.
 */
import type { DatabaseProvider, DatabaseRow } from '../database'
import { getAdmin } from './helpers'

type UsageMethods = Pick<
  DatabaseProvider,
  | 'getWorkspaceMonthlyAIUsage'
  | 'getWorkspaceMonthlyAPIUsage'
  | 'getWorkspaceMonthlyCDNBandwidth'
  | 'getOverageBillingLog'
  | 'createOverageBillingEntry'
  | 'hasOverageBeenBilled'
>

export function usageMethods(): UsageMethods {
  return {
    /**
     * Sum AI message count across all users in a workspace for a given month.
     * Source: 'studio' (UI chat messages only, excludes API).
     */
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

    /**
     * Sum API message count across all API keys in a workspace for a given month.
     * Source: 'api' (Conversation API only).
     */
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

    /**
     * Sum CDN bandwidth across all projects in a workspace for a given month.
     * Joins cdn_usage → projects via project_id to scope by workspace.
     */
    async getWorkspaceMonthlyCDNBandwidth(workspaceId, month) {
      const admin = getAdmin()

      // Get all project IDs in this workspace
      const { data: projects } = await admin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspaceId)

      if (!projects || projects.length === 0) return 0

      const projectIds = projects.map((p: Record<string, unknown>) => p.id as string)

      // Month boundaries for CDN daily aggregation
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

    /**
     * Get overage billing log entries for a workspace and billing period.
     */
    async getOverageBillingLog(workspaceId, billingPeriod) {
      const { data } = await getAdmin()
        .from('overage_billing_log')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('billing_period', billingPeriod)
        .order('created_at', { ascending: false })

      return (data ?? []) as DatabaseRow[]
    },

    /**
     * Create an overage billing log entry.
     * Uses UNIQUE constraint on (workspace_id, billing_period, category) to prevent double-billing.
     */
    async createOverageBillingEntry(entry) {
      const { data, error } = await getAdmin()
        .from('overage_billing_log')
        .insert({
          workspace_id: entry.workspaceId,
          billing_period: entry.billingPeriod,
          category: entry.category,
          units_billed: entry.unitsBilled,
          unit_price: entry.unitPrice,
          total_amount: entry.totalAmount,
          stripe_invoice_item_id: entry.stripeInvoiceItemId ?? null,
        })
        .select()
        .single()

      if (error) {
        // Unique constraint violation = already billed
        if (error.code === '23505') {
          throw createError({ statusCode: 409, message: 'Overage already billed for this period and category' })
        }
        throw createError({ statusCode: 500, message: `Failed to create overage billing entry: ${error.message}` })
      }

      return data as DatabaseRow
    },

    /**
     * Check if overage has already been billed for a given workspace, period, and category.
     */
    async hasOverageBeenBilled(workspaceId, billingPeriod, category) {
      const { data } = await getAdmin()
        .from('overage_billing_log')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('billing_period', billingPeriod)
        .eq('category', category)
        .limit(1)

      return (data ?? []).length > 0
    },
  }
}
