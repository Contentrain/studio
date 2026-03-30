/**
 * Remove a member from a workspace.
 * Only workspace owner/admin can remove members. Owner cannot be removed.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const memberId = getRouterParam(event, 'memberId')

  if (!workspaceId || !memberId)
    throw createError({ statusCode: 400, message: errorMessage('validation.member_id_required') })

  await db.deleteWorkspaceMember(session.accessToken, session.user.id, workspaceId, memberId)
  return { deleted: true }
})
