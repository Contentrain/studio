import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import PlanSelectionModal from '../../../app/components/organisms/PlanSelectionModal.vue'

/**
 * A subscription sold before catalog v2 keeps its terms ($0.03 credits:
 * Pro 350 AI / 140 API, overage $0.08). Its "Current plan" card must show
 * those, with a note — not the v2 catalog's 1,600 / 450 / $0.025.
 */
const { state } = vi.hoisted(() => ({ state: { creditUnit: '0.03' as '0.03' | '0.01' } }))

mockNuxtImport('useBilling', () => () => ({
  billingState: computed(() => 'subscribed'),
  effectivePlan: computed(() => 'pro'),
  trialConsumed: computed(() => true),
  activeAccount: computed(() => ({ credit_unit: state.creditUnit })),
  startCheckout: async () => {},
  openPortal: async () => {},
}))
mockNuxtImport('useWorkspaceRole', () => () => ({
  role: computed(() => 'owner'),
  isOwnerOrAdmin: computed(() => true),
}))

function proCard(): HTMLElement {
  const cards = [...document.body.querySelectorAll('h3')].filter(h => h.textContent?.trim() === 'Pro')
  return cards[0]!.closest('div.relative') as HTMLElement
}

describe('PlanSelectionModal — a pre-v2 subscriber\'s own terms', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('shows a pre-v2 Pro its own credits and overage price, with the note', async () => {
    state.creditUnit = '0.03'
    await mountSuspended(PlanSelectionModal, { props: { open: true }, attachTo: document.body })
    await nextTick()
    const card = proCard().textContent ?? ''
    expect(card).toContain('350')
    expect(card).toContain('$0.08')
    expect(card).not.toContain('1,600')
    expect(proCard().querySelector('[data-testid="original-terms-note"]')).not.toBeNull()
    // Starter is not their plan: the catalog's numbers.
    const starter = [...document.body.querySelectorAll('h3')].find(h => h.textContent?.trim() === 'Starter')!.closest('div.relative')!.textContent ?? ''
    expect(starter).toContain('300')
  })

  it('shows a v2 Pro the catalog\'s numbers and no note', async () => {
    state.creditUnit = '0.01'
    await mountSuspended(PlanSelectionModal, { props: { open: true }, attachTo: document.body })
    await nextTick()
    const card = proCard().textContent ?? ''
    expect(card).toContain('1,600')
    expect(card).toContain('$0.025')
    expect(proCard().querySelector('[data-testid="original-terms-note"]')).toBeNull()
  })
})
