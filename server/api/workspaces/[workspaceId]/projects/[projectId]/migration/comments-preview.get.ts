/**
 * A look at the old site's comments before they are imported (the setup's comments step): up to two approved
 * top-level comments, author and a short plain-text excerpt, plus the count. Read only from the export the Migrate grant
 * already holds (migration 040); nothing is fetched for a preview, so without a held export the answer is the count
 * alone (`rows: []`) and the step shows the count line.
 *
 * Owner/admin only, as the import itself.
 *
 * GET /api/workspaces/{workspaceId}/projects/{projectId}/migration/comments-preview
 *   → 200 { total: number | null, rows: { author: string, excerpt: string }[] }
 */
import type { CommentsExport } from '@contentrain/types'

const PREVIEW_ROWS = 2
const EXCERPT_CHARS = 140

function excerptOf(html: string): string {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : text
}

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id, repo_full_name')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const repoFullName = typeof project.repo_full_name === 'string' ? project.repo_full_name : ''
  const held = repoFullName ? await db.getMigrateCommentsExport(workspaceId, repoFullName, { withPayload: true }) : null
  if (held?.status !== 'ready') return { total: held ? held.comments : null, rows: [] }
  const comments = (held.payload as Partial<CommentsExport> | null)?.comments
  const rows = (Array.isArray(comments) ? comments : [])
    // Only what the site showed: approved, top level, with words in it.
    .filter(c => (c.approved === undefined || c.approved === '1') && !c.parent && typeof c.author === 'string' && typeof c.content === 'string')
    .map(c => ({ author: c.author.trim(), excerpt: excerptOf(c.content) }))
    .filter(r => r.author && r.excerpt)
    .slice(0, PREVIEW_ROWS)
  return { total: held.comments, rows }
})
