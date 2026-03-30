import { useDatabaseProvider, useGitProvider } from '../../utils/providers'

/**
 * Scan a repository for .contentrain/ and detect framework.
 *
 * Called during project connection to determine:
 * - Path A: .contentrain/ exists → ready to connect
 * - Path B: no .contentrain/ → needs init (Phase 2 via chat)
 * - Framework detection for content path suggestions
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const query = getQuery(event) as {
    workspaceId?: string
    owner?: string
    repo?: string
  }

  if (!query.workspaceId || !query.owner || !query.repo)
    throw createError({ statusCode: 400, message: errorMessage('github.scan_params_required') })

  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    query.workspaceId,
    ['owner', 'admin'],
    'id, github_installation_id',
  )

  const installationId = typeof workspace?.github_installation_id === 'number'
    ? workspace.github_installation_id
    : null

  if (!installationId)
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })

  // Create GitProvider for this repo
  const git = useGitProvider({
    installationId,
    owner: query.owner,
    repo: query.repo,
  })

  const detection = await git.detectFramework()
  const defaultBranch = await git.getDefaultBranch()

  return {
    defaultBranch,
    ...detection,
  }
})
