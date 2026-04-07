export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const body = await readBody<{
    email: string
    role: 'admin' | 'member'
  }>(event)

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  if (!body.email || !body.role)
    throw createError({ statusCode: 400, message: errorMessage('validation.email_role_required') })

  if (!['admin', 'member'].includes(body.role))
    throw createError({ statusCode: 400, message: errorMessage('members.invalid_workspace_role') })

  // Resolve workspace + plan
  const ws = await db.getWorkspaceForUser(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'], 'plan, name, slug')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  const memberLimit = getPlanLimit(plan, 'team.members')

  const workspaceName = typeof ws?.name === 'string' ? ws.name : ''
  const workspaceSlug = typeof ws?.slug === 'string' ? ws.slug : ''

  const { userId } = await inviteOrLookupUser(body.email, {
    workspaceName,
    inviterName: session.user.email ?? '',
    workspaceSlug,
  })

  // Atomic: check seat limit + insert in one transaction (prevents race condition)
  const result = await db.createWorkspaceMemberIfAllowed({
    workspaceId,
    memberUserId: userId,
    role: body.role,
    invitedEmail: body.email,
    acceptedAt: null,
    limit: memberLimit,
    accessToken: session.accessToken,
    callerUserId: session.user.id,
  })

  if (!result.allowed)
    throw createError({ statusCode: 403, message: errorMessage('members.seat_limit_reached', { limit: memberLimit }) })

  return result.member
})
