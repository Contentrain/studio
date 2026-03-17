export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const projectId = getRouterParam(event, 'id')

  if (!projectId)
    throw createError({ statusCode: 400, message: 'Project ID is required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('projects')
    .select(`
      *,
      project_members(
        id, role, user_id, specific_models, allowed_models, invited_email, accepted_at
      )
    `)
    .eq('id', projectId)
    .single()

  if (error)
    throw createError({ statusCode: error.code === 'PGRST116' ? 404 : 500, message: error.message })

  return data
})
