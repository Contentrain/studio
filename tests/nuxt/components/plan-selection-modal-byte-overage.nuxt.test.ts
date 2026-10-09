import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import PlanSelectionModal from '../../../app/components/organisms/PlanSelectionModal.vue'

/**
 * CDN and storage overage is sold only where the deployment runs their
 * meters (NUXT_CDN_ORIGIN_METER / NUXT_CDN_STORAGE_METER). The plan cards
 * quote its price only once the server says so (`overageSellable`).
 */
const { state } = vi.hoisted(() => ({ state: { sellable: false } }))

mockNuxtImport('useBilling', () => () => ({
  billingState: computed(() => 'subscribed'),
  effectivePlan: computed(() => 'starter'),
  trialConsumed: computed(() => true),
  activeAccount: computed(() => ({ credit_unit: '0.01' })),
  startCheckout: async () => {},
  openPortal: async () => {},
}))
mockNuxtImport('useWorkspaceRole', () => () => ({ role: computed(() => 'owner'), isOwnerOrAdmin: computed(() => true) }))
mockNuxtImport('useUsage', () => () => ({
  usage: computed(() => ({
    billingPeriod: '2026-10-01',
    categories: [
      { key: 'cdn_bandwidth', limitKey: 'cdn.bandwidth_gb', overageSellable: state.sellable },
      { key: 'media_storage', limitKey: 'media.storage_gb', overageSellable: state.sellable },
    ],
    totalOverageAmount: 0,
    projectedOverageAmount: 0,
  })),
  fetchUsage: vi.fn().mockResolvedValue(undefined),
}))

describe('PlanSelectionModal — CDN and storage overage prices', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('quotes no CDN or storage price while the deployment does not sell it', async () => {
    state.sellable = false
    await mountSuspended(PlanSelectionModal, { props: { open: true }, attachTo: document.body })
    await nextTick()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('$0.15')
    expect(text).not.toContain('$0.25')
  })

  it('quotes them once it does', async () => {
    state.sellable = true
    await mountSuspended(PlanSelectionModal, { props: { open: true }, attachTo: document.body })
    await nextTick()
    const text = document.body.textContent ?? ''
    expect(text).toContain('then $0.15 per GB')
    expect(text).toContain('then $0.25 per GB/month')
  })
})
