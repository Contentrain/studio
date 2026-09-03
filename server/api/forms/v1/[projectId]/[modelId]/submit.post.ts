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

import { getFormConfig, getClientIp, countFormEnabledModels, notifyFormSubmission, resolveProjectDefaultLocale } from '~~/server/utils/form-types'
import { sanitizeData } from '~~/server/utils/sanitize-input'
import { verifyTurnstileToken } from '~~/server/utils/turnstile'
import { getEffectiveLimit } from '~~/server/utils/overage'
import { createContentEngine } from '~~/server/utils/content-engine'
import { generateEntryId } from '@contentrain/types'

export default defineEventHandler(async (event) => {
  const db = useDatabaseProvider()
  // CORS headers for public embedding
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  setResponseHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  setResponseHeader(event, 'Access-Control-Allow-Headers', 'Content-Type')

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

  const workspace = await db.getWorkspaceById(project.workspace_id as string, 'id, name, slug, plan, github_installation_id, overage_settings')

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

    const captchaValid = await verifyTurnstileToken(body.captchaToken, ip)
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

  // Validate against the project's default locale — the locale an approved
  // submission is written to, so validation and the eventual write agree.
  const locale = resolveProjectDefaultLocale(brain)
  const validation = validateContent(filteredData, exposedFields, modelId, locale)
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
  const basePlanLimit = getPlanLimit(plan, 'forms.submissions_per_month')
  const overageSettings = workspace.overage_settings as Record<string, boolean> | null
  const monthlyLimit = getEffectiveLimit(basePlanLimit, 'forms.submissions_per_month', overageSettings)

  // Per-model cap from the form config (below the workspace plan limit).
  const modelCap = formConfig.limits?.maxPerMonth
  if (typeof modelCap === 'number' && modelCap > 0) {
    const used = await db.countMonthlySubmissionsForModel(workspace.id as string, projectId, modelId)
    if (used >= modelCap)
      throw createError({ statusCode: 429, message: errorMessage('forms.model_monthly_limit') })
  }

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
      locale,
    },
  )

  if (!allowed)
    throw createError({ statusCode: 429, message: errorMessage('forms.monthly_limit') })

  if (!submission)
    throw createError({ statusCode: 500, message: errorMessage('forms.submission_failed') })

  // Best-effort meter write for overage billing. Fire-and-forget.
  recordFormSubmissionUsage({
    workspaceId: workspace.id as string,
    submissionId: submission.id as string,
    modelId,
    projectId,
  }).catch(() => {})

  // Auto-approve: create content entry + update submission status
  if (shouldAutoApprove) {
    try {
      const engine = createContentEngine({ git, contentRoot, projectId })
      const entryId = generateEntryId()
      const entryData = { [entryId]: filteredData }
      const writeResult = await engine.saveContent(modelId, locale, entryData, 'form-auto-approve@contentrain.io', { autoPublish: false })

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

  // Notify the workspace owner/admins (fire-and-forget) — the model's
  // `form.notifications` flag defaults on; the plan feature gates it.
  if (formConfig.notifications !== false && hasFeature(plan, 'forms.notifications')) {
    notifyFormSubmission({
      workspaceId: workspace.id as string,
      workspaceName: String(workspace.name ?? ''),
      workspaceSlug: String(workspace.slug ?? workspace.id),
      projectId,
      projectName: repoFullName,
      modelId,
      modelName: String((model as { name?: string }).name ?? modelId),
      data: filteredData,
    }).catch(() => {})
  }

  // Emit webhook event (fire-and-forget) — gated by the
  // `forms.webhook_notification` feature so only plans that grant it
  // (and deployments with the enterprise bridge loaded) dispatch to
  // outbound webhook subscribers. Community Edition and Free plan
  // silently skip; ee/ bridge already no-ops without subscribers, but
  // the explicit gate keeps the intent readable.
  if (hasFeature(plan, 'forms.webhook_notification')) {
    emitWebhookEvent(projectId, workspace.id as string, 'form.submitted', {
      submissionId: submission.id,
      modelId,
      status: shouldAutoApprove ? 'approved' : submission.status,
    }).catch(() => {})
  }

  return {
    success: true,
    message: formConfig.successMessage ?? errorMessage('forms.default_success'),
  }
})
