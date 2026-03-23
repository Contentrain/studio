/**
 * Update CDN settings for a project (enable/disable, branch).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ cdn_enabled?: boolean, cdn_branch?: string | null }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Verify owner/admin
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Plan check if enabling
  if (body.cdn_enabled === true) {
    const { data: workspace } = await client
      .from('workspaces')
      .select('plan')
      .eq('id', workspaceId)
      .single()

    if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'cdn.delivery'))
      throw createError({ statusCode: 403, message: 'CDN requires Pro plan or higher' })
  }

  const update: Record<string, unknown> = {}
  if (body.cdn_enabled !== undefined) update.cdn_enabled = body.cdn_enabled
  if (body.cdn_branch !== undefined) update.cdn_branch = body.cdn_branch

  const { data, error } = await client
    .from('projects')
    .update(update)
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .select('cdn_enabled, cdn_branch')
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
