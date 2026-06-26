// Explicit relative import so ad-hoc test harnesses (which bypass
// Nuxt's auto-import scan) still resolve the symbols.
import { fetchLinkContent, ingestFile } from '../../../../../utils/attachment-ingest'

/**
 * Conversation attachment pre-upload (core / AGPL).
 *
 * Converts user-attached files (multipart) or pasted links (JSON
 * `{ url }` / `{ urls }`) into `AIContentBlock[]` returned as
 * `AttachmentRef[]`. The client then carries those blocks in the chat
 * POST body — keeping the SSE chat handler JSON-only and letting the UI
 * show per-attachment progress/errors. No feature gate on the endpoint
 * itself: text/PDF/link ride the existing chat token metering, and only
 * the image→CDN branch (inside `ingestFile`) is plan-gated, degrading
 * to base64 in Community Edition.
 */

/** Hard ceilings independent of the media plan (text/PDF aren't media). */
const ATTACHMENT_MAX_FILE_BYTES = 32 * 1024 * 1024
const ATTACHMENT_MAX_COUNT = 10

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

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})

  const contentType = (getHeader(event, 'content-type') ?? '').toLowerCase()

  // --- Channel 1: link paste (JSON) ---
  if (contentType.includes('application/json')) {
    const body = await readBody<{ url?: string, urls?: string[] }>(event)
    const urls = (body?.url ? [body.url] : (body?.urls ?? [])).filter(u => typeof u === 'string' && u.trim())
    if (urls.length === 0)
      throw createError({ statusCode: 400, message: errorMessage('attachment.no_url') })
    if (urls.length > ATTACHMENT_MAX_COUNT)
      throw createError({ statusCode: 400, message: errorMessage('attachment.too_many', { limit: ATTACHMENT_MAX_COUNT }) })
    const attachments = await Promise.all(urls.map(u => fetchLinkContent(u)))
    return { attachments }
  }

  // --- Channel 2: file upload (multipart) ---
  const formData = await readMultipartFormData(event)
  const files = (formData ?? []).filter(p => p.name === 'file' && p.filename && p.data)
  if (files.length === 0)
    throw createError({ statusCode: 400, message: errorMessage('media.no_file_provided') })
  if (files.length > ATTACHMENT_MAX_COUNT)
    throw createError({ statusCode: 400, message: errorMessage('attachment.too_many', { limit: ATTACHMENT_MAX_COUNT }) })

  const attachments = await Promise.all(files.map(async (filePart) => {
    if (filePart.data.length > ATTACHMENT_MAX_FILE_BYTES) {
      return {
        id: `att_${filePart.filename}`,
        source: 'upload' as const,
        filename: filePart.filename!,
        mime: filePart.type ?? 'application/octet-stream',
        kind: 'text' as const,
        blocks: [],
        error: errorMessage('media.file_too_large', { limit: Math.round(ATTACHMENT_MAX_FILE_BYTES / (1024 * 1024)) }),
      }
    }
    return ingestFile({
      buffer: Buffer.from(filePart.data),
      filename: filePart.filename!,
      declaredMime: (filePart.type ?? '').split(';')[0]!.trim(),
      projectId,
      workspaceId,
      userId: session.user.id,
      plan,
    })
  }))

  return { attachments }
})
