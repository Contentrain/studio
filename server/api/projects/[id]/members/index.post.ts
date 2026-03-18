export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const projectId = getRouterParam(event, 'id')
  const body = await readBody<{
    email: string
    role: 'editor' | 'reviewer' | 'viewer'
    specificModels?: boolean
    allowedModels?: string[]
  }>(event)

  if (!projectId)
    throw createError({ statusCode: 400, message: 'Project ID is required' })

  if (!body.email || !body.role)
    throw createError({ statusCode: 400, message: 'email and role are required' })

  if (!['editor', 'reviewer', 'viewer'].includes(body.role))
    throw createError({ statusCode: 400, message: 'role must be editor, reviewer, or viewer' })

  const client = useSupabaseUserClient(session.accessToken)

  // Verify caller is owner
  const { data: project } = await client
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()

  if (!project || project.owner_id !== session.user.id)
    throw createError({ statusCode: 403, message: 'Only the project owner can invite members' })

  // Invite user via auth provider (creates account if not exists, sends magic link)
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
