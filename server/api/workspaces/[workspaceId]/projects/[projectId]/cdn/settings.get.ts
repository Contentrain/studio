/**
 * Get CDN settings for a project.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('projects')
    .select('cdn_enabled, cdn_branch')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (error || !data)
    throw createError({ statusCode: 404, message: 'Project not found' })

  return data
})
