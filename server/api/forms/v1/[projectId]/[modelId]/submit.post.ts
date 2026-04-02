/**
 * Public form submission endpoint — accepts form data from external sites.
 *
 * Auth: NONE (public endpoint)
 * Rate limit: per-IP sliding window
 * Plan: requires forms.enabled feature + forms.models limit
 * Security: honeypot, captcha (Turnstile), field validation, HTML sanitization
 * Auto-approve: if configured + plan supports, creates content entry on submit
 *
 * POST /api/forms/v1/{projectId}/{modelId}/submit
 */

import { getFormConfig, getClientIp, countFormEnabledModels } from '~~/server/utils/form-types'
import { createContentEngine } from '~~/server/utils/content-engine'
import { generateEntryId } from '~~/server/utils/content-serialization'

/**
 * Verify Cloudflare Turnstile captcha token.
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
async function verifyCaptcha(token: string, secret: string): Promise<boolean> {
  if (!secret) return false

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }),
    })
    const result = await response.json() as { success: boolean }
    return result.success === true
  }
  catch {
    return false
  }
}

/**
 * Sanitize string — strip HTML tags and decode common entities.
 * Prevents stored XSS even though data is JSON-stored.
 */
function sanitizeString(value: string): string {
  let s = value
  // 1. Strip HTML tags first (before any entity decoding)
  s = s.replace(/<[^>]*>/g, '')
  // 2. Remove dangerous patterns
  s = s.replace(/javascript:/gi, '')
  s = s.replace(/on\w+\s*=/gi, '')
  // 3. Decode entities that might hide tags, then strip again
  s = s.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  s = s.replace(/&#x3[cC];/g, '<').replace(/&#x3[eE];/g, '>')
  s = s.replace(/&#60;/g, '<').replace(/&#62;/g, '>')
  s = s.replace(/<[^>]*>/g, '')
  // 4. Final pass for any remaining dangerous patterns
  s = s.replace(/javascript:/gi, '')
  s = s.replace(/on\w+\s*=/gi, '')
  return s
}

/**
 * Recursively sanitize all string values in an object.
 */
function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value)
    }
    else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'string'
          ? sanitizeString(item)
          : (item && typeof item === 'object' && !Array.isArray(item))
              ? sanitizeData(item as Record<string, unknown>)
              : item,
      )
    }
    else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeData(value as Record<string, unknown>)
    }
    else {
      sanitized[key] = value
    }
  }

  return sanitized
}

export default defineEventHandler(async (event) => {
  const db = useDatabaseProvider()
  // CORS headers for public embedding
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  setResponseHeader(event, 'Access-Control-Allow-Headers', 'Content-Type')

  // Handle OPTIONS preflight
  if (getMethod(event) === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }

  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')

  if (!projectId || !modelId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  // Extract IP — trust last hop, not client-supplied
  const ip = getClientIp(event)

  // Read body early so we can fail fast on missing data
  const body = await readBody<{
    data?: Record<string, unknown>
    captchaToken?: string
    _hp?: string
  }>(event)

  if (!body?.data || typeof body.data !== 'object')
    throw createError({ statusCode: 400, message: errorMessage('forms.data_required') })

  // Lookup project → workspace → plan (admin-level — public endpoint, no session)
  const project = await db.getProjectById(projectId, 'id, workspace_id, repo_full_name, content_root')

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('forms.not_found') })

  const workspace = await db.getWorkspaceById(project.workspace_id as string, 'id, plan, github_installation_id')

  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('forms.not_found') })

  // Plan check
  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, 'forms.enabled'))
    throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })

  // Build brain cache to get model definition
  if (!workspace.github_installation_id)
    throw createError({ statusCode: 404, message: errorMessage('forms.not_found') })

  const repoFullName = String(project.repo_full_name)
  const [owner = '', repo = ''] = repoFullName.split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id as number,
    owner,
    repo,
  })
  const contentRoot = normalizeContentRoot(project.content_root as string)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)

  // Get model definition
  const model = brain.models.get(modelId)
  if (!model)
    throw createError({ statusCode: 404, message: errorMessage('forms.model_not_found') })

  // Check form config exists and is enabled + public
  const formConfig = getFormConfig(model)
  if (!formConfig?.enabled || !formConfig?.public)
    throw createError({ statusCode: 404, message: errorMessage('forms.form_disabled') })

  // Enforce forms.models plan limit
  const formsModelLimit = getPlanLimit(plan, 'forms.models')
  const enabledCount = countFormEnabledModels(brain.models)
  if (enabledCount > formsModelLimit) {
    const enabledIds = [...brain.models.entries()]
      .filter(([, m]) => getFormConfig(m)?.enabled)
      .map(([id]) => id)
      .sort()
    const allowedIds = new Set(enabledIds.slice(0, formsModelLimit))
    if (!allowedIds.has(modelId))
      throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })
  }

  // Rate limit per IP + model (uses form config limit or default 10/min)
  const rateLimitPerIp = formConfig.limits?.rateLimitPerIp ?? 10
  const rateCheck = await checkRateLimit(`form:${ip}:${modelId}`, rateLimitPerIp, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('forms.rate_limited') })

  // Honeypot check — silent reject (return 200 to fool bots)
  if (formConfig.honeypot && body._hp) {
    return { success: true, message: formConfig.successMessage ?? errorMessage('forms.default_success') }
  }

  // Captcha verification (Pro+)
  if (hasFeature(plan, 'forms.captcha') && formConfig.captcha === 'turnstile') {
    if (!body.captchaToken) {
      return { success: false, errors: [{ field: 'captcha', message: errorMessage('forms.captcha_failed') }] }
    }

    const config = useRuntimeConfig()
    const captchaSecret = (config as unknown as { turnstile?: { secretKey?: string } }).turnstile?.secretKey ?? ''
    const captchaValid = await verifyCaptcha(body.captchaToken, captchaSecret)
    if (!captchaValid) {
      return { success: false, errors: [{ field: 'captcha', message: errorMessage('forms.captcha_failed') }] }
    }
  }

  // Filter model fields to exposed fields only
  const allFields = model.fields ?? {}
  const exposedFieldIds = new Set(formConfig.exposedFields ?? [])
  const exposedFields: Record<string, import('@contentrain/types').FieldDef> = {}

  for (const [fieldId, fieldDef] of Object.entries(allFields)) {
    if (exposedFieldIds.has(fieldId)) {
      exposedFields[fieldId] = { ...fieldDef }
    }
  }

  // Apply required overrides if configured
  if (formConfig.requiredOverrides) {
    for (const [fieldId, isRequired] of Object.entries(formConfig.requiredOverrides)) {
      if (exposedFields[fieldId]) {
        exposedFields[fieldId].required = isRequired
      }
    }
  }

  // Sanitize all string values in submission data (strip HTML + entities + JS)
  const sanitizedData = sanitizeData(body.data)

  // Only keep exposed fields from submitted data
  const filteredData: Record<string, unknown> = {}
  for (const fieldId of Object.keys(exposedFields)) {
    if (fieldId in sanitizedData) {
      filteredData[fieldId] = sanitizedData[fieldId]
    }
  }

  // Validate using content validation (exposed fields only)
  const validation = validateContent(filteredData, exposedFields, modelId, 'en')
  if (!validation.valid) {
    return {
      success: false,
      errors: validation.errors.map(e => ({
        field: e.field,
        message: e.message,
      })),
    }
  }

  // Determine auto-approve: config flag + plan feature
  const shouldAutoApprove = formConfig.autoApprove === true
    && hasFeature(plan, 'forms.auto_approve')

  // Atomic: check monthly limit + insert submission (prevents race conditions)
  const userAgent = getHeader(event, 'user-agent') ?? null
  const referrer = getHeader(event, 'referer') ?? getHeader(event, 'referrer') ?? null
  const monthlyLimit = getPlanLimit(plan, 'forms.submissions_per_month')

  const { allowed, submission } = await db.createFormSubmissionIfAllowed(
    workspace.id as string,
    monthlyLimit,
    {
      project_id: projectId,
      workspace_id: workspace.id as string,
      model_id: modelId,
      data: filteredData,
      source_ip: ip !== 'unknown' ? ip : undefined,
      user_agent: userAgent ?? undefined,
      referrer: referrer ?? undefined,
    },
  )

  if (!allowed)
    throw createError({ statusCode: 429, message: errorMessage('forms.monthly_limit') })

  if (!submission)
    throw createError({ statusCode: 500, message: errorMessage('forms.submission_failed') })

  // Auto-approve: create content entry + update submission status
  if (shouldAutoApprove) {
    try {
      const engine = createContentEngine({ git, contentRoot, projectId })
      const entryId = generateEntryId()
      const entryData = { [entryId]: filteredData }
      const writeResult = await engine.saveContent(modelId, 'en', entryData, 'form-auto-approve@contentrain.io', { autoPublish: false })

      // Auto-merge the content branch (form submissions go straight through)
      if (writeResult.branch) {
        await engine.mergeBranch(writeResult.branch).catch(() => {})
        invalidateBrainCache(projectId)
      }

      // Mark submission as approved with entry_id
      await db.updateFormSubmissionStatus(submission.id as string, 'approved', undefined, entryId)
    }
    catch {
      // Auto-approve failed — submission stays pending, no user-facing error
    }
  }

  // Emit webhook event (fire-and-forget)
  emitWebhookEvent(projectId, workspace.id as string, 'form.submitted', {
    submissionId: submission.id,
    modelId,
    status: shouldAutoApprove ? 'approved' : submission.status,
  }).catch(() => {})

  return {
    success: true,
    message: formConfig.successMessage ?? errorMessage('forms.default_success'),
  }
})
