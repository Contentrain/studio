/**
 * Project Health API — returns schema validation results from brain cache.
 *
 * Used by the project health dashboard and agent validate_schema tool.
 */
export default defineEventHandler(async (event) => {
  requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)

  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)

  return brain.schemaValidation ?? {
    valid: true,
    warnings: [],
    healthScore: 100,
    modelCount: brain.models.size,
    validModels: brain.models.size,
    timestamp: new Date().toISOString(),
  }
})
