/**
 * Overage utilities.
 *
 * Determines effective limits based on workspace overage preferences.
 * When overage is enabled for a category, the RPC limit is raised to
 * Postgres INT max — the RPC functions themselves are unchanged.
 * Overage amounts are computed at query time: max(0, usage - planLimit) * price.
 */

import { OVERAGE_PRICING } from '../../shared/utils/license'

/** Postgres INT max — used as soft cap when overage is enabled. */
const SOFT_CAP_MAX = 2_147_483_647

/**
 * Get the effective limit to pass to atomic RPC functions.
 *
 * - Overage disabled (default): returns the plan limit (hard cap).
 * - Overage enabled: returns SOFT_CAP_MAX (effectively unlimited for the RPC check).
 * - Infinity limits (enterprise): returns SOFT_CAP_MAX regardless.
 */
export function getEffectiveLimit(
  planLimit: number,
  limitKey: string,
  overageSettings: Record<string, boolean> | null | undefined,
): number {
  if (planLimit === Infinity) return SOFT_CAP_MAX

  const pricing = OVERAGE_PRICING[limitKey]
  if (!pricing) return planLimit

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
