import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { del, get, set } from 'idb-keyval'
import { useSnapshot } from '../../../app/composables/useSnapshot'

const cacheKey = 'cr-snapshot-project-1'

describe('useSnapshot', () => {
  beforeEach(async () => {
    await del(cacheKey)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await del(cacheKey)
  })

  it('serves a fresh cached snapshot without hitting the API', async () => {
    await set(cacheKey, {
      projectId: 'project-1',
      timestamp: Date.now(),
      data: {
        exists: true,
        config: { locales: { default: 'en' } },
        models: [{ id: 'faq', name: 'FAQ', kind: 'collection', type: 'collection', fields: {}, domain: 'marketing', i18n: true }],
        content: { faq: { count: 1, locales: ['en'] } },
      },
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)

    const snapshotStore = useSnapshot()
    await snapshotStore.fetchSnapshot('workspace-1', 'project-1')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(snapshotStore.snapshot.value?.models[0]?.id).toBe('faq')
    expect(snapshotStore.loading.value).toBe(false)
  })

  it('fetches and caches a snapshot when no cache is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      exists: true,
      config: { locales: { default: 'en' } },
      models: [{ id: 'docs', name: 'Docs', kind: 'document', type: 'document', fields: {}, domain: 'marketing', i18n: true }],
      content: { docs: { count: 2, locales: ['en'] } },
    })
    vi.stubGlobal('$fetch', fetchMock)

    const snapshotStore = useSnapshot()
    await snapshotStore.fetchSnapshot('workspace-1', 'project-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/workspace-1/projects/project-1/snapshot')
    expect(snapshotStore.snapshot.value?.models[0]?.id).toBe('docs')

    const cached = await get(cacheKey)
    expect(cached).toBeTruthy()
  })
})
