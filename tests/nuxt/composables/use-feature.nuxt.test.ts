import { beforeEach, describe, expect, it } from 'vitest'
import { useFeature, useFeatureLimit, useFeatureMeta } from '../../../app/composables/useFeature'

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

function seedWorkspace(plan: string | null) {
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

describe('useFeature', () => {
  beforeEach(() => {
    useState('workspaces').value = []
    useState('active-workspace-id').value = null
  })

  describe('Community Edition', () => {
    beforeEach(() => {
      setDeployment({ profile: 'community', edition: 'agpl', billingMode: 'off' })
      seedWorkspace(null)
    })

    it('force-disables requires_ee features', () => {
      expect(useFeature('ai.byoa').value).toBe(false)
      expect(useFeature('cdn.delivery').value).toBe(false)
      expect(useFeature('media.upload').value).toBe(false)
      expect(useFeature('roles.reviewer').value).toBe(false)
    })

    it('allows core features', () => {
      expect(useFeature('forms.enabled').value).toBe(true)
      expect(useFeature('workflow.review').value).toBe(true)
      expect(useFeature('api.mcp_cloud').value).toBe(true)
    })

    it('zeroes requires_ee limits', () => {
      expect(useFeatureLimit('cdn.bandwidth_gb').value).toBe(0)
      expect(useFeatureLimit('media.storage_gb').value).toBe(0)
    })

    it('keeps core limits unlimited', () => {
      expect(useFeatureLimit('team.members').value).toBe(Infinity)
      expect(useFeatureLimit('forms.submissions_per_month').value).toBe(Infinity)
    })
  })

  describe('Managed Edition (Pro plan)', () => {
    beforeEach(() => {
      setDeployment({ profile: 'managed', edition: 'ee', billingMode: 'polar' })
      // Workspace with active pro subscription — mirror the billing
      // composable path so `effectivePlan` resolves to 'pro'.
      useState('workspaces').value = [{
        id: 'ws-pro',
        name: 'Pro Team',
        slug: 'pro',
        type: 'secondary',
        owner_id: 'u',
        logo_url: null,
        github_installation_id: null,
        plan: 'pro',
        created_at: '2026-04-02T00:00:00.000Z',
        payment_account: {
          customer_id: 'cust-1',
          subscription_id: 'sub-1',
          subscription_status: 'active',
          plan: 'pro',
          current_period_end: null,
          trial_ends_at: null,
          grace_period_ends_at: null,
          cancel_at_period_end: false,
        },
      }]
      useState('active-workspace-id').value = 'ws-pro'
    })

    it('grants Pro-tier ee features', () => {
      expect(useFeature('ai.byoa').value).toBe(true)
      expect(useFeature('cdn.delivery').value).toBe(true)
      expect(useFeature('media.upload').value).toBe(true)
      expect(useFeature('roles.reviewer').value).toBe(true)
    })

    it('denies enterprise-only features', () => {
      expect(useFeature('sso.saml').value).toBe(false)
      expect(useFeature('branding.white_label').value).toBe(false)
    })

    it('returns Pro limits', () => {
      expect(useFeatureLimit('cdn.bandwidth_gb').value).toBe(60)
      expect(useFeatureLimit('team.members').value).toBe(25)
    })
  })

  describe('useFeatureMeta', () => {
    it('exposes roadmap flag for coming-soon features', () => {
      setDeployment({ profile: 'managed', edition: 'ee', billingMode: 'polar' })
      seedWorkspace('enterprise')
      const meta = useFeatureMeta('sso.saml').value
      expect(meta.defined).toBe(true)
      expect(meta.requiresEE).toBe(true)
      expect(meta.roadmap).toBe(true)
    })

    it('returns undefined-shape for missing keys', () => {
      setDeployment({ profile: 'managed', edition: 'ee', billingMode: 'polar' })
      seedWorkspace('pro')
      const meta = useFeatureMeta('nonexistent.feature').value
      expect(meta.defined).toBe(false)
      expect(meta.enabled).toBe(false)
    })
  })
})
