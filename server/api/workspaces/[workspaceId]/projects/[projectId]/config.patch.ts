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
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  // Only owner/admin can change project config
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (permissions.workspaceRole !== 'owner' && permissions.workspaceRole !== 'admin')
    throw createError({ statusCode: 403, message: errorMessage('project.settings_owner_only') })

  const client = useSupabaseUserClient(session.accessToken)
  const { git, contentRoot, workspace } = await resolveProjectContext(client, workspaceId, projectId)
  const plan = getWorkspacePlan(workspace)

  // Plan gate: review workflow requires Pro+
  if (body.workflow === 'review' && !hasFeature(plan, 'workflow.review'))
    throw createError({ statusCode: 403, message: errorMessage('project.review_workflow_upgrade') })

  const configPath = contentRoot ? `${contentRoot}/.contentrain/config.json` : '.contentrain/config.json'

  // Read current config
  let config: ContentrainConfig
  try {
    config = JSON.parse(await git.readFile(configPath)) as ContentrainConfig
  }
  catch {
    throw createError({ statusCode: 404, message: errorMessage('project.config_not_found') })
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
    [{ path: configPath, content: `${JSON.stringify(config, null, 2)}\n` }],
    `contentrain: update project config\n\nChanged: ${Object.keys(body).join(', ')}`,
    { name: 'Contentrain Studio[bot]', email: 'bot@contentrain.io' },
  )

  // Use content engine merge (has PR fallback for protected branches)
  const engine = createContentEngine({ git, contentRoot })
  const mergeResult = await engine.mergeBranch(branchName)

  return { config, merged: mergeResult.merged, pullRequestUrl: mergeResult.pullRequestUrl }
})
