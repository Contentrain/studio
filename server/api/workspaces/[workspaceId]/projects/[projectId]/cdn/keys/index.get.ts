/**
 * List CDN API keys for a project (hashes hidden, prefixes shown).
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  // Defense in depth: explicit role check (RLS also filters)
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const data = await db.listCDNKeys(session.accessToken, projectId, workspaceId)

  return data ?? []
})
