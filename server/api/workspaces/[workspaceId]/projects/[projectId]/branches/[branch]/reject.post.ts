/**
 * Reject (delete) a content branch.
 * Requires reviewer, admin, or owner role.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const branch = getRouterParam(event, 'branch')

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and branch are required' })

  // Role check: only reviewer+ can reject
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('reject_branch'))
    throw createError({ statusCode: 403, message: 'Insufficient permissions to reject branches' })

  const { git, contentRoot } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  const engine = createContentEngine({ git, contentRoot })
  await engine.rejectBranch(branch)
  return { rejected: true }
})
