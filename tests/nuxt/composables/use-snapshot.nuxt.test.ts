import type { ComputedRef, Ref } from 'vue'
import { computed, ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSnapshot } from '../../../app/composables/useSnapshot'

interface ModelStub {
  id: string
  name: string
  kind: string
  fields: Record<string, unknown>
  domain: string
  i18n: boolean
}

interface BrainStub {
  ready: Ref<boolean>
  hasContentrain: ComputedRef<boolean>
  config: Ref<{ locales: { default: string } } | null>
  models: Ref<ModelStub[]>
  vocabulary: Ref<Record<string, Record<string, string>> | null>
  contentContext: Ref<Record<string, unknown> | null>
  contentSummary: Ref<Record<string, { count: number, locales: string[] }>>
  projectStats: ComputedRef<unknown>
  syncing: Ref<boolean>
  syncError: Ref<string | null>
  initBrain: (projectId: string) => void
  sync: (workspaceId: string, projectId: string) => Promise<void>
  destroyBrain: () => void
  invalidate: (projectId: string) => Promise<void> | void
}

const nuxtState = vi.hoisted(() => ({
  brain: null as BrainStub | null,
}))

mockNuxtImport('useContentBrain', () => () => nuxtState.brain)

describe('useSnapshot', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps current brain state into the legacy snapshot shape', () => {
    const brain = {
      ready: ref(true),
      hasContentrain: computed(() => true),
      config: ref({ locales: { default: 'en' } }),
      models: ref([{ id: 'faq', name: 'FAQ', kind: 'collection', fields: {}, domain: 'marketing', i18n: true }]),
      vocabulary: ref({ headline: { en: 'Headline' } }),
      contentContext: ref({ stats: { entries: 1 } }),
      contentSummary: ref({ faq: { count: 1, locales: ['en'] } }),
      projectStats: computed(() => ({ modelCount: 1, entryCount: 1, localeCount: 1, locales: ['en'] })),
      syncing: ref(false),
      syncError: ref<string | null>(null),
      initBrain: vi.fn(),
      sync: vi.fn(),
      destroyBrain: vi.fn(),
      invalidate: vi.fn(),
    }
    nuxtState.brain = brain

    const snapshotStore = useSnapshot()

    expect(snapshotStore.snapshot.value).toEqual({
      exists: true,
      config: { locales: { default: 'en' } },
      models: [{ id: 'faq', name: 'FAQ', kind: 'collection', type: 'collection', fields: {}, domain: 'marketing', i18n: true }],
      content: { faq: { count: 1, locales: ['en'] } },
      vocabulary: { headline: { en: 'Headline' } },
      contentContext: { stats: { entries: 1 } },
    })
    expect(snapshotStore.loading.value).toBe(false)
  })

  it('initializes and syncs the brain for the requested project', async () => {
    const config = ref(null)
    const models = ref<ModelStub[]>([])
    const contentSummary = ref<Record<string, { count: number, locales: string[] }>>({})
    const vocabulary = ref<Record<string, Record<string, string>> | null>(null)
    const contentContext = ref<Record<string, unknown> | null>(null)
    const initBrain = vi.fn()
    const sync = vi.fn().mockImplementation(async () => {
      config.value = { locales: { default: 'en' } }
      models.value = [{ id: 'docs', name: 'Docs', kind: 'document', fields: {}, domain: 'marketing', i18n: true }]
      contentSummary.value = { docs: { count: 2, locales: ['en'] } }
      vocabulary.value = { cta: { en: 'Start' } }
      contentContext.value = { stats: { entries: 2 } }
    })
    const brain = {
      ready: ref(false),
      hasContentrain: computed(() => config.value !== null),
      config,
      models,
      vocabulary,
      contentContext,
      contentSummary,
      projectStats: computed(() => null),
      syncing: ref(false),
      syncError: ref<string | null>(null),
      initBrain,
      sync,
      destroyBrain: vi.fn(),
      invalidate: vi.fn(),
    }
    nuxtState.brain = brain

    const snapshotStore = useSnapshot()
    await snapshotStore.fetchSnapshot('workspace-1', 'project-1')

    expect(initBrain).toHaveBeenCalledWith('project-1')
    expect(sync).toHaveBeenCalledWith('workspace-1', 'project-1')
    expect(snapshotStore.snapshot.value?.models[0]?.id).toBe('docs')
    expect(snapshotStore.snapshot.value?.content.docs).toEqual({ count: 2, locales: ['en'] })
  })
})
