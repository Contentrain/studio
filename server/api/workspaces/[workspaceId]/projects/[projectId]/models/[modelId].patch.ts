/**
 * Update a model definition — currently supports form config updates.
 * Uses content engine saveModel() for Git branching + auto-merge.
 *
 * Auth: owner/admin only
 * PATCH /api/workspaces/{workspaceId}/projects/{projectId}/models/{modelId}
 */

import type { ModelDefinition } from '@contentrain/types'
import type { FormConfig } from '~~/server/utils/form-types'
import { countFormEnabledModels, getFormConfig } from '~~/server/utils/form-types'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: errorMessage('validation.params_required') })

  // Only owner/admin can modify model definitions
  const db = useDatabaseProvider()
  await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])

  const body = await readBody<{
    form?: Partial<FormConfig>
  }>(event)

  if (!body?.form)
    throw createError({ statusCode: 400, message: errorMessage('validation.data_required') })

  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)

  // Validate forms feature
  if (!hasFeature(plan, 'forms.enabled'))
    throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })

  // Load current model definition from brain cache
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const existingModel = brain.models.get(modelId)
  if (!existingModel)
    throw createError({ statusCode: 404, message: errorMessage('model.not_found') })

  // Only collection models can have forms
  if (existingModel.kind !== 'collection')
    throw createError({ statusCode: 400, message: errorMessage('forms.not_collection') })

  // Enforce forms.models plan limit when enabling a new form
  const isEnabling = body.form.enabled === true
  const wasEnabled = getFormConfig(existingModel)?.enabled === true
  if (isEnabling && !wasEnabled) {
    const enabledCount = countFormEnabledModels(brain.models)
    const limit = getPlanLimit(plan, 'forms.models')
    if (enabledCount >= limit)
      throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })
  }

  // Plan gate: captcha requires Pro+
  if (body.form.captcha && !hasFeature(plan, 'forms.captcha'))
    body.form.captcha = null

  // Plan gate: auto-approve requires Pro+
  if (body.form.autoApprove && !hasFeature(plan, 'forms.auto_approve'))
    body.form.autoApprove = false

  // Merge form config into existing model
  const currentForm = getFormConfig(existingModel) ?? {} as Partial<FormConfig>
  const mergedForm: FormConfig = {
    enabled: body.form.enabled ?? currentForm.enabled ?? false,
    public: body.form.public ?? currentForm.public ?? false,
    exposedFields: body.form.exposedFields ?? currentForm.exposedFields ?? [],
    requiredOverrides: body.form.requiredOverrides ?? currentForm.requiredOverrides,
    honeypot: body.form.honeypot ?? currentForm.honeypot,
    captcha: body.form.captcha !== undefined ? body.form.captcha : currentForm.captcha,
    successMessage: body.form.successMessage !== undefined ? body.form.successMessage : currentForm.successMessage,
    limits: body.form.limits ?? currentForm.limits,
    autoApprove: body.form.autoApprove ?? currentForm.autoApprove,
  }

  // Validate: enabled form must have at least one exposed field
  if (mergedForm.enabled && mergedForm.exposedFields.length === 0)
    throw createError({ statusCode: 400, message: errorMessage('forms.validation_failed') })

  // Build updated model definition
  const updatedModel = {
    ...existingModel,
    form: mergedForm,
  } as ModelDefinition & { form: FormConfig }

  // Save via content engine (branch → commit → merge)
  const engine = createContentEngine({ git, contentRoot })
  const writeResult = await engine.saveModel(updatedModel as unknown as ModelDefinition, session.user.email ?? '')

  if (!writeResult.validation.valid) {
    return { saved: false, validation: writeResult.validation }
  }

  // Auto-merge — model config changes take effect immediately
  let merged = false
  if (writeResult.branch) {
    const mergeResult = await engine.mergeBranch(writeResult.branch)
    merged = mergeResult.merged
  }

  invalidateBrainCache(projectId)

  return { saved: true, merged, form: mergedForm }
})
