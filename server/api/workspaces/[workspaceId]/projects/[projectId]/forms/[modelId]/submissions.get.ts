/**
 * List form submissions for a model.
 * Supports status filter, pagination, sorting.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  // Verify project belongs to workspace
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  // Workspace members need explicit project assignment
  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, session.user.id)
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'forms.enabled'))
    throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })

  const query = getQuery(event) as {
    page?: string
    limit?: string
    status?: string
    sort?: string
  }

  return db.listFormSubmissions(workspaceId, projectId, modelId, {
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Math.min(Number(query.limit), 100) : 50,
    status: query.status,
    sort: (query.sort as 'newest' | 'oldest') ?? 'newest',
  })
})
