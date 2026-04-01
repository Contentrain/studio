import type { EnterpriseProjectMemberAccess, EnterprisePlan } from '../../server/utils/enterprise'
import { hasFeature } from '../../server/utils/license'

/**
 * Normalize project member access based on plan features.
 *
 * All plans include reviewer/viewer roles (starter, pro, enterprise).
 * Only specific_models access is plan-gated (Pro+).
 */
export function normalizeProjectMemberAccess(input: {
  plan: EnterprisePlan
  role: 'editor' | 'reviewer' | 'viewer' | null | undefined
  specificModels?: boolean | null
  allowedModels?: string[] | null
}): EnterpriseProjectMemberAccess {
  const role: EnterpriseProjectMemberAccess['role'] = input.role === 'reviewer' || input.role === 'viewer'
    ? input.role
    : 'editor'

  const specificModels = Boolean(input.specificModels) && hasFeature(input.plan, 'roles.specific_models')

  return {
    role,
    specificModels,
    allowedModels: specificModels ? [...(input.allowedModels ?? [])] : [],
  }
}
