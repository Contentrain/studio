/**
 * Bulk media operations: delete multiple assets or tag multiple assets.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const client = db.getUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const body = await readBody<{
    action: 'delete' | 'tag'
    assetIds: string[]
    tags?: string[]
  }>(event)

  if (!body.action || !body.assetIds?.length)
    throw createError({ statusCode: 400, message: errorMessage('media.bulk_params_required') })

  if (body.assetIds.length > 50)
    throw createError({ statusCode: 400, message: errorMessage('media.bulk_limit_exceeded') })

  const results: { id: string, success: boolean, error?: string }[] = []

  if (body.action === 'delete') {
    for (const assetId of body.assetIds) {
      try {
        const asset = await media.getAsset(assetId)
        if (!asset || asset.projectId !== projectId) {
          results.push({ id: assetId, success: false, error: 'Not found' })
          continue
        }
        await media.delete(projectId, assetId)
        results.push({ id: assetId, success: true })
      }
      catch (e: unknown) {
        results.push({ id: assetId, success: false, error: e instanceof Error ? e.message : 'Failed' })
      }
    }
  }
  else if (body.action === 'tag') {
    if (!body.tags?.length)
      throw createError({ statusCode: 400, message: errorMessage('media.bulk_tags_required') })

    for (const assetId of body.assetIds) {
      try {
        const asset = await media.getAsset(assetId)
        if (!asset || asset.projectId !== projectId) {
          results.push({ id: assetId, success: false, error: 'Not found' })
          continue
        }
        const merged = [...new Set([...asset.tags, ...body.tags])]
        await media.updateMetadata(assetId, { tags: merged })
        results.push({ id: assetId, success: true })
      }
      catch (e: unknown) {
        results.push({ id: assetId, success: false, error: e instanceof Error ? e.message : 'Failed' })
      }
    }
  }
  else {
    throw createError({ statusCode: 400, message: errorMessage('media.bulk_unknown_action', { action: body.action }) })
  }

  return { results }
})
