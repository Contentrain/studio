import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import WorkspaceAIKeysPanel from '../../../app/components/organisms/WorkspaceAIKeysPanel.vue'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
mockNuxtImport('useToast', () => () => toast)

const KEY = { id: 'key-1', provider: 'anthropic', key_hint: 'abcd', created_at: '2026-07-01T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  toast.success.mockReset()
  toast.error.mockReset()
})

describe('WorkspaceAIKeysPanel', () => {
  it('says the key is personal', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => []))
    const wrapper = await mountSuspended(WorkspaceAIKeysPanel, { props: { workspaceId: 'ws-1' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Your Anthropic API key')
    expect(wrapper.text()).toContain('visible only to you, and each member adds their own')
  })

  it('reloads the key list when the workspace prop changes', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes('ws-1') ? [KEY] : []))
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = await mountSuspended(WorkspaceAIKeysPanel, { props: { workspaceId: 'ws-1' } })
    await flushPromises()
    expect(wrapper.text()).toContain('abcd')

    await wrapper.setProps({ workspaceId: 'ws-2' })
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-2/ai-keys')
    expect(wrapper.text()).not.toContain('abcd')
  })

  it('a failed delete says the key could not be removed, not that it could not be saved', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'DELETE') throw new Error('boom')
      return [KEY]
    }))
    const wrapper = await mountSuspended(WorkspaceAIKeysPanel, { props: { workspaceId: 'ws-1' } })
    await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === 'Delete')!.trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Failed to remove the API key')
  })

  it('locked: shows the upgrade call to action and does not load keys', async () => {
    const fetchMock = vi.fn(async () => [])
    vi.stubGlobal('$fetch', fetchMock)
    const wrapper = await mountSuspended(WorkspaceAIKeysPanel, { props: { workspaceId: 'ws-1', locked: true } })
    await flushPromises()
    expect(wrapper.find('[data-testid="ai-keys-locked"]').exists()).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.find('form').exists()).toBe(false)
  })
})
