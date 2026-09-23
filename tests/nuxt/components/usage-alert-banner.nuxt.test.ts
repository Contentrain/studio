import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import UsageAlertBanner from '../../../app/components/molecules/UsageAlertBanner.vue'
import type { UsageCategory, UsageData } from '../../../app/composables/useUsage'

/**
 * A limit that stops something — Studio AI, the site's forms — used to be
 * visible only inside Settings › Billing, to an owner who opened it. Forms and
 * comments fail for the site visitor, never for anyone in Studio.
 */
const { state } = vi.hoisted(() => ({ state: { role: 'owner', usage: null as unknown } }))

mockNuxtImport('useUsage', () => () => ({ usage: computed(() => state.usage as UsageData | null), fetchUsage: vi.fn().mockResolvedValue(undefined) }))
mockNuxtImport('useWorkspaces', () => () => ({ activeWorkspace: ref({ id: 'ws-1', slug: 'lanista' }) }))
mockNuxtImport('useWorkspaceRole', () => () => ({
  role: computed(() => state.role),
  isOwnerOrAdmin: computed(() => state.role === 'owner' || state.role === 'admin'),
}))

function category(key: string, name: string, current: number, limit: number, resetsAt: string | null, extra: Partial<UsageCategory> = {}): UsageCategory {
  return {
    key, limitKey: key, name, current, limit, unit: 'units', overageEnabled: false, overageSellable: true,
    overageUnits: 0, overageUnitPrice: 0, overageAmount: 0, percentage: Math.round(current / limit * 100), resetsAt, ...extra,
  }
}

function usage(...categories: UsageCategory[]): UsageData {
  return { billingPeriod: '2026-09-15', categories, totalOverageAmount: 0, projectedOverageAmount: 0 }
}

describe('UsageAlertBanner', () => {
  beforeEach(() => {
    state.role = 'owner'
    sessionStorage.clear()
  })

  it('tells an owner that AI credits are used up, until when, and links to Billing', async () => {
    state.usage = usage(category('ai_messages', 'AI Credits', 1036, 350, '2026-10-15T00:00:00.000Z'))
    const wrapper = await mountSuspended(UsageAlertBanner)
    expect(wrapper.text()).toContain('AI credits are used up until October 15.')
    expect(wrapper.find('a').attributes('href')).toBe('/w/lanista/settings?tab=billing')
  })

  it('tells a member that site form submissions are being rejected, and who to ask', async () => {
    state.role = 'member'
    state.usage = usage(category('form_submissions', 'Form Submissions', 3100, 3000, '2026-10-01T00:00:00.000Z'))
    const wrapper = await mountSuspended(UsageAlertBanner)
    expect(wrapper.text()).toContain('Form submissions from your site are being rejected until October 1.')
    expect(wrapper.text()).toContain('Ask a workspace owner or admin.')
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('warns an owner at 80 %, but not a member', async () => {
    state.usage = usage(category('ai_messages', 'AI Credits', 300, 350, '2026-10-15T00:00:00.000Z'))
    expect((await mountSuspended(UsageAlertBanner)).text()).toContain('AI Credits: 86% used — resets October 15')
    state.role = 'member'
    expect((await mountSuspended(UsageAlertBanner)).text()).toBe('')
  })

  it('says nothing about a meter whose overage is on — nothing has stopped', async () => {
    state.usage = usage(category('ai_messages', 'AI Credits', 400, 350, '2026-10-15T00:00:00.000Z', { overageEnabled: true }))
    expect((await mountSuspended(UsageAlertBanner)).text()).toBe('')
  })

  it('CDN past its limit: still serving, owners see the upgrade notice, members see nothing yet', async () => {
    state.usage = usage(category('cdn_bandwidth', 'CDN Bandwidth', 65, 60, '2026-10-01T00:00:00.000Z'))
    const text = (await mountSuspended(UsageAlertBanner)).text()
    expect(text).toContain('Delivery stops at 120%')
    state.role = 'member'
    expect((await mountSuspended(UsageAlertBanner)).text()).toBe('')
  })

  it('CDN at the 120 % hard stop: everyone is told delivery has stopped', async () => {
    state.role = 'member'
    state.usage = usage(category('cdn_bandwidth', 'CDN Bandwidth', 73, 60, '2026-10-01T00:00:00.000Z'))
    expect((await mountSuspended(UsageAlertBanner)).text()).toContain('CDN delivery has stopped until October 1')
  })

  it('995 of 1 000 is not "stopped" even though it rounds to 100 %', async () => {
    state.usage = usage(category('form_submissions', 'Form Submissions', 2995, 3000, '2026-10-01T00:00:00.000Z', { percentage: 100 }))
    const text = (await mountSuspended(UsageAlertBanner)).text()
    expect(text).not.toContain('being rejected')
    expect(text).toContain('Form Submissions: 100% used')
  })

  it('renders when session storage is unavailable', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    state.usage = usage(category('ai_messages', 'AI Credits', 1036, 350, '2026-10-15T00:00:00.000Z'))
    expect((await mountSuspended(UsageAlertBanner)).text()).toContain('AI credits are used up')
    spy.mockRestore()
  })
})
