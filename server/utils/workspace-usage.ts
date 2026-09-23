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
 *
 * A meter whose read fails is never counted as 0 (AI-15). By default the
 * error propagates. The billing screen and the alert job ask for
 * `readErrors: 'unavailable'`: that meter comes back marked `unavailable`,
 * with no percentage, overage or projection (so it never alerts), the failure
 * is reported, and the other meters are unaffected.
 */
import { OVERAGE_PRICING, getPlanLimitForPlan } from '../../shared/utils/license'
import { CURRENT_CREDIT_UNIT, creditTermsFor, isCreditLimitKey } from '../../shared/utils/credit-unit'
import type { CreditUnit } from '../../shared/utils/credit-unit'
import type { DatabaseProvider } from '../providers/database'
import { calculateOverageUnits, isOverageSellable } from './overage'
import type { OverageLock } from './overage-lock'
import { reportBillingRisk } from './alert'
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
  /** The read failed: `current`, `percentage` and the overage fields are 0 and mean nothing. */
  unavailable?: boolean
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
  /**
   * `throw` (default): a failed read rejects the whole computation.
   * `unavailable`: that meter is marked `unavailable` and the rest still show.
   */
  readErrors?: 'throw' | 'unavailable'
  /**
   * The credit unit the account is billed in. Credit limits and every
   * overage price are read in it (`credit-unit.ts`); absent = current unit.
   */
  creditUnit?: CreditUnit
}): Promise<WorkspaceUsage> {
  const { workspaceId, plan, overageSettings, period } = input
  const terms = creditTermsFor(input.creditUnit ?? CURRENT_CREDIT_UNIT)
  const now = input.now ?? new Date()
  // Forms, comments and CDN keep the calendar month: their rows are written
  // by date-range aggregators, and the CDN reader expands a `YYYY-MM` key into
  // a month window — a `YYYY-MM-DD` key would report zero.
  const calendar = usagePeriodFrom(null, now)

  const reads = await Promise.allSettled([
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
  const failed = reads.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed && input.readErrors !== 'unavailable') throw failed.reason
  const READ_NAMES = ['ai_messages', 'byoa', 'api_messages', 'form_submissions', 'cdn_bandwidth', 'mcp_calls', 'comments']
  reads.forEach((r, i) => {
    if (r.status === 'rejected') reportBillingRisk(r.reason, { op: `usage-read.${READ_NAMES[i]}`, workspaceId })
  })
  // null: the read failed.
  const value = (i: number): number | null => {
    const r = reads[i]!
    return r.status === 'fulfilled' ? r.value : null
  }
  const [aiUsage, byoaRequests, apiUsage, formSubmissions, cdnBandwidthBytes, mcpCloudCalls, comments] = [0, 1, 2, 3, 4, 5, 6].map(value)

  const meters: Array<{ key: string, limitKey: string, name: string, current: number | null, unit: string, window: UsagePeriod | null }> = [
    { key: 'ai_messages', limitKey: 'ai.messages_per_month', name: 'AI Credits', current: aiUsage ?? null, unit: 'credits', window: period },
    { key: 'form_submissions', limitKey: 'forms.submissions_per_month', name: 'Form Submissions', current: formSubmissions ?? null, unit: 'submissions', window: calendar },
    { key: 'comments', limitKey: 'comments.per_month', name: 'Comments', current: comments ?? null, unit: 'comments', window: calendar },
    { key: 'cdn_bandwidth', limitKey: 'cdn.bandwidth_gb', name: 'CDN Bandwidth', current: cdnBandwidthBytes == null ? null : cdnBandwidthBytes / GB, unit: 'GB', window: calendar },
    // Storage is a level, not a rate: it does not reset and is not projected.
    { key: 'media_storage', limitKey: 'media.storage_gb', name: 'Media Storage', current: input.storageBytes / GB, unit: 'GB', window: null },
    { key: 'api_messages', limitKey: 'api.messages_per_month', name: 'API Credits', current: apiUsage ?? null, unit: 'credits', window: period },
    { key: 'mcp_calls', limitKey: 'api.mcp_calls_per_month', name: 'MCP Cloud Calls', current: mcpCloudCalls ?? null, unit: 'calls', window: period },
  ]

  const categories: WorkspaceUsageCategory[] = []
  let projectedOverageAmount = 0

  for (const m of meters) {
    const planLimit = isCreditLimitKey(m.limitKey) ? terms.creditLimit(plan, m.limitKey) : getPlanLimitForPlan(plan, m.limitKey)
    const unavailable = m.current === null
    const current = m.current ?? 0
    const pricing = OVERAGE_PRICING[m.limitKey]
    // A limit that is not sellable is a hard cap: the toggle is ignored and
    // no amount is quoted, whatever `overage_settings` still holds.
    // A limit with no overage price (comments) is not sold either: there is
    // no meter to bill it on, so it is a fixed limit, not a toggle that 400s.
    const sellable = !!pricing && isOverageSellable(m.limitKey)
    const overageLock = pricing ? input.overageLocks?.[pricing.settingsKey] ?? null : null
    const overageEnabled = sellable && pricing && !overageLock ? (overageSettings[pricing.settingsKey] === true) : false
    // The price the account's own product sells overage at.
    const overageUnitPrice = sellable ? terms.overagePrice(m.limitKey) ?? 0 : 0
    const overageUnits = overageEnabled && !unavailable ? calculateOverageUnits(current, planLimit) : 0
    const overageAmount = overageUnits * overageUnitPrice

    if (overageEnabled && !unavailable && planLimit !== Infinity && planLimit > 0) {
      if (!m.window) {
        projectedOverageAmount += overageAmount
      }
      else {
        // Project each meter across its own window: a calendar counter scaled
        // by the billing period would be off by whatever offset sits between them.
        const start = new Date(m.window.startsAt).getTime()
        const end = new Date(m.window.resetsAt).getTime()
        const multiplier = Math.max(end - start, 1) / Math.max(now.getTime() - start, 1)
        projectedOverageAmount += Math.max(0, current * multiplier - planLimit) * overageUnitPrice
      }
    }

    categories.push({
      key: m.key,
      limitKey: m.limitKey,
      name: m.name,
      current: round2(current),
      limit: planLimit === Infinity ? -1 : planLimit, // -1 signals unlimited to the client
      overageEnabled,
      overageSellable: sellable,
      overageLock,
      overageUnits: round2(overageUnits),
      overageUnitPrice,
      overageAmount: round2(overageAmount),
      unit: m.unit,
      percentage: unavailable || planLimit === Infinity || planLimit === 0 ? 0 : Math.round((current / planLimit) * 100),
      resetsAt: m.window?.resetsAt ?? null,
      periodKey: (m.window ?? calendar).key,
      ...(unavailable ? { unavailable: true } : {}),
    })
  }

  return {
    categories,
    // A line beside the AI meter, not a meter: an unreadable count shows no line.
    byoaRequests: byoaRequests ?? 0,
    totalOverageAmount: round2(categories.reduce((sum, c) => sum + c.overageAmount, 0)),
    projectedOverageAmount: round2(projectedOverageAmount),
  }
}
