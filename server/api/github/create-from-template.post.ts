import { useDatabaseProvider, useGitAppProvider } from '../../utils/providers'

/**
 * Create a new repository from a Contentrain starter template.
 *
 * Uses GitHub's "create repository using template" API with the App
 * installation token. Templates are public repos in the Contentrain org.
 *
 * Known limitation: If the user's GitHub App installation is set to
 * "Only select repositories", the newly created repo is NOT auto-added
 * to the access list. In that case we return `needsAccess: true` so
 * the UI can prompt the user to update their installation settings.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const body = await readBody<{
    workspaceId: string
    templateRepo: string // e.g. "contentrain-starter-astro-blog"
    name: string // desired repo name
    isPrivate?: boolean
    description?: string
  }>(event)

  if (!body.workspaceId || !body.templateRepo || !body.name)
    throw createError({ statusCode: 400, message: errorMessage('github.template_params_required') })

  // Validate repo name
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(body.name))
    throw createError({ statusCode: 400, message: errorMessage('github.repo_name_invalid') })

  const workspace = await db.getWorkspaceForUser(
    session.accessToken,
    session.user.id,
    body.workspaceId,
    ['owner', 'admin'],
    'id, github_installation_id',
  )

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: errorMessage('github.installation_missing') })

  const gitApp = useGitAppProvider(workspace.github_installation_id as number)

  // Create repo from template
  let newRepo
  try {
    const config = useRuntimeConfig()
    const templateOwner = (config.public.templateOwner as string) || 'Contentrain'
    newRepo = await gitApp.createRepositoryFromTemplate({
      templateOwner,
      templateRepo: body.templateRepo,
      name: body.name,
      private: body.isPrivate ?? false,
      description: body.description,
    })
  }
  catch (e: unknown) {
    const err = e as { status?: number, response?: { data?: { message?: string } } }
    const detail = err.response?.data?.message || 'Unknown error'
    console.error('[create-from-template] Failed:', detail, 'status:', err.status)

    if (err.status === 422)
      throw createError({ statusCode: 422, message: errorMessage('github.repo_exists') })

    if (err.status === 403)
      throw createError({ statusCode: 403, message: errorMessage('github.repo_permission_denied') })

    throw createError({ statusCode: 500, message: errorMessage('github.repo_create_failed', { detail }) })
  }

  // Check if the App can access the newly created repo
  // (may fail if installation is set to "Only select repositories")
  const needsAccess = !(await gitApp.canAccessRepository(newRepo.owner, newRepo.name))

  return {
    id: newRepo.id,
    fullName: newRepo.fullName,
    name: newRepo.name,
    owner: newRepo.owner,
    private: newRepo.private,
    defaultBranch: newRepo.defaultBranch || 'main',
    description: newRepo.description,
    htmlUrl: newRepo.htmlUrl,
    needsAccess,
  }
})
