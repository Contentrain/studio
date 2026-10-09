import type { EnterpriseProjectMemberAccess, EnterprisePlan } from '../../server/utils/enterprise'
import { hasFeature } from '../../server/utils/license'

/**
 * Normalize project member access based on plan features.
 *
 * Reviewer and Viewer are plan-gated at assignment (`members/index.post.ts`
 * refuses them without `roles.reviewer` / `roles.viewer`). A role already
 * stored is kept on every plan: both are read-only or narrower than editor,
 * so widening one to editor after a downgrade would grant write access.
 * Only specific_models access is plan-gated here (Pro+).
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
