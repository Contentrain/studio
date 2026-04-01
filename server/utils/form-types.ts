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
  const { generateEntryId } = await import('~~/server/utils/content-serialization')

  const db = useDatabaseProvider()
  const modelId = submission.model_id as string
  const data = submission.data as Record<string, unknown>

  const engine = createContentEngine({ git, contentRoot })
  const entryId = generateEntryId()
  const entryData = { [entryId]: data }

  const writeResult = await engine.saveContent(
    modelId,
    'en',
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
