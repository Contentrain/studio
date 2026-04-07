/**
 * Bulk form submission operations: approve, reject, spam, or delete multiple submissions.
 * Only workspace owners and admins can perform bulk actions.
 *
 * Approve creates content entries in Git for each submission.
 */

import { approveSubmissionAsContent } from '~~/server/utils/form-types'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const body = await readBody<{
    action: 'approve' | 'reject' | 'spam' | 'delete'
    submissionIds: string[]
  }>(event)

  const validActions = ['approve', 'reject', 'spam', 'delete']
  if (!body.action || !validActions.includes(body.action))
    throw createError({ statusCode: 400, message: errorMessage('forms.invalid_action', { action: body.action ?? 'undefined' }) })

  if (!body.submissionIds?.length)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  if (body.submissionIds.length > 50)
    throw createError({ statusCode: 400, message: errorMessage('forms.bulk_limit') })

  // Delete — sequential per-submission with ownership check + GDPR audit logging
  if (body.action === 'delete') {
    const results: { id: string, success: boolean, error?: string }[] = []
    const sourceIp = getRequestIP(event, { xForwardedFor: true }) ?? null
    const userAgent = getHeader(event, 'user-agent') ?? null

    for (const submissionId of body.submissionIds) {
      try {
        const existing = await db.getFormSubmission(submissionId)
        if (!existing || existing.workspace_id !== workspaceId || existing.project_id !== projectId || existing.model_id !== modelId) {
          results.push({ id: submissionId, success: false, error: 'Not found' })
          continue
        }
        await db.deleteFormSubmission(submissionId)
        // Explicit audit log — POST endpoint does not trigger DELETE audit middleware
        await db.createAuditLog({
          workspaceId,
          actorId: session.user.id,
          action: 'delete_form_submission',
          tableName: 'form_submissions',
          recordId: submissionId,
          recordSnapshot: existing as Record<string, unknown>,
          sourceIp,
          userAgent,
          origin: 'app',
        }).catch(() => {}) // Audit failure must never block the user's operation
        results.push({ id: submissionId, success: true })
      }
      catch (e: unknown) {
        results.push({ id: submissionId, success: false, error: e instanceof Error ? e.message : 'Failed' })
      }
    }

    return { results, updated: results.filter(r => r.success).length }
  }

  // Approve — create content entries in Git for each submission
  if (body.action === 'approve') {
    const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)
    const results: { id: string, success: boolean, entryId?: string, error?: string }[] = []

    for (const submissionId of body.submissionIds) {
      try {
        const existing = await db.getFormSubmission(submissionId)
        if (!existing || existing.workspace_id !== workspaceId || existing.project_id !== projectId || existing.model_id !== modelId) {
          results.push({ id: submissionId, success: false, error: 'Not found' })
          continue
        }
        const entryId = await approveSubmissionAsContent(existing, git, contentRoot, projectId, session.user.id)
        results.push({ id: submissionId, success: true, entryId: entryId ?? undefined })
      }
      catch (e: unknown) {
        results.push({ id: submissionId, success: false, error: e instanceof Error ? e.message : 'Failed' })
      }
    }

    return { results, updated: results.filter(r => r.success).length }
  }

  // Reject / spam — bulk status update
  const statusMap: Record<string, 'approved' | 'rejected' | 'spam'> = {
    reject: 'rejected',
    spam: 'spam',
  }

  const updated = await db.bulkUpdateSubmissions(
    body.submissionIds,
    statusMap[body.action]!,
    undefined,
    { workspaceId, projectId, modelId },
  )

  return { updated }
})
