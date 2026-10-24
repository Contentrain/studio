/**
 * Bind this migrated project's site to Studio again (the setup's forms step): studio.json, so the site's forms and
 * comments are Studio's. The same binding Connect wrote (`bindMigrateGrantSite` → `ensureMigrateSiteBinding`), asked
 * for from the project rather than the grant, and idempotent: a bound site stays as it is, a waiting branch is reused.
 *
 * Owner/admin only. On a review project the click is the clicker's approval of the binding (their id, email and role),
 * as Connect's is the grant owner's; a policy that wants more leaves the branch for its reviewers.
 *
 * POST /api/workspaces/{workspaceId}/projects/{projectId}/migration/site-binding
 *   → 200 { siteBinding: MigrateSiteBinding | null }   (null: the workspace has no GitHub installation to write with)
 *   → 404 project.not_found · 409 migrate.connect_grant_not_ready · 429
 */
import { resolveWorkspaceBilling } from '~~/server/utils/workspace-billing'
import { bindMigrateGrantSite } from '~~/server/utils/migrate-site-binding-run'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const projectId = getRouterParam(event, 'projectId')
  if (!workspaceId || !projectId)
    throw createError({ statusCode: 400, message: errorMessage('validation.project_id_required') })

  const db = useDatabaseProvider()
  const workspace = await db.getWorkspaceForUser(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'], 'id, slug, type, plan, overage_settings, github_installation_id, media_storage_bytes')
  if (!workspace) throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  const role = await db.requireWorkspaceRole(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'])
  const project = await db.getProjectForWorkspace(session.accessToken, workspaceId, projectId, 'id, repo_full_name, default_branch')
  if (!project) throw createError({ statusCode: 404, message: errorMessage('project.not_found') })

  const repoFullName = String(project.repo_full_name ?? '')
  const [owner, name] = repoFullName.split('/')
  const grant = owner && name ? await db.getMigrateGrantForProject(workspaceId, repoFullName) : null
  // Only a grant in use that Connect could bind: the binding is the grant's record (049).
  if (!grant || grant.kind !== 'bundle' || !grant.redeemed_at || grant.revoked_at || !session.user.email)
    throw createError({ statusCode: 409, message: errorMessage('migrate.connect_grant_not_ready'), data: { code: 'grant_not_ready' } })

  const rate = await checkRateLimit(`migration-site-binding:${session.user.id}`, 5, 60_000)
  if (!rate.allowed)
    throw createError({ statusCode: 429, message: errorMessage('migration.setup_rate_limited') })

  const billing = await resolveWorkspaceBilling(db, { ...workspace, id: workspaceId } as Parameters<typeof resolveWorkspaceBilling>[1])
  const siteBinding = await bindMigrateGrantSite({
    db,
    grant,
    workspace: { ...workspace, id: workspaceId },
    projectId,
    repo: { owner: owner!, name: name! },
    ...(typeof project.default_branch === 'string' && project.default_branch ? { defaultBranch: project.default_branch } : {}),
    plan: billing.effectivePlan,
    approver: { id: session.user.id, email: session.user.email, workspaceId, role: role ?? null },
  })
  return { siteBinding }
})
