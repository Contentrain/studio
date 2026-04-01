/**
 * Transfer workspace ownership to another admin member.
 * Only the current owner of a secondary workspace can transfer.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{ memberId: string }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  if (!body.memberId)
    throw createError({ statusCode: 400, message: errorMessage('workspace.transfer_member_required') })

  // Verify caller is the current owner
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner'])

  // Verify workspace exists and is secondary
  const workspace = await db.getWorkspaceById(workspaceId, 'id, type, owner_id')
  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('workspace.not_found') })
  if (workspace.type === 'primary')
    throw createError({ statusCode: 400, message: errorMessage('workspace.cannot_transfer_primary') })
  if (workspace.owner_id !== session.user.id)
    throw createError({ statusCode: 403, message: errorMessage('workspace.owner_only_transfer') })

  // Verify target member exists and has admin role
  const targetMember = await db.getWorkspaceMember(session.accessToken, session.user.id, workspaceId, body.memberId)
  if (!targetMember)
    throw createError({ statusCode: 404, message: errorMessage('members.not_found') })
  if (targetMember.role !== 'admin')
    throw createError({ statusCode: 400, message: errorMessage('workspace.transfer_requires_admin') })

  const newOwnerId = targetMember.user_id as string

  await db.transferWorkspaceOwnership(workspaceId, session.user.id, newOwnerId)

  return { transferred: true }
})
