export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
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

  const client = useSupabaseUserClient(session.accessToken)

  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Team size limit
  const { data: ws } = await client.from('workspaces').select('plan, name, slug').eq('id', workspaceId).single()
  const plan = getWorkspacePlan(ws ?? {})
  const currentMembers = await listWorkspaceMembers(useSupabaseAdmin(), workspaceId)
  const memberLimit = getPlanLimit(plan, 'team.members')
  if (currentMembers.length >= memberLimit)
    throw createError({ statusCode: 403, message: errorMessage('members.seat_limit_reached', { limit: memberLimit }) })

  const { userId } = await inviteOrLookupUser(body.email, {
    workspaceName: ws?.name ?? '',
    inviterName: session.user.email ?? '',
    workspaceSlug: ws?.slug ?? '',
  })

  const { data: member, error } = await client
    .from('workspace_members')
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      role: body.role,
      invited_email: body.email,
      accepted_at: null, // Pending until user logs in and accesses workspace
    })
    .select()
    .single()

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return member
})
