/**
 * POST /api/migrate/grants/:grantId/connect-project
 *
 * The delivered site of a bundle grant (Studio came with the Migrate order) as a project in the grant's
 * workspace — one click on `/migrate/claim`. The repository is the grant's, never the caller's. It makes the
 * project the way the Connect dialog does (`connectWorkspaceProject`), after saying which of the things it
 * needs is missing, each with its own `data.code` so the screen can show the next step:
 * `plan_locked`, `no_installation`, `repo_not_accessible` (with the installation's settings page),
 * `repo_other_account` (the repository belongs to a GitHub account other than the one the workspace is
 * connected to: a workspace carries one installation, so giving the app access is a dead end there),
 * `migration_not_merged`. A repository that is already a project is the answer, not an error.
 *
 * Then the site is bound to the project (`ensureMigrateSiteBinding`: studio.json, so its forms and comments are
 * Studio's) and the answer says how that went (`siteBinding`). Every answer binds, the "already a project" ones too:
 * the claim screen's retry is this same call, and the binding is idempotent.
 */
import { resolveWorkspaceBilling } from '../../../../utils/workspace-billing'
import { isBillingLocked } from '../../../../utils/billing'
import { migrateClaimPublicKey } from '../../../../utils/migrate-grant'
import { connectWorkspaceProject } from '../../../../utils/project-connect'
import { useGitAppProvider, useGitProvider } from '../../../../utils/providers'
import { ensureMigrateSiteBinding } from '../../../../utils/migrate-site-binding'
import type { MigrateSiteBinding } from '../../../../utils/migrate-site-binding'
import { publicMediaBase } from '../../../../utils/media-url'

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
  let owner = grant.repo_owner as string | null
  let name = grant.repo_name as string | null
  // Only a bundle grant that is in use, tied to a workspace, and knows its repository (the claim writes it).
  if (grant.kind !== 'bundle' || !grant.redeemed_at || !workspaceId || !owner || !name)
    throw createError({ statusCode: 409, message: errorMessage('migrate.connect_grant_not_ready'), data: { code: 'grant_not_ready' } })

  const workspace = await db.getWorkspaceForUser(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'], 'id, slug, type, plan, overage_settings, github_installation_id')
  if (!workspace) throw createError({ statusCode: 403, message: errorMessage('auth.forbidden') })
  const slug = workspace.slug as string
  const repoFullName = `${owner}/${name}`

  let billing: Awaited<ReturnType<typeof resolveWorkspaceBilling>> | undefined
  const billingOf = async () => (billing ??= await resolveWorkspaceBilling(db, { ...workspace, id: workspaceId } as Parameters<typeof resolveWorkspaceBilling>[1]))
  // The site's binding to the project (studio.json). Recorded on the grant; never fails the connect.
  const bind = async (projectId: string, repo: { owner: string, name: string }, defaultBranch?: string): Promise<MigrateSiteBinding | null> => {
    const installation = typeof workspace.github_installation_id === 'number' ? workspace.github_installation_id : null
    if (!installation) return null
    const git = useGitProvider({ installationId: installation, owner: repo.owner, repo: repo.name })
    const project = await db.getProjectById(projectId, 'id, content_root, default_branch')
    return ensureMigrateSiteBinding({
      db,
      grantId,
      projectId,
      git,
      contentRoot: normalizeContentRoot((project?.content_root as string | null) ?? ''),
      defaultBranch: defaultBranch ?? (project?.default_branch as string | null) ?? await git.getDefaultBranch(),
      plan: (await billingOf()).effectivePlan,
      studio: { baseUrl: String(useRuntimeConfig().public?.siteUrl ?? ''), mediaBaseUrl: publicMediaBase(projectId) },
    })
  }

  // Already a project: the answer, not an error. Compared without case, as the claim screen does.
  const existing = (await db.listWorkspaceProjects(session.accessToken, workspaceId))
    .find(p => typeof p.repo_full_name === 'string' && p.repo_full_name.toLowerCase() === repoFullName.toLowerCase())
  if (existing) return { projectId: existing.id as string, workspaceSlug: slug, created: false, siteBinding: await bind(existing.id as string, { owner, name }) }

  const { state: billingState, effectivePlan } = await billingOf()
  if (billingState === 'free' || isBillingLocked(billingState))
    throw createError({ statusCode: 409, message: errorMessage('migrate.connect_plan_locked'), data: { code: 'plan_locked' } })

  const installationId = typeof workspace.github_installation_id === 'number' ? workspace.github_installation_id : null
  if (!installationId)
    throw createError({ statusCode: 409, message: errorMessage('migrate.connect_no_installation'), data: { code: 'no_installation' } })

  // Migrate made the repository with its own app: the Studio app may not be allowed on it. A repository
  // that was renamed or transferred answers under its new name (GitHub redirects the old one).
  const gitApp = useGitAppProvider(installationId)
  const resolved = await gitApp.resolveRepository(owner, name).catch(() => null)
  if (!resolved) {
    const account = (await gitApp.getInstallationDetails().catch(() => null))?.account.login ?? null
    if (account && account.toLowerCase() !== owner.toLowerCase()) {
      throw createError({
        statusCode: 409,
        message: errorMessage('migrate.connect_repo_other_account', { repoOwner: owner, workspaceAccount: account }),
        data: { code: 'repo_other_account', repoOwner: owner, workspaceAccount: account },
      })
    }
    throw createError({
      statusCode: 409,
      message: errorMessage('migrate.connect_repo_not_accessible', { repo: repoFullName }),
      data: { code: 'repo_not_accessible', settingsUrl: `https://github.com/settings/installations/${installationId}` },
    })
  }

  let connectedName = repoFullName
  if (resolved.fullName.toLowerCase() !== repoFullName.toLowerCase()) {
    const [movedOwner, movedName] = resolved.fullName.split('/') as [string, string]
    await db.updateMigrateGrantRepo(grantId, { owner: movedOwner, name: movedName })
    owner = movedOwner
    name = movedName
    connectedName = resolved.fullName
    const moved = (await db.listWorkspaceProjects(session.accessToken, workspaceId))
      .find(p => typeof p.repo_full_name === 'string' && p.repo_full_name.toLowerCase() === connectedName.toLowerCase())
    if (moved) return { projectId: moved.id as string, workspaceSlug: slug, created: false, siteBinding: await bind(moved.id as string, { owner, name }) }
  }

  const git = useGitProvider({ installationId, owner, repo: name })
  const [detection, defaultBranch] = await Promise.all([git.detectFramework(), git.getDefaultBranch()])
  const project = await connectWorkspaceProject(session.accessToken, workspaceId, effectivePlan, {
    repoFullName: connectedName,
    defaultBranch,
    detectedStack: detection.stack,
    hasContentrain: detection.hasContentDir,
  })
  return { projectId: project.id as string, workspaceSlug: slug, created: true, siteBinding: await bind(project.id as string, { owner, name }, defaultBranch) }
})
