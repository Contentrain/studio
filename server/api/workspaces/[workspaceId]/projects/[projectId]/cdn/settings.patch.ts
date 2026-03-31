/**
 * Update CDN settings for a project (enable/disable, branch).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ cdn_enabled?: boolean, cdn_branch?: string | null }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  // Verify owner/admin
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  // Plan check if enabling
  if (body.cdn_enabled === true) {
    const workspace = await db.getWorkspaceById(workspaceId, 'plan')

    if (!hasFeature(getWorkspacePlan(workspace ?? {}), 'cdn.delivery'))
      throw createError({ statusCode: 403, message: errorMessage('cdn.upgrade') })
  }

  const update: Record<string, unknown> = {}
  if (body.cdn_enabled !== undefined) update.cdn_enabled = body.cdn_enabled
  if (body.cdn_branch !== undefined) update.cdn_branch = body.cdn_branch

  const data = await db.updateProject(projectId, update, 'cdn_enabled, cdn_branch')

  return data
})
