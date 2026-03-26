import type { ModelKind } from '@contentrain/types'

/**
 * Snapshot composable — thin adapter over Content Brain.
 *
 * Preserves the exact same return shape as the original useSnapshot()
 * so all consuming components (AppSidebar, ContentPanel, project page)
 * continue working without changes.
 *
 * Data source: useContentBrain() → Worker IndexedDB + /api/brain/sync
 */

interface ModelSummary {
  id: string
  name: string
  kind: ModelKind
  type: ModelKind
  fields: Record<string, unknown>
  domain: string
  i18n: boolean
}

interface ContentSummary {
  count: number
  locales: string[]
}

interface ContentContext {
  lastOperation?: { tool?: string, model?: string, locale?: string, timestamp?: string }
  stats?: { models?: number, entries?: number, locales?: string[] }
}

interface Snapshot {
  exists: boolean
  config: unknown
  models: ModelSummary[]
  content: Record<string, ContentSummary>
  vocabulary?: Record<string, Record<string, string>> | null
  contentContext?: ContentContext | null
}

export function useSnapshot() {
  const brain = useContentBrain()

  const snapshot = computed<Snapshot | null>(() => {
    if (!brain.ready.value && !brain.config.value) return null

    return {
      exists: brain.hasContentrain.value,
      config: brain.config.value,
      models: brain.models.value.map(m => ({
        id: m.id ?? '',
        name: m.name ?? '',
        kind: (m.kind ?? 'collection') as ModelKind,
        type: (m.kind ?? 'collection') as ModelKind,
        fields: (m.fields ?? {}) as Record<string, unknown>,
        domain: m.domain ?? '',
        i18n: m.i18n ?? false,
      })),
      content: brain.contentSummary.value,
      vocabulary: brain.vocabulary.value,
      contentContext: brain.contentContext.value as ContentContext | null,
    }
  })

  async function fetchSnapshot(workspaceId: string, projectId: string) {
    brain.initBrain(projectId)
    await brain.sync(workspaceId, projectId)
  }

  function clearSnapshot() {
    brain.destroyBrain()
  }

  async function invalidateCache(projectId: string) {
    await brain.invalidate(projectId)
  }

  const models = computed(() => snapshot.value?.models ?? [])
  const hasContentrain = brain.hasContentrain
  const vocabulary = computed(() => snapshot.value?.vocabulary ?? null)
  const contentContext = computed(() => snapshot.value?.contentContext ?? null)
  const projectStats = brain.projectStats

  return {
    snapshot: readonly(snapshot),
    models,
    hasContentrain,
    vocabulary,
    contentContext,
    projectStats,
    loading: brain.syncing,
    refreshing: computed(() => false),
    error: brain.syncError,
    fetchSnapshot,
    clearSnapshot,
    invalidateCache,
  }
}
