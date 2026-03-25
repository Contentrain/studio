import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'

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
  const body = await readBody<{
    workspaceId: string
    templateRepo: string // e.g. "contentrain-starter-astro-blog"
    name: string // desired repo name
    isPrivate?: boolean
    description?: string
  }>(event)

  if (!body.workspaceId || !body.templateRepo || !body.name)
    throw createError({ statusCode: 400, message: 'workspaceId, templateRepo, and name are required' })

  // Validate repo name
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(body.name))
    throw createError({ statusCode: 400, message: 'Invalid repository name' })

  const client = useSupabaseUserClient(session.accessToken)

  // Only owner/admin can create repos
  await requireWorkspaceRole(client, session.user.id, body.workspaceId, ['owner', 'admin'])

  const workspace = await getWorkspace(client, body.workspaceId)

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: 'GitHub App not installed for this workspace' })

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

  // Resolve installation target (org or user account)
  const { data: installation } = await octokit.apps.getInstallation({
    installation_id: workspace.github_installation_id,
  })

  const targetOwner = installation.account?.login
  if (!targetOwner)
    throw createError({ statusCode: 500, message: 'Could not resolve GitHub installation owner' })

  // Create repo from template
  let newRepo
  try {
    const { data } = await octokit.repos.createUsingTemplate({
      template_owner: 'Contentrain',
      template_repo: body.templateRepo,
      owner: targetOwner,
      name: body.name,
      private: body.isPrivate ?? false,
      description: body.description || undefined,
      include_all_branches: false,
    })
    newRepo = data
  }
  catch (e: unknown) {
    const err = e as { status?: number, response?: { data?: { message?: string } } }
    const detail = err.response?.data?.message || 'Unknown error'
    console.error('[create-from-template] Failed:', detail, 'status:', err.status)

    if (err.status === 422)
      throw createError({ statusCode: 422, message: 'Repository name already exists or is invalid' })

    if (err.status === 403)
      throw createError({ statusCode: 403, message: 'GitHub App does not have permission to create repositories. Please update the App permissions in GitHub settings.' })

    throw createError({ statusCode: 500, message: `Failed to create repository: ${detail}` })
  }

  // Check if the App can access the newly created repo
  // (may fail if installation is set to "Only select repositories")
  let needsAccess = false
  try {
    await octokit.repos.get({
      owner: newRepo.owner.login,
      repo: newRepo.name,
    })
  }
  catch {
    needsAccess = true
  }

  return {
    id: newRepo.id,
    fullName: newRepo.full_name,
    name: newRepo.name,
    owner: newRepo.owner.login,
    private: newRepo.private,
    defaultBranch: newRepo.default_branch || 'main',
    description: newRepo.description,
    htmlUrl: newRepo.html_url,
    needsAccess,
  }
})
