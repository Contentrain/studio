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
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  if (!body.email || !body.role)
    throw createError({ statusCode: 400, message: errorMessage('validation.email_role_required') })

  if (!['editor', 'reviewer', 'viewer'].includes(body.role))
    throw createError({ statusCode: 400, message: errorMessage('members.invalid_project_role') })

  const db = useDatabaseProvider()
  const client = db.getUserClient(session.accessToken)

  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const admin = db.getAdminClient()
  const { data: project } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found_in_workspace') })

  // Plan-based role gating: reviewer/viewer require Pro+, specificModels requires Pro+
  const { data: ws } = await client.from('workspaces').select('plan, name, slug').eq('id', workspaceId).single()
  const plan = getWorkspacePlan(ws ?? {})
  const normalizedAccess = await normalizeEnterpriseProjectMemberAccess({
    plan,
    role: body.role,
    specificModels: body.specificModels ?? false,
    allowedModels: body.allowedModels ?? [],
  })

  const { userId } = await inviteOrLookupUser(body.email, {
    workspaceName: ws?.name ?? '',
    inviterName: session.user.email ?? '',
    workspaceSlug: ws?.slug ?? '',
  })

  // Ensure user is a workspace member (auto-add as 'member' if not)
  // Check seat limit before auto-adding
  const currentMembers = await listWorkspaceMembers(admin, workspaceId)
  const isAlreadyMember = currentMembers.some(m => (m as { user_id?: string }).user_id === userId)
  if (!isAlreadyMember) {
    const memberLimit = getPlanLimit(plan, 'team.members')
    if (currentMembers.length >= memberLimit)
      throw createError({ statusCode: 403, message: errorMessage('members.seat_limit_reached', { limit: memberLimit }) })
  }
  await ensureWorkspaceMember(client, admin, workspaceId, userId, body.email)

  // Create project member record
  const { data: member, error } = await client
    .from('project_members')
    .insert({
      project_id: projectId,
      user_id: userId,
      role: normalizedAccess.role,
      specific_models: normalizedAccess.specificModels,
      allowed_models: normalizedAccess.allowedModels,
      invited_email: body.email,
      accepted_at: null, // Pending until user accesses project
    })
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return member
})
