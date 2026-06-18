// Explicit relative imports — integration-test harness bypasses Nuxt
// auto-imports (see workspaces/.../media/index.post.ts for rationale).
import type { VariantConfig } from '../../../../../providers/media'
import { fetchRemoteMedia } from '../../../../../utils/media-ingest'
import { resolveMediaApiContext } from '../../../../../utils/media-api'
import { withMediaUrls } from '../../../../../utils/media-url'
import { resolveVariantConfigWithPlan } from '../../../../../utils/media-variants'

/**
 * Upload a media asset. Public media API — `media:write`.
 *
 * Two input modes (modern + AI-friendly):
 *   - `multipart/form-data` with a `file` part (direct binary — local
 *     files via an agent/CI),
 *   - JSON `{ url }` (URL import — agents passing an image URL; the fetch
 *     is SSRF-guarded).
 *
 * Both feed the same validated pipeline: MIME whitelist, plan size cap,
 * atomic storage-quota reservation, variant generation, then R2 + DB.
 */
export default defineEventHandler(async (event) => {
  const ctx = await resolveMediaApiContext(event, {
    scope: 'media:write',
    feature: 'media.upload',
    upgradeKey: 'media.upload_upgrade',
  })

  const maxBytes = getPlanLimit(ctx.plan, 'media.max_file_size_mb') * 1024 * 1024

  let file: Buffer
  let filename: string
  let contentType: string
  let alt: string | undefined
  let tags: string[] | undefined
  let variantInput: string | Record<string, VariantConfig> | undefined
  let source: 'upload' | 'url'

  const reqContentType = getHeader(event, 'content-type') ?? ''
  if (reqContentType.includes('multipart/form-data')) {
    const formData = await readMultipartFormData(event)
    const filePart = formData?.find(p => p.name === 'file')
    if (!filePart?.data || !filePart.filename)
      throw createError({ statusCode: 400, message: errorMessage('media.file_field_required') })

    contentType = (filePart.type ?? 'application/octet-stream').split(';')[0]!.trim()
    if (!isAllowedMimeType(contentType))
      throw createError({ statusCode: 400, message: errorMessage('media.file_type_not_allowed', { type: contentType }) })

    file = Buffer.from(filePart.data)
    if (file.length > maxBytes)
      throw createError({ statusCode: 400, message: errorMessage('media.file_too_large', { limit: Math.round(maxBytes / (1024 * 1024)) }) })

    filename = filePart.filename
    alt = formData?.find(p => p.name === 'alt')?.data?.toString('utf-8')
    const tagsRaw = formData?.find(p => p.name === 'tags')?.data?.toString('utf-8')
    tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : undefined
    const variantsRaw = formData?.find(p => p.name === 'variants')?.data?.toString('utf-8')
    if (variantsRaw) {
      try {
        variantInput = JSON.parse(variantsRaw)
      }
      catch { /* fall back to default variants */ }
    }
    source = 'upload'
  }
  else {
    const body = await readBody<{ url?: string, alt?: string, tags?: string[], variants?: string | Record<string, VariantConfig> }>(event)
    const remote = await fetchRemoteMedia({ url: body.url ?? '', maxBytes })
    file = remote.buffer
    filename = remote.filename
    contentType = remote.contentType
    alt = body.alt
    tags = body.tags
    variantInput = body.variants
    source = 'url'
  }

  const variants = resolveVariantConfigWithPlan(variantInput, {
    hasCustomVariants: hasFeature(ctx.plan, 'media.custom_variants'),
    variantsPerFieldLimit: getPlanLimit(ctx.plan, 'media.variants_per_field'),
  })

  // Atomic storage-quota reservation (mirrors the session upload path).
  const db = useDatabaseProvider()
  const basePlanLimit = getPlanLimit(ctx.plan, 'media.storage_gb') * 1024 * 1024 * 1024
  const storageLimit = getEffectiveLimit(basePlanLimit, 'media.storage_gb', ctx.overageSettings)
  let storageReserved = false
  if (storageLimit > 0) {
    const reservation = await db.reserveStorageIfAllowed(ctx.workspaceId, file.length, storageLimit)
    if (!reservation.allowed)
      throw createError({ statusCode: 403, message: errorMessage('storage.quota_exceeded') })
    storageReserved = true
  }

  try {
    const asset = await ctx.media.upload({
      projectId: ctx.projectId,
      workspaceId: ctx.workspaceId,
      file,
      filename,
      contentType,
      alt,
      tags,
      variants,
      uploadedBy: `cdn-key:${ctx.keyId}`,
      source,
      skipStorageIncrement: storageReserved,
    })

    // Reconcile the reservation to the post-optimization size.
    if (storageReserved) {
      const actualBytes = typeof asset.size === 'number' ? asset.size : 0
      const delta = actualBytes - file.length
      if (delta !== 0)
        await db.incrementWorkspaceStorageBytes(ctx.workspaceId, delta)
    }

    emitWebhookEvent(ctx.projectId, ctx.workspaceId, 'media.uploaded', {
      assetId: asset.id,
      filename: asset.filename,
      contentType: asset.contentType,
    }).catch(() => {})

    setResponseStatus(event, 201)
    return withMediaUrls(ctx.projectId, asset)
  }
  catch (err) {
    if (storageReserved)
      await db.incrementWorkspaceStorageBytes(ctx.workspaceId, -file.length).catch(() => {})
    throw err
  }
})
