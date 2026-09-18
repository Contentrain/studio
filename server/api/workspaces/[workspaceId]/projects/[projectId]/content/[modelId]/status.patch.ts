/**
 * Update entry status (publish/unpublish/archive).
 * Only modifies meta, not content data.
 * Owner/Admin can publish, Editor can only draft.
 *
 * The merge goes through the same approval gate as every other write: a status
 * change is the most visible edit there is, and a route that merged it
 * unconditionally let an editor archive — or an owner publish — past a review
 * workflow the project had switched on.
 */
import { decideMerge, writeSignals } from '~~/server/utils/approval-gate'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const body = await readBody<{
    entryIds: string[]
    status: 'draft' | 'published' | 'archived'
    locale?: string
  }>(event)

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: errorMessage('validation.model_id_required') })

  if (!body.entryIds?.length || !body.status)
    throw createError({ statusCode: 400, message: errorMessage('validation.entry_status_required') })

  if (!['draft', 'published', 'archived'].includes(body.status))
    throw createError({ statusCode: 400, message: errorMessage('validation.status_invalid') })

  // Permission check: publish requires owner/admin, draft/archive requires editor+
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)

  if (body.status === 'published') {
    if (permissions.workspaceRole !== 'owner' && permissions.workspaceRole !== 'admin')
      throw createError({ statusCode: 403, message: errorMessage('content.publish_owner_only') })
  }
  else if (!permissions.availableTools.includes('save_content')) {
    throw createError({ statusCode: 403, message: errorMessage('content.insufficient_permissions') })
  }

  // Model restriction
  if (permissions.specificModels && !permissions.allowedModels.includes(modelId))
    throw createError({ statusCode: 403, message: errorMessage('content.model_no_access', { model: modelId }) })

  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)

  const engine = createContentEngine({ git, contentRoot, projectId })
  const writeResult = await engine.updateEntryStatus(
    modelId, body.locale ?? 'en', body.entryIds, body.status, session.user.email ?? '',
  )

  // Every named entry already carried the requested status — nothing was
  // committed, so there is no branch to merge.
  if (writeResult.unchanged)
    return { merged: false, unchanged: true, status: body.status, entryIds: body.entryIds, statusChanges: writeResult.statusChanges }

  const locale = body.locale ?? 'en'
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const workflow = hasFeature(plan, 'workflow.review') ? (brain.config?.workflow ?? 'auto-merge') : 'auto-merge'
  const gate = await decideMerge({
    workflow,
    tool: 'update_status',
    scope: { models: [modelId], locales: [locale], entries: body.entryIds },
    signals: writeSignals('update_status', { status: body.status }),
    policy: brain.approvalPolicy,
    commitSha: writeResult.commit?.sha,
  })

  if (!gate.allowed) {
    // Held on its branch: report why, in the shape the save route uses.
    return { merged: false, branch: writeResult.branch, workflow, status: body.status, entryIds: body.entryIds, statusChanges: writeResult.statusChanges, ...gate.review }
  }

  const mergeResult = await engine.mergeBranch(writeResult.branch)
  invalidateBrainCache(projectId)
  return { merged: mergeResult.merged, workflow, status: body.status, entryIds: body.entryIds, statusChanges: writeResult.statusChanges }
})
