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

  // Verify caller is workspace owner/admin (RLS handles this, but explicit check for clear error)
  const { data: callerMembership } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', session.user.id)
    .single()

  if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role))
    throw createError({ statusCode: 403, message: 'Only workspace owner/admin can invite members' })

  // Invite user via auth provider
  const authProvider = useAuthProvider()
  let userId: string | null = null
  try {
    const result = await authProvider.inviteUserByEmail(body.email)
    userId = result.userId
  }
  catch {
    // User might already exist — look up by email
    const admin = useSupabaseAdmin()
    const { data: users } = await admin.auth.admin.listUsers()
    const existing = users?.users?.find(u => u.email === body.email)
    userId = existing?.id ?? null
  }

  // Create workspace member record
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
