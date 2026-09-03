import type { H3Event } from 'h3'
import type { DatabaseRow } from '~~/server/providers/database'
import type { GitProvider } from '~~/server/providers/git'

/**
 * Shared form configuration type — used by public endpoints and internal utilities.
 * Stored on model definitions under `form` property.
 */
export interface FormConfig {
  enabled: boolean
  public: boolean
  exposedFields: string[]
  requiredOverrides?: Record<string, boolean>
  honeypot?: boolean
  captcha?: 'turnstile' | null
  successMessage?: string
  limits?: { rateLimitPerIp?: number, maxPerMonth?: number }
  autoApprove?: boolean
  /** Email the workspace owner/admins on every submission (default true; needs `forms.notifications`). */
  notifications?: boolean
}

/**
 * Extract FormConfig from a model definition (loosely typed from brain cache).
 */
export function getFormConfig(model: unknown): FormConfig | undefined {
  return (model as { form?: FormConfig })?.form
}

/**
 * Extract client IP — trust only the last hop from X-Forwarded-For
 * (the one appended by the reverse proxy, not the client-supplied ones).
 * Falls back to cf-connecting-ip, x-real-ip, or 'unknown'.
 */
export function getClientIp(event: H3Event): string {
  const xff = getHeader(event, 'x-forwarded-for')
  if (xff) {
    const parts = xff.split(',').map(s => s.trim())
    return parts[parts.length - 1] ?? 'unknown'
  }
  return getHeader(event, 'x-real-ip')
    ?? getHeader(event, 'cf-connecting-ip')
    ?? 'unknown'
}

/**
 * The project's default locale from `.contentrain/config.json` — the locale a
 * form submission is validated against and, on approve, written to.
 */
export function resolveProjectDefaultLocale(brain: { config?: { locales?: { default?: string } } | null } | null | undefined): string {
  const value = brain?.config?.locales?.default
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value) ? value : 'en'
}

/** Short, escaped field summary for a notification email (first few string values). */
export function summarizeSubmissionData(data: Record<string, unknown>, max = 6): Array<{ field: string, value: string }> {
  const rows: Array<{ field: string, value: string }> = []
  for (const [field, raw] of Object.entries(data)) {
    if (rows.length >= max) break
    let value: string
    if (raw === null || raw === undefined || raw === '') continue
    else if (typeof raw === 'string') value = raw
    else if (typeof raw === 'number' || typeof raw === 'boolean') value = String(raw)
    else value = JSON.stringify(raw)
    value = value.replace(/\s+/g, ' ').trim()
    if (value.length > 160) value = `${value.slice(0, 160)}…`
    rows.push({ field, value })
  }
  return rows
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Email the workspace owner + admins about a new submission. Best-effort and
 * fire-and-forget: a mail failure never affects the public submit response.
 * Gated by the `forms.notifications` plan feature and the model's
 * `form.notifications` flag (default on) by the caller.
 */
export async function notifyFormSubmission(input: {
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  projectId: string
  projectName: string
  modelId: string
  modelName: string
  data: Record<string, unknown>
}): Promise<void> {
  const email = useEmailProvider()
  if (!email) return

  const db = useDatabaseProvider()
  const recipients = await db.listWorkspaceNotificationRecipients(input.workspaceId)
  if (recipients.length === 0) return

  const config = useRuntimeConfig()
  const submissionsUrl = `${config.public.siteUrl}/w/${input.workspaceSlug}/projects/${input.projectId}`
  const rows = summarizeSubmissionData(input.data)
  const summaryHtml = rows.length > 0
    ? `<table>${rows.map(r => `<tr><td><strong>${escapeHtml(r.field)}</strong></td><td>${escapeHtml(r.value)}</td></tr>`).join('')}</table>`
    : ''

  const tpl = emailTemplate('form-submitted', {
    workspaceName: input.workspaceName,
    projectName: input.projectName,
    modelName: input.modelName,
    summaryHtml,
    submissionsUrl,
  })

  await Promise.all(recipients.map(r => email.sendEmail({ to: r.email, subject: tpl.subject, html: tpl.body }).catch(() => {})))
}

/**
 * Count how many models in a brain cache have form.enabled = true.
 * Used to enforce forms.models plan limit.
 */
export function countFormEnabledModels(models: Map<string, unknown>): number {
  let count = 0
  for (const model of models.values()) {
    const form = getFormConfig(model)
    if (form?.enabled) count++
  }
  return count
}

/**
 * Approve a form submission → create content entry in Git.
 *
 * Shared by: PATCH endpoint, bulk endpoint, conversation engine approve.
 * Creates a draft entry in the model's collection, merges the branch,
 * and updates the submission record with entry_id.
 *
 * Returns the generated entry ID, or null if content creation failed.
 */
export async function approveSubmissionAsContent(
  submission: DatabaseRow,
  git: GitProvider,
  contentRoot: string,
  projectId: string,
  approvedBy?: string,
): Promise<string | null> {
  const { createContentEngine } = await import('~~/server/utils/content-engine')
  const { generateEntryId } = await import('@contentrain/types')

  const db = useDatabaseProvider()
  const modelId = submission.model_id as string
  const data = submission.data as Record<string, unknown>

  const engine = createContentEngine({ git, contentRoot, projectId })
  const entryId = generateEntryId()
  const entryData = { [entryId]: data }

  // The submission carries the locale it was validated against (the project
  // default at submit time); a legacy row without one falls back to `en`.
  const locale = typeof submission.locale === 'string' && submission.locale ? submission.locale : 'en'
  const writeResult = await engine.saveContent(
    modelId,
    locale,
    entryData,
    'form-submission@contentrain.io',
    { autoPublish: false },
  )

  // Auto-merge the content branch
  if (writeResult.branch) {
    await engine.mergeBranch(writeResult.branch).catch(() => {})
    invalidateBrainCache(projectId)
  }

  // Update submission status with entry_id
  await db.updateFormSubmissionStatus(
    submission.id as string,
    'approved',
    approvedBy,
    entryId,
  )

  return entryId
}
