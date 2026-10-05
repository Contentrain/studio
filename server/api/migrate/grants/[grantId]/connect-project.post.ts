/**
 * POST /api/migrate/grants/:grantId/connect-project
 *
 * The delivered site of a bundle grant (Studio came with the Migrate order) as a project in the grant's
 * workspace — one click on `/migrate/claim`. The repository is the grant's, never the caller's. It makes the
 * project the way the Connect dialog does (`connectWorkspaceProject`), after saying which of the things it
 * needs is missing, each with its own `data.code` so the screen can show the next step:
 * `plan_locked`, `no_installation`, `repo_not_accessible` (with the installation's settings page),
 * `migration_not_merged`. A repository that is already a project is the answer, not an error.
 */
import { resolveWorkspaceBilling } from '../../../../utils/workspace-billing'
import { isBillingLocked } from '../../../../utils/billing'
import { migrateClaimPublicKey } from '../../../../utils/migrate-grant'
import { connectWorkspaceProject } from '../../../../utils/project-connect'
import { useGitAppProvider, useGitProvider } from '../../../../utils/providers'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  if (!migrateClaimPublicKey())
    throw createError({ statusCode: 404, message: errorMessage('migrate.unavailable'), data: { code: 'unavailable' } })

  const grantId = getRouterParam(event, 'grantId') ?? ''
  const db = useDatabaseProvider()
  const grant = grantId ? await db.getMigrateGrantForUser(grantId, session.user.id) : null
  if (!grant) throw createError({ statusCode: 404, message: errorMessage('migrate.grant_not_found'), data: { code: 'grant_not_found' } })
  if (grant.revoked_at) throw createError({ statusCode: 409, message: errorMessage('migrate.grant_revoked'), data: { code: 'grant_revoked' } })

  const workspaceId = grant.workspace_id as string | null
  const owner = grant.repo_owner as string | null
  const name = grant.repo_name as string | null
  // Only a bundle grant that is in use, tied to a workspace, and knows its repository (the claim writes it).
  if (grant.kind !== 'bundle' || !grant.redeemed_at || !workspaceId || !owner || !name)
    throw createError({ statusCode: 409, message: errorMessage('migrate.connect_grant_not_ready'), data: { code: 'grant_not_ready' } })

  const workspace = await db.getWorkspaceForUser(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'], 'id, slug, type, plan, overage_settings, github_installation_id')
  if (!workspace) throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  const slug = workspace.slug as string
  const repoFullName = `${owner}/${name}`

  // Already a project: the answer, not an error. Compared without case, as the claim screen does.
  const existing = (await db.listWorkspaceProjects(session.accessToken, workspaceId))
    .find(p => typeof p.repo_full_name === 'string' && p.repo_full_name.toLowerCase() === repoFullName.toLowerCase())
  if (existing) return { projectId: existing.id as string, workspaceSlug: slug, created: false }

  const billing = await resolveWorkspaceBilling(db, { ...workspace, id: workspaceId } as Parameters<typeof resolveWorkspaceBilling>[1])
  if (billing.state === 'free' || isBillingLocked(billing.state))
    throw createError({ statusCode: 409, message: errorMessage('migrate.connect_plan_locked'), data: { code: 'plan_locked' } })

  const installationId = typeof workspace.github_installation_id === 'number' ? workspace.github_installation_id : null
  if (!installationId)
    throw createError({ statusCode: 409, message: errorMessage('migrate.connect_no_installation'), data: { code: 'no_installation' } })

  // Migrate made the repository with its own app: the Studio app may not be allowed on it.
  const accessible = await useGitAppProvider(installationId).canAccessRepository(owner, name).catch(() => false)
  if (!accessible) {
    throw createError({
      statusCode: 409,
      message: errorMessage('migrate.connect_repo_not_accessible', { repo: repoFullName }),
      data: { code: 'repo_not_accessible', settingsUrl: `https://github.com/settings/installations/${installationId}` },
    })
  }

  const git = useGitProvider({ installationId, owner, repo: name })
  const [detection, defaultBranch] = await Promise.all([git.detectFramework(), git.getDefaultBranch()])
  const project = await connectWorkspaceProject(session.accessToken, workspaceId, billing.effectivePlan, {
    repoFullName,
    defaultBranch,
    detectedStack: detection.stack,
    hasContentrain: detection.hasContentDir,
  })
  return { projectId: project.id as string, workspaceSlug: slug, created: true }
})
