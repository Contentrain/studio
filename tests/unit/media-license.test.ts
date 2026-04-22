import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlanLimit, hasFeature } from '../../server/utils/license'
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
  // Media features require the enterprise bridge — inject a fake one
  // and reset the deployment cache so `hasFeature` resolves `edition: 'ee'`.
  setEnterpriseBridgeForTesting(FAKE_BRIDGE)
  __resetDeploymentCache()
})

afterEach(() => {
  setEnterpriseBridgeForTesting(null)
  __resetDeploymentCache()
})

describe('media license features (EE edition)', () => {
  it('media.upload available on paid plans', () => {
    expect(hasFeature('starter', 'media.upload')).toBe(true)
    expect(hasFeature('pro', 'media.upload')).toBe(true)
    expect(hasFeature('enterprise', 'media.upload')).toBe(true)
  })

  it('media.library available on paid plans', () => {
    expect(hasFeature('starter', 'media.library')).toBe(true)
    expect(hasFeature('pro', 'media.library')).toBe(true)
  })

  it('gates media.custom_variants to pro+', () => {
    expect(hasFeature('starter', 'media.custom_variants')).toBe(false)
    expect(hasFeature('pro', 'media.custom_variants')).toBe(true)
    expect(hasFeature('enterprise', 'media.custom_variants')).toBe(true)
  })
})

describe('media plan limits (EE edition)', () => {
  it('returns correct storage limits', () => {
    expect(getPlanLimit('starter', 'media.storage_gb')).toBe(1)
    expect(getPlanLimit('pro', 'media.storage_gb')).toBe(15)
    expect(getPlanLimit('enterprise', 'media.storage_gb')).toBe(100)
  })

  it('returns correct file size limits', () => {
    expect(getPlanLimit('starter', 'media.max_file_size_mb')).toBe(5)
    expect(getPlanLimit('pro', 'media.max_file_size_mb')).toBe(50)
    expect(getPlanLimit('enterprise', 'media.max_file_size_mb')).toBe(100)
  })

  it('returns correct variant limits', () => {
    expect(getPlanLimit('starter', 'media.variants_per_field')).toBe(4)
    expect(getPlanLimit('pro', 'media.variants_per_field')).toBe(10)
    expect(getPlanLimit('enterprise', 'media.variants_per_field')).toBe(Infinity)
  })
})

describe('Community Edition media gating', () => {
  beforeEach(() => {
    setEnterpriseBridgeForTesting(null)
    __resetDeploymentCache()
  })

  it('force-disables all media features', () => {
    expect(hasFeature('community', 'media.upload')).toBe(false)
    expect(hasFeature('community', 'media.library')).toBe(false)
    expect(hasFeature('community', 'media.custom_variants')).toBe(false)
  })

  it('force-zeroes all media limits', () => {
    expect(getPlanLimit('community', 'media.storage_gb')).toBe(0)
    expect(getPlanLimit('community', 'media.max_file_size_mb')).toBe(0)
    expect(getPlanLimit('community', 'media.variants_per_field')).toBe(0)
  })
})
