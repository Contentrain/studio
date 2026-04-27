import { beforeEach, describe, expect, it } from 'vitest'
import { useBilling } from '../../../app/composables/useBilling'

/**
 * See use-deployment.nuxt.test.ts for the rationale — we mutate the
 * live runtimeConfig object rather than stubbing the auto-import.
 */
function setDeployment(deployment: { profile?: string, edition?: string, billingMode?: string }) {
  const cfg = useRuntimeConfig()
  const pub = cfg.public as Record<string, unknown>
  pub.deployment = {
    profile: deployment.profile ?? '',
    edition: deployment.edition ?? '',
    billingMode: deployment.billingMode ?? '',
  }
  pub.billingEnabled = (deployment.billingMode === 'polar' || deployment.billingMode === 'stripe')
}

function seedWorkspace(plan: string | null = null) {
  useState('workspaces').value = [
    {
      id: 'workspace-1',
      name: 'Team',
      slug: 'team',
      type: 'secondary',
      owner_id: 'user-1',
      logo_url: null,
      github_installation_id: null,
      plan,
      created_at: '2026-04-02T00:00:00.000Z',
    },
  ]
  useState('active-workspace-id').value = 'workspace-1'
}

describe('useBilling', () => {
  beforeEach(() => {
    useState('workspaces').value = []
    useState('workspaces-loading').value = false
    useState('active-workspace-id').value = null
  })

  describe('community profile', () => {
    beforeEach(() => {
      setDeployment({ profile: 'community', edition: 'agpl', billingMode: 'off' })
      seedWorkspace('free')
    })

    it('reports billingState="subscribed" and effectivePlan="community"', () => {
      const billing = useBilling()
      expect(billing.billingState.value).toBe('subscribed')
      expect(billing.effectivePlan.value).toBe('community')
      expect(billing.billingEnabled.value).toBe(false)
      expect(billing.isLocked.value).toBe(false)
    })

    it('ignores workspace.plan overrides (edition is fixed)', () => {
      seedWorkspace('pro')
      const billing = useBilling()
      expect(billing.effectivePlan.value).toBe('community')
    })
  })

  describe('on-premise profile', () => {
    beforeEach(() => {
      setDeployment({ profile: 'on-premise', edition: 'ee', billingMode: 'off' })
    })

    it('honors workspace.plan, defaults to enterprise when missing', () => {
      seedWorkspace('pro')
      const pro = useBilling()
      expect(pro.billingState.value).toBe('subscribed')
      expect(pro.effectivePlan.value).toBe('pro')

      seedWorkspace(null)
      const enterpriseDefault = useBilling()
      expect(enterpriseDefault.effectivePlan.value).toBe('enterprise')
    })

    it('never enters a locked state', () => {
      seedWorkspace('enterprise')
      const billing = useBilling()
      expect(billing.isLocked.value).toBe(false)
      expect(billing.billingEnabled.value).toBe(false)
    })
  })

  describe('managed profile', () => {
    beforeEach(() => {
      setDeployment({ profile: 'managed', edition: 'ee', billingMode: 'polar' })
    })

    it('free plan without payment account → free state', () => {
      seedWorkspace('free')
      const billing = useBilling()
      expect(billing.billingState.value).toBe('free')
      expect(billing.effectivePlan.value).toBe('free')
      expect(billing.billingEnabled.value).toBe(true)
    })
  })

  describe('dedicated profile (flat-fee)', () => {
    beforeEach(() => {
      setDeployment({ profile: 'dedicated', edition: 'ee', billingMode: 'off' })
    })

    it('acts like on-premise — workspace.plan honored, no subscription', () => {
      seedWorkspace('enterprise')
      const billing = useBilling()
      expect(billing.billingState.value).toBe('subscribed')
      expect(billing.effectivePlan.value).toBe('enterprise')
    })
  })
})
