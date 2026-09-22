import type { ComputedRef, Ref } from 'vue'
import { computed, nextTick, ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModelContent } from '../../../app/composables/useModelContent'

interface BrainQueryResult {
  data: unknown
  kind: string
  meta: Record<string, unknown> | null
}

interface BrainStub {
  queryContent: (modelId: string, locale: string) => Promise<BrainQueryResult>
  invalidate: (projectId: string) => Promise<void> | void
  syncing: Ref<boolean>
  ready: Ref<boolean>
  config: Ref<unknown>
  models: Ref<unknown[]>
  vocabulary: Ref<Record<string, Record<string, string>> | null>
  contentContext: Ref<Record<string, unknown> | null>
  contentSummary: Ref<Record<string, unknown>>
  hasContentrain: ComputedRef<boolean>
  projectStats: ComputedRef<unknown>
  syncError: Ref<string | null>
  initBrain: (projectId: string) => void
  destroyBrain: () => void
  sync: (workspaceId: string, projectId: string) => Promise<void> | void
  searchContent: (...args: unknown[]) => unknown
  treeSha: Ref<string | null>
}

const nuxtState = vi.hoisted(() => ({
  brain: null as BrainStub | null,
}))

mockNuxtImport('useContentBrain', () => () => nuxtState.brain)

describe('useModelContent', () => {
  beforeEach(() => {
    useState('model-content').value = null
    useState('model-content-kind').value = 'collection'
    useState('model-content-meta').value = null
    useState('model-content-loading').value = false
    useState('model-content-request').value = null
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrates content from brain queries', async () => {
    const queryContent = vi.fn().mockResolvedValue({
      data: { entry: { title: 'Cached' } },
      kind: 'collection',
      meta: { entry: { status: 'published' } },
    })
    nuxtState.brain = {
      queryContent,
      invalidate: vi.fn(),
      syncing: ref(false),
      ready: ref(true),
      config: ref(null),
      models: ref([]),
      vocabulary: ref(null),
      contentContext: ref(null),
      contentSummary: ref({}),
      hasContentrain: computed(() => false),
      projectStats: computed(() => null),
      syncError: ref<string | null>(null),
      initBrain: vi.fn(),
      destroyBrain: vi.fn(),
      sync: vi.fn(),
      searchContent: vi.fn(),
      treeSha: ref(null),
    }

    const store = useModelContent()
    await store.fetchContent('workspace-1', 'project-1', 'faq', 'en')

    expect(queryContent).toHaveBeenCalledWith('faq', 'en')
    expect(store.content.value).toEqual({ entry: { title: 'Cached' } })
    expect(store.meta.value).toEqual({ entry: { status: 'published' } })
    expect(store.kind.value).toBe('collection')
    expect(store.loading.value).toBe(false)
  })

  it('clears content when brain queries fail', async () => {
    nuxtState.brain = {
      queryContent: vi.fn().mockRejectedValue(new Error('brain unavailable')),
      invalidate: vi.fn(),
      syncing: ref(false),
      ready: ref(false),
      config: ref(null),
      models: ref([]),
      vocabulary: ref(null),
      contentContext: ref(null),
      contentSummary: ref({}),
      hasContentrain: computed(() => false),
      projectStats: computed(() => null),
      syncError: ref<string | null>(null),
      initBrain: vi.fn(),
      destroyBrain: vi.fn(),
      sync: vi.fn(),
      searchContent: vi.fn(),
      treeSha: ref(null),
    }

    const store = useModelContent()
    await store.fetchContent('workspace-1', 'project-1', 'faq', 'en')

    expect(store.content.value).toBeNull()
    expect(store.loading.value).toBe(false)
  })

  it('invalidates project content through the brain adapter', async () => {
    const invalidate = vi.fn().mockResolvedValue(undefined)
    nuxtState.brain = {
      queryContent: vi.fn().mockResolvedValue({
        data: { entry: { title: 'Remote' } },
        kind: 'collection',
        meta: null,
      }),
      invalidate,
      syncing: ref(false),
      ready: ref(true),
      config: ref(null),
      models: ref([]),
      vocabulary: ref(null),
      contentContext: ref(null),
      contentSummary: ref({}),
      hasContentrain: computed(() => false),
      projectStats: computed(() => null),
      syncError: ref<string | null>(null),
      initBrain: vi.fn(),
      destroyBrain: vi.fn(),
      sync: vi.fn(),
      searchContent: vi.fn(),
      treeSha: ref(null),
    }

    const store = useModelContent()
    await store.fetchContent('workspace-1', 'project-1', 'faq', 'en')
    expect(store.content.value).toEqual({ entry: { title: 'Remote' } })

    await store.invalidateProjectContent('project-1')

    expect(invalidate).toHaveBeenCalledWith('project-1')
    expect(store.content.value).toBeNull()
  })

  function brainQuerying(queryContent: BrainStub['queryContent']): BrainStub {
    return {
      queryContent,
      invalidate: vi.fn(),
      syncing: ref(true),
      ready: ref(true),
      config: ref(null),
      models: ref([]),
      vocabulary: ref(null),
      contentContext: ref(null),
      contentSummary: ref({}),
      hasContentrain: computed(() => true),
      projectStats: computed(() => null),
      syncError: ref<string | null>(null),
      initBrain: vi.fn(),
      destroyBrain: vi.fn(),
      sync: vi.fn(),
      searchContent: vi.fn(),
      treeSha: ref<string | null>('cached-tree'),
    }
  }

  it('keeps the newest answer when an older read arrives after it', async () => {
    // A model opened from the cache during the sync is read out of IndexedDB;
    // the read made once the sync answered comes from memory, and first.
    let answerCachedRead: (result: BrainQueryResult) => void = () => {}
    const queryContent = vi.fn()
      .mockImplementationOnce(() => new Promise<BrainQueryResult>((resolve) => {
        answerCachedRead = resolve
      }))
      .mockResolvedValueOnce({ data: { entry: { title: 'Fresh' } }, kind: 'collection', meta: null })
    nuxtState.brain = brainQuerying(queryContent)

    const store = useModelContent()
    const cachedRead = store.fetchContent('workspace-1', 'project-1', 'faq', 'en')
    await store.fetchContent('workspace-1', 'project-1', 'faq', 'en')
    expect(store.loading.value).toBe(false)

    answerCachedRead({ data: { entry: { title: 'Stale' } }, kind: 'collection', meta: null })
    await cachedRead

    expect(store.content.value).toEqual({ entry: { title: 'Fresh' } })
  })

  it('reads the open model again when the sync brings another tree', async () => {
    const queryContent = vi.fn()
      .mockResolvedValueOnce({ data: { entry: { title: 'Stale' } }, kind: 'collection', meta: null })
      .mockResolvedValueOnce({ data: { entry: { title: 'Fresh' } }, kind: 'collection', meta: null })
    const brain = brainQuerying(queryContent)
    nuxtState.brain = brain

    const store = useModelContent()
    store.followTreeChanges()
    await store.fetchContent('workspace-1', 'project-1', 'faq', 'tr')
    expect(store.content.value).toEqual({ entry: { title: 'Stale' } })

    brain.treeSha.value = 'new-tree'
    await nextTick()
    await vi.waitFor(() => expect(store.content.value).toEqual({ entry: { title: 'Fresh' } }))
    expect(queryContent).toHaveBeenLastCalledWith('faq', 'tr')
  })

  it('reads nothing on a tree change when no model is open', async () => {
    const queryContent = vi.fn()
    const brain = brainQuerying(queryContent)
    nuxtState.brain = brain

    const store = useModelContent()
    store.followTreeChanges()
    await store.fetchContent('workspace-1', 'project-1', 'faq', 'en')
    store.clearContent()
    queryContent.mockClear()

    brain.treeSha.value = 'new-tree'
    await nextTick()

    expect(queryContent).not.toHaveBeenCalled()
  })
})
