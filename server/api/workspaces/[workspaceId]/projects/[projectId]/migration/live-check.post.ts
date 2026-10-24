/**
 * Make the setup's test change (the live-site step): a fresh check file on the site, merged under the owner's click
 * (`writeLiveCheck`; on a review project the click is the approval). The live site shows it once the host has rebuilt;
 * `POST …/live-check/verify` looks for it there.
 *
 * Owner/admin only: it commits to the customer's repository.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/live-check
 *   → 200 { liveCheck: { status: merged | pull_request | pending_review, branch, pullRequestUrl, at } }
 *   → 404 project.not_found · 409 migration.live_check_conflict · 429
 */
import { writeLiveCheck } from '~~/server/utils/migration-live-check'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id')
  if (!project)
    throw createError({ statusCode: 404, message: errorMessage('project.not_found') })
  if (!session.user.email)
    throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })

  const rate = await checkRateLimit(`migration-live-check:${session.user.id}`, 5, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('migration.setup_rate_limited') })

  const ws = await db.getWorkspaceById(workspaceId, 'plan')
  const plan = event.context.billing?.effectivePlan ?? getWorkspacePlan(ws ?? {})
  const ctx = await resolveProjectContext(workspaceId, projectId)
  const check = await writeLiveCheck({
    db,
    git: ctx.git,
    contentRoot: ctx.contentRoot,
    projectId,
    plan,
    defaultBranch: ctx.project.default_branch ?? 'main',
    approver: { id: session.user.id, email: session.user.email, role: role ?? null, workspaceId },
  })
  await db.mergeProjectMigrationSetup(projectId, { live_check: check })
  // The nonce stays server-side: the live site is where it shows.
  return { liveCheck: { status: check.status, branch: check.branch ?? null, pullRequestUrl: check.pullRequestUrl ?? null, at: check.at } }
})
