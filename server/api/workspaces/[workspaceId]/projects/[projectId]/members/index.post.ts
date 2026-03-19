export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{
    email: string
    role: 'editor' | 'reviewer' | 'viewer'
    specificModels?: boolean
    allowedModels?: string[]
  }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'Workspace ID and Project ID are required' })

  if (!body.email || !body.role)
    throw createError({ statusCode: 400, message: 'email and role are required' })

  if (!['editor', 'reviewer', 'viewer'].includes(body.role))
    throw createError({ statusCode: 400, message: 'role must be editor, reviewer, or viewer' })

  const client = useSupabaseUserClient(session.accessToken)

  // Verify caller is workspace owner/admin
  const { data: callerMembership } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', session.user.id)
    .single()

  if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role))
    throw createError({ statusCode: 403, message: 'Only workspace owner/admin can assign project members' })

  // Invite user via auth provider (creates account if needed)
  const authProvider = useAuthProvider()
  let userId: string | null = null
  try {
    const result = await authProvider.inviteUserByEmail(body.email)
    userId = result.userId
  }
  catch {
    const admin = useSupabaseAdmin()
    const { data: users } = await admin.auth.admin.listUsers()
    const existing = users?.users?.find(u => u.email === body.email)
    userId = existing?.id ?? null
  }

  // Ensure user is a workspace member first (auto-add as 'member' if not)
  if (userId) {
    const { data: existingWsMember } = await client
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .single()

    if (!existingWsMember) {
      // Use admin client to bypass RLS for this insert
      const admin = useSupabaseAdmin()
      await admin
        .from('workspace_members')
        .insert({
          workspace_id: workspaceId,
          user_id: userId,
          role: 'member',
          invited_email: body.email,
          accepted_at: new Date().toISOString(),
        })
    }
  }

  // Create project member record
  const { data: member, error } = await client
    .from('project_members')
    .insert({
      project_id: projectId,
      user_id: userId,
      role: body.role,
      specific_models: body.specificModels ?? false,
      allowed_models: body.allowedModels ?? [],
      invited_email: body.email,
      accepted_at: userId ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return member
})
