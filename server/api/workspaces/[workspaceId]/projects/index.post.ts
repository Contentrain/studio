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

  // Free plan cannot create projects — requires paid subscription
  const billingPlan = event.context.billing?.effectivePlan
  if (billingPlan === 'free') {
    throw createError({
      statusCode: 402,
      message: 'A paid plan is required to connect repositories.',
      data: { requiresCheckout: true, workspaceId },
    })
  }

  const db = useDatabaseProvider()

  // Prevent duplicate — same repo in same workspace
  const isDuplicate = await db.checkDuplicateProject(workspaceId, body.repoFullName)

  if (isDuplicate)
    throw createError({ statusCode: 409, message: errorMessage('project.already_connected') })

  return db.createProject(session.accessToken, {
    workspace_id: workspaceId,
    repo_full_name: body.repoFullName,
    default_branch: body.defaultBranch || 'main',
    content_root: body.contentRoot || '/',
    detected_stack: body.detectedStack || null,
    status: body.hasContentrain === false ? 'setup' : 'active',
  })
})
