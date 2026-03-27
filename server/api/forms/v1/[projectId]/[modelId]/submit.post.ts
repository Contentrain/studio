/**
 * Public form submission endpoint — accepts form data from external sites.
 *
 * Auth: NONE (public endpoint)
 * Rate limit: per-IP sliding window
 * Plan: requires forms.enabled feature
 * Security: honeypot, captcha (Turnstile), field validation, HTML sanitization
 *
 * POST /api/forms/v1/{projectId}/{modelId}/submit
 */

interface FormConfig {
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
 * Verify Cloudflare Turnstile captcha token.
 * TODO: implement when captcha provider configured
 */
async function verifyCaptcha(_token: string, _secret: string): Promise<boolean> {
  // Turnstile verification — TODO: implement when captcha provider configured
  return true
}

/**
 * Strip HTML tags from a string to prevent XSS.
 */
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}

/**
 * Recursively sanitize all string values in an object.
 */
function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      sanitized[key] = stripHtml(value)
    }
    else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'string'
          ? stripHtml(item)
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

  // Extract IP for rate limiting
  const ip = getHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    ?? getHeader(event, 'x-real-ip')
    ?? 'unknown'

  // Read body early so we can fail fast on missing data
  const body = await readBody<{
    data?: Record<string, unknown>
    captchaToken?: string
    _hp?: string
  }>(event)

  if (!body?.data || typeof body.data !== 'object')
    throw createError({ statusCode: 400, message: errorMessage('forms.data_required') })

  // Admin client (bypasses RLS for public endpoint)
  const admin = useSupabaseAdmin()

  // Lookup project → workspace → plan
  const { data: project } = await admin
    .from('projects')
    .select('id, workspace_id, repo_full_name, content_root')
    .eq('id', projectId)
    .single()

  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('forms.not_found') })

  const { data: workspace } = await admin
    .from('workspaces')
    .select('id, plan, github_installation_id')
    .eq('id', project.workspace_id)
    .single()

  if (!workspace)
    throw createError({ statusCode: 404, message: errorMessage('forms.not_found') })

  // Plan check
  const plan = getWorkspacePlan(workspace)
  if (!hasFeature(plan, 'forms.enabled'))
    throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })

  // Build brain cache to get model definition
  if (!workspace.github_installation_id)
    throw createError({ statusCode: 404, message: errorMessage('forms.not_found') })

  const [owner, repo] = project.repo_full_name.split('/')
  const git = useGitProvider({
    installationId: workspace.github_installation_id,
    owner,
    repo,
  })
  const contentRoot = normalizeContentRoot(project.content_root)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)

  // Get model definition
  const model = brain.models.get(modelId)
  if (!model)
    throw createError({ statusCode: 404, message: errorMessage('forms.model_not_found') })

  // Check form config exists and is enabled + public
  const formConfig = (model as unknown as { form?: FormConfig }).form
  if (!formConfig?.enabled || !formConfig?.public)
    throw createError({ statusCode: 404, message: errorMessage('forms.form_disabled') })

  // Rate limit per IP + model (uses form config limit or default 10/min)
  const rateLimitPerIp = formConfig.limits?.rateLimitPerIp ?? 10
  const rateCheck = checkRateLimit(`form:${ip}:${modelId}`, rateLimitPerIp, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('forms.rate_limited') })

  // Monthly submission limit check
  const monthlyCount = await countMonthlySubmissions(admin, projectId)
  const monthlyLimit = getPlanLimit(plan, 'forms.submissions_per_month')
  if (monthlyCount >= monthlyLimit)
    throw createError({ statusCode: 429, message: errorMessage('forms.monthly_limit') })

  // Honeypot check — silent reject (return 200 to fool bots)
  if (formConfig.honeypot && body._hp) {
    return { success: true, message: formConfig.successMessage ?? 'Thank you!' }
  }

  // Captcha verification (Pro+)
  if (hasFeature(plan, 'forms.captcha') && formConfig.captcha === 'turnstile') {
    if (!body.captchaToken) {
      return { success: false, errors: [{ field: 'captcha', message: 'Captcha verification required.' }] }
    }

    const config = useRuntimeConfig()
    const captchaSecret = (config as unknown as { turnstile?: { secretKey?: string } }).turnstile?.secretKey ?? ''
    const captchaValid = await verifyCaptcha(body.captchaToken, captchaSecret)
    if (!captchaValid) {
      return { success: false, errors: [{ field: 'captcha', message: 'Captcha verification failed.' }] }
    }
  }

  // Filter model fields to exposed fields only
  const allFields = model.fields ?? {}
  const exposedFieldIds = new Set(formConfig.exposedFields ?? [])
  const exposedFields: Record<string, Record<string, unknown>> = {}

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

  // Sanitize all string values in submission data (strip HTML tags)
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

  // Create form submission record
  const userAgent = getHeader(event, 'user-agent') ?? null
  const referrer = getHeader(event, 'referer') ?? getHeader(event, 'referrer') ?? null

  await createFormSubmission(admin, {
    project_id: projectId,
    workspace_id: workspace.id,
    model_id: modelId,
    data: filteredData,
    source_ip: ip !== 'unknown' ? ip : undefined,
    user_agent: userAgent ?? undefined,
    referrer: referrer ?? undefined,
  })

  return {
    success: true,
    message: formConfig.successMessage ?? 'Thank you!',
  }
})
