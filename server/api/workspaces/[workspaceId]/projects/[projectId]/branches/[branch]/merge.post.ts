/**
 * Merge a content branch into the default branch.
 * Requires reviewer, admin, or owner role.
 */
import { clearBranchRequestSafe } from '~~/server/utils/branch-requests'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  // cr/* branch names contain slashes, so the client sends them
  // percent-encoded; without { decode: true } the raw "cr%2F..." fails the
  // startsWith('cr/') guard and would be passed verbatim to the Git API.
  const branch = getRouterParam(event, 'branch', { decode: true })

  if (!workspaceId || !projectId || !branch)
    throw createError({ statusCode: 400, message: errorMessage('validation.branch_params_required') })

  // Only cr/* branches can be merged through this endpoint
  if (!branch.startsWith('cr/'))
    throw createError({ statusCode: 400, message: errorMessage('branches.contentrain_only') })

  // Role check: only reviewer+ can merge
  const permissions = await resolveAgentPermissions(session.user.id, workspaceId, projectId, session.accessToken)
  if (!permissions.availableTools.includes('merge_branch'))
    throw createError({ statusCode: 403, message: errorMessage('branches.merge_forbidden') })

  const { git, contentRoot } = await resolveProjectContext(workspaceId, projectId)

  const engine = createContentEngine({ git, contentRoot, projectId })
  const mergeResult = await engine.mergeBranch(branch)
  if (mergeResult.merged) clearBranchRequestSafe(projectId, branch)

  // Emit webhook event (fire-and-forget)
  emitWebhookEvent(projectId, workspaceId, 'branch.merged', {
    branch,
    source: 'api',
  }).catch(() => {})

  return mergeResult
})
