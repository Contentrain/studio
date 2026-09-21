/**
 * GET /api/workspaces/:workspaceId/usage
 *
 * Returns usage metrics for the current billing period.
 * Each metered resource shows current usage, plan limit, overage status,
 * and cost projections. Used by the billing dashboard UI.
 */

import { OVERAGE_PRICING, getPlanLimitForPlan, normalizePlan } from '../../../../shared/utils/license'
import { calculateOverageUnits, isOverageSellable } from '../../../../server/utils/overage'
import { resolveUsagePeriod } from '../../../../server/utils/usage-period'

interface UsageCategory {
  key: string
  limitKey: string
  name: string
  current: number
  limit: number
  overageEnabled: boolean
  /** False when usage past the limit is not sold at all — a hard cap. */
  overageSellable: boolean
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

  // The same plan the limits are actually enforced against. Reading
  // `workspaces.plan` directly would show a locked workspace (expired
  // trial, expired grace) the limits of the plan it no longer has —
  // every gate resolves through `effectivePlan`, so this screen must too.
  const plan = event.context?.billing?.effectivePlan ?? normalizePlan(workspace.plan as string | null)
  const overageSettings = (workspace.overage_settings as Record<string, boolean>) ?? {}

  // The three credit pools are counted in the workspace's billing period.
  const period = await resolveUsagePeriod(workspaceId)
  // CDN bandwidth is not: `cdn_usage` rows are written by a date-range
  // aggregator keyed `YYYY-MM`, and the reader expands the key into a
  // month window — handing it a `YYYY-MM-DD` key would build a nonsense
  // range and report zero. Form submissions and comments are counted the
  // same calendar way, from `created_at`. Aligning those three is a
  // separate change; they keep the old key here so the numbers stay real.
  const calendarMonth = new Date().toISOString().substring(0, 7)

  // Fetch all usage metrics in parallel
  const [aiUsage, apiUsage, formSubmissions, cdnBandwidthBytes, mcpCloudCalls, comments] = await Promise.all([
    db.getWorkspaceMonthlyAIUsage(workspaceId, period.key),
    db.getWorkspaceMonthlyAPIUsage(workspaceId, period.key),
    db.countMonthlySubmissions(workspaceId),
    db.getWorkspaceMonthlyCDNBandwidth(workspaceId, calendarMonth),
    db.getWorkspaceMonthlyMcpCloudUsage(workspaceId, period.key),
    db.countMonthlyComments(workspaceId),
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
    { key: 'ai_messages', limitKey: 'ai.messages_per_month', name: 'AI Credits', current: aiUsage, unit: 'credits' },
    { key: 'form_submissions', limitKey: 'forms.submissions_per_month', name: 'Form Submissions', current: formSubmissions, unit: 'submissions' },
    { key: 'comments', limitKey: 'comments.per_month', name: 'Comments', current: comments, unit: 'comments' },
    { key: 'cdn_bandwidth', limitKey: 'cdn.bandwidth_gb', name: 'CDN Bandwidth', current: cdnBandwidthBytes / (1024 * 1024 * 1024), unit: 'GB' },
    { key: 'media_storage', limitKey: 'media.storage_gb', name: 'Media Storage', current: storageBytes / (1024 * 1024 * 1024), unit: 'GB' },
    { key: 'api_messages', limitKey: 'api.messages_per_month', name: 'API Credits', current: apiUsage, unit: 'credits' },
    { key: 'mcp_calls', limitKey: 'api.mcp_calls_per_month', name: 'MCP Cloud Calls', current: mcpCloudCalls, unit: 'calls' },
  ]

  for (const m of metricsConfig) {
    const planLimit = getPlanLimitForPlan(plan, m.limitKey)
    const pricing = OVERAGE_PRICING[m.limitKey]
    // A limit that is not sellable is a hard cap: the toggle is ignored
    // and no amount is quoted, whatever `overage_settings` still holds.
    const sellable = isOverageSellable(m.limitKey)
    const overageEnabled = sellable && pricing ? (overageSettings[pricing.settingsKey] === true) : false
    const overageUnits = sellable ? calculateOverageUnits(m.current, planLimit) : 0
    const overageUnitPrice = sellable ? pricing?.price ?? 0 : 0
    const overageAmount = overageUnits * overageUnitPrice

    categories.push({
      key: m.key,
      limitKey: m.limitKey,
      name: m.name,
      current: Math.round(m.current * 100) / 100,
      limit: planLimit === Infinity ? -1 : planLimit, // -1 signals unlimited to the client
      overageEnabled,
      overageSellable: sellable,
      overageUnits: Math.round(overageUnits * 100) / 100,
      overageUnitPrice,
      overageAmount: Math.round(overageAmount * 100) / 100,
      unit: m.unit,
      percentage: planLimit === Infinity || planLimit === 0 ? 0 : Math.round((m.current / planLimit) * 100),
    })
  }

  const totalOverageAmount = categories.reduce((sum, c) => sum + c.overageAmount, 0)

  // Project to the end of the period based on the rate so far. This has to
  // use the same window the counters use — projecting a billing-period
  // count against a calendar month would rescale it by whatever offset
  // sits between the two.
  const now = new Date()
  const periodStart = new Date(period.startsAt).getTime()
  const periodEnd = new Date(period.resetsAt).getTime()
  const elapsedMs = Math.max(now.getTime() - periodStart, 1)
  const totalMs = Math.max(periodEnd - periodStart, 1)
  const projectionMultiplier = totalMs / elapsedMs

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
      comments: 'comments',
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
    // Kept as the period key for compatibility with existing clients.
    billingPeriod: period.key,
    // What the screen tells the user: when this window opened, when the
    // counters reset, and whether that date follows their subscription or
    // the calendar. Without it "45 / 500" does not say how long 45 took.
    period: {
      startsAt: period.startsAt,
      resetsAt: period.resetsAt,
      source: period.source,
    },
    categories,
    totalOverageAmount: Math.round(totalOverageAmount * 100) / 100,
    projectedOverageAmount: Math.round(projectedOverageAmount * 100) / 100,
  }
})
