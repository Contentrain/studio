import { useDatabaseProvider, useGitAppProvider } from '../../utils/providers'

/**
 * List repositories accessible via the GitHub App installation.
 *
 * Returns repos the user can connect as projects.
 * Requires workspace to have a github_installation_id.
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
    'id, github_installation_id',
  )

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })

  const repos = await useGitAppProvider(workspace.github_installation_id as number).listInstallationRepositories()

  return repos.map(repo => ({
    id: repo.id,
    fullName: repo.fullName,
    name: repo.name,
    owner: repo.owner,
    private: repo.private,
    defaultBranch: repo.defaultBranch ?? null,
    description: repo.description,
    language: repo.language,
    updatedAt: repo.updatedAt ?? null,
  }))
})
