/**
 * Reactive client-side feature gate.
 *
 * Wraps the shared `hasFeatureForPlan` / `getPlanLimitForPlan` helpers
 * with the current deployment edition and the active workspace plan,
 * so every UI surface gets consistent answers. Use this instead of
 * importing the shared helpers directly in components — that way a
 * future change to plan resolution (e.g. a per-project override) only
 * touches this composable.
 *
 * ```ts
 * const byoaEnabled = useFeature('ai.byoa')
 * if (byoaEnabled.value) { ... }
 *
 * const storageLimit = useFeatureLimit('media.storage_gb')
 * ```
 *
 * Roadmap features (flagged `roadmap: true` in `plan-features`) are
 * exposed via `useFeatureMeta` so callers can render a "Coming Soon"
 * chip without re-reading the matrix.
 */

import { FEATURE_MATRIX, getPlanLimitForPlan, hasFeatureForPlan, PLAN_LIMITS } from '~~/shared/utils/license'
import type { Edition, StudioPlan } from '~~/shared/utils/license'

function resolveEdition(): Edition {
  const { edition } = useDeployment()
  // Community Edition forces `'agpl'`; every other profile claims ee.
  return edition === 'agpl' ? 'agpl' : 'ee'
}

function resolvePlan(): StudioPlan | string | null | undefined {
  return useBilling().effectivePlan.value
}

/**
 * Reactive flag: can the current workspace use this feature?
 * Honors both plan tier AND edition (`requires_ee` force-disables in
 * Community Edition regardless of plan).
 */
export function useFeature(featureKey: string) {
  return computed(() => hasFeatureForPlan(resolvePlan(), featureKey, { edition: resolveEdition() }))
}

/**
 * Reactive limit: numeric cap for the current plan + edition.
 * Returns `0` for requires_ee limits in Community Edition.
 * `Infinity` means unlimited.
 */
export function useFeatureLimit(limitKey: string) {
  return computed(() => getPlanLimitForPlan(resolvePlan(), limitKey, { edition: resolveEdition() }))
}

export interface FeatureMeta {
  /** Whether the feature row exists in the matrix. */
  defined: boolean
  /** The feature requires the enterprise bridge (ee/) to function. */
  requiresEE: boolean
  /** The feature is advertised but not yet implemented. UI may show "Coming Soon". */
  roadmap: boolean
  /** Resolved gate (plan + edition). */
  enabled: boolean
}

/**
 * Structural metadata for a feature — useful when the UI needs to
 * distinguish "not in your plan" from "requires ee upgrade" from
 * "advertised but unimplemented".
 */
export function useFeatureMeta(featureKey: string) {
  return computed<FeatureMeta>(() => {
    const entry = FEATURE_MATRIX[featureKey]
    if (!entry) {
      return { defined: false, requiresEE: false, roadmap: false, enabled: false }
    }
    return {
      defined: true,
      requiresEE: entry.requires_ee,
      roadmap: entry.roadmap,
      enabled: hasFeatureForPlan(resolvePlan(), featureKey, { edition: resolveEdition() }),
    }
  })
}

/**
 * Whether a limit row exists in the matrix. Limits never have a
 * `roadmap` flag (roadmap only makes sense for feature flags).
 */
export function useLimitMeta(limitKey: string) {
  return computed(() => {
    const entry = PLAN_LIMITS[limitKey]
    if (!entry) return { defined: false, requiresEE: false }
    return { defined: true, requiresEE: entry.requires_ee }
  })
}
