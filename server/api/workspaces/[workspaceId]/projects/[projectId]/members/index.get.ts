/**
 * List project members with their profiles.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('project_members')
    .select(`
      id, role, specific_models, allowed_models, invited_email, invited_at, accepted_at,
      profiles:user_id(id, display_name, email, avatar_url)
    `)
    .eq('project_id', projectId)
    .order('invited_at', { ascending: true })

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
