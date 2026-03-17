export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const body = await readBody<{
    repoFullName: string
    defaultBranch?: string
    contentRoot?: string
    detectedStack?: string
    githubInstallationId?: number
  }>(event)

  if (!body.repoFullName)
    throw createError({ statusCode: 400, message: 'repoFullName is required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Create project
  const { data: project, error: projectError } = await client
    .from('projects')
    .insert({
      owner_id: session.user.id,
      repo_full_name: body.repoFullName,
      default_branch: body.defaultBranch || 'main',
      content_root: body.contentRoot || '/',
      detected_stack: body.detectedStack || null,
      github_installation_id: body.githubInstallationId || null,
    })
    .select()
    .single()

  if (projectError)
    throw createError({ statusCode: 500, message: projectError.message })

  // Add owner as project member
  const { error: memberError } = await client
    .from('project_members')
    .insert({
      project_id: project.id,
      user_id: session.user.id,
      role: 'owner',
      accepted_at: new Date().toISOString(),
    })

  if (memberError)
    throw createError({ statusCode: 500, message: memberError.message })

  return project
})
