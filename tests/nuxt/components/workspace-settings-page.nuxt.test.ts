import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import SettingsPage from '../../../app/pages/w/[slug]/settings.vue'

const state = vi.hoisted(() => ({
  edition: 'ee' as 'agpl' | 'ee',
  plan: 'pro' as string,
  query: {} as Record<string, string>,
}))

mockNuxtImport('useDeployment', () => () => ({ edition: state.edition }))
mockNuxtImport('useBilling', () => () => ({ effectivePlan: ref(state.plan) }))
mockNuxtImport('useRoute', () => () => ({ params: { slug: 'acme' }, query: state.query }))
mockNuxtImport('useToast', () => () => ({ success: vi.fn(), error: vi.fn() }))

let replaceSpy: ReturnType<typeof vi.spyOn>

async function visit(query: Record<string, string> = {}) {
  state.query = query
  replaceSpy = vi.spyOn(useRouter(), 'replace').mockResolvedValue(undefined)
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => (url === '/api/workspaces'
    ? [{ id: 'ws-1', slug: 'acme', name: 'Acme', plan: 'free', workspace_members: [{ role: 'owner' }] }]
    : [])))
  const wrapper = await mountSuspended(SettingsPage, {
    attachTo: document.body,
    // Only the tab strip and the AI panel matter here; the other panels have their own tests.
    global: {
      stubs: {
        OrganismsWorkspaceOverviewPanel: true,
        OrganismsWorkspaceMembersPanel: true,
        OrganismsWorkspaceBillingPanel: true,
        OrganismsWorkspaceGitHubPanel: true,
        OrganismsWorkspaceConnectedAppsPanel: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

function tabLabels(wrapper: Awaited<ReturnType<typeof visit>>): string[] {
  return wrapper.findAll('[role="tab"]').map(el => el.text())
}

afterEach(() => {
  replaceSpy?.mockRestore()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('workspace settings tabs', () => {
  it('has Connected apps and AI, and no MCP Cloud tab', async () => {
    state.edition = 'ee'
    state.plan = 'pro'
    const wrapper = await visit()
    const labels = tabLabels(wrapper)
    expect(labels).toContain('Connected apps')
    expect(labels).toContain('AI')
    expect(labels).not.toContain('MCP Cloud')
    expect(labels).not.toContain('AI Keys')
  })

  it('old ?tab=ai-keys links land on the AI tab', async () => {
    state.edition = 'ee'
    state.plan = 'pro'
    const wrapper = await visit({ tab: 'ai-keys' })
    expect(replaceSpy).toHaveBeenCalledWith({ query: { tab: 'ai' } })
    expect(wrapper.find('[role="tab"][data-state="active"]').text()).toBe('AI')
  })

  it('old ?tab=mcp-cloud links land on Connected apps', async () => {
    state.edition = 'ee'
    state.plan = 'pro'
    const wrapper = await visit({ tab: 'mcp-cloud' })
    expect(replaceSpy).toHaveBeenCalledWith({ query: { tab: 'connected-apps' } })
    expect(wrapper.find('[role="tab"][data-state="active"]').text()).toBe('Connected apps')
  })

  it('managed Free sees the AI tab with an upgrade call to action; Community does not see it at all', async () => {
    state.edition = 'ee'
    state.plan = 'free'
    const free = await visit({ tab: 'ai' })
    expect(tabLabels(free)).toContain('AI')
    expect(document.body.querySelector('[data-testid="ai-keys-locked"]')).not.toBeNull()
    document.body.innerHTML = ''

    state.edition = 'agpl'
    state.plan = 'community'
    const community = await visit({ tab: 'ai' })
    expect(tabLabels(community)).not.toContain('AI')
  })
})
