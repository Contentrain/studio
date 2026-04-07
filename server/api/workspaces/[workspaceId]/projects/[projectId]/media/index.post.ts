/**
 * Upload a media asset.
 * Accepts multipart/form-data with file + optional alt/tags.
 * Processes: validate → optimize → blurhash → variants → R2 → DB → git sync.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, session.user.id)
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  const ws = await db.getWorkspaceById(workspaceId, 'plan, media_storage_bytes')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'media.upload'))
    throw createError({ statusCode: 403, message: errorMessage('media.upload_upgrade', getUpgradeParams(plan)) })

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  // Parse multipart
  const formData = await readMultipartFormData(event)
  if (!formData?.length)
    throw createError({ statusCode: 400, message: errorMessage('media.no_file_provided') })

  const filePart = formData.find(p => p.name === 'file')
  if (!filePart?.data || !filePart.filename)
    throw createError({ statusCode: 400, message: errorMessage('media.file_field_required') })

  const contentType = filePart.type ?? 'application/octet-stream'

  // MIME whitelist
  if (!isAllowedMimeType(contentType))
    throw createError({ statusCode: 400, message: errorMessage('media.file_type_not_allowed', { type: contentType }) })

  // Size limit
  const maxSizeMb = getPlanLimit(plan, 'media.max_file_size_mb')
  if (filePart.data.length > maxSizeMb * 1024 * 1024)
    throw createError({ statusCode: 400, message: errorMessage('media.file_too_large', { limit: maxSizeMb }) })

  // Atomic storage quota check + reservation (prevents race condition on concurrent uploads)
  // When overage is enabled, the effective limit is raised so uploads aren't blocked.
  const basePlanLimit = getPlanLimit(plan, 'media.storage_gb') * 1024 * 1024 * 1024
  const overageSettings = event.context.billing?.overageSettings as Record<string, boolean> | undefined
  const storageLimit = getEffectiveLimit(basePlanLimit, 'media.storage_gb', overageSettings)
  const reserveBytes = filePart.data.length
  let storageReserved = false

  if (storageLimit > 0) {
    const reservation = await db.reserveStorageIfAllowed(workspaceId, reserveBytes, storageLimit)
    if (!reservation.allowed)
      throw createError({ statusCode: 403, message: errorMessage('storage.quota_exceeded') })
    storageReserved = true
  }

  // Extract form fields
  const altPart = formData.find(p => p.name === 'alt')
  const tagsPart = formData.find(p => p.name === 'tags')

  // Resolve variant config from target field
  const variantsPart = formData.find(p => p.name === 'variants')
  let variants: Record<string, import('~~/server/providers/media').VariantConfig> = {}
  if (variantsPart?.data) {
    try {
      const parsed = JSON.parse(variantsPart.data.toString('utf-8'))
      if (typeof parsed === 'string') {
        variants = resolveVariantConfig(parsed)
      }
      else {
        variants = parsed
      }
    }
    catch { /* use default */ }
  }
  if (Object.keys(variants).length === 0) {
    variants = resolveVariantConfig(undefined)
  }

  try {
    const asset = await media.upload({
      projectId,
      workspaceId,
      file: Buffer.from(filePart.data),
      filename: filePart.filename,
      contentType,
      alt: altPart?.data?.toString('utf-8'),
      tags: tagsPart?.data ? tagsPart.data.toString('utf-8').split(',').map(t => t.trim()).filter(Boolean) : [],
      variants,
      uploadedBy: session.user.id,
      source: 'upload',
      skipStorageIncrement: storageReserved,
    })

    // Adjust reservation to actual bytes (optimization may change size)
    if (storageReserved) {
      const actualBytes = typeof asset.size === 'number' ? asset.size : 0
      const delta = actualBytes - reserveBytes
      if (delta !== 0) {
        await db.incrementWorkspaceStorageBytes(workspaceId, delta)
      }
    }

    // Emit webhook event (fire-and-forget)
    emitWebhookEvent(projectId, workspaceId, 'media.uploaded', {
      assetId: asset.id,
      filename: asset.filename,
      contentType: asset.contentType,
    }).catch(() => {})

    setResponseStatus(event, 201)
    return asset
  }
  catch (e) {
    // Release reservation on upload failure
    if (storageReserved) {
      await db.incrementWorkspaceStorageBytes(workspaceId, -reserveBytes).catch(() => {})
    }
    throw e
  }
})
