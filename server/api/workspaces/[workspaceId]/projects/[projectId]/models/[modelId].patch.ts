/**
 * Update a model definition — form config, comments config and/or the field that titles entries.
 * Uses content engine saveModel() for Git branching + auto-merge.
 *
 * Auth: owner/admin only
 * PATCH /api/workspaces/{workspaceId}/projects/{projectId}/models/{modelId}
 */

import type { FieldDef, ModelDefinition } from '@contentrain/types'
import type { FormConfig } from '~~/server/utils/form-types'
import { countFormEnabledModels, getFormConfig } from '~~/server/utils/form-types'
import type { CommentsConfig } from '~~/server/utils/comment-types'
import { countCommentEnabledModels, getCommentsConfig, modelSupportsComments, normalizeCommentsConfig } from '~~/server/utils/comment-types'

/**
 * Mirrors the `title_field` rule in `@contentrain/mcp`'s validator so a bad
 * pick is refused here, with a message, instead of failing later inside a git
 * write the caller cannot read.
 */
const TITLE_FIELD_TYPES = new Set(['string', 'text', 'slug', 'email', 'url', 'code', 'markdown', 'richtext'])

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
    comments?: Partial<CommentsConfig>
    titleField?: string
  }>(event)

  if (!body?.form && !body?.comments && body?.titleField === undefined)
    throw createError({ statusCode: 400, message: errorMessage('validation.data_required') })

  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)

  // Load current model definition from brain cache
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const existingModel = brain.models.get(modelId)
  if (!existingModel)
    throw createError({ statusCode: 404, message: errorMessage('model.not_found') })

  let updatedModel = { ...existingModel } as ModelDefinition & { form?: FormConfig, comments?: CommentsConfig }

  // ── Title field ────────────────────────────────────────────
  // Deliberately outside the forms gate: which field titles an entry is part of
  // the model contract, not a forms feature, and gating it would make the
  // listing unreadable on plans that simply do not have forms.
  if (body.titleField !== undefined) {
    const titleField = body.titleField
    const fields = (existingModel.fields ?? {}) as Record<string, FieldDef>

    if (existingModel.kind === 'dictionary') {
      // A dictionary has no fields; its entry key IS the title, and `key` is
      // the one value the schema allows.
      if (titleField !== 'key')
        throw createError({ statusCode: 400, message: errorMessage('model.title_field_dictionary') })
    }
    else if (!fields[titleField] || !TITLE_FIELD_TYPES.has(fields[titleField].type ?? '')) {
      throw createError({
        statusCode: 400,
        message: errorMessage('model.title_field_invalid', { field: titleField }),
      })
    }

    updatedModel = { ...updatedModel, title_field: titleField }
  }

  // ── Form config ────────────────────────────────────────────
  let mergedForm: FormConfig | undefined

  if (body.form) {
    // Validate forms feature
    if (!hasFeature(plan, 'forms.enabled'))
      throw createError({ statusCode: 403, message: errorMessage('forms.upgrade') })

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
    mergedForm = {
      enabled: body.form.enabled ?? currentForm.enabled ?? false,
      public: body.form.public ?? currentForm.public ?? false,
      exposedFields: body.form.exposedFields ?? currentForm.exposedFields ?? [],
      requiredOverrides: body.form.requiredOverrides ?? currentForm.requiredOverrides,
      honeypot: body.form.honeypot ?? currentForm.honeypot,
      captcha: body.form.captcha !== undefined ? body.form.captcha : currentForm.captcha,
      successMessage: body.form.successMessage !== undefined ? body.form.successMessage : currentForm.successMessage,
      limits: body.form.limits ?? currentForm.limits,
      autoApprove: body.form.autoApprove ?? currentForm.autoApprove,
      notifications: body.form.notifications ?? currentForm.notifications,
    }

    // Validate: enabled form must have at least one exposed field
    if (mergedForm.enabled && mergedForm.exposedFields.length === 0)
      throw createError({ statusCode: 400, message: errorMessage('forms.validation_failed') })

    updatedModel = { ...updatedModel, form: mergedForm }
  }

  // ── Comments config ────────────────────────────────────────
  let mergedComments: CommentsConfig | undefined

  if (body.comments) {
    if (!hasFeature(plan, 'comments.enabled'))
      throw createError({ statusCode: 403, message: errorMessage('comments.upgrade') })

    if (!modelSupportsComments(existingModel))
      throw createError({ statusCode: 400, message: errorMessage('comments.not_collection') })

    // Enforce comments.models plan limit when enabling comments on a new model
    const isEnabling = body.comments.enabled === true
    const wasEnabled = getCommentsConfig(existingModel)?.enabled === true
    if (isEnabling && !wasEnabled) {
      const enabledCount = countCommentEnabledModels(brain.models)
      const limit = getPlanLimit(plan, 'comments.models')
      if (enabledCount >= limit)
        throw createError({ statusCode: 403, message: errorMessage('comments.upgrade') })
    }

    const current = getCommentsConfig(existingModel) ?? {}
    const merged: Partial<CommentsConfig> = { ...current, ...body.comments }

    // Plan gates: captcha and publish-without-approval need the feature
    if (merged.captcha && !hasFeature(plan, 'comments.captcha'))
      merged.captcha = null
    if (merged.requireApproval === false && !hasFeature(plan, 'comments.auto_approve'))
      merged.requireApproval = true

    mergedComments = normalizeCommentsConfig(merged)
    updatedModel = { ...updatedModel, comments: mergedComments }
  }

  // Save via content engine (branch → commit → merge)
  const engine = createContentEngine({ git, contentRoot, projectId })
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

  // Emit webhook event (fire-and-forget)
  emitWebhookEvent(projectId, workspaceId, 'model.saved', {
    modelId,
    source: 'api',
    merged,
  }).catch(() => {})

  return { saved: true, merged, form: mergedForm, comments: mergedComments, titleField: updatedModel.title_field }
})
