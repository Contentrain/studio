/**
 * Overage utilities.
 *
 * Determines effective limits based on workspace overage preferences.
 * When overage is enabled for a category, the RPC limit is raised to
 * Postgres INT max — the RPC functions themselves are unchanged.
 * Overage amounts are computed at query time: max(0, usage - planLimit) * price.
 */

import { OVERAGE_PRICING } from '../../shared/utils/license'
import { USAGE_METER_LIST } from '../../shared/utils/usage-meters'

/**
 * Limits whose usage is not sold past the plan allowance, whatever the
 * workspace has toggled. A meter that cannot carry an included allowance
 * would bill from the first unit, so selling overage against it would
 * charge for what the plan already covers — the limit stays hard until
 * the meter counts the unit the plan sells.
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
 * Get the effective limit to pass to atomic RPC functions.
 *
 * - Overage disabled (default): returns the plan limit (hard cap).
 * - Overage enabled: returns SOFT_CAP_MAX (effectively unlimited for the RPC check).
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
  return enabled ? SOFT_CAP_MAX : planLimit
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
