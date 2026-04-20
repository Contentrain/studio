/**
 * GET /api/workspaces/:workspaceId/usage
 *
 * Returns usage metrics for the current billing period.
 * Each metered resource shows current usage, plan limit, overage status,
 * and cost projections. Used by the billing dashboard UI.
 */

import { OVERAGE_PRICING, getPlanLimitForPlan, normalizePlan } from '../../../../shared/utils/license'
import { calculateOverageUnits } from '../../../../server/utils/overage'

interface UsageCategory {
  key: string
  limitKey: string
  name: string
  current: number
  limit: number
  overageEnabled: boolean
  overageUnits: number
  overageUnitPrice: number
  overageAmount: number
  unit: string
  percentage: number
}

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  // Owner/admin can view usage
  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    workspaceId,
    ['owner', 'admin'],
    'id, plan, overage_settings, media_storage_bytes',
  )

  if (!workspace)
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })

  const plan = normalizePlan(workspace.plan as string | null)
  const overageSettings = (workspace.overage_settings as Record<string, boolean>) ?? {}
  const billingPeriod = new Date().toISOString().substring(0, 7) // YYYY-MM

  // Fetch all usage metrics in parallel
  const [aiUsage, apiUsage, formSubmissions, cdnBandwidthBytes, mcpCloudCalls] = await Promise.all([
    db.getWorkspaceMonthlyAIUsage(workspaceId, billingPeriod),
    db.getWorkspaceMonthlyAPIUsage(workspaceId, billingPeriod),
    db.countMonthlySubmissions(workspaceId),
    db.getWorkspaceMonthlyCDNBandwidth(workspaceId, billingPeriod),
    db.getWorkspaceMonthlyMcpCloudUsage(workspaceId, billingPeriod),
  ])

  const storageBytes = (workspace.media_storage_bytes as number) ?? 0

  // Build category metrics
  const categories: UsageCategory[] = []

  const metricsConfig: Array<{
    key: string
    limitKey: string
    name: string
    current: number
    unit: string
    transform?: (v: number) => number
  }> = [
    { key: 'ai_messages', limitKey: 'ai.messages_per_month', name: 'AI Messages', current: aiUsage, unit: 'messages' },
    { key: 'form_submissions', limitKey: 'forms.submissions_per_month', name: 'Form Submissions', current: formSubmissions, unit: 'submissions' },
    { key: 'cdn_bandwidth', limitKey: 'cdn.bandwidth_gb', name: 'CDN Bandwidth', current: cdnBandwidthBytes / (1024 * 1024 * 1024), unit: 'GB' },
    { key: 'media_storage', limitKey: 'media.storage_gb', name: 'Media Storage', current: storageBytes / (1024 * 1024 * 1024), unit: 'GB' },
    { key: 'api_messages', limitKey: 'api.messages_per_month', name: 'API Messages', current: apiUsage, unit: 'messages' },
    { key: 'mcp_calls', limitKey: 'api.mcp_calls_per_month', name: 'MCP Cloud Calls', current: mcpCloudCalls, unit: 'calls' },
  ]

  for (const m of metricsConfig) {
    const planLimit = getPlanLimitForPlan(plan, m.limitKey)
    const pricing = OVERAGE_PRICING[m.limitKey]
    const overageEnabled = pricing ? (overageSettings[pricing.settingsKey] === true) : false
    const overageUnits = calculateOverageUnits(m.current, planLimit)
    const overageUnitPrice = pricing?.price ?? 0
    const overageAmount = overageUnits * overageUnitPrice

    categories.push({
      key: m.key,
      limitKey: m.limitKey,
      name: m.name,
      current: Math.round(m.current * 100) / 100,
      limit: planLimit === Infinity ? -1 : planLimit, // -1 signals unlimited to the client
      overageEnabled,
      overageUnits: Math.round(overageUnits * 100) / 100,
      overageUnitPrice,
      overageAmount: Math.round(overageAmount * 100) / 100,
      unit: m.unit,
      percentage: planLimit === Infinity || planLimit === 0 ? 0 : Math.round((m.current / planLimit) * 100),
    })
  }

  const totalOverageAmount = categories.reduce((sum, c) => sum + c.overageAmount, 0)

  // Project to end of month based on current usage rate
  const now = new Date()
  const dayOfMonth = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const projectionMultiplier = dayOfMonth > 0 ? daysInMonth / dayOfMonth : 1

  const projectedOverageAmount = categories.reduce((sum, c) => {
    if (c.limit === -1 || c.limit === 0) return sum
    // Storage is not rate-based — use current value directly
    if (c.key === 'media_storage') return sum + c.overageAmount
    const projectedUsage = c.current * projectionMultiplier
    const projectedOverage = Math.max(0, projectedUsage - c.limit)
    return sum + (projectedOverage * c.overageUnitPrice)
  }, 0)

  // CLI-compatible flat format: ?format=simple
  const query = getQuery(event) as { format?: string }
  if (query.format === 'simple') {
    const keyMap: Record<string, string> = {
      ai_messages: 'aiMessages',
      form_submissions: 'formSubmissions',
      cdn_bandwidth: 'cdnBandwidthGb',
      media_storage: 'mediaStorageGb',
      api_messages: 'apiMessages',
      mcp_calls: 'mcpCalls',
    }
    const simple: Record<string, { current: number, limit: number, percentage: number }> = {}
    for (const c of categories) {
      const key = keyMap[c.key] ?? c.key
      simple[key] = { current: c.current, limit: c.limit, percentage: c.percentage }
    }
    return simple
  }

  return {
    billingPeriod,
    categories,
    totalOverageAmount: Math.round(totalOverageAmount * 100) / 100,
    projectedOverageAmount: Math.round(projectedOverageAmount * 100) / 100,
  }
})
