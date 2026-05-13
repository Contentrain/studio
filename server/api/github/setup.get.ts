import { useDatabaseProvider, useGitAppService } from '../../utils/providers'
import { getValidGitHubUserToken } from '../../utils/github-token'

/**
 * GitHub App installation callback.
 *
 * After user installs the GitHub App on their org/account,
 * GitHub redirects here with installation_id.
 * We save it to the workspace and redirect to the dashboard.
 *
 * Security: in addition to the workspace-role and 409 collision checks,
 * we verify the caller actually has GitHub-side access to the
 * installation_id they supplied (PostHog-style ownership check). This
 * is defense-in-depth against installation_id parameter spoofing.
 * Without the GitHub user OAuth token we degrade to the legacy
 * "trust the redirect" path — this only matters when the user signed
 * in via Google/magic link AND then somehow ended up at this callback,
 * which is an unsupported flow but not a hard failure.
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

  // GitHub-side ownership verification (PostHog pattern). If we have a
  // GitHub user OAuth token (sign-in went through GitHub), confirm the
  // user actually has access to the installation_id they supplied.
  // Without this, an attacker who guesses or leaks an installation_id
  // from a different tenant could attempt to attach it, blocked only
  // by the 409 collision check below — and unbound stolen ids would
  // succeed. When the user has no token (Google/magic-link sign-in,
  // unsupported but possible), we skip the check rather than hard-fail
  // and rely on the redirect-from-GitHub trust + the 409 collision.
  const userToken = await getValidGitHubUserToken(session.user.id)
  if (userToken) {
    const gitAppService = useGitAppService()
    const hasAccess = await gitAppService.verifyUserHasAccessToInstallation(userToken, installationId)
    if (!hasAccess)
      throw createError({ statusCode: 403, message: errorMessage('github.installation_access_denied') })
  }

  // Check if another workspace already uses this installation
  const existingWs = await db.findWorkspaceByGithubInstallation(installationId, workspaceId)

  if (existingWs)
    throw createError({ statusCode: 409, message: errorMessage('github.installation_linked') })
  await db.updateWorkspaceGithubInstallation(workspaceId, installationId)

  // Redirect to workspace dashboard
  await sendRedirect(event, `/w/${workspaceSlug}`)
})
