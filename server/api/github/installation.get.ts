import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'

/**
 * Get GitHub App installation details for a workspace.
 *
 * Returns the connected account info (login, avatar, selection type)
 * and the list of accessible repositories.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const query = getQuery(event) as { workspaceId?: string }

  if (!query.workspaceId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_id_required') })

  const client = useSupabaseUserClient(session.accessToken)

  await requireWorkspaceRole(client, session.user.id, query.workspaceId, ['owner', 'admin'])

  const workspace = await getWorkspace(client, query.workspaceId)

  if (!workspace?.github_installation_id)
    return { installed: false }

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

  try {
    const { data: installation } = await octokit.apps.getInstallation({
      installation_id: workspace.github_installation_id,
    })

    // List accessible repos
    const { data: repoData } = await octokit.apps.listReposAccessibleToInstallation({
      per_page: 100,
    })

    return {
      installed: true,
      installationId: workspace.github_installation_id,
      account: {
        login: (installation.account as { login?: string })?.login ?? null,
        avatarUrl: (installation.account as { avatar_url?: string })?.avatar_url ?? null,
        type: installation.target_type, // 'Organization' | 'User'
      },
      selection: installation.repository_selection, // 'all' | 'selected'
      permissions: installation.permissions,
      suspendedAt: installation.suspended_at,
      repos: repoData.repositories.map(repo => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        language: repo.language,
      })),
      settingsUrl: `https://github.com/settings/installations/${workspace.github_installation_id}`,
    }
  }
  catch (e: unknown) {
    const status = (e as { status?: number }).status
    // Installation was deleted or suspended
    if (status === 404 || status === 403) {
      return {
        installed: true,
        installationId: workspace.github_installation_id,
        error: 'installation_not_accessible',
        settingsUrl: `https://github.com/settings/installations/${workspace.github_installation_id}`,
      }
    }
    throw createError({ statusCode: 500, message: errorMessage('github.installation_fetch_failed') })
  }
})
