/**
 * Import a media asset from an external URL.
 * Fetches the file server-side, then processes through the same pipeline as direct upload.
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

  const body = await readBody<{
    url: string
    alt?: string
    tags?: string[]
    variants?: string | Record<string, unknown>
  }>(event)

  if (!body.url?.trim())
    throw createError({ statusCode: 400, message: 'url is required' })

  // Fetch the URL server-side
  let response: Response
  try {
    response = await fetch(body.url, {
      headers: { 'User-Agent': 'Contentrain-Studio/1.0' },
      signal: AbortSignal.timeout(30_000),
    })
  }
  catch {
    throw createError({ statusCode: 400, message: 'Failed to fetch URL' })
  }

  if (!response.ok)
    throw createError({ statusCode: 400, message: `URL returned ${response.status}` })

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
  if (!isAllowedMimeType(contentType.split(';')[0]!.trim()))
    throw createError({ statusCode: 400, message: `File type not allowed: ${contentType}` })

  const buffer = Buffer.from(await response.arrayBuffer())

  // Size limit
  const maxSizeMb = getPlanLimit(plan, 'media.max_file_size_mb')
  if (buffer.length > maxSizeMb * 1024 * 1024)
    throw createError({ statusCode: 400, message: `File exceeds ${maxSizeMb}MB limit` })

  // Extract filename from URL
  const urlPath = new URL(body.url).pathname
  const filename = urlPath.split('/').pop() ?? 'imported-file'

  // Resolve variants
  let variants: Record<string, import('~/server/providers/media').VariantConfig>
  if (body.variants && typeof body.variants === 'string') {
    variants = resolveVariantConfig(body.variants)
  }
  else if (body.variants && typeof body.variants === 'object') {
    variants = body.variants as Record<string, import('~/server/providers/media').VariantConfig>
  }
  else {
    variants = resolveVariantConfig(undefined)
  }

  const asset = await media.upload({
    projectId,
    workspaceId,
    file: buffer,
    filename,
    contentType: contentType.split(';')[0]!.trim(),
    alt: body.alt,
    tags: body.tags,
    variants,
    uploadedBy: session.user.id,
    source: 'url',
  })

  setResponseStatus(event, 201)
  return asset
})
