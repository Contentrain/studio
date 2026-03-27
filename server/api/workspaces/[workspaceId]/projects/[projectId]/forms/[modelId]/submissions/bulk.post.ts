/**
 * Bulk form submission operations: approve, reject, spam, or delete multiple submissions.
 * Only workspace owners and admins can perform bulk actions.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

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

  const admin = useSupabaseAdmin()

  if (body.action === 'delete') {
    const results: { id: string, success: boolean, error?: string }[] = []

    for (const submissionId of body.submissionIds) {
      try {
        const existing = await getFormSubmission(admin, submissionId)
        if (!existing || existing.project_id !== projectId || existing.model_id !== modelId) {
          results.push({ id: submissionId, success: false, error: 'Not found' })
          continue
        }
        await deleteFormSubmission(admin, submissionId)
        results.push({ id: submissionId, success: true })
      }
      catch (e: unknown) {
        results.push({ id: submissionId, success: false, error: e instanceof Error ? e.message : 'Failed' })
      }
    }

    return { results, updated: results.filter(r => r.success).length }
  }

  // Map action to status
  const statusMap: Record<string, 'approved' | 'rejected' | 'spam'> = {
    approve: 'approved',
    reject: 'rejected',
    spam: 'spam',
  }

  const updated = await bulkUpdateSubmissions(
    admin,
    body.submissionIds,
    statusMap[body.action],
    body.action === 'approve' ? session.user.id : undefined,
  )

  return { updated }
})
