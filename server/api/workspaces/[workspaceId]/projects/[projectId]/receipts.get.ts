/**
 * What has been run under an approval, newest first.
 *
 * The audit answer to "who let this in": each receipt carries the plan it ran,
 * what it actually touched, who ran it, and the decisions that permitted it.
 * The grants themselves are cleared when a branch lands, so the receipt keeps
 * its own copy — a record whose evidence can be deleted is not a record.
 *
 * GET …/receipts?limit=50
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  await requireProjectAccess(session.user.id, workspaceId, projectId, session.accessToken)

  const raw = Number(getQuery(event).limit ?? 50)
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50

  const rows = await useDatabaseProvider().listReceipts(projectId, limit)
  return {
    receipts: rows.map(row => ({
      id: String(row.id),
      target: String(row.target),
      planHash: String(row.plan_hash),
      createdAt: String(row.created_at),
      receipt: row.receipt,
    })),
  }
})
