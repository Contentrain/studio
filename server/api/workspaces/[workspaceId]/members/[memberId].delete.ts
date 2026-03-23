/**
 * Remove a member from a workspace.
 * Only workspace owner/admin can remove members. Owner cannot be removed.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const memberId = getRouterParam(event, 'memberId')

  if (!workspaceId || !memberId)
    throw createError({ statusCode: 400, message: 'workspaceId and memberId are required' })

  const client = useSupabaseUserClient(session.accessToken)

  // Verify caller is workspace owner/admin
  const { data: callerMembership } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', session.user.id)
    .single()

  if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role))
    throw createError({ statusCode: 403, message: 'Only workspace owner/admin can remove members' })

  // Prevent removing the owner
  const { data: target } = await client
    .from('workspace_members')
    .select('role')
    .eq('id', memberId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!target)
    throw createError({ statusCode: 404, message: 'Member not found' })

  if (target.role === 'owner')
    throw createError({ statusCode: 400, message: 'Cannot remove workspace owner' })

  const { error } = await client
    .from('workspace_members')
    .delete()
    .eq('id', memberId)
    .eq('workspace_id', workspaceId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
