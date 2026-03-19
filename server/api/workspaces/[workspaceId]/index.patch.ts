export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    name?: string
    slug?: string
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: 'Workspace ID is required' })

  const client = useSupabaseUserClient(session.accessToken)

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.slug !== undefined) {
    // Sanitize slug
    const slug = body.slug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')

    if (slug.length < 2)
      throw createError({ statusCode: 400, message: 'Slug must be at least 2 characters' })

    updates.slug = slug
  }

  if (Object.keys(updates).length === 0)
    throw createError({ statusCode: 400, message: 'No fields to update' })

  const { data, error } = await client
    .from('workspaces')
    .update(updates)
    .eq('id', workspaceId)
    .select()
    .single()

  if (error) {
    // Unique constraint violation on slug
    if (error.code === '23505')
      throw createError({ statusCode: 409, message: 'This slug is already taken' })
    throw createError({ statusCode: 500, message: error.message })
  }

  return data
})
