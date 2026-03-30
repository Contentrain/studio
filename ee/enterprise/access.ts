import type { EnterpriseProjectMemberAccess, EnterprisePlan } from '../../server/utils/enterprise'
import { hasFeature } from '../../server/utils/license'

export function normalizeProjectMemberAccess(input: {
  plan: EnterprisePlan
  role: 'editor' | 'reviewer' | 'viewer' | null | undefined
  specificModels?: boolean | null
  allowedModels?: string[] | null
}): EnterpriseProjectMemberAccess {
  let role: EnterpriseProjectMemberAccess['role'] = input.role === 'reviewer' || input.role === 'viewer'
    ? input.role
    : 'editor'

  if (role === 'reviewer' && !hasFeature(input.plan, 'roles.reviewer')) {
    role = 'editor'
  }
  if (role === 'viewer' && !hasFeature(input.plan, 'roles.viewer')) {
    role = 'editor'
  }

  const specificModels = Boolean(input.specificModels) && hasFeature(input.plan, 'roles.specific_models')

  return {
    role,
    specificModels,
    allowedModels: specificModels ? [...(input.allowedModels ?? [])] : [],
  }
}
