import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import WorkspaceBillingPanel from '../../../app/components/organisms/WorkspaceBillingPanel.vue'

/**
 * A cancellation scheduled in the portal keeps the plan to the end of the
 * period. Studio said nothing: the plan looked the same until the day it was
 * gone, and there was no way back from the app.
 */
const { state } = vi.hoisted(() => ({ state: { role: 'owner', cancelsAt: null as string | null, openPortal: null as unknown } }))

mockNuxtImport('useBilling', () => () => ({
  billingState: computed(() => 'subscribed'),
  effectivePlan: computed(() => 'pro'),
  isTrialing: computed(() => false),
  trialDaysLeft: computed(() => 0),
  cancelsAt: computed(() => state.cancelsAt),
  billingEnabled: computed(() => true),
  openPortal: state.openPortal,
}))
mockNuxtImport('useDeployment', () => () => ({
  hasManagedBilling: computed(() => true),
  isCommunity: computed(() => false),
  isOperatorManagedPlan: computed(() => false),
}))
mockNuxtImport('useWorkspaceRole', () => () => ({
  role: computed(() => state.role),
  isOwnerOrAdmin: computed(() => state.role === 'owner' || state.role === 'admin'),
}))
mockNuxtImport('useUsage', () => () => ({ usage: computed(() => null), loading: computed(() => false), fetchUsage: vi.fn(), toggleOverage: vi.fn() }))

describe('WorkspaceBillingPanel — scheduled cancellation', () => {
  beforeEach(() => {
    state.role = 'owner'
    state.cancelsAt = '2026-10-15T07:36:00.000Z'
    state.openPortal = vi.fn().mockResolvedValue(undefined)
  })

  it('says when the plan ends and offers to keep it', async () => {
    const wrapper = await mountSuspended(WorkspaceBillingPanel, { props: { workspaceId: 'ws-1' } })
    const notice = wrapper.find('[data-testid="cancel-scheduled"]')
    expect(notice.text()).toContain('Your Pro plan is set to end on October 15, 2026.')
    const keep = notice.findAll('button').find(b => b.text() === 'Keep my plan')!
    await keep.trigger('click')
    expect(state.openPortal).toHaveBeenCalled()
  })

  it('tells a member the date and who to ask', async () => {
    state.role = 'member'
    const notice = (await mountSuspended(WorkspaceBillingPanel, { props: { workspaceId: 'ws-1' } })).find('[data-testid="cancel-scheduled"]')
    expect(notice.text()).toContain('October 15, 2026')
    expect(notice.text()).toContain('Ask a workspace owner or admin.')
    expect(notice.text()).not.toContain('Keep my plan')
  })

  it('shows nothing when no cancellation is scheduled', async () => {
    state.cancelsAt = null
    expect((await mountSuspended(WorkspaceBillingPanel, { props: { workspaceId: 'ws-1' } })).find('[data-testid="cancel-scheduled"]').exists()).toBe(false)
  })
})
