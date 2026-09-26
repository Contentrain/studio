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
    const move = wrapper.findAll('button').find(b => b.text().includes('Move 12 files'))
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
  it('files still on the old site: said, and counted in the move; one on another host is said to stay', async () => {
    const { wrapper } = await mount({ present: true, uploadAllowed: true, job: null, preflight: preflight({ onOrigin: { count: 3, knownBytes: 10 * MB, overSize: [], offOrigin: 1 } }) })
    const origin = wrapper.find('[data-testid=migration-media-origin]').text()
    expect(origin).toContain('3 files are still on the old site')
    expect(origin).toContain('1 files are on another host')
    expect(wrapper.findAll('button').some(b => b.text().includes('Move 15 files (40.0 MB)'))).toBe(true)
  })

  it('CDN delivery off: says the images would not load, links to CDN delivery, and holds the switch back', async () => {
    const done = { id: 'job-1', status: 'done', total: 12, done: 12, failed: 0, deduped: 0, pending: 0, bytesDone: 0, error: null }
    const routerReplace = vi.spyOn(useRouter(), 'replace').mockResolvedValue(undefined)
    const { wrapper, fetcher } = await mount({ present: true, uploadAllowed: true, deliveryBlocked: 'cdn_disabled', job: done, preflight: preflight() })
    const notice = wrapper.find('[data-testid=migration-media-delivery]')
    expect(notice.text()).toContain('CDN delivery, which is off')
    await notice.findAll('button').find(b => b.text() === 'Open CDN delivery')!.trigger('click')
    expect(routerReplace).toHaveBeenCalledWith({ query: { cdn: 'true' } })

    fetcher.mockImplementation(async () => ({ status: 'dry_run', blocked: 'cdn_disabled', counts: { filesChanged: 2, rewritten: 12, drifted: [], notImported: [], remaining: [], deleted: 0, keptBecause: 'not_requested' } }))
    await wrapper.findAll('button').find(b => b.text() === 'Check the addresses')!.trigger('click')
    await flushPromises()
    const switchButton = wrapper.findAll('button').find(b => b.text() === 'Switch to Studio addresses')!
    expect(switchButton.attributes('disabled')).toBeDefined()

    // CDN turned on in the meantime: the next check clears the notice and frees the switch.
    fetcher.mockImplementation(async () => ({ status: 'dry_run', counts: { filesChanged: 2, rewritten: 12, drifted: [], notImported: [], remaining: [], deleted: 0, keptBecause: 'not_requested' } }))
    await wrapper.findAll('button').find(b => b.text() === 'Check the addresses')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=migration-media-delivery]').exists()).toBe(false)
    expect(wrapper.findAll('button').find(b => b.text() === 'Switch to Studio addresses')!.attributes('disabled')).toBeUndefined()
  })

  it('a plan without CDN delivery: the notice offers the plans, not the CDN panel', async () => {
    const { wrapper } = await mount({ present: true, uploadAllowed: true, deliveryBlocked: 'plan', job: null, preflight: preflight() })
    const notice = wrapper.find('[data-testid=migration-media-delivery]')
    expect(notice.text()).toContain('needs a plan with CDN delivery')
    expect(notice.findAll('button').map(b => b.text())).toEqual(['See plans'])
  })

  it('public media off: says who can turn it on, offers no button the user could not follow', async () => {
    const { wrapper } = await mount({ present: true, uploadAllowed: true, deliveryBlocked: 'public_media_off', job: null, preflight: preflight() })
    const notice = wrapper.find('[data-testid=migration-media-delivery]')
    expect(notice.text()).toContain('ask them to turn it on')
    expect(notice.findAll('button')).toHaveLength(0)
  })
})
