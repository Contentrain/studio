/**
 * Get CDN settings for a project.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const client = useSupabaseUserClient(session.accessToken)

  const { data, error } = await client
    .from('projects')
    .select('cdn_enabled, cdn_branch')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (error || !data)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  return data
})
