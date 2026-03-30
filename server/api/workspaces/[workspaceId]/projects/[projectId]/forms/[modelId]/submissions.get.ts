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
  const client = db.getUserClient(session.accessToken)
  const role = await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  // Verify project belongs to workspace (prevents cross-project access)
  const admin = db.getAdminClient()
  const { data: project } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  // Workspace members need explicit project assignment
  if (role === 'member') {
    const { data: pm } = await admin.from('project_members').select('id').eq('project_id', projectId).eq('user_id', session.user.id).single()
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  const plan = getWorkspacePlan(await getWorkspace(client, workspaceId))
  if (!hasFeature(plan, 'forms.enabled'))
    throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })

  const query = getQuery(event) as {
    page?: string
    limit?: string
    status?: string
    sort?: string
  }

  return listFormSubmissions(admin, workspaceId, projectId, modelId, {
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Math.min(Number(query.limit), 100) : 50,
    status: query.status,
    sort: (query.sort as 'newest' | 'oldest') ?? 'newest',
  })
})
