import { GITHUB_REAUTH_REQUIRED_CODE, getValidGitHubUserToken } from '../../../utils/github-token'

/**
 * GET /api/github/installations/available?workspaceId=<id>
 *
 * Enumerate GitHub App installations visible to the authenticated user,
 * annotated with whether each one is already bound to a workspace
 * (so the UI can disable bound items in the picker).
 *
 * Auth: workspace owner/admin role required (the listing is gated on
 * the calling user being able to act on the target workspace —
 * preventing arbitrary cross-tenant enumeration even though the
 * underlying GitHub API call only sees the user's own installations).
 *
 * Returns 401 with code='GITHUB_REAUTH_REQUIRED' when no usable
 * provider token exists (user signed in via Google / magic link, or
 * the refresh token expired). Frontend handles this by prompting the
 * user to reconnect their GitHub account.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const query = getQuery(event) as { workspaceId?: string }

  if (!query.workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  // Authorize: caller must be owner or admin of the target workspace.
  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    query.workspaceId,
    ['owner', 'admin'],
  )
  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('github.workspace_not_found') })

  const userToken = await getValidGitHubUserToken(session.user.id)
  if (!userToken) {
    throw createError({
      statusCode: 401,
      message: errorMessage('github.user_token_missing'),
      data: { code: GITHUB_REAUTH_REQUIRED_CODE },
    })
  }

  const gitAppService = useGitAppService()
  const installations = await gitAppService.listInstallationsForUser(userToken)

  if (installations.length === 0) {
    return { installations: [] }
  }

  // Annotate each installation with `boundWorkspaceId` so the picker
  // can disable items already in use. Done in a single batch query
  // rather than N round trips.
  const ids = installations.map(i => i.id)
  const boundMap = new Map<number, { id: string, name: string, slug: string }>()
  for (const id of ids) {
    const bound = await db.findWorkspaceByGithubInstallation(id)
    if (bound) {
      boundMap.set(id, {
        id: bound.id as string,
        name: (bound.name as string) ?? '',
        slug: (bound.slug as string) ?? '',
      })
    }
  }

  return {
    installations: installations.map(inst => ({
      id: inst.id,
      account: inst.account,
      repositorySelection: inst.repositorySelection,
      targetType: inst.targetType,
      boundWorkspace: boundMap.get(inst.id) ?? null,
    })),
  }
})
