import { describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import WorkspaceConnectedAppsPanel from '../../../app/components/organisms/WorkspaceConnectedAppsPanel.vue'

mockNuxtImport('useFeature', () => (_key: string) => computed(() => true))
mockNuxtImport('useToast', () => () => ({ success: vi.fn(), error: vi.fn() }))

registerEndpoint('/api/workspaces/ws-grants/connected-apps', () => ({
  enabled: true,
  endpoint: 'https://studio.example/api/mcp/remote',
  grants: [
    {
      grantId: 'grant-1',
      clientHost: 'claude.ai',
      clientName: 'Claude',
      logoUri: null,
      projectId: 'proj-1',
      projectRepo: 'acme/site',
      scopes: ['content:read', 'content:write', 'offline_access'],
      createdAt: '2026-07-01T00:00:00Z',
      lastUsedAt: '2026-07-12T10:00:00Z',
      callsThisMonth: 42,
      mine: true,
    },
  ],
}))

registerEndpoint('/api/workspaces/ws-supabase/connected-apps', () => ({
  enabled: false,
  endpoint: null,
  grants: [],
}))

describe('WorkspaceConnectedAppsPanel', () => {
  it('renders the endpoint card and grant rows', async () => {
    const wrapper = await mountSuspended(WorkspaceConnectedAppsPanel, {
      props: { workspaceId: 'ws-grants' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    const text = wrapper.text()
    expect(text).toContain('https://studio.example/api/mcp/remote')
    expect(text).toContain('claude mcp add --transport http contentrain-remote https://studio.example/api/mcp/remote')
    // The relying party is the client host, spec-style.
    expect(text).toContain('claude.ai')
    expect(text).toContain('acme/site')
    expect(text).toContain('content:write')
    expect(text).toContain('42')
  })

  it('offers a copyable Codex config.toml block for the same endpoint, with the OAuth login step', async () => {
    const wrapper = await mountSuspended(WorkspaceConnectedAppsPanel, {
      props: { workspaceId: 'ws-grants' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('OpenAI Codex (config.toml)')
    expect(wrapper.find('[data-testid="codex-config"]').text()).toBe([
      '[mcp_servers.contentrain-remote]',
      'url = "https://studio.example/api/mcp/remote"',
      '# then: codex mcp login contentrain-remote',
    ].join('\n'))
  })

  it('explains the managed-pair requirement instead of erroring on other deployments', async () => {
    const wrapper = await mountSuspended(WorkspaceConnectedAppsPanel, {
      props: { workspaceId: 'ws-supabase' },
    })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(wrapper.text()).toContain('managed deployments')
    expect(wrapper.text()).toContain('Project settings → API keys')
    expect(wrapper.text()).not.toContain('MCP Cloud tab')
    expect(wrapper.text()).not.toContain('/api/mcp/remote')
  })

  it('names the OAuth server contentrain-remote so it never collides with an MCP key entry', async () => {
    const wrapper = await mountSuspended(WorkspaceConnectedAppsPanel, { props: { workspaceId: 'ws-grants' } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(wrapper.text()).not.toContain('add --transport http contentrain ')
  })

  it('points CI and custom agents at the project API keys', async () => {
    const wrapper = await mountSuspended(WorkspaceConnectedAppsPanel, { props: { workspaceId: 'ws-grants' } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(wrapper.find('[data-testid="connected-apps-keys-hint"]').text()).toContain('Project settings → API keys')
  })

  it('disconnects after an inline confirm (no browser dialog)', async () => {
    const confirm = vi.fn()
    vi.stubGlobal('confirm', confirm)
    const fetchMock = vi.fn(async () => ({}))
    const wrapper = await mountSuspended(WorkspaceConnectedAppsPanel, { props: { workspaceId: 'ws-grants' } })
    await new Promise(resolve => setTimeout(resolve, 10))
    // The list came from the registered endpoint; only the DELETE goes through the stub.
    vi.stubGlobal('$fetch', fetchMock)
    await wrapper.findAll('button').find(b => b.text() === 'Disconnect')!.trigger('click')
    expect(wrapper.find('[data-testid="grant-confirm"]').exists()).toBe(true)
    await wrapper.find('[data-testid="grant-confirm-revoke"]').trigger('click')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-grants/connected-apps/grant-1', { method: 'DELETE' })
    expect(confirm).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
