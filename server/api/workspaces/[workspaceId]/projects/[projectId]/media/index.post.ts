/**
 * Upload a media asset.
 * Accepts multipart/form-data with file + optional alt/tags.
 * Processes: validate → optimize → blurhash → variants → R2 → DB → git sync.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: 'workspaceId and projectId are required' })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const plan = getWorkspacePlan(await getWorkspace(client, workspaceId))
  if (!hasFeature(plan, 'media.upload'))
    throw createError({ statusCode: 403, message: 'Media upload requires Pro plan or higher' })

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: 'Media storage not configured' })

  // Parse multipart
  const formData = await readMultipartFormData(event)
  if (!formData?.length)
    throw createError({ statusCode: 400, message: 'No file provided' })

  const filePart = formData.find(p => p.name === 'file')
  if (!filePart?.data || !filePart.filename)
    throw createError({ statusCode: 400, message: 'File field is required' })

  const contentType = filePart.type ?? 'application/octet-stream'

  // MIME whitelist
  if (!isAllowedMimeType(contentType))
    throw createError({ statusCode: 400, message: `File type not allowed: ${contentType}` })

  // Size limit
  const maxSizeMb = getPlanLimit(plan, 'media.max_file_size_mb')
  if (filePart.data.length > maxSizeMb * 1024 * 1024)
    throw createError({ statusCode: 400, message: `File exceeds ${maxSizeMb}MB limit` })

  // Storage quota
  const admin = useSupabaseAdmin()
  const { data: ws } = await admin
    .from('workspaces')
    .select('media_storage_bytes')
    .eq('id', workspaceId)
    .single()

  const storageLimit = getPlanLimit(plan, 'media.storage_gb') * 1024 * 1024 * 1024
  const currentUsage = (ws as { media_storage_bytes: number } | null)?.media_storage_bytes ?? 0
  if (storageLimit > 0 && currentUsage + filePart.data.length > storageLimit)
    throw createError({ statusCode: 403, message: 'Storage quota exceeded' })

  // Extract form fields
  const altPart = formData.find(p => p.name === 'alt')
  const tagsPart = formData.find(p => p.name === 'tags')

  // Resolve variant config from target field
  const variantsPart = formData.find(p => p.name === 'variants')
  let variants: Record<string, import('~/server/providers/media').VariantConfig> = {}
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
  })

  setResponseStatus(event, 201)
  return asset
})
