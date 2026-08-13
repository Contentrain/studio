import { describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import ContentCollectionView from '../../../app/components/organisms/ContentCollectionView.vue'

const searchContent = vi.hoisted(() => vi.fn())
const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }))
const searchReady = vi.hoisted(() => ({ value: true }))

mockNuxtImport('useContentBrain', () => () => ({
  searchContent,
  searchReady: computed(() => searchReady.value),
  models: computed(() => []),
  queryContent: vi.fn(),
}))

mockNuxtImport('useRoute', () => () => ({ query: routeQuery.value, params: {} }))

function makeContent(count: number) {
  const out: Record<string, Record<string, unknown>> = {}
  for (let i = 0; i < count; i++) out[`entry-${i}`] = { title: `Entry ${i}` }
  return out
}

async function mount(count: number) {
  return mountSuspended(ContentCollectionView, {
    props: { content: makeContent(count), modelId: 'articles', locale: 'en', editable: true },
  })
}

describe('ContentCollectionView progressive rendering', () => {
  it('renders one page instead of every entry', async () => {
    // Each row is a `<details>` plus a stateful Radix dropdown and three
    // buttons; at 1000 entries that is the whole cost of opening a model.
    const wrapper = await mount(1000)

    expect(wrapper.findAll('details')).toHaveLength(50)
  })

  it('reveals another page on demand, and says where you are', async () => {
    const wrapper = await mount(120)
    expect(wrapper.text()).toContain('Showing 50 of 120')

    await wrapper.findAll('button').find(b => b.text().includes('Show more'))!.trigger('click')

    expect(wrapper.findAll('details')).toHaveLength(100)
    expect(wrapper.text()).toContain('Showing 100 of 120')
  })

  it('drops the counter qualifier once everything is on screen', async () => {
    const wrapper = await mount(10)

    expect(wrapper.findAll('details')).toHaveLength(10)
    expect(wrapper.text()).toContain('10 entry(s)')
    expect(wrapper.findAll('button').find(b => b.text().includes('Show more'))).toBeUndefined()
  })
})

describe('ContentCollectionView search', () => {
  it('narrows to what the index returned, not to what was rendered', async () => {
    // The point of searching the index: a match on page twenty is found without
    // paging there.
    searchContent.mockResolvedValue([{ modelId: 'articles', entryId: 'entry-900', locale: 'en', score: 1 }])
    const wrapper = await mount(1000)

    await wrapper.find('input').setValue('needle')
    await new Promise(r => setTimeout(r, 250))
    await nextTick()

    // The title resolver is injected by ContentPanel; standalone the row falls
    // back to the entry id, which is enough to say WHICH row survived.
    expect(wrapper.findAll('details')).toHaveLength(1)
    expect(wrapper.text()).toContain('entry-900')
  })

  it('scopes the search to this model and locale', async () => {
    searchContent.mockResolvedValue([])
    const wrapper = await mount(10)

    await wrapper.find('input').setValue('needle')
    await new Promise(r => setTimeout(r, 250))

    expect(searchContent).toHaveBeenCalledWith('needle', expect.objectContaining({
      modelId: 'articles',
      locale: 'en',
    }))
  })

  it('ignores an index hit this locale no longer holds', async () => {
    // The index is rebuilt per sync, so it can briefly name a stale entry.
    searchContent.mockResolvedValue([
      { modelId: 'articles', entryId: 'entry-1', locale: 'en', score: 1 },
      { modelId: 'articles', entryId: 'deleted-one', locale: 'en', score: 1 },
    ])
    const wrapper = await mount(10)

    await wrapper.find('input').setValue('needle')
    await new Promise(r => setTimeout(r, 250))
    await nextTick()

    expect(wrapper.findAll('details')).toHaveLength(1)
  })

  it('says the index is not ready rather than claiming no matches', async () => {
    // `searchContent` resolves to `[]` when the worker is absent, which is
    // indistinguishable from "nothing matched" unless it is asked.
    searchReady.value = false
    searchContent.mockResolvedValue([])
    const wrapper = await mount(10)

    await wrapper.find('input').setValue('needle')
    await new Promise(r => setTimeout(r, 250))
    await nextTick()

    expect(wrapper.text()).toContain('Search is not ready yet')
    expect(wrapper.text()).not.toContain('No matches')
    searchReady.value = true
  })
})

describe('ContentCollectionView deep link', () => {
  it('pulls the entry named by ?entry= to the front and opens it', async () => {
    // Otherwise "go to this entry" drops you at the top of a thousand rows to
    // find it yourself — which is what the search was for.
    routeQuery.value = { entry: 'entry-800' }
    const wrapper = await mount(1000)

    const first = wrapper.findAll('details')[0]!
    expect(first.text()).toContain('entry-800')
    expect(first.attributes('open')).toBeDefined()

    routeQuery.value = {}
  })
})
