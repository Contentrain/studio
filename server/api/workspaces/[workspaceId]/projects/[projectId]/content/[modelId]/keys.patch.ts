/**
 * Remove or rename dictionary keys — dictionary models only.
 *
 * Body: { remove: string[], locales?: string[] } — the keys go from every
 *       locale that holds them, or only from `locales`.
 *       { rename: { from, to } } — one commit across every locale holding
 *       `from`; refused when `to` already exists anywhere.
 *
 * Both are deletes as far as permissions and the approval gate go: a site
 * reading the old key breaks either way, and Studio cannot see its code.
 * The response has the shape the save route returns.
 */

import { decideMerge } from '~~/server/utils/approval-gate'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  const modelId = getRouterParam(event, 'modelId')
  const body = await readBody<{
    remove?: string[]
    locales?: string[]
    rename?: { from?: string, to?: string }
  }>(event)

  if (!workspaceId || !projectId || !modelId)
    throw createError({ statusCode: 400, message: errorMessage('validation.model_id_required') })

  const remove = Array.isArray(body?.remove) ? body.remove.filter((k): k is string => typeof k === 'string' && k.length > 0) : []
  const from = typeof body?.rename?.from === 'string' ? body.rename.from : ''
  const to = typeof body?.rename?.to === 'string' ? body.rename.to.trim() : ''
  if ((remove.length > 0) === Boolean(from && to))
    throw createError({ statusCode: 400, message: errorMessage('validation.keys_op_required') })

  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('delete_content'))
    throw createError({ statusCode: 403, message: errorMessage('content.delete_forbidden') })

  if (permissions.specificModels && !permissions.allowedModels.includes(modelId))
    throw createError({ statusCode: 403, message: errorMessage('content.model_no_access', { model: modelId }) })

  const { git, contentRoot, workspace } = await resolveProjectContext(workspaceId, projectId)
  const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
  const model = brain.models.get(modelId)
  if (model?.kind !== 'dictionary')
    throw createError({ statusCode: 400, message: errorMessage('content.dictionary_only') })

  const defaultLocale = brain.config?.locales?.default ?? 'en'
  const engine = createContentEngine({ git, contentRoot, projectId })
  const result = remove.length > 0
    ? await engine.deleteContent(modelId, defaultLocale, remove, session.user.email ?? '', body.locales)
    : await engine.renameDictionaryKey(modelId, from, to, session.user.email ?? '')

  if (!result.validation.valid) return result

  const touchedLocales = result.touchedLocales ?? [defaultLocale]
  const keys = remove.length > 0 ? remove : [from, to]
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(workspace)
  const workflow = hasFeature(plan, 'workflow.review') ? (brain.config?.workflow ?? 'auto-merge') : 'auto-merge'
  const gate = await decideMerge({
    workflow,
    tool: 'delete_content',
    scope: { models: [modelId], locales: touchedLocales, entries: keys },
    signals: {},
    policy: brain.approvalPolicy,
    commitSha: result.commit?.sha,
  })

  let merged = false
  let pullRequestUrl: string | null = null
  if (gate.allowed && result.branch) {
    const mergeResult = await engine.mergeBranch(result.branch)
    merged = mergeResult.merged
    pullRequestUrl = mergeResult.pullRequestUrl
    invalidateBrainCache(projectId)
  }

  // A rename writes the new key as much as it drops the old one.
  const webhook = remove.length > 0
    ? emitWebhookEvent(projectId, workspaceId, 'content.deleted', { models: [modelId], locale: defaultLocale, locales: touchedLocales, entryIds: remove, source: 'api' })
    : emitWebhookEvent(projectId, workspaceId, 'content.saved', { models: [modelId], locale: defaultLocale, source: 'api', merged })
  webhook.catch(() => {})

  return { ...result, merged, workflow, pullRequestUrl, ...(merged ? {} : gate.review) }
})
