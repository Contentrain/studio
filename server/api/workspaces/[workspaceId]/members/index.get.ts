export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: 'Workspace ID is required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('workspace_members')
    .select(`
      id, role, invited_email, invited_at, accepted_at,
      profiles:user_id(id, display_name, email, avatar_url)
    `)
    .eq('workspace_id', workspaceId)
    .order('invited_at', { ascending: true })

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
