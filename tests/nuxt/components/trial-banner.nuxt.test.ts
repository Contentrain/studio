import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, reactive } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import TrialBanner from '../../../app/components/molecules/TrialBanner.vue'
import type { BillingState } from '../../../app/composables/useBilling'

// Hoisted because mockNuxtImport's factory is lifted above the imports. The
// route has to be genuinely reactive — the banner re-arms urgent notices by
// watching it.
const { billing, nav } = vi.hoisted(() => ({
  billing: { state: 'trial_active' as string },
  nav: { route: null as null | { path: string } },
}))

mockNuxtImport('useBilling', () => () => ({
  billingState: computed(() => billing.state as BillingState),
  trialDaysLeft: computed(() => 7),
  effectivePlan: computed(() => 'pro' as const),
}))
mockNuxtImport('useRoute', () => {
  nav.route ??= reactive({ path: '/w/acme' })
  return () => nav.route!
})

const DISMISS_KEY = 'contentrain-billing-banner-dismissed'

describe('TrialBanner', () => {
  beforeEach(() => {
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
})
