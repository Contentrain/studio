import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MigrationHandoffCard from '../../../app/components/organisms/MigrationHandoffCard.vue'

/** What the customer reads on the migration card: labels, never raw keys or Migrate's own records. */
const summary = {
  siteUrl: 'https://old.example',
  generatedAt: '2026-10-24T10:00:00.000Z',
  content: { models: 7, entries: 95, locales: ['tr-tr', 'en'] },
  capabilities: [
    { key: 'forms', disposition: 'needs_runtime' },
    { key: 'comments', disposition: 'kept_on_wordpress' },
  ],
  needsRuntime: ['forms'],
  offers: [
    { capability: 'forms', provider: 'studio_managed', supported: true, chosen: true },
    { capability: 'forms', provider: 'keep_wordpress', supported: true },
    { capability: 'comments', provider: 'studio_managed', supported: true },
    { capability: 'comments', provider: 'keep_wordpress', supported: true, chosen: true },
    { capability: 'search', provider: 'keep_wordpress', supported: true },
    { capability: 'search', provider: 'adapter', supported: true },
  ],
  chosenOffers: [
    { capability: 'forms', provider: 'studio_managed' },
    { capability: 'comments', provider: 'keep_wordpress' },
  ],
  notes: ['content store: .contentrain', 'form model: contact'],
  issues: [{ code: 'runtime_unbound', capabilities: ['forms'] }, { code: 'preview_url_missing' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('MigrationHandoffCard', () => {
  it('labels capabilities: the chosen offer alone, an unchosen capability with its open options; no preview-URL issue, no notes, locale names', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => (url.endsWith('/migration')
      ? { present: true, syncedAt: null, summary, commentsImported: 0, claimExport: null }
      : { present: false })))
    const wrapper = await mountSuspended(MigrationHandoffCard, { props: { workspaceId: 'w', projectId: 'p' } })
    await flushPromises()
    const text = wrapper.text()

    expect(wrapper.findAll('[data-testid=migration-offers] li').map(li => li.text())).toEqual(['Forms: Studio runs it', 'Comments: Stays on WordPress', 'Search: Stays on WordPress / An outside service (not chosen yet)'])
    expect(text).not.toContain('studio_managed')
    expect(text).not.toContain('keep_wordpress')
    expect(text).toContain('Not connected yet — the generated site is not pointed at this project: Forms')
    expect(text).not.toContain('preview URL')
    expect(text).not.toContain('content store')
    expect(text).toContain('Turkish (TR), English')
  })
})
