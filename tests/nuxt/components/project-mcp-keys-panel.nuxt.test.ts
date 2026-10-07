import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectMcpKeysPanel from '../../../app/components/organisms/ProjectMcpKeysPanel.vue'

const state = vi.hoisted(() => ({ admin: true, limit: 5 as number, success: vi.fn(), error: vi.fn() }))

mockNuxtImport('useWorkspaceRole', () => () => ({ isOwnerOrAdmin: ref(state.admin) }))
mockNuxtImport('useFeatureLimit', () => (_key: string) => computed(() => state.limit))
mockNuxtImport('useToast', () => () => ({ success: state.success, error: state.error }))

const KEYS = [
  { id: 'k1', name: 'Cursor', key_prefix: 'crn_mcp_a1', project_id: 'proj-1', media_enabled: false, last_used_at: null, calls_this_month: 7 },
  { id: 'k2', name: 'CI', key_prefix: 'crn_mcp_b2', project_id: 'proj-1', media_enabled: true, last_used_at: null, calls_this_month: 0 },
  { id: 'k3', name: 'Other project key', key_prefix: 'crn_mcp_c3', project_id: 'proj-2', media_enabled: false, last_used_at: null, calls_this_month: 0 },
]

function stubFetch(extra?: (url: string, opts?: { method?: string }) => unknown) {
  const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
    const custom = extra?.(url, opts)
    if (custom !== undefined) return custom
    return { keys: KEYS }
  })
  vi.stubGlobal('$fetch', fetchMock)
  return fetchMock
}

function revokeButton(wrapper: { findAll: (selector: string) => Array<{ text: () => string, trigger: (event: string) => Promise<void> }> }) {
  return wrapper.findAll('button').find(b => b.text() === 'Revoke')
}

async function mountPanel() {
  const wrapper = await mountSuspended(ProjectMcpKeysPanel, { props: { workspaceId: 'ws-1', projectId: 'proj-1' } })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.unstubAllGlobals()
  state.admin = true
  state.limit = 5
  state.success.mockReset()
  state.error.mockReset()
})

describe('ProjectMcpKeysPanel', () => {
  it('lists only this project\'s keys but counts every workspace key against the limit', async () => {
    stubFetch()
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('Cursor')
    expect(wrapper.text()).toContain('CI')
    expect(wrapper.text()).not.toContain('Other project key')
    expect(wrapper.find('[data-testid="mcp-key-quota"]').text()).toBe('3 of 5 keys used across this workspace.')
  })

  it('says "no limit" instead of "of Infinity" on an unlimited plan', async () => {
    state.limit = Infinity
    stubFetch()
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="mcp-key-quota"]').text()).toBe('3 keys used across this workspace, with no limit on your plan.')
  })

  it('shows this project\'s endpoint', async () => {
    stubFetch()
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('/api/mcp/v1/proj-1/mcp')
  })

  it('creates a key for this project without a project picker', async () => {
    const fetchMock = stubFetch((url, opts) => (opts?.method === 'POST' ? { key: 'crn_mcp_secret' } : undefined))
    const wrapper = await mountPanel()
    await wrapper.find('#mcp-key-name').setValue('Agent')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const post = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST')
    expect(post?.[0]).toBe('/api/workspaces/ws-1/mcp-cloud-keys')
    expect(post?.[1]).toMatchObject({ body: { name: 'Agent', projectId: 'proj-1', mediaEnabled: false } })
    expect(wrapper.find('select').exists()).toBe(false)
  })

  it('a member sees the keys but no create form and no revoke buttons, and is told why', async () => {
    state.admin = false
    stubFetch()
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('Cursor')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(revokeButton(wrapper)).toBeUndefined()
    expect(wrapper.find('[data-testid="mcp-keys-admin-note"]').text()).toContain('Only workspace owners and admins')
  })

  it('revokes with an inline two-step confirm and the success toast', async () => {
    const fetchMock = stubFetch((url, opts) => (opts?.method === 'DELETE' ? {} : undefined))
    const wrapper = await mountPanel()
    await revokeButton(wrapper)!.trigger('click')
    await wrapper.find('[data-testid="mcp-key-confirm-revoke"]').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-1/mcp-cloud-keys/k1', { method: 'DELETE' })
    expect(state.success).toHaveBeenCalledWith('Key revoked')
    expect(wrapper.text()).not.toContain('crn_mcp_a1')
  })

  it('a failed revoke says so, not "Failed to create key"', async () => {
    stubFetch((url, opts) => {
      if (opts?.method === 'DELETE') throw new Error('boom')
      return undefined
    })
    const wrapper = await mountPanel()
    await revokeButton(wrapper)!.trigger('click')
    await wrapper.find('[data-testid="mcp-key-confirm-revoke"]').trigger('click')
    await flushPromises()
    expect(state.error).toHaveBeenCalledWith('Failed to revoke the key')
  })
})
