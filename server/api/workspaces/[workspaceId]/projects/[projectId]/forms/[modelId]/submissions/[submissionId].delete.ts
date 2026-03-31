/**
 * Delete a form submission.
 * Only workspace owners and admins can delete submissions.
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

  // Verify submission exists and belongs to this workspace/project/model
  const existing = await db.getFormSubmission(submissionId)
  if (!existing || existing.workspace_id !== workspaceId || existing.project_id !== projectId || existing.model_id !== modelId)
    throw createError({ statusCode: 404, message: errorMessage('forms.submission_not_found') })

  await db.deleteFormSubmission(submissionId)

  return { deleted: true }
})
