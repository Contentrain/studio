export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const data = await useDatabaseProvider().getWorkspaceDetailForUser(
    session.accessToken,
    session.user.id,
    workspaceId,
  )

  if (!data)
    throw createError({ statusCode: 404, message: errorMessage('workspace.not_found') })

  return data
})
