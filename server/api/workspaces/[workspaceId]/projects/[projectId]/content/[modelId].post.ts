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

  const { git, contentRoot } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  const engine = createContentEngine({ git, contentRoot })
  return engine.saveContent(modelId, body.locale ?? 'en', body.data, session.user.email ?? '')
})
