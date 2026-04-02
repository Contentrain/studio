/**
 * Create a new CDN API key. Returns the full key ONCE — never shown again.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const body = await readBody<{ name: string }>(event)

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  if (!body.name?.trim())
    throw createError({ statusCode: 400, message: errorMessage('cdn.key_name_required') })

  // Role + plan check
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const workspace = await db.getWorkspaceById(workspaceId, 'plan')

  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace ?? {})
  if (!hasFeature(plan, 'cdn.delivery'))
    throw createError({ statusCode: 403, message: errorMessage('cdn.upgrade', getUpgradeParams(plan)) })

  // Check key limit
  const keyLimit = getPlanLimit(plan, 'cdn.api_keys')
  const activeKeyCount = await db.countActiveCDNKeys(projectId)

  if (activeKeyCount >= keyLimit)
    throw createError({ statusCode: 403, message: errorMessage('cdn.key_limit_reached', { limit: keyLimit }) })

  // Generate key
  const { key, keyHash, keyPrefix } = generateCDNKey()

  const data = await db.createCDNKey({
    projectId,
    workspaceId,
    keyHash,
    keyPrefix,
    name: body.name.trim(),
  })

  // Return the FULL key — this is the only time it's shown
  return { ...data, key }
})
