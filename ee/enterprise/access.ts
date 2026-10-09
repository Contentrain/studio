import type { EnterpriseProjectMemberAccess, EnterprisePlan } from '../../server/utils/enterprise'
import { hasFeature } from '../../server/utils/license'

/**
 * Normalize project member access based on plan features.
 *
 * Reviewer and Viewer are plan-gated (`roles.reviewer`, `roles.viewer`).
 * A stored reviewer/viewer role on a plan without the feature (after a
 * downgrade, or written before this check) acts as `editor`, the same way
 * `specificModels` falls back when `roles.specific_models` is missing.
 */
export function normalizeProjectMemberAccess(input: {
  plan: EnterprisePlan
  role: 'editor' | 'reviewer' | 'viewer' | null | undefined
  specificModels?: boolean | null
  allowedModels?: string[] | null
}): EnterpriseProjectMemberAccess {
  const role: EnterpriseProjectMemberAccess['role'] = (input.role === 'reviewer' || input.role === 'viewer')
    && hasFeature(input.plan, `roles.${input.role}`)
    ? input.role
    : 'editor'

  const specificModels = Boolean(input.specificModels) && hasFeature(input.plan, 'roles.specific_models')

  return {
    role,
    specificModels,
    allowedModels: specificModels ? [...(input.allowedModels ?? [])] : [],
  }
}
