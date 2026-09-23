/**
 * A workspace's usage against its plan — one computation for every reader.
 *
 * The billing screen (`usage.get.ts`) and the usage alert job
 * (`server/plugins/usage-alerts.ts`) must agree on what "80 %" and "limit
 * reached" mean; two copies of this arithmetic would drift the same way the
 * receipt code once did. Both call this.
 *
 * Each meter carries its own counting window. AI credits, API credits and MCP
 * calls follow the billing period; form submissions, comments and CDN
 * bandwidth are still counted per calendar month (see `usage-period.ts`).
 * Showing one "Resets" date for all of them told a customer billed from the
 * 15th that forms reset on the 15th when they reset on the 1st.
 *
 * Money is only quoted where it can be charged: a meter's overage units,
 * amount and projection are zero unless overage is turned on for it. With the
 * switch off the meter is hard-capped, and quoting "$54.88 overage" there
 * told customers they owed something they did not.
 */
import { OVERAGE_PRICING, getPlanLimitForPlan } from '../../shared/utils/license'
import type { DatabaseProvider } from '../providers/database'
import { calculateOverageUnits, isOverageSellable } from './overage'
import type { OverageLock } from './overage-lock'
import { usagePeriodFrom } from './usage-period'
import type { UsagePeriod } from './usage-period'

export interface WorkspaceUsageCategory {
  key: string
  limitKey: string
  name: string
  current: number
  limit: number
  overageEnabled: boolean
  /** False when usage past the limit is not sold at all — a hard cap. */
  overageSellable: boolean
  /** Set → overage cannot be turned on yet: why, and until when. */
  overageLock: OverageLock | null
  /** Units past the limit that will be billed — zero while overage is off. */
  overageUnits: number
  /** Price per unit past the limit; shown beside the switch before it is turned on. */
  overageUnitPrice: number
  overageAmount: number
  unit: string
  percentage: number
  /** When this meter goes back to zero; null for a meter that does not reset (storage). */
  resetsAt: string | null
  /** The window this meter is counted in — also the dedupe key for usage alerts. */
  periodKey: string
}

export interface WorkspaceUsage {
  categories: WorkspaceUsageCategory[]
  byoaRequests: number
  totalOverageAmount: number
  projectedOverageAmount: number
}

type UsageReader = Pick<DatabaseProvider,
  | 'getWorkspaceMonthlyAIUsage'
  | 'getWorkspaceMonthlyAPIUsage'
  | 'countMonthlySubmissions'
  | 'getWorkspaceMonthlyCDNBandwidth'
  | 'getWorkspaceMonthlyMcpCloudUsage'
  | 'countMonthlyComments'
>

const GB = 1024 * 1024 * 1024
const round2 = (value: number) => Math.round(value * 100) / 100

export async function computeWorkspaceUsage(db: UsageReader, input: {
  workspaceId: string
  plan: string
  overageSettings: Record<string, boolean>
  storageBytes: number
  /** The billing (or calendar) period the three credit pools are keyed by. */
  period: UsagePeriod
  overageLocks?: Record<string, OverageLock>
  now?: Date
}): Promise<WorkspaceUsage> {
  const { workspaceId, plan, overageSettings, period } = input
  const now = input.now ?? new Date()
  // Forms, comments and CDN keep the calendar month: their rows are written
  // by date-range aggregators, and the CDN reader expands a `YYYY-MM` key into
  // a month window — a `YYYY-MM-DD` key would report zero.
  const calendar = usagePeriodFrom(null, now)

  const [aiUsage, byoaRequests, apiUsage, formSubmissions, cdnBandwidthBytes, mcpCloudCalls, comments] = await Promise.all([
    db.getWorkspaceMonthlyAIUsage(workspaceId, period.key),
    // Turns run on members' own Anthropic keys. Shown beside the AI credits,
    // never counted in them (migration 030, chat route metering guard).
    db.getWorkspaceMonthlyAIUsage(workspaceId, period.key, 'byoa'),
    db.getWorkspaceMonthlyAPIUsage(workspaceId, period.key),
    db.countMonthlySubmissions(workspaceId),
    db.getWorkspaceMonthlyCDNBandwidth(workspaceId, calendar.key),
    db.getWorkspaceMonthlyMcpCloudUsage(workspaceId, period.key),
    db.countMonthlyComments(workspaceId),
  ])

  const meters: Array<{ key: string, limitKey: string, name: string, current: number, unit: string, window: UsagePeriod | null }> = [
    { key: 'ai_messages', limitKey: 'ai.messages_per_month', name: 'AI Credits', current: aiUsage, unit: 'credits', window: period },
    { key: 'form_submissions', limitKey: 'forms.submissions_per_month', name: 'Form Submissions', current: formSubmissions, unit: 'submissions', window: calendar },
    { key: 'comments', limitKey: 'comments.per_month', name: 'Comments', current: comments, unit: 'comments', window: calendar },
    { key: 'cdn_bandwidth', limitKey: 'cdn.bandwidth_gb', name: 'CDN Bandwidth', current: cdnBandwidthBytes / GB, unit: 'GB', window: calendar },
    // Storage is a level, not a rate: it does not reset and is not projected.
    { key: 'media_storage', limitKey: 'media.storage_gb', name: 'Media Storage', current: input.storageBytes / GB, unit: 'GB', window: null },
    { key: 'api_messages', limitKey: 'api.messages_per_month', name: 'API Credits', current: apiUsage, unit: 'credits', window: period },
    { key: 'mcp_calls', limitKey: 'api.mcp_calls_per_month', name: 'MCP Cloud Calls', current: mcpCloudCalls, unit: 'calls', window: period },
  ]

  const categories: WorkspaceUsageCategory[] = []
  let projectedOverageAmount = 0

  for (const m of meters) {
    const planLimit = getPlanLimitForPlan(plan, m.limitKey)
    const pricing = OVERAGE_PRICING[m.limitKey]
    // A limit that is not sellable is a hard cap: the toggle is ignored and
    // no amount is quoted, whatever `overage_settings` still holds.
    // A limit with no overage price (comments) is not sold either: there is
    // no meter to bill it on, so it is a fixed limit, not a toggle that 400s.
    const sellable = !!pricing && isOverageSellable(m.limitKey)
    const overageLock = pricing ? input.overageLocks?.[pricing.settingsKey] ?? null : null
    const overageEnabled = sellable && pricing && !overageLock ? (overageSettings[pricing.settingsKey] === true) : false
    const overageUnitPrice = sellable ? pricing?.price ?? 0 : 0
    const overageUnits = overageEnabled ? calculateOverageUnits(m.current, planLimit) : 0
    const overageAmount = overageUnits * overageUnitPrice

    if (overageEnabled && planLimit !== Infinity && planLimit > 0) {
      if (!m.window) {
        projectedOverageAmount += overageAmount
      }
      else {
        // Project each meter across its own window: a calendar counter scaled
        // by the billing period would be off by whatever offset sits between them.
        const start = new Date(m.window.startsAt).getTime()
        const end = new Date(m.window.resetsAt).getTime()
        const multiplier = Math.max(end - start, 1) / Math.max(now.getTime() - start, 1)
        projectedOverageAmount += Math.max(0, m.current * multiplier - planLimit) * overageUnitPrice
      }
    }

    categories.push({
      key: m.key,
      limitKey: m.limitKey,
      name: m.name,
      current: round2(m.current),
      limit: planLimit === Infinity ? -1 : planLimit, // -1 signals unlimited to the client
      overageEnabled,
      overageSellable: sellable,
      overageLock,
      overageUnits: round2(overageUnits),
      overageUnitPrice,
      overageAmount: round2(overageAmount),
      unit: m.unit,
      percentage: planLimit === Infinity || planLimit === 0 ? 0 : Math.round((m.current / planLimit) * 100),
      resetsAt: m.window?.resetsAt ?? null,
      periodKey: (m.window ?? calendar).key,
    })
  }

  return {
    categories,
    byoaRequests,
    totalOverageAmount: round2(categories.reduce((sum, c) => sum + c.overageAmount, 0)),
    projectedOverageAmount: round2(projectedOverageAmount),
  }
}
