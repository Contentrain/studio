/**
 * The window a usage quota is counted in.
 *
 * Quotas used to be keyed by calendar month (`YYYY-MM`), while the
 * subscription is billed from its own anniversary. A workspace that
 * subscribed on the 21st therefore got a full fresh quota on the 1st,
 * ten days into a paid period it had already paid once for — one free
 * quota per customer, sized by how late in the month they signed up.
 *
 * A subscribed workspace is now keyed by the **start date of its billing
 * period** (`YYYY-MM-DD`), so the counter resets exactly when the invoice
 * does. Workspaces with no subscription (free tier, self-hosted, any
 * deployment with no payment plugin) keep the calendar month: there is no
 * billing period to align to, and their behaviour is unchanged.
 *
 * Both keys live in the same `month text` column. They cannot collide —
 * one is ten characters, the other seven — so historical rows keep their
 * own key and nothing needs rewriting.
 *
 * Scope: this covers the three quota pools keyed by that column — AI
 * credits (`agent_usage`), API credits (`api_message_usage`) and MCP
 * calls (`mcp_cloud_usage` / `mcp_oauth_usage`). Form submissions,
 * comments and CDN bandwidth are still counted per calendar month
 * because their rows are written by date-range aggregators rather than
 * by a period key; aligning those is a larger change and is tracked
 * separately.
 */

export type UsagePeriodSource = 'billing' | 'calendar'

export interface UsagePeriod {
  /** Value written to (and read from) the `month` column. */
  key: string
  /** ISO instant the window opened. */
  startsAt: string
  /** ISO instant the window closes and the quota resets. */
  resetsAt: string
  source: UsagePeriodSource
}

/** The shape this module needs from an active payment account row. */
export interface UsagePeriodAccount {
  current_period_start?: string | Date | null
  current_period_end?: string | Date | null
  subscription_status?: string | null
}

/** Statuses that carry a real billing period. */
const BILLED_STATUSES = new Set(['active', 'trialing', 'past_due', 'canceled'])

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Shift by whole months, clamping the day to the target month's length.
 *
 * `Date.setUTCMonth` overflows instead of clamping: 31 March minus one
 * month is 3 March, not 28 February. A billing period that starts on the
 * 31st exists for every month, so the clamp is not an edge case here —
 * it is half the calendar.
 */
export function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate()
  const shifted = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    1,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ))
  const daysInTarget = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate()
  shifted.setUTCDate(Math.min(day, daysInTarget))
  return shifted
}

function calendarPeriod(now: Date): UsagePeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return {
    key: start.toISOString().substring(0, 7),
    startsAt: start.toISOString(),
    resetsAt: end.toISOString(),
    source: 'calendar',
  }
}

/**
 * Resolve the window from an account row, without touching the database.
 *
 * Falls back to the calendar month whenever the account cannot describe a
 * period — no row, a status that carries no billing cycle, or neither
 * boundary recorded. `current_period_start` is derived from
 * `current_period_end` when the provider only sent the end.
 *
 * If the recorded window has already elapsed — the renewal webhook is late,
 * or was missed — the window rolls forward in whole months until it
 * contains `now`. Holding the stale key instead would mean the quota never
 * resets, which is the opposite of the bug this fixes.
 */
export function usagePeriodFrom(account: UsagePeriodAccount | null | undefined, now: Date = new Date()): UsagePeriod {
  if (!account) return calendarPeriod(now)

  const status = account.subscription_status ?? null
  if (status && !BILLED_STATUSES.has(status)) return calendarPeriod(now)

  const end = toDate(account.current_period_end)
  let start = toDate(account.current_period_start) ?? (end ? addMonthsClamped(end, -1) : null)
  if (!start) return calendarPeriod(now)

  let periodEnd = end && end > start ? end : addMonthsClamped(start, 1)

  // Roll forward past a period that has already closed.
  let guard = 0
  while (periodEnd.getTime() <= now.getTime() && guard < 240) {
    start = periodEnd
    periodEnd = addMonthsClamped(start, 1)
    guard += 1
  }

  // A period that has not opened yet (clock skew, a provider sending a
  // future start) would count nothing; treat it as the calendar month.
  if (start.getTime() > now.getTime()) return calendarPeriod(now)

  return {
    key: start.toISOString().substring(0, 10),
    startsAt: start.toISOString(),
    resetsAt: periodEnd.toISOString(),
    source: 'billing',
  }
}

/**
 * Resolve the window for a workspace, reading its active payment account.
 *
 * A lookup failure degrades to the calendar month rather than throwing —
 * a billing-metadata read must never be what stops a user's message.
 */
export async function resolveUsagePeriod(workspaceId: string, now: Date = new Date()): Promise<UsagePeriod> {
  try {
    const account = await useDatabaseProvider().getActivePaymentAccount(workspaceId)
    return usagePeriodFrom(account as UsagePeriodAccount | null, now)
  }
  catch {
    return calendarPeriod(now)
  }
}
