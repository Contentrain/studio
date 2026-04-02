/**
 * Public form config endpoint — serves form schema for external embedding.
 *
 * Auth: NONE (public endpoint)
 * Rate limit: per-IP sliding window
 * Plan: requires forms.enabled feature + forms.models limit
 *
 * GET /api/forms/v1/{projectId}/{modelId}/config
 */

import { getFormConfig, getClientIp, countFormEnabledModels } from '~~/server/utils/form-types'

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

  // Rate limit config endpoint to prevent enumeration
  const ip = getClientIp(event)
  const rateCheck = await checkRateLimit(`form-config:${ip}`, 30, 60_000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('forms.rate_limited') })

  // Lookup project → workspace → plan
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

  const [owner = '', repo = ''] = (project.repo_full_name as string).split('/')
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

  // Enforce forms.models plan limit — count enabled models vs plan cap
  const formsModelLimit = getPlanLimit(plan, 'forms.models')
  const enabledCount = countFormEnabledModels(brain.models)
  if (enabledCount > formsModelLimit) {
    // Check if THIS model is within the limit (sorted by model ID for determinism)
    const enabledIds = [...brain.models.entries()]
      .filter(([, m]) => getFormConfig(m)?.enabled)
      .map(([id]) => id)
      .sort()
    const allowedIds = new Set(enabledIds.slice(0, formsModelLimit))
    if (!allowedIds.has(modelId))
      throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })
  }

  // Filter fields to only exposed ones
  const allFields = model.fields ?? {}
  const exposedFieldIds = new Set(formConfig.exposedFields ?? [])
  const publicFields: Record<string, unknown> = {}

  for (const [fieldId, fieldDef] of Object.entries(allFields)) {
    if (exposedFieldIds.has(fieldId)) {
      // Clone to avoid mutating brain cache
      publicFields[fieldId] = { ...(fieldDef as unknown as Record<string, unknown>) }
    }
  }

  // Apply required overrides if configured
  if (formConfig.requiredOverrides) {
    for (const [fieldId, isRequired] of Object.entries(formConfig.requiredOverrides)) {
      if (publicFields[fieldId]) {
        ;(publicFields[fieldId] as Record<string, unknown>).required = isRequired
      }
    }
  }

  return {
    modelId,
    fields: publicFields,
    captcha: formConfig.captcha ?? null,
    successMessage: formConfig.successMessage ?? errorMessage('forms.default_success'),
    honeypotField: formConfig.honeypot ? '_hp' : null,
  }
})
