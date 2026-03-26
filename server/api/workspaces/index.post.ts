export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const body = await readBody<{
    name: string
    slug: string
  }>(event)

  if (!body.name || !body.slug)
    throw createError({ statusCode: 400, message: errorMessage('validation.name_slug_required') })

  const client = useSupabaseUserClient(session.accessToken)

  // Workspace count limit — check user's current plan (from primary workspace)
  const existingWorkspaces = await listUserWorkspaces(client)
  if (existingWorkspaces.length > 0) {
    const primaryWs = existingWorkspaces[0] as { plan?: string }
    const plan = getWorkspacePlan(primaryWs)
    const limit = getPlanLimit(plan, 'workspace.count')
    if (existingWorkspaces.length >= limit)
      throw createError({ statusCode: 403, message: errorMessage('workspace.limit_reached', { limit }) })
  }

  const { data, error } = await client
    .from('workspaces')
    .insert({
      name: body.name,
      slug: slugify(body.slug),
      type: 'secondary',
      owner_id: session.user.id,
    })
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  // Owner is auto-added as workspace member via DB trigger
  return data
})
