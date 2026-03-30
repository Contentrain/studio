export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const body = await readBody<{
    name: string
    slug: string
  }>(event)

  if (!body.name || !body.slug)
    throw createError({ statusCode: 400, message: errorMessage('validation.name_slug_required') })

  // Workspace count limit — check user's current plan (from primary workspace)
  const existingWorkspaces = await db.listUserWorkspaces(session.accessToken, session.user.id)
  if (existingWorkspaces.length > 0) {
    const primaryWs = existingWorkspaces[0] as { plan?: string }
    const plan = getWorkspacePlan(primaryWs)
    const limit = getPlanLimit(plan, 'workspace.count')
    if (existingWorkspaces.length >= limit)
      throw createError({ statusCode: 403, message: errorMessage('workspace.limit_reached', { limit }) })
  }

  // Owner is auto-added as workspace member via DB trigger
  return db.createWorkspace(session.accessToken, {
    ownerId: session.user.id,
    name: body.name,
    slug: slugify(body.slug),
    type: 'secondary',
  })
})
