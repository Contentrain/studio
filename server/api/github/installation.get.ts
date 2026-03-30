import { useDatabaseProvider, useGitAppProvider } from '../../utils/providers'

/**
 * Get GitHub App installation details for a workspace.
 *
 * Returns the connected account info (login, avatar, selection type)
 * and the list of accessible repositories.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const query = getQuery(event) as { workspaceId?: string }

  if (!query.workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    query.workspaceId,
    ['owner', 'admin'],
  )

  const installationId = typeof workspace?.github_installation_id === 'number'
    ? workspace.github_installation_id
    : null

  if (!installationId)
    return { installed: false }

  const gitApp = useGitAppProvider(installationId)

  try {
    const [installation, repos] = await Promise.all([
      gitApp.getInstallationDetails(),
      gitApp.listInstallationRepositories(),
    ])

    return {
      installed: true,
      installationId,
      account: installation.account,
      selection: installation.selection,
      permissions: installation.permissions,
      suspendedAt: installation.suspendedAt,
      repos: repos.map(repo => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        private: repo.private,
        language: repo.language ?? null,
      })),
      settingsUrl: `https://github.com/settings/installations/${installationId}`,
    }
  }
  catch (e: unknown) {
    const status = (e as { status?: number }).status
    // Installation was deleted or suspended
    if (status === 404 || status === 403) {
      return {
        installed: true,
        installationId,
        error: 'installation_not_accessible',
        settingsUrl: `https://github.com/settings/installations/${installationId}`,
      }
    }
    throw createError({ statusCode: 500, message: errorMessage('github.installation_fetch_failed') })
  }
})
