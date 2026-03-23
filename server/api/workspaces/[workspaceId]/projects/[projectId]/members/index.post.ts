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

  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Plan-based role gating: reviewer/viewer require Pro+, specificModels requires Pro+
  const { data: ws } = await client.from('workspaces').select('plan').eq('id', workspaceId).single()
  const plan = getWorkspacePlan(ws ?? {})

  if (body.role === 'reviewer' && !hasFeature(plan, 'roles.reviewer'))
    throw createError({ statusCode: 403, message: 'Reviewer role requires Pro plan or higher' })

  if (body.role === 'viewer' && !hasFeature(plan, 'roles.viewer'))
    throw createError({ statusCode: 403, message: 'Viewer role requires Pro plan or higher' })

  if (body.specificModels && !hasFeature(plan, 'roles.specific_models'))
    throw createError({ statusCode: 403, message: 'Model-specific access requires Pro plan or higher' })

  const userId = await inviteOrLookupUser(body.email)

  // Ensure user is a workspace member (auto-add as 'member' if not)
  await ensureWorkspaceMember(client, useSupabaseAdmin(), workspaceId, userId, body.email)

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
