import type { ContentrainConfig } from '@contentrain/types'

/**
 * Update .contentrain/config.json settings.
 * Always auto-merges — config changes must take effect immediately.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<Partial<ContentrainConfig>>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  // Only owner/admin can change project config
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (permissions.workspaceRole !== 'owner' && permissions.workspaceRole !== 'admin')
    throw createError({ statusCode: 403, message: 'Only workspace owner/admin can change project settings' })

  const client = useSupabaseUserClient(session.accessToken)

  const { data: project } = await client
    .from('projects')
    .select('repo_full_name, content_root, workspace_id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: 'Project not found' })

  const { data: workspace } = await client
    .from('workspaces')
    .select('github_installation_id')
    .eq('id', workspaceId)
    .single()

  if (!workspace?.github_installation_id)
    throw createError({ statusCode: 400, message: 'GitHub App not installed' })

  const [owner, repo] = project.repo_full_name.split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id,
    owner,
    repo,
  })

  const contentRoot = normalizeContentRoot(project.content_root)
  const configPath = contentRoot ? `${contentRoot}/.contentrain/config.json` : '.contentrain/config.json'

  // Read current config
  let config: ContentrainConfig
  try {
    config = JSON.parse(await git.readFile(configPath)) as ContentrainConfig
  }
  catch {
    throw createError({ statusCode: 404, message: '.contentrain/config.json not found' })
  }

  // Merge allowed fields only
  if (body.workflow !== undefined) config.workflow = body.workflow
  if (body.domains !== undefined) config.domains = body.domains
  if (body.locales !== undefined) {
    if (body.locales.default) config.locales.default = body.locales.default
    if (body.locales.supported) config.locales.supported = body.locales.supported
  }

  // Commit directly — config changes always auto-merge
  const branchName = `contentrain/config-${Date.now().toString(36)}`
  await git.createBranch(branchName)

  await git.commitFiles(
    branchName,
    [{ path: configPath, content: JSON.stringify(config, null, 2) + '\n' }],
    `contentrain: update project config\n\nChanged: ${Object.keys(body).join(', ')}`,
    { name: 'Contentrain Studio[bot]', email: 'bot@contentrain.io' },
  )

  const defaultBranch = await git.getDefaultBranch()
  const mergeResult = await git.mergeBranch(branchName, defaultBranch)

  if (mergeResult.merged) {
    try {
      await git.deleteBranch(branchName)
    }
    catch { /* auto-deleted */ }
  }

  return { config, merged: mergeResult.merged }
})
