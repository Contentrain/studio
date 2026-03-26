import type { ComputedRef, Ref } from 'vue'
import { computed, ref } from 'vue'
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
})
