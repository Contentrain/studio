export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    name?: string
    slug?: string
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name.trim()
  if (body.slug !== undefined) {
    const slug = slugify(body.slug)

    if (slug.length < 2)
      throw createError({ statusCode: 400, message: errorMessage('workspace.slug_too_short') })

    updates.slug = slug
  }

  if (Object.keys(updates).length === 0)
    throw createError({ statusCode: 400, message: errorMessage('validation.no_fields_to_update') })

  return db.updateWorkspaceForUser(
    session.accessToken,
    session.user.id,
    workspaceId,
    updates,
  )
})
