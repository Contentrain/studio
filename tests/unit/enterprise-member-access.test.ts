import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeProjectMemberAccess } from '../../ee/enterprise/access'
import { __resetDeploymentCache } from '../../server/utils/deployment'
import { setEnterpriseBridgeForTesting } from '../../server/utils/enterprise'
import type { EnterpriseBridge } from '../../server/utils/enterprise'

const FAKE_BRIDGE: EnterpriseBridge = {
  listWorkspaceAiKeys: async () => null,
  createWorkspaceAiKey: async () => null,
  deleteWorkspaceAiKey: async () => null,
  listProjectWebhooks: async () => null,
  createProjectWebhook: async () => null,
  updateProjectWebhook: async () => null,
  deleteProjectWebhook: async () => null,
  testProjectWebhook: async () => null,
  listWebhookDeliveries: async () => null,
  listProjectConversationKeys: async () => null,
  createProjectConversationKey: async () => null,
  updateProjectConversationKey: async () => null,
  deleteProjectConversationKey: async () => null,
  handleConversationApiMessage: async () => null,
  handleConversationApiHistory: async () => null,
}

vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
  stripe: { secretKey: 'sk_test_mock' },
  polar: { accessToken: '' },
}))

beforeEach(() => {
  // Role features are requires_ee — inject a fake bridge
  // and reset the deployment cache so `hasFeature` resolves `edition: 'ee'`.
  setEnterpriseBridgeForTesting(FAKE_BRIDGE)
  __resetDeploymentCache()
})

afterEach(() => {
  setEnterpriseBridgeForTesting(null)
  __resetDeploymentCache()
})

/**
 * Reviewer/Viewer are plan features gated at assignment (#438). A role
 * already stored is kept on every plan: widening it to editor would grant
 * write access to a read-only member.
 */
describe('normalizeProjectMemberAccess (EE edition)', () => {
  it.each(['reviewer', 'viewer'] as const)('keeps %s on a plan with the feature (Starter, Pro)', (role) => {
    expect(normalizeProjectMemberAccess({ plan: 'starter', role }).role).toBe(role)
    expect(normalizeProjectMemberAccess({ plan: 'pro', role }).role).toBe(role)
  })

  it.each(['reviewer', 'viewer'] as const)('keeps a stored %s on Free, never widening it to editor', (role) => {
    expect(normalizeProjectMemberAccess({ plan: 'free', role }).role).toBe(role)
    expect(normalizeProjectMemberAccess({ plan: 'community', role }).role).toBe(role)
  })

  it('keeps editor, and defaults a missing role to editor', () => {
    expect(normalizeProjectMemberAccess({ plan: 'free', role: 'editor' }).role).toBe('editor')
    expect(normalizeProjectMemberAccess({ plan: 'pro', role: null }).role).toBe('editor')
  })

  it('still gates specific models on roles.specific_models', () => {
    expect(normalizeProjectMemberAccess({ plan: 'free', role: 'editor', specificModels: true, allowedModels: ['blog'] }))
      .toEqual({ role: 'editor', specificModels: false, allowedModels: [] })
    expect(normalizeProjectMemberAccess({ plan: 'pro', role: 'reviewer', specificModels: true, allowedModels: ['blog'] }))
      .toEqual({ role: 'reviewer', specificModels: true, allowedModels: ['blog'] })
  })
})
