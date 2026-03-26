export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    name?: string
    slug?: string
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const client = useSupabaseUserClient(session.accessToken)

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

  const { data, error } = await client
    .from('workspaces')
    .update(updates)
    .eq('id', workspaceId)
    .select()
    .single()

  if (error) {
    if (error.code === '23505')
      throw createError({ statusCode: 409, message: errorMessage('workspace.slug_taken') })
    throw createError({ statusCode: 500, message: error.message })
  }

  return data
})
