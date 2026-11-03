import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ConsentPage from '../../../app/pages/oauth/consent.vue'

/**
 * The consent screen never picks the project for the user: a grant opens one project's content to an outside app, so
 * even the only eligible workspace and project wait for the user's own click.
 */
const consent = {
  client: { displayHost: 'claude.ai', name: 'Claude', logoUri: null, loopbackOnly: false },
  scope: 'content:read project:metadata',
  scopes: ['content:read', 'project:metadata'],
  workspaces: [{ id: 'ws-1', name: 'Acme', slug: 'acme', role: 'owner', eligible: true, reason: null, projects: [{ id: 'proj-1', repoFullName: 'acme/site', eligible: true, reason: null }] }],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/oauth/consent', () => {
  it('the only eligible workspace and project are not preselected: Approve is off until the user picks both', async () => {
    const fetcher = vi.fn(async (_url: string, options?: { method?: string, body?: unknown }) => (options?.method === 'POST' ? { redirectTo: '/done' } : consent))
    vi.stubGlobal('$fetch', fetcher)
    const wrapper = await mountSuspended(ConsentPage)
    await flushPromises()
    const approve = () => wrapper.findAll('button').find(b => b.text() === 'Approve')!

    expect(wrapper.find('input[type="radio"]').exists()).toBe(false)
    expect(approve().attributes('disabled')).toBeDefined()

    await wrapper.findAll('button').find(b => b.text().includes('Acme'))!.trigger('click')
    const radio = wrapper.find('input[type="radio"]')
    expect((radio.element as HTMLInputElement).checked).toBe(false)
    expect(approve().attributes('disabled')).toBeDefined()

    await radio.setValue(true)
    expect(approve().attributes('disabled')).toBeUndefined()
  })
})
