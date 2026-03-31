/**
 * Revoke a CDN API key (soft delete — sets revoked_at).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const keyId = getRouterParam(event, 'keyId')

  if (!workspaceId || !keyId)
    throw createError({ statusCode: 400, message: errorMessage('api.key_id_required') })

  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const projectId = getRouterParam(event, 'projectId')
  if (!projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  await db.revokeCDNKey(keyId, projectId)

  return { revoked: true }
})
