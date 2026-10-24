import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MigrationSetupWizard from '../../../app/components/organisms/MigrationSetupWizard.vue'
import type { MigrationSetupScreen, MigrationSetupStep, MigrationState } from '../../../app/composables/useMigrationSetup'

/**
 * The setup wizard: each screen follows its step's state from `GET …/migration` `setup` and offers one primary click,
 * and each click is the route the step's state comes back from.
 */

const step = (name: MigrationSetupStep['step'], state: MigrationSetupStep['state'], reason: string): MigrationSetupStep => ({ step: name, state, reason })
const migration = (steps: MigrationSetupStep[], over: Partial<NonNullable<MigrationState['setup']>> = {}): MigrationState => ({
  present: true,
  summary: { siteUrl: 'https://www.acme.com', comments: { total: 4 } },
  commentsImported: 0,
  setup: {
    grant: { kind: 'bundle', plan: 'starter' },
    steps,
    completedAt: null,
    liveSiteUrl: null,
    liveCheck: null,
    forms: { models: 1, overLimit: 0 },
    media: { jobId: null, refusedTooLarge: null },
    ...over,
  },
})
const OPEN = [step('forms', 'needs_you', 'unbound'), step('comments', 'needs_you', 'ready'), step('images', 'needs_you', 'ready'), step('live', 'needs_you', 'unchecked')]

const preflight = { count: 9, totalBytes: 240_000, overSize: [], missing: [], fontsKept: 3, files: 2, limits: { maxFileBytes: 10 * 1024 * 1024 }, fits: true }

function stubFetch(answers: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (url: string, _opts?: { method?: string, body?: Record<string, unknown> }) => {
    const path = url.replace(/^.*\/migration/, '')
    if (path in answers) return answers[path]
    if (path === '/media') return { present: true, uploadAllowed: true, job: null, preflight }
    if (path === '/comments-preview') return { total: 4, rows: [{ author: 'Ada', excerpt: 'Lovely post.' }] }
    return {}
  })
  vi.stubGlobal('$fetch', fetcher)
  return fetcher
}

async function mount(state: MigrationState, screen: MigrationSetupScreen, reload: () => Promise<void> = async () => {}) {
  const wrapper = await mountSuspended(MigrationSetupWizard, {
    attachTo: document.body,
    props: {
      state,
      base: '/api/workspaces/w/projects/p/migration',
      repoFullName: 'acme/site',
      models: [{ id: 'posts', name: 'Posts' }, { id: 'pages', name: 'Pages' }],
      content: { posts: { count: 9 }, pages: { count: 7 } },
      reload,
      open: true,
      screen,
    },
  })
  await flushPromises()
  return wrapper
}

const dialog = () => document.body.querySelector('[data-testid="migration-setup-wizard"]')!
const primaries = () => [...dialog().querySelectorAll('button')].filter(b => b.className.includes('bg-primary-600'))
const button = (text: string) => [...dialog().querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('MigrationSetupWizard', () => {
  it.each([
    ['main', OPEN, 'Start setup'],
    ['forms', OPEN, 'Turn on and continue'],
    ['forms', [step('forms', 'done', 'bound'), ...OPEN.slice(1)], 'Continue'],
    ['comments', OPEN, 'Import 4 comments'],
    ['comments', [OPEN[0]!, step('comments', 'done', 'none'), ...OPEN.slice(2)], 'Continue'],
    ['images', OPEN, 'Move 9 images'],
    ['images', [...OPEN.slice(0, 2), step('images', 'needs_you', 'review'), OPEN[3]!], 'Approve and merge'],
    ['images', [...OPEN.slice(0, 2), step('images', 'needs_you', 'apply_pending'), OPEN[3]!], 'Point the pages at Studio Media'],
    ['live', OPEN, 'I see it, finish'],
  ] as const)('%s screen, %#: one primary click', async (screen, steps, label) => {
    stubFetch()
    await mount(migration([...steps]), screen)
    expect(dialog().getAttribute('data-screen')).toBe(screen)
    expect(primaries().map(b => b.textContent?.trim())).toEqual([label])
  })

  it('the first screen names the repository, the plan the migration came with, and the content by model', async () => {
    stubFetch()
    await mount(migration(OPEN), 'main')
    const text = dialog().textContent
    expect(text).toContain('Set up acme.com in Studio')
    expect(text).toContain('acme/site')
    expect(text).toContain('Studio Starter plan')
    expect(text).toContain('Posts (9), Pages (7)')
  })

  it('turning forms on binds the site, then the comments screen says so and shows the preview', async () => {
    const fetcher = stubFetch()
    const state = reactive(migration(OPEN))
    const reload = async () => {
      state.setup!.steps = [step('forms', 'done', 'bound'), ...OPEN.slice(1)]
    }
    await mount(state, 'forms', reload)
    button('Turn on and continue')!.click()
    await flushPromises()
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/w/projects/p/migration/site-binding', expect.objectContaining({ method: 'POST' }))
    expect(dialog().getAttribute('data-screen')).toBe('comments')
    expect(dialog().textContent).toContain('Forms and comments run with Studio now')
    expect(dialog().textContent).toContain('Ada')
  })

  it('Move asks for the apply with the move and with the repository copies choice; skipping records a skip', async () => {
    const fetcher = stubFetch({ '/media': { present: true, uploadAllowed: true, job: null, preflight } })
    await mount(migration(OPEN), 'images')
    const box = dialog().querySelector('input[type="checkbox"]') as HTMLInputElement
    box.click()
    await flushPromises()
    button('Move 9 images')!.click()
    await flushPromises()
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/w/projects/p/migration/media', { method: 'POST', body: { applyWhenDone: true, deleteLocal: true } })
    button('Keep them in the repository')!.click()
    await flushPromises()
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/w/projects/p/migration/setup', { method: 'POST', body: { skip: 'images' } })
  })

  it('a blocked image delivery holds the Move back and says why', async () => {
    stubFetch({ '/media': { present: true, uploadAllowed: true, job: null, deliveryBlocked: 'cdn_disabled', preflight } })
    await mount(migration(OPEN), 'images')
    expect(dialog().querySelector('[data-testid="setup-images-delivery-blocked"]')).toBeTruthy()
    expect(dialog().querySelector('[data-testid="setup-images-delivery-on"]')).toBeNull()
    expect(button('Move 9 images')!.disabled).toBe(true)
  })

  it('the live check: not seen by the fetch offers the owner\'s word, which is recorded', async () => {
    const fetcher = stubFetch({ '/live-check/verify': { seen: false } })
    const state = migration([...OPEN.slice(0, 3), step('live', 'needs_you', 'not_seen')], { liveSiteUrl: 'https://acme.com', liveCheck: { status: 'merged', at: 't', seenAt: null, seenBy: null } })
    await mount(state, 'live')
    button('I see it, finish')!.click()
    await flushPromises()
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/w/projects/p/migration/live-check/verify', expect.objectContaining({ method: 'POST' }))
    expect(dialog().querySelector('[data-testid="setup-live-not-seen"]')).toBeTruthy()
    button('mark it done')!.click()
    await flushPromises()
    expect(fetcher).toHaveBeenCalledWith('/api/workspaces/w/projects/p/migration/setup', { method: 'POST', body: { seen: true } })
  })
})
