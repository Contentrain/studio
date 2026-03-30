import type { ModelDefinition } from '@contentrain/types'

/**
 * Brain Sync API — unified content sync with delta detection.
 *
 * Replaces snapshot.get + content/[modelId].get with a single endpoint.
 * Returns all config, models, content, meta, vocabulary, context in one call.
 *
 * Delta detection: pass `?treeSha=<hash>` — if tree hasn't changed,
 * returns empty delta (0 additional Git calls after cache check).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const { git, contentRoot } = await resolveProjectContext(
    db.getUserClient(session.accessToken), workspaceId, projectId,
  )

  const query = getQuery(event) as { treeSha?: string }
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)

  // Delta check: if client's treeSha matches, nothing changed
  if (query.treeSha && query.treeSha === brain.treeSha) {
    return {
      treeSha: brain.treeSha,
      delta: true,
      config: null,
      models: null,
      content: null,
      vocabulary: null,
      contentContext: null,
      contentSummary: null,
    }
  }

  // Full sync: return everything
  // Convert Maps to plain objects for JSON serialization
  const models: Record<string, ModelDefinition> = {}
  for (const [id, def] of brain.models) {
    models[id] = def
  }

  const content: Record<string, { data: unknown, meta: Record<string, unknown> | null, kind: string }> = {}
  for (const [key, data] of brain.content) {
    const [modelId] = key.split(':')
    const modelDef = modelId ? brain.models.get(modelId) : null
    content[key] = {
      data,
      meta: brain.meta.get(key) ?? null,
      kind: modelDef?.kind ?? 'collection',
    }
  }

  return {
    treeSha: brain.treeSha,
    delta: false,
    config: brain.config,
    models,
    content,
    vocabulary: brain.vocabulary,
    contentContext: brain.contentContext,
    contentSummary: brain.contentSummary,
    schemaValidation: brain.schemaValidation,
  }
})
