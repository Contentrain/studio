/**
 * Save content for a model.
 * Uses Content Engine: validate → serialize → branch → commit → diff.
 *
 * Body: { locale, data, entryId? }
 * - Collection: data = { entryId: { fields } } or full object-map
 * - Singleton: data = { field: value }
 * - Dictionary: data = { key: value }
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const body = await readBody<{
    locale?: string
    data: Record<string, unknown>
  }>(event)

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: errorMessage('validation.model_id_required') })

  if (!body.data)
    throw createError({ statusCode: 400, message: errorMessage('validation.data_required') })

  // Permission check: editor+ can write content
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('save_content'))
    throw createError({ statusCode: 403, message: errorMessage('content.write_forbidden') })

  // Model restriction check
  if (permissions.specificModels && !permissions.allowedModels.includes(modelId))
    throw createError({ statusCode: 403, message: errorMessage('content.model_no_access', { model: modelId }) })

  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)

  const engine = createContentEngine({ git, contentRoot, projectId })
  const result = await engine.saveContent(modelId, body.locale ?? 'en', body.data, session.user.email ?? '')

  if (!result.validation.valid) {
    return result
  }

  // Workflow-aware auto-merge (same logic as chat handler)
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const configWorkflow = brain.config?.workflow ?? 'auto-merge'
  const workflow = hasFeature(plan, 'workflow.review') ? configWorkflow : 'auto-merge'
  const shouldMerge = workflow === 'auto-merge'
    || permissions.workspaceRole === 'owner'
    || permissions.workspaceRole === 'admin'

  let merged = false
  let pullRequestUrl: string | null = null
  if (shouldMerge && result.branch) {
    const mergeResult = await engine.mergeBranch(result.branch)
    merged = mergeResult.merged
    pullRequestUrl = mergeResult.pullRequestUrl
    invalidateBrainCache(projectId)
  }

  // Track media usage (non-blocking, non-fatal)
  try {
    const mediaProvider = useMediaProvider()
    if (mediaProvider) {
      const locale = body.locale ?? 'en'
      // Scan saved data for media paths and track usage
      for (const [entryId, entry] of Object.entries(body.data)) {
        if (typeof entry !== 'object' || !entry) continue
        for (const [fieldId, value] of Object.entries(entry as Record<string, unknown>)) {
          if (typeof value === 'string' && value.startsWith('media/')) {
            // Find asset by path
            const { assets } = await mediaProvider.listAssets(projectId, { search: value.split('/').pop(), limit: 1 })
            if (assets.length > 0) {
              await db.trackMediaUsage({
                asset_id: assets[0]!.id,
                project_id: projectId,
                model_id: modelId,
                entry_id: entryId,
                field_id: fieldId,
                locale,
              })
            }
          }
        }
      }
    }
  }
  catch {
    // Usage tracking failure is non-fatal
  }

  // Emit webhook event (fire-and-forget)
  emitWebhookEvent(projectId, workspaceId, 'content.saved', {
    models: [modelId],
    locale: body.locale ?? 'en',
    source: 'api',
    merged,
  }).catch(() => {})

  return { ...result, merged, workflow, pullRequestUrl }
})
