/**
 * List projects the current user can access in a workspace.
 *
 * Owner/Admin → all projects in the workspace
 * Member → only projects with explicit project_members assignment
 *
 * Filtering is done at application level (not RLS-dependent)
 * so the adapter pattern holds for non-PostgreSQL databases.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')

  if (!workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const db = useDatabaseProvider()
  const client = db.getUserClient(session.accessToken)
  const admin = db.getAdminClient()

  // Get user's workspace role
  const { data: membership } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', session.user.id)
    .single()

  if (!membership)
    throw createError({ statusCode: 403, message: errorMessage('workspace.not_a_member') })

  // Owner/Admin: all projects
  if (membership.role === 'owner' || membership.role === 'admin') {
    const { data, error } = await admin
      .from('projects')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })

    if (error)
      throw createError({ statusCode: 500, message: error.message })

    return data
  }

  // Member: only explicitly assigned projects
  const { data: assignments } = await admin
    .from('project_members')
    .select('project_id')
    .eq('user_id', session.user.id)

  const assignedIds = (assignments ?? []).map(a => a.project_id)

  if (assignedIds.length === 0) return []

  const { data, error } = await admin
    .from('projects')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('id', assignedIds)
    .order('created_at', { ascending: false })

  if (error)
    throw createError({ statusCode: 500, message: error.message })

  return data
})
