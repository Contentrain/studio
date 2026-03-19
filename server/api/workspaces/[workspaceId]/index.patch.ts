export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    name?: string
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: 'Workspace ID is required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Build update payload (only include provided fields)
  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name

  if (Object.keys(updates).length === 0)
    throw createError({ statusCode: 400, message: 'No fields to update' })

  const { data, error } = await client
    .from('workspaces')
    .update(updates)
    .eq('id', workspaceId)
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
