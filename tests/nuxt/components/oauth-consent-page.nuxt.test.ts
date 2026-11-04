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

  it('lists the media permissions only for a media-eligible project, as the grant does', async () => {
    const media = {
      ...consent,
      scope: 'content:read project:metadata media:read media:write',
      scopes: ['content:read', 'project:metadata', 'media:read', 'media:write'],
      workspaces: [{
        ...consent.workspaces[0]!,
        projects: [
          { id: 'proj-1', repoFullName: 'acme/site', eligible: true, reason: null, mediaEligible: true },
          { id: 'proj-2', repoFullName: 'acme/docs', eligible: true, reason: null, mediaEligible: false },
        ],
      }],
    }
    vi.stubGlobal('$fetch', vi.fn(async () => media))
    const wrapper = await mountSuspended(ConsentPage)
    await flushPromises()

    // Nothing picked yet: no media permission is promised.
    expect(wrapper.text()).not.toContain('View media assets')

    await wrapper.findAll('button').find(b => b.text().includes('Acme'))!.trigger('click')
    const radios = wrapper.findAll('input[type="radio"]')
    await radios[1]!.setValue(true)
    expect(wrapper.text()).not.toContain('View media assets')

    await radios[0]!.setValue(true)
    expect(wrapper.text()).toContain('View media assets')
  })
})
