import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'

/**
 * List repositories accessible via the GitHub App installation.
 *
 * Returns repos the user can connect as projects.
 * Requires workspace to have a github_installation_id.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const query = getQuery(event) as { workspaceId?: string }

  if (!query.workspaceId)
    throw createError({ statusCode: 400, message: 'workspaceId is required' })

  const workspace = await getWorkspace(useSupabaseUserClient(session.accessToken), query.workspaceId)

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: 'GitHub App not installed for this workspace' })

  // Create Octokit with installation auth
  const config = useRuntimeConfig()
  const privateKey = Buffer.from(config.github.privateKey, 'base64').toString('utf-8')

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.github.appId,
      privateKey,
      installationId: workspace.github_installation_id,
    },
  })

  // List repos accessible to this installation
  const { data } = await octokit.apps.listReposAccessibleToInstallation({
    per_page: 100,
  })

  return data.repositories.map(repo => ({
    id: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner.login,
    private: repo.private,
    defaultBranch: repo.default_branch,
    description: repo.description,
    language: repo.language,
    updatedAt: repo.updated_at,
  }))
})
