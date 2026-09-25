import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import MigrationMediaCard from '../../../app/components/organisms/MigrationMediaCard.vue'

const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }))
mockNuxtImport('useRoute', () => () => ({ query: routeQuery.value }))

const MB = 1024 * 1024
const preflight = (over: Record<string, unknown> = {}) => ({
  count: 12,
  totalBytes: 30 * MB,
  overSize: [],
  missing: [],
  fontsKept: 2,
  refs: 40,
  limits: { maxFileBytes: 5 * MB, storageBytes: 1024 * MB },
  storage: { usedBytes: 0, remainingBytes: 1024 * MB },
  fits: true,
  upgrade: null,
  ...over,
})

function stubFetch(state: Record<string, unknown>) {
  const fetcher = vi.fn(async (url: string, opts?: { method?: string }) => {
    if (url.endsWith('/migration/media') && opts?.method === 'POST')
      return { job: { id: 'job-1', status: 'queued', total: 12, done: 0, failed: 0, deduped: 0, pending: 12, bytesDone: 0, error: null } }
    return state
  })
  vi.stubGlobal('$fetch', fetcher)
  return fetcher
}

async function mount(state: Record<string, unknown>, query: Record<string, string> = {}) {
  const fetcher = stubFetch(state)
  routeQuery.value = query
  const wrapper = await mountSuspended(MigrationMediaCard, { props: { workspaceId: 'w', projectId: 'p', editable: true } })
  await flushPromises()
  return { wrapper, fetcher }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MigrationMediaCard', () => {
  it('says what is in the repository, that it will be public, and offers the move', async () => {
    const { wrapper, fetcher } = await mount({ present: true, uploadAllowed: true, job: null, preflight: preflight() })
    const text = wrapper.text()
    expect(text).toContain('12 images (30.0 MB)')
    expect(text).toContain('public addresses')
    const move = wrapper.findAll('button').find(b => b.text().includes('Move 12 images'))
    expect(move).toBeTruthy()
    await move!.trigger('click')
    await flushPromises()
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/w/projects/p/migration/media', { method: 'POST' })
  })

  it('a plan without media storage: no move, an upgrade prompt instead', async () => {
    const { wrapper } = await mount({ present: true, uploadAllowed: false, job: null, preflight: preflight() })
    expect(wrapper.text()).toContain('needs a plan with media storage')
    expect(wrapper.findAll('button').some(b => b.text().includes('Move'))).toBe(false)
    expect(wrapper.findAll('button').some(b => b.text().includes('See plans'))).toBe(true)
  })

  it('a paused move shows where it stopped and offers to continue', async () => {
    const { wrapper } = await mount({ present: true, uploadAllowed: true, job: { id: 'job-1', status: 'paused_quota', total: 12, done: 5, failed: 0, deduped: 0, pending: 7, bytesDone: 0, error: null }, preflight: preflight() })
    expect(wrapper.text()).toContain('Paused at 5 of 12')
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('42')
    expect(wrapper.findAll('button').some(b => b.text() === 'Continue')).toBe(true)
  })

  it('no manifest: nothing rendered', async () => {
    const { wrapper } = await mount({ present: false })
    expect(wrapper.find('[data-testid="migration-media"]').exists()).toBe(false)
  })

  it('opened from the claim screen (?focus=migration-media), the card scrolls into view; otherwise it stays put', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    await mount({ present: true, uploadAllowed: true, job: null, preflight: preflight() })
    expect(scroll).not.toHaveBeenCalled()
    const { wrapper } = await mount({ present: true, uploadAllowed: true, job: null, preflight: preflight() }, { focus: 'migration-media' })
    expect(scroll).toHaveBeenCalledOnce()
    expect(scroll.mock.contexts[0]).toBe(wrapper.find('#migration-media').element)
  })
})
