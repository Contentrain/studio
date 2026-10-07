/**
 * GET /api/workspaces/:workspaceId/projects/:projectId/activity
 *
 * Returns a paginated activity feed from the audit log.
 * A workspace owner/admin sees the whole workspace's log. A member needs access to this project and sees only the
 * rows that name it (`record_snapshot.project_id`); rows with no project are owner/admin only.
 *
 * Query params:
 *   - page (default: 1)
 *   - limit (default: 20, max: 100)
 *   - action (optional filter, e.g. "delete_project")
 *   - sort (default: "newest", or "oldest")
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()

  // Verify workspace access (owner/admin/member); a member also needs this project (same rule as requireProjectAccess)
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])
  const projectScoped = role === 'member'
  if (projectScoped) {
    const projectMember = await db.getProjectMember(projectId, session.user.id)
    if (!projectMember)
      throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  // Verify project belongs to workspace
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const query = getQuery(event) as {
    page?: string
    limit?: string
    action?: string
    sort?: string
  }

  const page = query.page ? Number(query.page) : 1
  const limit = query.limit ? Math.min(Number(query.limit), 100) : 20

  const result = await db.listAuditLogs(workspaceId, {
    page,
    limit,
    action: query.action,
    sort: (query.sort as 'newest' | 'oldest') ?? 'newest',
    projectId: projectScoped ? projectId : undefined,
  })

  return {
    data: result.data.map(log => ({
      id: log.id,
      action: log.action,
      actor: log.actor_id,
      entity: log.table_name,
      recordId: log.record_id,
      origin: log.origin,
      createdAt: log.created_at,
    })),
    total: result.total,
    page,
    limit,
  }
})
