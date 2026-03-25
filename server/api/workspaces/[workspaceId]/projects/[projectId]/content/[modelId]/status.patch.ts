/**
 * Update entry status (publish/unpublish/archive).
 * Only modifies meta, not content data.
 * Owner/Admin can publish, Editor can only draft.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const body = await readBody<{
    entryIds: string[]
    status: 'draft' | 'published' | 'archived'
    locale?: string
  }>(event)

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and modelId are required' })

  if (!body.entryIds?.length || !body.status)
    throw createError({ statusCode: 400, message: 'entryIds and status are required' })

  if (!['draft', 'published', 'archived'].includes(body.status))
    throw createError({ statusCode: 400, message: 'status must be draft, published, or archived' })

  // Permission check: publish requires owner/admin, draft/archive requires editor+
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)

  if (body.status === 'published') {
    if (permissions.workspaceRole !== 'owner' && permissions.workspaceRole !== 'admin')
      throw createError({ statusCode: 403, message: 'Only workspace owner/admin can publish content' })
  }
  else if (!permissions.availableTools.includes('save_content')) {
    throw createError({ statusCode: 403, message: 'Insufficient permissions' })
  }

  // Model restriction
  if (permissions.specificModels && !permissions.allowedModels.includes(modelId))
    throw createError({ statusCode: 403, message: `No access to model: ${modelId}` })

  const { git, contentRoot } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  const engine = createContentEngine({ git, contentRoot })
  const writeResult = await engine.updateEntryStatus(
    modelId, body.locale ?? 'en', body.entryIds, body.status, session.user.email ?? '',
  )

  // Auto-merge status changes (no review needed for publish/unpublish)
  const mergeResult = await engine.mergeBranch(writeResult.branch)
  return { merged: mergeResult.merged, status: body.status, entryIds: body.entryIds }
})
