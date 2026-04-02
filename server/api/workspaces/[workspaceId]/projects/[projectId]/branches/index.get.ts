/**
 * List cr/* branches (pending content changes).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  await requireProjectAccess(session.user.id, workspaceId, projectId, session.accessToken)
  const { git } = await resolveProjectContext(workspaceId, projectId)

  const branches = await git.listBranches('cr/')
  return { branches }
})
