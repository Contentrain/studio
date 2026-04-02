/**
 * Project Health API — returns schema validation results from brain cache.
 *
 * Used by the project health dashboard and agent validate_schema tool.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  await requireProjectAccess(session.user.id, workspaceId, projectId, session.accessToken)
  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)

  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)

  if (!brain.schemaValidation) {
    return {
      valid: null,
      warnings: [],
      healthScore: null,
      modelCount: brain.models.size,
      validModels: 0,
      timestamp: new Date().toISOString(),
      unavailable: true,
    }
  }

  return brain.schemaValidation
})
