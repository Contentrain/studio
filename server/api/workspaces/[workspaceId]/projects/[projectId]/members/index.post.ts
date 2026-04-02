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
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found_in_workspace') })

  // Plan-based role gating
  const ws = await db.getWorkspaceById(workspaceId, 'plan, name, slug')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  const normalizedAccess = await normalizeEnterpriseProjectMemberAccess({
    plan,
    role: body.role,
    specificModels: body.specificModels ?? false,
    allowedModels: body.allowedModels ?? [],
  })

  const wsName = typeof ws?.name === 'string' ? ws.name : ''
  const wsSlug = typeof ws?.slug === 'string' ? ws.slug : ''

  const { userId } = await inviteOrLookupUser(body.email, {
    workspaceName: wsName,
    inviterName: session.user.email ?? '',
    workspaceSlug: wsSlug,
  })

  // Ensure user is a workspace member (auto-add as 'member' if not)
  const currentMembers = await db.listWorkspaceMembers(session.accessToken, session.user.id, workspaceId)
  const isAlreadyMember = currentMembers.some(m => (m as { user_id?: string }).user_id === userId)
  if (!isAlreadyMember) {
    const memberLimit = getPlanLimit(plan, 'team.members')
    if (currentMembers.length >= memberLimit)
      throw createError({ statusCode: 403, message: errorMessage('members.seat_limit_reached', { limit: memberLimit }) })
  }
  await db.ensureWorkspaceMember(session.accessToken, workspaceId, userId, body.email)

  return db.createProjectMember({
    projectId,
    workspaceId,
    userId,
    role: normalizedAccess.role,
    invitedEmail: body.email,
    specificModels: normalizedAccess.specificModels,
    allowedModels: normalizedAccess.allowedModels,
  })
})
