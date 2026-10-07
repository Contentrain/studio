import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ConversationKeysPanel from '../../../app/components/organisms/ConversationKeysPanel.vue'
import WebhookSettingsPanel from '../../../app/components/organisms/WebhookSettingsPanel.vue'

const state = vi.hoisted(() => ({ admin: true, success: vi.fn(), error: vi.fn() }))

mockNuxtImport('useWorkspaceRole', () => () => ({ isOwnerOrAdmin: ref(state.admin) }))
mockNuxtImport('useToast', () => () => ({ success: state.success, error: state.error }))

const props = { workspaceId: 'ws-1', projectId: 'proj-1' }

afterEach(() => {
  vi.unstubAllGlobals()
  state.admin = true
  state.success.mockReset()
  state.error.mockReset()
})

describe('Conversation API keys panel', () => {
  it('a member is told it is admin-only and the owner/admin route is never called', async () => {
    state.admin = false
    const fetchMock = vi.fn(async () => [])
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = await mountSuspended(ConversationKeysPanel, { props })
    await flushPromises()
    expect(wrapper.find('[data-testid="conversation-keys-admin-note"]').text()).toContain('Only workspace owners and admins')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('No API keys')
  })

  it('an admin sees role labels from the dictionary and the monthly usage', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => [{
      id: 'c1', name: 'Bot', keyPrefix: 'crn_conv_x', role: 'editor', monthlyUsage: 12, lastUsedAt: null, revokedAt: null,
    }]))
    const wrapper = await mountSuspended(ConversationKeysPanel, { props })
    await flushPromises()
    expect(wrapper.text()).toContain('Editor')
    expect(wrapper.find('[data-testid="conversation-key-usage"]').text()).toBe('12 messages this month')
  })

  it('the revoke confirm button says Revoke', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => [{
      id: 'c1', name: 'Bot', keyPrefix: 'crn_conv_x', role: 'viewer', monthlyUsage: 0, lastUsedAt: null, revokedAt: null,
    }]))
    const wrapper = await mountSuspended(ConversationKeysPanel, { props })
    await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === 'Revoke')!.trigger('click')
    const labels = wrapper.findAll('button').map(b => b.text())
    expect(labels.filter(l => l === 'Revoke')).toHaveLength(1)
    expect(labels).not.toContain('Delete')
  })
})

describe('Webhooks panel', () => {
  const hook = { id: 'w1', name: 'Prod', url: 'https://example.com/hook', events: ['content.saved'], active: true, created_at: '2026-07-01T00:00:00Z', updated_at: null, secret: null }

  it('a member is told it is admin-only and the owner/admin route is never called', async () => {
    state.admin = false
    const fetchMock = vi.fn(async () => [])
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = await mountSuspended(WebhookSettingsPanel, { props })
    await flushPromises()
    expect(wrapper.find('[data-testid="webhooks-admin-note"]').exists()).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an admin can pause an active webhook (PATCH active:false) and the badge follows', async () => {
    const fetchMock = vi.fn(async (_url: string, opts?: { method?: string }) => (opts?.method === 'PATCH' ? {} : [hook]))
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = await mountSuspended(WebhookSettingsPanel, { props })
    await flushPromises()
    expect(wrapper.text()).toContain('Active')
    await wrapper.find('[data-testid="webhook-toggle"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-1/projects/proj-1/webhooks/w1', { method: 'PATCH', body: { active: false } })
    expect(wrapper.text()).toContain('Inactive')
    expect(wrapper.find('[data-testid="webhook-toggle"]').text()).toBe('Resume')
  })

  it('the description no longer claims a Business plan is required', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => []))
    const wrapper = await mountSuspended(WebhookSettingsPanel, { props })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Business plan')
  })
})
