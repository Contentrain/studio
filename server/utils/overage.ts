/**
 * Overage utilities.
 *
 * Determines effective limits based on workspace overage preferences.
 * When overage is enabled for a category, the RPC limit is raised to
 * Postgres INT max — the RPC functions themselves are unchanged — or, for a
 * limit with an abuse ceiling, to that multiple of the plan.
 * Overage amounts are computed at query time: max(0, usage - planLimit) * price.
 */

import { OVERAGE_PRICING } from '../../shared/utils/license'
import { USAGE_METER_LIST } from '../../shared/utils/usage-meters'

/**
 * Limits whose usage is not sold past the plan allowance, whatever the
 * workspace has toggled (`overageBillable: false` in the meter manifest).
 * A meter that cannot carry an included allowance would bill from the
 * first unit, so selling overage against it would charge for what the
 * plan already covers. Empty today; kept so a future meter can be listed
 * before it is sold.
 */
const UNSELLABLE_LIMIT_KEYS: ReadonlySet<string> = new Set(
  USAGE_METER_LIST.filter(m => !m.overageBillable).map(m => m.limitKey),
)

/** Whether usage past the plan limit may be sold for this limit at all. */
export function isOverageSellable(limitKey: string): boolean {
  return !UNSELLABLE_LIMIT_KEYS.has(limitKey)
}

/** Postgres INT max — used as soft cap when overage is enabled. */
const SOFT_CAP_MAX = 2_147_483_647

/**
 * Abuse ceilings: with overage on, how many times its plan allowance a
 * limit may reach before it stops again, whatever is paid.
 *
 * Overage is invoiced after the fact, so usage past the plan is credit
 * Studio extends until the period closes. For CDN transfer and media
 * storage that credit is real money (egress, storage) and a leaked key or
 * a runaway sync could run it up without bound. Ten times the plan is far
 * past any site that is merely busy (Pro: 600 GB of origin transfer,
 * 250 GB stored), so it bounds the exposure without making a growing
 * site unusable. Reaching it stops the same way the hard limit does
 * (CDN 429 until the window resets, uploads refused) and the owner is
 * told; upgrading or contacting support lifts it.
 *
 * Also the unit fix: callers pass the media limit in bytes, and the
 * int32 soft cap read as bytes is 2 GiB — below every paid plan — so a
 * byte-valued limit must be raised by a multiple, never to SOFT_CAP_MAX.
 */
export const OVERAGE_ABUSE_CEILING_RATIO: Readonly<Record<string, number>> = {
  'cdn.bandwidth_gb': 10,
  'media.storage_gb': 10,
}

/**
 * Get the effective limit to pass to atomic RPC functions.
 *
 * - Overage disabled (default): returns the plan limit (hard cap).
 * - Overage enabled: returns SOFT_CAP_MAX (effectively unlimited for the RPC check),
 *   or the plan limit × its abuse ceiling ratio where one is set — in the
 *   caller's own unit, so a limit passed in bytes stays in bytes.
 * - Infinity limits (enterprise): returns SOFT_CAP_MAX regardless.
 * - Limits that are not sellable: always the plan limit, toggle or not.
 */
export function getEffectiveLimit(
  planLimit: number,
  limitKey: string,
  overageSettings: Record<string, boolean> | null | undefined,
): number {
  if (planLimit === Infinity) return SOFT_CAP_MAX

  const pricing = OVERAGE_PRICING[limitKey]
  if (!pricing) return planLimit

  // A stale `true` in `overage_settings` must not raise a cap we have no
  // way to bill for, so this is checked after the toggle, not instead.
  if (!isOverageSellable(limitKey)) return planLimit

  const enabled = overageSettings?.[pricing.settingsKey] === true
  if (!enabled) return planLimit
  const ceiling = OVERAGE_ABUSE_CEILING_RATIO[limitKey]
  return ceiling ? Math.round(planLimit * ceiling) : SOFT_CAP_MAX
}

/**
 * The most a limit can reach with overage on, in the limit's own unit;
 * Infinity when overage on it has no ceiling.
 */
export function overageCeiling(planLimit: number, limitKey: string): number {
  if (planLimit === Infinity) return Infinity
  const ratio = OVERAGE_ABUSE_CEILING_RATIO[limitKey]
  return ratio ? planLimit * ratio : Infinity
}

/**
 * Check if overage is enabled for a given limit category.
 */
export function isOverageEnabled(
  limitKey: string,
  overageSettings: Record<string, boolean> | null | undefined,
): boolean {
  const pricing = OVERAGE_PRICING[limitKey]
  if (!pricing) return false
  if (!isOverageSellable(limitKey)) return false
  return overageSettings?.[pricing.settingsKey] === true
}

/**
 * Calculate overage units for a given usage amount.
 * Returns 0 when usage is within the plan limit.
 */
export function calculateOverageUnits(currentUsage: number, planLimit: number): number {
  if (planLimit === Infinity) return 0
  return Math.max(0, currentUsage - planLimit)
}
