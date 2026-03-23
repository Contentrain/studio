/**
 * Update a workspace member's role.
 * Only workspace owner can change roles. Owner role cannot be changed.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const memberId = getRouterParam(event, 'memberId')
  const body = await readBody<{ role: 'admin' | 'member' }>(event)

  if (!workspaceId || !memberId)
    throw createError({ statusCode: 400, message: 'workspaceId and memberId are required' })

  if (!body.role || !['admin', 'member'].includes(body.role))
    throw createError({ statusCode: 400, message: 'role must be admin or member' })

  const client = useSupabaseUserClient(session.accessToken)

  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner'])

  // Prevent changing owner role
  const { data: target } = await client
    .from('workspace_members')
    .select('role')
    .eq('id', memberId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!target)
    throw createError({ statusCode: 404, message: 'Member not found' })

  if (target.role === 'owner')
    throw createError({ statusCode: 400, message: 'Cannot change owner role' })

  const { data, error } = await client
    .from('workspace_members')
    .update({ role: body.role })
    .eq('id', memberId)
    .eq('workspace_id', workspaceId)
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
