export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'Workspace ID and Project ID are required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('projects')
    .select(`
      *,
      project_members(
        id, role, user_id, specific_models, allowed_models, invited_email, accepted_at,
        profiles:user_id(id, display_name, email, avatar_url)
      )
    `)
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (error)
    throw createError({ statusCode: error.code === 'PGRST116' ? 404 : 500, message: error.message })

  return data
})
