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
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const body = await readBody<{
    locale?: string
    data: Record<string, unknown>
  }>(event)

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and modelId are required' })

  if (!body.data)
    throw createError({ statusCode: 400, message: 'data is required' })

  // Permission check: editor+ can write content
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('save_content'))
    throw createError({ statusCode: 403, message: 'Insufficient permissions to write content' })

  // Model restriction check
  if (permissions.specificModels && !permissions.allowedModels.includes(modelId))
    throw createError({ statusCode: 403, message: `No access to model: ${modelId}` })

  const { git, contentRoot } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  const engine = createContentEngine({ git, contentRoot })
  const result = await engine.saveContent(modelId, body.locale ?? 'en', body.data, session.user.email ?? '')

  // Track media usage (non-blocking, non-fatal)
  try {
    const mediaProvider = useMediaProvider()
    if (mediaProvider) {
      const admin = useSupabaseAdmin()
      const locale = body.locale ?? 'en'
      // Scan saved data for media paths and track usage
      for (const [entryId, entry] of Object.entries(body.data)) {
        if (typeof entry !== 'object' || !entry) continue
        for (const [fieldId, value] of Object.entries(entry as Record<string, unknown>)) {
          if (typeof value === 'string' && value.startsWith('media/')) {
            // Find asset by path
            const { assets } = await mediaProvider.listAssets(projectId, { search: value.split('/').pop(), limit: 1 })
            if (assets.length > 0) {
              await trackMediaUsage(admin, {
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

  return result
})
