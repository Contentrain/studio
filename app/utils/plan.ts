/**
 * Client-side feature checks are UX-only.
 * The authoritative gate still lives on the server, but both sides now
 * resolve from the same shared feature matrix.
 */
import { hasFeatureForPlan } from '../../shared/utils/license'

export function hasFeature(plan: string | null | undefined, feature: string): boolean {
  return hasFeatureForPlan(plan, feature)
}
