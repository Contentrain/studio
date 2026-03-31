/**
 * Update a form submission status (approve, reject, mark as spam).
 * Only workspace owners and admins can moderate submissions.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const submissionId = getRouterParam(event, 'submissionId')

  if (!workspaceId || !projectId || !modelId || !submissionId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const body = await readBody<{
    status: 'approved' | 'rejected' | 'spam'
  }>(event)

  const validStatuses = ['approved', 'rejected', 'spam']
  if (!body.status || !validStatuses.includes(body.status))
    throw createError({ statusCode: 400, message: errorMessage('forms.invalid_status', { status: body.status ?? 'undefined' }) })

  // Verify submission exists and belongs to this workspace/project/model
  const existing = await db.getFormSubmission(submissionId)
  if (!existing || existing.workspace_id !== workspaceId || existing.project_id !== projectId || existing.model_id !== modelId)
    throw createError({ statusCode: 404, message: errorMessage('forms.submission_not_found') })

  return db.updateFormSubmissionStatus(
    submissionId,
    body.status,
    body.status === 'approved' ? session.user.id : undefined,
  )
})
