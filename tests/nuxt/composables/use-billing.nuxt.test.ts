import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBilling } from '../../../app/composables/useBilling'

describe('useBilling', () => {
  beforeEach(() => {
    useState('workspaces').value = []
    useState('workspaces-loading').value = false
    useState('active-workspace-id').value = null
    vi.stubGlobal('useRuntimeConfig', vi.fn().mockReturnValue({
      public: {
        billingEnabled: 'false',
      },
    }))
  })

  it('maps free workspaces to starter in self-host mode', () => {
    useState('workspaces').value = [
      {
        id: 'workspace-1',
        name: 'Team',
        slug: 'team',
        type: 'secondary',
        owner_id: 'user-1',
        logo_url: null,
        github_installation_id: null,
        plan: 'free',
        created_at: '2026-04-02T00:00:00.000Z',
      },
    ]
    useState('active-workspace-id').value = 'workspace-1'

    const billing = useBilling()

    expect(billing.billingState.value).toBe('subscribed')
    expect(billing.effectivePlan.value).toBe('starter')
  })
})
