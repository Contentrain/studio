import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import WorkspaceUsagePanel from '../../../app/components/organisms/WorkspaceUsagePanel.vue'
import type { UsageCategory, UsageData } from '../../../app/composables/useUsage'

/** What the billing screen showed on staging, 2026-09-23 (BR-11), and what it must say instead. */
const { state } = vi.hoisted(() => ({ state: { usage: null as unknown } }))

mockNuxtImport('useUsage', () => () => ({
  usage: computed(() => state.usage as UsageData | null),
  loading: computed(() => false),
  fetchUsage: vi.fn(),
  toggleOverage: vi.fn(),
}))
mockNuxtImport('useBilling', () => () => ({ billingState: computed(() => 'subscribed'), billingEnabled: computed(() => true) }))

function category(key: string, limitKey: string, name: string, current: number, limit: number, unit: string, resetsAt: string | null, extra: Partial<UsageCategory> = {}): UsageCategory {
  return {
    key, limitKey, name, current, limit, unit, overageEnabled: false, overageSellable: true, overageLock: null,
    overageUnits: 0, overageUnitPrice: 0, overageAmount: 0, percentage: Math.round(current / limit * 100), resetsAt, ...extra,
  }
}

function staging(canManage: boolean): UsageData {
  return {
    billingPeriod: '2026-09-15',
    canManage,
    categories: [
      category('ai_messages', 'ai.messages_per_month', 'AI Credits', 1036, 350, 'credits', '2026-10-15T00:00:00.000Z', { overageUnitPrice: canManage ? 0.08 : 0 }),
      category('form_submissions', 'forms.submissions_per_month', 'Form Submissions', 1, 3000, 'submissions', '2026-10-01T00:00:00.000Z', { overageUnitPrice: canManage ? 0.01 : 0 }),
      category('cdn_bandwidth', 'cdn.bandwidth_gb', 'CDN Bandwidth', 5.3, 60, 'GB', '2026-10-01T00:00:00.000Z', { overageSellable: false }),
      category('media_storage', 'media.storage_gb', 'Media Storage', 1.9, 15, 'GB', null, { overageSellable: false }),
    ],
    totalOverageAmount: 0,
    projectedOverageAmount: 0,
  }
}

describe('WorkspaceUsagePanel', () => {
  beforeEach(() => {
    state.usage = staging(true)
  })

  it('shows the overage price before the switch is turned on', async () => {
    const text = (await mountSuspended(WorkspaceUsagePanel, { props: { workspaceId: 'ws-1' } })).text()
    expect(text).toContain('$0.08 per credit past the limit')
    expect(text).toContain('$0.01 per submission past the limit')
  })

  it('gives each meter its own reset date instead of one for all', async () => {
    const text = (await mountSuspended(WorkspaceUsagePanel, { props: { workspaceId: 'ws-1' } })).text()
    expect(text).toContain('Resets October 15')
    expect(text).toContain('Resets October 1')
    expect(text).toContain('Current total — does not reset')
    expect(text).not.toContain('September 2026')
  })

  it('prints a unit once: "60 GB", not "60 GB GB"', async () => {
    const text = (await mountSuspended(WorkspaceUsagePanel, { props: { workspaceId: 'ws-1' } })).text()
    expect(text).toContain('/ 60 GB')
    expect(text).not.toContain('GB GB')
  })

  it('points an owner at the switch when a limit is reached', async () => {
    const text = (await mountSuspended(WorkspaceUsagePanel, { props: { workspaceId: 'ws-1' } })).text()
    expect(text).toContain('AI Credits limit reached. Allow overage or upgrade to continue.')
  })

  it('shows a member the meters and who can change them — no switches', async () => {
    state.usage = staging(false)
    const wrapper = await mountSuspended(WorkspaceUsagePanel, { props: { workspaceId: 'ws-1' } })
    expect(wrapper.text()).toContain('Only workspace owners and admins can change the plan or allow overage.')
    expect(wrapper.text()).toContain('AI Credits limit reached. Ask a workspace owner or admin to allow overage or upgrade.')
    expect(wrapper.text()).not.toContain('Allow overage')
    expect(wrapper.find('[role="switch"]').exists()).toBe(false)
  })

  it('shows a meter it could not read as unavailable — no number, no switch, no price (AI-15)', async () => {
    const data = staging(true)
    data.categories[1] = category('form_submissions', 'forms.submissions_per_month', 'Form Submissions', 0, 3000, 'submissions', '2026-10-01T00:00:00.000Z', { overageUnitPrice: 0.01, percentage: 0, unavailable: true })
    state.usage = data
    const wrapper = await mountSuspended(WorkspaceUsagePanel, { props: { workspaceId: 'ws-1' } })
    const text = wrapper.text()
    expect(text).toContain('Usage could not be loaded right now. Try again in a moment.')
    expect(text).toContain('Unavailable')
    expect(text).not.toContain('/ 3,000 submissions')
    expect(text).not.toContain('/ 3000 submissions')
    expect(text).not.toContain('$0.01 per submission past the limit')
    // The other meters still show their numbers.
    expect(text).toContain('$0.08 per credit past the limit')
  })
})
