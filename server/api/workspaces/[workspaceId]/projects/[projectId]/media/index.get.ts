/**
 * List media assets for a project.
 * Supports search, tag filter, content type filter, pagination, sorting.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const plan = getWorkspacePlan(await getWorkspace(client, workspaceId))
  if (!hasFeature(plan, 'media.library'))
    throw createError({ statusCode: 403, message: 'Media library requires Pro plan or higher' })

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
    throw createError({ statusCode: 503, message: 'Media storage not configured' })

  return media.listAssets(projectId, {
    search: query.search,
    tags: query.tags ? query.tags.split(',') : undefined,
    contentType: query.type,
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Math.min(Number(query.limit), 100) : 50,
    sort: (query.sort as 'newest' | 'oldest' | 'name' | 'size') ?? 'newest',
  })
})
