/**
 * License & feature flag system.
 *
 * Design: hasFeature() is the ONLY way to check features.
 * Client and server share the same underlying matrices through shared/utils/license.ts.
 */

import {
  FEATURE_MATRIX,
  getPlanLimitForPlan,
  hasFeatureForPlan,
  normalizePlan,
} from '../../shared/utils/license'

import type { StudioPlan } from '../../shared/utils/license'

export type Plan = StudioPlan

/**
 * Extract plan from workspace row. Defaults to 'starter'.
 */
export function getWorkspacePlan(workspace: { plan?: string | null }): Plan {
  return normalizePlan(workspace?.plan)
}

/**
 * Check if a plan includes a specific feature.
 * This is the ONLY function to use for feature gating.
 */
export function hasFeature(plan: Plan | string | null | undefined, feature: string): boolean {
  return hasFeatureForPlan(plan, feature)
}

/**
 * Get all features available for a plan.
 */
export function getAvailableFeatures(plan: Plan): string[] {
  const normalized = normalizePlan(plan)
  return Object.entries(FEATURE_MATRIX)
    .filter(([_, plans]) => plans.includes(normalized))
    .map(([feature]) => feature)
}

export function getPlanLimit(plan: Plan | string | null | undefined, limit: string): number {
  return getPlanLimitForPlan(plan, limit)
}
