/**
 * Update a workspace member's role.
 * Only workspace owner can change roles. Owner role cannot be changed.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const memberId = getRouterParam(event, 'memberId')
  const body = await readBody<{ role: 'admin' | 'member' }>(event)

  if (!workspaceId || !memberId)
    throw createError({ statusCode: 400, message: errorMessage('validation.member_id_required') })

  if (!body.role || !['admin', 'member'].includes(body.role))
    throw createError({ statusCode: 400, message: errorMessage('members.invalid_workspace_role') })

  return db.updateWorkspaceMemberRole(session.accessToken, session.user.id, workspaceId, memberId, body.role)
})
