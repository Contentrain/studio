export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    email: string
    role: 'admin' | 'member'
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: 'Workspace ID is required' })

  if (!body.email || !body.role)
    throw createError({ statusCode: 400, message: 'email and role are required' })

  if (!['admin', 'member'].includes(body.role))
    throw createError({ statusCode: 400, message: 'role must be admin or member' })

  const client = useSupabaseUserClient(session.accessToken)

  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const userId = await inviteOrLookupUser(body.email)

  const { data: member, error } = await client
    .from('workspace_members')
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      role: body.role,
      invited_email: body.email,
      accepted_at: userId ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return member
})
