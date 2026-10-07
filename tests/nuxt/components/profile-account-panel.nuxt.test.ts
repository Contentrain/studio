import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ProfileAccountPanel from '../../../app/components/organisms/ProfileAccountPanel.vue'

function stubFetch(endingPlans: Array<{ workspace_id: string, ends_at: string }>) {
  vi.stubGlobal('$fetch', vi.fn(async (url: string) => (url === '/api/profile/ending-plans' ? endingPlans : [])))
}

async function openDeleteDialog() {
  const wrapper = await mountSuspended(ProfileAccountPanel, { attachTo: document.body })
  await flushPromises()
  const button = wrapper.findAll('button').find(b => b.text() === 'Delete My Account')
  await button!.trigger('click')
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('delete account dialog', () => {
  it('warns when a plan is already set to end: access ends now, the rest is not refunded', async () => {
    stubFetch([{ workspace_id: 'ws-1', ends_at: '2027-01-15T12:00:00Z' }])
    await openDeleteDialog()
    expect(document.body.textContent).toContain('Your plan is set to end on January 15, 2027. Deleting your account now ends access immediately; the remaining period is not refunded.')
  })

  it('says nothing about a plan when none is set to end', async () => {
    stubFetch([])
    await openDeleteDialog()
    expect(document.body.textContent).toContain('This will permanently delete your account')
    expect(document.body.textContent).not.toContain('is set to end on')
  })
})
