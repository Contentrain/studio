import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { del, get, set } from 'idb-keyval'
import { useModelContent } from '../../../app/composables/useModelContent'

const cacheKey = 'cr-content-project-1:faq:en'

describe('useModelContent', () => {
  beforeEach(async () => {
    await del(cacheKey)
    useState('model-content').value = null
    useState('model-content-kind').value = 'collection'
    useState('model-content-meta').value = null
    useState('model-content-loading').value = false
    const store = useModelContent()
    await store.invalidateProjectContent('project-1')
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await del(cacheKey)
  })

  it('serves fresh indexeddb content without calling the API', async () => {
    await set(cacheKey, {
      data: { entry: { title: 'Cached' } },
      kind: 'collection',
      meta: { entry: { status: 'published' } },
      timestamp: Date.now(),
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)

    const store = useModelContent()
    await store.fetchContent('workspace-1', 'project-1', 'faq', 'en')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.content.value).toEqual({ entry: { title: 'Cached' } })
    expect(store.meta.value).toEqual({ entry: { status: 'published' } })
  })

  it('fetches remote content and caches it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      data: { entry: { title: 'Remote' } },
      kind: 'collection',
      meta: { entry: { status: 'draft' } },
    })
    vi.stubGlobal('$fetch', fetchMock)

    const store = useModelContent()
    await store.fetchContent('workspace-1', 'project-1', 'faq', 'en')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace-1/projects/project-1/content/faq',
      { params: { locale: 'en' } },
    )
    expect(store.content.value).toEqual({ entry: { title: 'Remote' } })

    const cached = await get(cacheKey)
    expect(cached).toBeTruthy()
  })

  it('invalidates cached project content across memory and indexeddb', async () => {
    const store = useModelContent()
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      data: { entry: { title: 'Remote' } },
      kind: 'collection',
      meta: null,
    }))

    await store.fetchContent('workspace-1', 'project-1', 'faq', 'en')
    expect(store.content.value).toEqual({ entry: { title: 'Remote' } })

    await store.invalidateProjectContent('project-1')

    expect(store.content.value).toBeNull()
    expect(await get(cacheKey)).toBeUndefined()
  })
})
