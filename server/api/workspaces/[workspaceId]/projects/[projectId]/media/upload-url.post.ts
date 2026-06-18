// Explicit relative imports — see media/index.post.ts for rationale.
import { resolveVariantConfigWithPlan } from '../../../../../../utils/media-variants'
import { fetchRemoteMedia } from '../../../../../../utils/media-ingest'

/**
 * Import a media asset from an external URL.
 * Fetches the file server-side, then processes through the same pipeline as direct upload.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')

  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin', 'member'])

  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId)
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  if (role === 'member') {
    const pm = await db.getProjectMember(projectId, session.user.id)
    if (!pm) throw createError({ statusCode: 403, message: errorMessage('project.access_denied') })
  }

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  if (!hasFeature(plan, 'media.upload'))
    throw createError({ statusCode: 403, message: errorMessage('media.upload_upgrade', getUpgradeParams(plan)) })

  const media = useMediaProvider()
  if (!media)
    throw createError({ statusCode: 503, message: errorMessage('media.storage_not_configured') })

  const body = await readBody<{
    url: string
    alt?: string
    tags?: string[]
    variants?: string | Record<string, unknown>
  }>(event)

  // Fetch + validate the remote file in one place: SSRF-guarded, MIME
  // whitelist + plan size cap enforced, filename normalised.
  const maxSizeMb = getPlanLimit(plan, 'media.max_file_size_mb')
  const { buffer, filename, contentType } = await fetchRemoteMedia({
    url: body.url ?? '',
    maxBytes: maxSizeMb * 1024 * 1024,
  })

  // Resolve variants with plan enforcement — see media/index.post.ts
  // for the rationale on `hasCustomVariants` + `variantsPerFieldLimit`.
  const variants = resolveVariantConfigWithPlan(
    body.variants as string | Record<string, import('~~/server/providers/media').VariantConfig> | undefined,
    {
      hasCustomVariants: hasFeature(plan, 'media.custom_variants'),
      variantsPerFieldLimit: getPlanLimit(plan, 'media.variants_per_field'),
    },
  )

  const asset = await media.upload({
    projectId,
    workspaceId,
    file: buffer,
    filename,
    contentType,
    alt: body.alt,
    tags: body.tags,
    variants,
    uploadedBy: session.user.id,
    source: 'url',
  })

  setResponseStatus(event, 201)
  return asset
})
