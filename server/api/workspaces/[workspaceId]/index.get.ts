export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: 'Workspace ID is required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('workspaces')
    .select(`
      *,
      workspace_members(
        id, role, user_id, invited_email, accepted_at,
        profiles:user_id(id, display_name, email, avatar_url)
      )
    `)
    .eq('id', workspaceId)
    .single()

  if (error)
    throw createError({ statusCode: error.code === 'PGRST116' ? 404 : 500, message: error.message })

  return data
})
