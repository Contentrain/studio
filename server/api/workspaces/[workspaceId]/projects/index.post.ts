export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    repoFullName: string
    defaultBranch?: string
    contentRoot?: string
    detectedStack?: string
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: 'Workspace ID is required' })

  if (!body.repoFullName)
    throw createError({ statusCode: 400, message: 'repoFullName is required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data: project, error } = await client
    .from('projects')
    .insert({
      workspace_id: workspaceId,
      repo_full_name: body.repoFullName,
      default_branch: body.defaultBranch || 'main',
      content_root: body.contentRoot || '/',
      detected_stack: body.detectedStack || null,
    })
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return project
})
