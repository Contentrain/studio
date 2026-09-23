import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, reactive } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import TrialBanner from '../../../app/components/molecules/TrialBanner.vue'
import type { BillingState } from '../../../app/composables/useBilling'

// Hoisted because mockNuxtImport's factory is lifted above the imports. The
// route has to be genuinely reactive — the banner re-arms urgent notices by
// watching it.
const { billing, nav, who } = vi.hoisted(() => ({
  who: { role: 'owner' },
  billing: { state: 'trial_active' as string },
  nav: { route: null as null | { path: string } },
}))

mockNuxtImport('useBilling', () => () => ({
  billingState: computed(() => billing.state as BillingState),
  trialDaysLeft: computed(() => 7),
  effectivePlan: computed(() => 'pro' as const),
}))
mockNuxtImport('useWorkspaceRole', () => () => ({
  role: computed(() => who.role),
  isOwnerOrAdmin: computed(() => who.role === 'owner' || who.role === 'admin'),
}))
mockNuxtImport('useRoute', () => {
  nav.route ??= reactive({ path: '/w/acme' })
  return () => nav.route!
})

const DISMISS_KEY = 'contentrain-billing-banner-dismissed'

describe('TrialBanner', () => {
  beforeEach(() => {
    who.role = 'owner'
    billing.state = 'trial_active'
    if (nav.route) nav.route.path = '/w/acme'
    sessionStorage.clear()
  })

  it('stays dismissed for the rest of the tab on a trial notice', async () => {
    const wrapper = await mountSuspended(TrialBanner)
    expect(wrapper.text()).toContain('trial')

    await wrapper.findAll('button').at(-1)!.trigger('click')

    expect(wrapper.text()).toBe('')
    expect(sessionStorage.getItem(DISMISS_KEY)).toBe('trial_active')
  })

  it('keeps a past_due notice out of session storage so it comes back', async () => {
    billing.state = 'past_due'
    const wrapper = await mountSuspended(TrialBanner)

    await wrapper.findAll('button').at(-1)!.trigger('click')

    expect(wrapper.text()).toBe('')
    // Nothing persisted — the next navigation re-arms it.
    expect(sessionStorage.getItem(DISMISS_KEY)).toBeNull()

    nav.route!.path = '/w/acme/projects/p1'
    await nextTick()
    expect(wrapper.text()).toContain('Payment failed')
  })

  it('leaves a trial dismissal alone across navigation', async () => {
    const wrapper = await mountSuspended(TrialBanner)
    await wrapper.findAll('button').at(-1)!.trigger('click')

    nav.route!.path = '/w/acme/projects/p1'
    await nextTick()

    expect(wrapper.text()).toBe('')
  })

  it('re-surfaces when the billing state changes under a stored dismissal', async () => {
    sessionStorage.setItem(DISMISS_KEY, 'trial_active')
    billing.state = 'past_due'

    const wrapper = await mountSuspended(TrialBanner)

    expect(wrapper.text()).toContain('Payment failed')
  })

  it('honours a stored dismissal for the same state', async () => {
    sessionStorage.setItem(DISMISS_KEY, 'trial_active')

    const wrapper = await mountSuspended(TrialBanner)

    expect(wrapper.text()).toBe('')
  })

  it('renders nothing for a subscribed workspace', async () => {
    billing.state = 'subscribed'

    const wrapper = await mountSuspended(TrialBanner)

    expect(wrapper.text()).toBe('')
  })

  it('gives the dismiss control a button type and a label from the dictionary', async () => {
    const wrapper = await mountSuspended(TrialBanner)
    const dismiss = wrapper.findAll('button').at(-1)!

    expect(dismiss.attributes('type')).toBe('button')
    expect(dismiss.text()).toContain('Dismiss')
  })

  it('gives a member who to ask instead of a plan button that answers 403', async () => {
    who.role = 'member'
    const wrapper = await mountSuspended(TrialBanner)
    expect(wrapper.text()).toContain('Ask a workspace owner or admin.')
    expect(wrapper.text()).not.toContain('Choose a plan')
  })

  it('says a payment-paused workspace is paused and sends the owner to fix the payment, not to a new plan', async () => {
    billing.state = 'grace_expired'
    const wrapper = await mountSuspended(TrialBanner)
    expect(wrapper.text()).toContain('Subscription paused — update your payment method to continue.')
    expect(wrapper.text()).not.toContain('trial')
    const cta = wrapper.findAll('button').find(b => b.text() === 'Update Payment')!
    await cta.trigger('click')
    expect(wrapper.emitted('manageBilling')).toHaveLength(1)
    expect(wrapper.emitted('choosePlan')).toBeUndefined()
  })

  it('tells a member of a paused workspace who to ask', async () => {
    billing.state = 'grace_expired'
    who.role = 'member'
    const wrapper = await mountSuspended(TrialBanner)
    expect(wrapper.text()).toContain('Subscription paused')
    expect(wrapper.text()).toContain('Ask a workspace owner or admin.')
    expect(wrapper.text()).not.toContain('Update Payment')
  })

  it('says an ended subscription has ended, not that a trial expired', async () => {
    billing.state = 'canceled_expired'
    expect((await mountSuspended(TrialBanner)).text()).toContain('Your subscription has ended.')
  })
})
