import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectSettingsModal from '../../../app/components/organisms/ProjectSettingsModal.vue'

const state = vi.hoisted(() => ({ edition: 'ee' as 'agpl' | 'ee', plan: 'pro' as string, admin: true }))

mockNuxtImport('useDeployment', () => () => ({ edition: state.edition }))
mockNuxtImport('useBilling', () => () => ({ effectivePlan: ref(state.plan) }))
mockNuxtImport('useWorkspaceRole', () => () => ({ isOwnerOrAdmin: ref(state.admin) }))
mockNuxtImport('useToast', () => () => ({ success: vi.fn(), error: vi.fn() }))

function stubFetch() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => (url.endsWith('/mcp-cloud-keys') ? { keys: [] } : [])))
}

async function open(initialTab?: 'general' | 'media' | 'api' | 'webhooks' | 'danger') {
  stubFetch()
  await mountSuspended(ProjectSettingsModal, {
    props: { open: true, workspaceId: 'ws-1', projectId: 'proj-1', projectName: 'Site', initialTab },
    attachTo: document.body,
  })
  await flushPromises()
}

function tabLabels(): string[] {
  return [...document.body.querySelectorAll('[role="tab"]')].map(el => el.textContent?.trim() ?? '')
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('project settings tabs', () => {
  it('Community: API keys (MCP keys) stays, webhooks are hidden', async () => {
    state.edition = 'agpl'
    state.plan = 'community'
    await open('api')
    const labels = tabLabels()
    expect(labels).toContain('API keys')
    expect(labels).not.toContain('Webhooks')
    expect(labels).not.toContain('Conversation API')
    expect(document.body.querySelector('[data-testid="project-mcp-keys"]')).not.toBeNull()
    // The ee-backed Conversation API section is hidden in Community, not locked.
    expect(document.body.querySelector('[data-testid="conversation-keys-section"]')).toBeNull()
  })

  it('managed Free: the tabs show, the ee-backed ones carry an upgrade call to action', async () => {
    state.edition = 'ee'
    state.plan = 'free'
    await open('api')
    expect(tabLabels()).toEqual(expect.arrayContaining(['General', 'API keys', 'Webhooks', 'Danger Zone']))
    expect(document.body.querySelector('[data-testid="conversation-keys-locked"]')).not.toBeNull()
    expect(document.body.textContent).toContain('The Conversation API is available on Pro and Enterprise plans')
  })

  it('managed Free: the webhooks tab says what plan it needs', async () => {
    state.edition = 'ee'
    state.plan = 'free'
    await open('webhooks')
    expect(document.body.querySelector('[data-testid="webhooks-locked"]')).not.toBeNull()
  })

  it('Pro: MCP keys and Conversation API keys sit in one tab as two sections, webhooks work', async () => {
    state.edition = 'ee'
    state.plan = 'pro'
    await open('api')
    expect(tabLabels()).toEqual(expect.arrayContaining(['API keys', 'Webhooks']))
    expect(document.body.querySelector('[data-testid="project-mcp-keys"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="conversation-keys-section"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="conversation-keys-locked"]')).toBeNull()
  })

  it('the old Conversation API tab label is gone', async () => {
    state.edition = 'ee'
    state.plan = 'pro'
    await open()
    expect(tabLabels()).not.toContain('Conversation API')
  })
})
