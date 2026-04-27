import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDeploymentCache, resolveDeployment } from '../../server/utils/deployment'
import { __resetBillingConfiguredCache } from '../../server/utils/license'
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

function mockRuntime(config: { polar?: string, stripe?: string } = {}) {
  vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
    polar: { accessToken: config.polar ?? '' },
    stripe: { secretKey: config.stripe ?? '' },
  }))
}

describe('resolveDeployment', () => {
  beforeEach(() => {
    __resetDeploymentCache()
    __resetBillingConfiguredCache()
    // No bridge by default — community fallback.
    setEnterpriseBridgeForTesting(null)
    delete process.env.NUXT_DEPLOYMENT_PROFILE
  })

  afterEach(() => {
    setEnterpriseBridgeForTesting(null)
    __resetDeploymentCache()
    __resetBillingConfiguredCache()
    vi.unstubAllGlobals()
    delete process.env.NUXT_DEPLOYMENT_PROFILE
  })

  describe('auto-detect', () => {
    it('ee + polar configured → managed', () => {
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      mockRuntime({ polar: 'polar_oat_test' })
      __resetBillingConfiguredCache()

      const d = resolveDeployment()
      expect(d.profile).toBe('managed')
      expect(d.edition).toBe('ee')
      expect(d.billingMode).toBe('polar')
      expect(d.planSource).toBe('subscription')
      expect(d.defaultPlan).toBe('free')
    })

    it('ee + stripe configured → managed', () => {
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      mockRuntime({ stripe: 'sk_test_abc' })
      __resetBillingConfiguredCache()

      const d = resolveDeployment()
      expect(d.profile).toBe('managed')
      expect(d.billingMode).toBe('stripe')
    })

    it('ee + no billing env → on-premise', () => {
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      mockRuntime({})

      const d = resolveDeployment()
      expect(d.profile).toBe('on-premise')
      expect(d.edition).toBe('ee')
      expect(d.billingMode).toBe('off')
      expect(d.planSource).toBe('operator')
      expect(d.defaultPlan).toBe('enterprise')
    })

    it('no ee bridge → community (regardless of billing env)', () => {
      // Even with polar configured, missing ee/ must fall through to community.
      mockRuntime({ polar: 'polar_oat_test' })
      __resetBillingConfiguredCache()

      const d = resolveDeployment()
      expect(d.profile).toBe('community')
      expect(d.edition).toBe('agpl')
      expect(d.billingMode).toBe('off')
      expect(d.planSource).toBe('fixed')
      expect(d.fixedPlan).toBe('community')
      expect(d.defaultPlan).toBe('community')
    })
  })

  describe('explicit override', () => {
    it('NUXT_DEPLOYMENT_PROFILE=managed honored when ee loaded', () => {
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      mockRuntime({})
      process.env.NUXT_DEPLOYMENT_PROFILE = 'managed'

      const d = resolveDeployment()
      expect(d.profile).toBe('managed')
      expect(d.planSource).toBe('subscription')
    })

    it('NUXT_DEPLOYMENT_PROFILE=dedicated honored', () => {
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      mockRuntime({ polar: 'polar_oat_test' })
      __resetBillingConfiguredCache()
      process.env.NUXT_DEPLOYMENT_PROFILE = 'dedicated'

      const d = resolveDeployment()
      expect(d.profile).toBe('dedicated')
      expect(d.defaultPlan).toBe('enterprise')
      // With polar configured, dedicated uses subscription planSource.
      expect(d.planSource).toBe('subscription')
    })

    it('NUXT_DEPLOYMENT_PROFILE=dedicated without billing → operator planSource', () => {
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      mockRuntime({})
      process.env.NUXT_DEPLOYMENT_PROFILE = 'dedicated'

      const d = resolveDeployment()
      expect(d.profile).toBe('dedicated')
      expect(d.planSource).toBe('operator')
    })

    it('NUXT_DEPLOYMENT_PROFILE=on-premise honored', () => {
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      mockRuntime({ polar: 'polar_oat_test' }) // even with polar, on-premise forces billing off
      __resetBillingConfiguredCache()
      process.env.NUXT_DEPLOYMENT_PROFILE = 'on-premise'

      const d = resolveDeployment()
      expect(d.profile).toBe('on-premise')
      expect(d.billingMode).toBe('off')
      expect(d.planSource).toBe('operator')
    })

    it('explicit managed without ee falls back to community (misconfiguration guard)', () => {
      // No bridge injected.
      mockRuntime({})
      process.env.NUXT_DEPLOYMENT_PROFILE = 'managed'

      const d = resolveDeployment()
      // Guard rail kicks in: ee-required profile with agpl edition → community.
      expect(d.profile).toBe('community')
      expect(d.edition).toBe('agpl')
    })

    it('invalid profile string falls back to auto-detect', () => {
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      mockRuntime({ polar: 'polar_oat_test' })
      __resetBillingConfiguredCache()
      process.env.NUXT_DEPLOYMENT_PROFILE = 'garbage'

      const d = resolveDeployment()
      expect(d.profile).toBe('managed') // auto-detect result
    })
  })

  describe('cache behavior', () => {
    it('caches across calls', () => {
      mockRuntime({})
      const first = resolveDeployment()
      const second = resolveDeployment()
      expect(first).toBe(second)
    })

    it('__resetDeploymentCache forces re-evaluation', () => {
      mockRuntime({})
      const first = resolveDeployment()
      setEnterpriseBridgeForTesting(FAKE_BRIDGE)
      __resetDeploymentCache()
      const second = resolveDeployment()
      expect(first.edition).toBe('agpl')
      expect(second.edition).toBe('ee')
    })
  })
})
