/**
 * License & feature flag system — server entry.
 *
 * Design: `hasFeature()` and `getPlanLimit()` are the ONLY ways to check
 * features on the server. Both automatically honor the current
 * deployment edition (AGPL vs ee/) so `requires_ee` features are
 * force-disabled in Community Edition even if the matrix grants them
 * for the requested plan tier.
 *
 * Client code shares the same matrices via `shared/utils/license.ts`
 * but must pass the edition explicitly because the client has no access
 * to `resolveDeployment()`.
 */

import {
  FEATURE_MATRIX,
  getPlanLimitForPlan,
  hasFeatureForPlan,
  normalizePlan,
} from '../../shared/utils/license'
import { bootstrapPaymentPlugins, resolveDefaultPlugin } from '../providers/payment'
import type { PaymentPluginConfig } from '../providers/payment'
import { resolveDeployment } from './deployment'

import type { Edition, StudioPlan } from '../../shared/utils/license'

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
 * Extract plan from workspace row.
 *
 * Resolution follows the deployment's planSource:
 *   - 'fixed'        → deployment.fixedPlan (e.g. `community` in
 *                      Community Edition)
 *   - 'operator'     → normalize(workspace.plan ?? deployment.defaultPlan)
 *                      (on-prem and dedicated profiles; operator sets
 *                       the plan directly on the workspace row)
 *   - 'subscription' → normalize(workspace.plan) (managed profile;
 *                      billing webhooks sync this column from the
 *                      active payment account)
 *
 * This replaces the previous `isBillingConfigured()`-keyed bypass which
 * forced every self-host workspace to `'starter'` regardless of the
 * operator's DB entry.
 */
export function getWorkspacePlan(workspace: { plan?: string | null }): Plan {
  const d = resolveDeployment()
  switch (d.planSource) {
    case 'fixed':
      return d.fixedPlan ?? d.defaultPlan
    case 'operator':
      return normalizePlan(workspace?.plan ?? d.defaultPlan)
    case 'subscription':
      return normalizePlan(workspace?.plan)
  }
}

/** Current edition — convenience wrapper for call sites that only need the gate. */
export function getEdition(): Edition {
  return resolveDeployment().edition
}

/**
 * Check if a plan includes a specific feature in the current edition.
 * This is the ONLY function to use for feature gating on the server.
 */
export function hasFeature(plan: Plan | string | null | undefined, feature: string): boolean {
  return hasFeatureForPlan(plan, feature, { edition: getEdition() })
}

/**
 * Get all features available for a plan in the current edition.
 */
export function getAvailableFeatures(plan: Plan): string[] {
  const edition = getEdition()
  const normalized = normalizePlan(plan)
  return Object.entries(FEATURE_MATRIX)
    .filter(([_, entry]) => {
      if (entry.requires_ee && edition === 'agpl') return false
      return entry.plans.includes(normalized)
    })
    .map(([feature]) => feature)
}

export function getPlanLimit(plan: Plan | string | null | undefined, limit: string): number {
  return getPlanLimitForPlan(plan, limit, { edition: getEdition() })
}
