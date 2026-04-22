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
import { bootstrapPaymentPlugins, resolveDefaultPlugin } from '../providers/payment'
import type { PaymentPluginConfig } from '../providers/payment'

import type { StudioPlan } from '../../shared/utils/license'

export type Plan = StudioPlan

/**
 * Whether any payment provider is configured at runtime.
 * Cached after first check. Used by self-hosted bypass and middleware.
 */
let _billingConfigured: boolean | null = null
export function isBillingConfigured(): boolean {
  if (_billingConfigured === null) {
    bootstrapPaymentPlugins()
    const config = useRuntimeConfig() as unknown as PaymentPluginConfig
    _billingConfigured = resolveDefaultPlugin(config) !== null
  }
  return _billingConfigured
}

/** Test helper — clear the cached configuration flag. */
export function __resetBillingConfiguredCache(): void {
  _billingConfigured = null
}

/**
 * Extract plan from workspace row. Defaults to 'free'.
 *
 * Self-hosted bypass: when no payment provider is configured, all
 * workspaces are treated as 'starter' (core features). This ensures
 * public routes (CDN, forms, conversation API) that read plan directly
 * from DB get consistent behavior with the billing middleware.
 */
export function getWorkspacePlan(workspace: { plan?: string | null }): Plan {
  const plan = normalizePlan(workspace?.plan)
  if (plan === 'free' && !isBillingConfigured()) return 'starter'
  return plan
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
