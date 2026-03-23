/**
 * Merge a content branch into the default branch.
 * Requires reviewer, admin, or owner role.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const branch = getRouterParam(event, 'branch')

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: 'workspaceId, projectId, and branch are required' })

  // Role check: only reviewer+ can merge
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('merge_branch'))
    throw createError({ statusCode: 403, message: 'Insufficient permissions to merge branches' })

  const { git, contentRoot } = await resolveProjectContext(
    useSupabaseUserClient(session.accessToken), workspaceId, projectId,
  )

  const engine = createContentEngine({ git, contentRoot })
  return engine.mergeBranch(branch)
})
