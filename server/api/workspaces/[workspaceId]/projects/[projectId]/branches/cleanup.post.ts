/**
 * Trigger branch cleanup — deletes merged cr/* branches past retention.
 * Requires admin or owner workspace role.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  // Admin+ only — cleanup is a governance action
  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const { git } = await resolveProjectContext(workspaceId, projectId)
  const report = await cleanupMergedBranches(git, projectId)

  return report
})
