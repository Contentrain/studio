import { useDatabaseProvider } from '../../utils/providers'

/**
 * GitHub App installation callback.
 *
 * After user installs the GitHub App on their org/account,
 * GitHub redirects here with installation_id.
 * We save it to the workspace and redirect to the dashboard.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const query = getQuery(event) as {
    installation_id?: string
    setup_action?: string
    state?: string // workspace ID passed during GitHub App install
  }

  if (!query.installation_id) {
    throw createError({ statusCode: 400, message: errorMessage('github.installation_id_missing') })
  }

  const installationId = Number(query.installation_id)
  if (!installationId || Number.isNaN(installationId))
    throw createError({ statusCode: 400, message: errorMessage('github.installation_id_invalid') })

  // State parameter is required — it carries the target workspace ID
  if (!query.state)
    throw createError({ statusCode: 400, message: errorMessage('github.workspace_state_required') })

  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    query.state,
    ['owner', 'admin'],
  )

  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('github.workspace_not_found') })

  const workspaceId = typeof workspace.id === 'string' ? workspace.id : null
  const workspaceSlug = typeof workspace.slug === 'string' ? workspace.slug : null

  if (!workspaceId || !workspaceSlug)
    throw createError({ statusCode: 500, message: errorMessage('workspace.not_found') })

  // Check if another workspace already uses this installation
  const existingWs = await db.findWorkspaceByGithubInstallation(installationId, workspaceId)

  if (existingWs)
    throw createError({ statusCode: 409, message: errorMessage('github.installation_linked') })
  await db.updateWorkspaceGithubInstallation(workspaceId, installationId)

  // Redirect to workspace dashboard
  await sendRedirect(event, `/w/${workspaceSlug}`)
})
