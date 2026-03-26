/**
 * Remove a member from a workspace.
 * Only workspace owner/admin can remove members. Owner cannot be removed.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const memberId = getRouterParam(event, 'memberId')

  if (!workspaceId || !memberId)
    throw createError({ statusCode: 400, message: errorMessage('validation.member_id_required') })

  const client = useSupabaseUserClient(session.accessToken)

  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Prevent removing the owner
  const { data: target } = await client
    .from('workspace_members')
    .select('role')
    .eq('id', memberId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!target)
    throw createError({ statusCode: 404, message: errorMessage('members.not_found') })

  if (target.role === 'owner')
    throw createError({ statusCode: 400, message: errorMessage('members.cannot_remove_owner') })

  const { error } = await client
    .from('workspace_members')
    .delete()
    .eq('id', memberId)
    .eq('workspace_id', workspaceId)

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return { deleted: true }
})
