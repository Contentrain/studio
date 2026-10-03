import { escapeHtml } from './email-layout'

const EXCERPT_LENGTH = 400

/**
 * Email the workspace owner + admins about a new public comment. Best-effort
 * and fire-and-forget: a mail failure never affects the public submit
 * response. The caller gates it on the model's `comments.notifications`
 * flag (default on). A pending comment asks for review; an auto-approved one
 * is already live and says so.
 */
export async function notifyCommentSubmitted(input: {
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  projectId: string
  projectName: string
  modelId: string
  entryId: string
  status: 'pending' | 'approved'
  authorName: string
  body: string
}): Promise<void> {
  const email = useEmailProvider()
  if (!email) return

  const db = useDatabaseProvider()
  const recipients = await db.listWorkspaceNotificationRecipients(input.workspaceId)
  if (recipients.length === 0) return

  const config = useRuntimeConfig()
  const excerpt = input.body.length > EXCERPT_LENGTH ? `${input.body.slice(0, EXCERPT_LENGTH).trimEnd()}…` : input.body

  const tpl = emailTemplate(input.status === 'pending' ? 'comment-pending' : 'comment-published', {
    workspaceName: escapeHtml(input.workspaceName),
    projectName: escapeHtml(input.projectName),
    modelName: escapeHtml(input.modelId),
    entryId: escapeHtml(input.entryId),
    authorName: escapeHtml(input.authorName),
    excerptHtml: escapeHtml(excerpt),
    moderationUrl: `${config.public.siteUrl}/w/${input.workspaceSlug}/projects/${input.projectId}`,
  })

  await Promise.all(recipients.map(r => email.sendEmail({ to: r.email, subject: tpl.subject, html: tpl.body }).catch(() => {})))
}
