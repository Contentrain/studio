import { GITHUB_REAUTH_REQUIRED_CODE, getValidGitHubUserToken } from '../../../utils/github-token'

/**
 * POST /api/github/installations/connect
 * Body: { workspaceId: string, installationId: number }
 *
 * Bind an existing GitHub App installation to a workspace — the
 * "Connect existing installation" counterpart to the install-callback
 * flow at `setup.get.ts`. Used when the App is already installed on
 * the user's account/org (e.g. after deleting a previous workspace)
 * and GitHub's `installations/new` page short-circuits to "Configure".
 *
 * Security checks (in order):
 *  1. Caller is owner/admin of the target workspace.
 *  2. Caller has GitHub-side access to the installation
 *     (`verifyUserHasAccessToInstallation` — PostHog pattern). This
 *     defends against a user supplying an arbitrary installation_id
 *     they don't actually own.
 *  3. The installation isn't already bound to a different workspace
 *     (409 — same invariant as setup.get.ts:48).
 *
 * On success the workspace's `github_installation_id` is set and the
 * status column flips to 'active'.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const body = await readBody<{ workspaceId?: string, installationId?: number }>(event)

  if (!body.workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const installationId = typeof body.installationId === 'number'
    ? body.installationId
    : Number(body.installationId)
  if (!installationId || Number.isNaN(installationId))
    throw createError({ statusCode: 400, message: errorMessage('github.installation_id_invalid') })

  // 1. Role check.
  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    body.workspaceId,
    ['owner', 'admin'],
  )
  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('github.workspace_not_found') })

  // 2. GitHub-side ownership verification.
  const userToken = await getValidGitHubUserToken(session.user.id)
  if (!userToken) {
    throw createError({
      statusCode: 401,
      message: errorMessage('github.user_token_missing'),
      data: { code: GITHUB_REAUTH_REQUIRED_CODE },
    })
  }

  const gitAppService = useGitAppService()
  const hasAccess = await gitAppService.verifyUserHasAccessToInstallation(userToken, installationId)
  if (!hasAccess)
    throw createError({ statusCode: 403, message: errorMessage('github.installation_access_denied') })

  // 3. Collision check — installation must not already back a
  // different workspace. The DB schema does not enforce UNIQUE on
  // github_installation_id, so this check is the only protection.
  const conflict = await db.findWorkspaceByGithubInstallation(installationId, body.workspaceId)
  if (conflict)
    throw createError({ statusCode: 409, message: errorMessage('github.installation_linked') })

  await db.updateWorkspaceGithubInstallation(body.workspaceId, installationId)

  return { connected: true, installationId, workspaceId: body.workspaceId }
})
