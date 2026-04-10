/**
 * GET /api/workspaces/:workspaceId/projects/:projectId/activity
 *
 * Returns a paginated activity feed from the audit log.
 * Currently workspace-scoped (audit_logs table has workspace_id).
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

  // Verify workspace access (owner/admin/member)
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

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
