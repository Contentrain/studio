/**
 * List media assets for a project.
 * Supports search, tag filter, content type filter, pagination, sorting.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, session.user.id)
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'media.library'))
    throw createError({ statusCode: 403, message: errorMessage('media.library_upgrade') })

  const query = getQuery(event) as {
    search?: string
    tags?: string
    type?: string
    page?: string
    limit?: string
    sort?: string
  }

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  return media.listAssets(projectId, {
    search: query.search,
    tags: query.tags ? query.tags.split(',') : undefined,
    contentType: query.type,
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Math.min(Number(query.limit), 100) : 50,
    sort: (query.sort as 'newest' | 'oldest' | 'name' | 'size') ?? 'newest',
  })
})
