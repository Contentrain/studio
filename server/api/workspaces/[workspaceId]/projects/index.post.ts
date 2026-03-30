export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    repoFullName: string
    defaultBranch?: string
    contentRoot?: string
    detectedStack?: string
    hasContentrain?: boolean
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  if (!body.repoFullName)
    throw createError({ statusCode: 400, message: errorMessage('validation.repo_required') })

  const db = useDatabaseProvider()
  const client = db.getUserClient(session.accessToken)

  // Prevent duplicate — same repo in same workspace
  const { data: existing } = await db.getAdminClient()
    .from('projects')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('repo_full_name', body.repoFullName)
    .single()

  if (existing)
    throw createError({ statusCode: 409, message: errorMessage('project.already_connected') })

  const { data: project, error } = await client
    .from('projects')
    .insert({
      workspace_id: workspaceId,
      repo_full_name: body.repoFullName,
      default_branch: body.defaultBranch || 'main',
      content_root: body.contentRoot || '/',
      detected_stack: body.detectedStack || null,
      status: body.hasContentrain === false ? 'setup' : 'active',
    })
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return project
})
