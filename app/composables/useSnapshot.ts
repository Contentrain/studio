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
  fields: Record<string, unknown> | Readonly<Record<string, unknown>>
  domain: string
  i18n: boolean
  /**
   * Which field titles an entry. Carried all the way from the repo through the
   * brain — and then dropped here, because this summary is built field by field
   * and a new part of the contract does not add itself.
   */
  title_field?: string
}

interface ContentSummary {
  count: number
  locales: string[] | readonly string[]
}

interface ContentContext {
  lastOperation?: { tool?: string, model?: string, locale?: string, timestamp?: string }
  stats?: { models?: number, entries?: number, locales?: string[] }
}

interface Snapshot {
  exists: boolean
  config: unknown
  models: ModelSummary[]
  content: Record<string, ContentSummary> | Readonly<Record<string, ContentSummary>>
  vocabulary?: Record<string, Record<string, string>> | Readonly<Record<string, Readonly<Record<string, string>>>> | null
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
        title_field: m.title_field,
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

  /**
   * Start reading this project's cache now. The worker needs only the project
   * id, so a page can boot it before the workspace round trips that the sync
   * itself has to wait for — and show the cache in the meantime.
   */
  function primeSnapshot(projectId: string) {
    void brain.initBrain(projectId)
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
    // Only a project with nothing to show waits on the network. One with a
    // cache (or an earlier answer) stays on screen while the sync runs.
    loading: computed(() => brain.syncing.value && snapshot.value === null),
    refreshing: computed(() => brain.syncing.value && snapshot.value !== null),
    error: brain.syncError,
    fetchSnapshot,
    primeSnapshot,
    clearSnapshot,
    invalidateCache,
  }
}
