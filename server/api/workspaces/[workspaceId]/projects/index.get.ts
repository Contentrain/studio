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

  // Get user's workspace role
  const role = await db.getWorkspaceMemberRole(session.accessToken, session.user.id, workspaceId)

  if (!role)
    throw createError({ statusCode: 403, message: errorMessage('workspace.not_a_member') })

  // Owner/Admin: all projects
  if (role === 'owner' || role === 'admin') {
    return db.listWorkspaceProjectsAdmin(workspaceId)
  }

  // Member: only explicitly assigned projects
  const assignedIds = await db.listUserAssignedProjectIds(session.user.id)

  if (assignedIds.length === 0) return []

  return db.listWorkspaceProjectsByIds(workspaceId, assignedIds)
})
