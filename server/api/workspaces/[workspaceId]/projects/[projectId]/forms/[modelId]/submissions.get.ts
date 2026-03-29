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

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const plan = getWorkspacePlan(await getWorkspace(client, workspaceId))
  if (!hasFeature(plan, 'forms.enabled'))
    throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })

  const query = getQuery(event) as {
    page?: string
    limit?: string
    status?: string
    sort?: string
  }

  const admin = useSupabaseAdmin()

  return listFormSubmissions(admin, workspaceId, projectId, modelId, {
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Math.min(Number(query.limit), 100) : 50,
    status: query.status,
    sort: (query.sort as 'newest' | 'oldest') ?? 'newest',
  })
})
