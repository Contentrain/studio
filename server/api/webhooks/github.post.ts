/**
 * GitHub webhook handler.
 *
 * Validates HMAC-SHA256 signature, then processes:
 * - push → update projects.content_updated_at
 * - installation → update workspace github_installation_id
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PushDiffDecision } from '../../utils/cdn-push-diff'

export default defineEventHandler(async (event) => {
  const db = useDatabaseProvider()
  const runtimeConfig = useRuntimeConfig()
  const secret = runtimeConfig.github.webhookSecret

  if (!secret)
    throw createError({ statusCode: 500, message: errorMessage('webhook.secret_not_configured') })

  // Verify HMAC-SHA256 signature
  const signature = getHeader(event, 'x-hub-signature-256')
  if (!signature)
    throw createError({ statusCode: 401, message: errorMessage('webhook.missing_signature') })

  const rawBody = await readRawBody(event)
  if (!rawBody)
    throw createError({ statusCode: 400, message: errorMessage('webhook.empty_body') })

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`

  const sigBuf = Buffer.from(signature)
  const expectedBuf = Buffer.from(expected)

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf))
    throw createError({ statusCode: 401, message: errorMessage('webhook.invalid_signature') })

  const body = JSON.parse(rawBody) as Record<string, unknown>
  const eventType = getHeader(event, 'x-github-event')

  if (eventType === 'push') {
    const repoFullName = (body.repository as { full_name?: string })?.full_name
    if (!repoFullName) return { ok: true }

    await db.updateProjectContentTimestamp(repoFullName)

    // CDN build trigger — check if any project has CDN enabled
    const cdnProjects = await db.listCDNEnabledProjects(repoFullName)

    if (cdnProjects?.length) {
      const ref = body.ref as string | undefined
      const pushBranch = ref?.replace('refs/heads/', '')

      // The true before...after diff is resolved once per push via the
      // Compare API and shared across the (rare) multi-project case —
      // payload commit file lists are unreliable for merges, capped
      // arrays, and force pushes (issue #133, see cdn-push-diff.ts).
      let pushDiff: PushDiffDecision | null = null

      for (const proj of cdnProjects) {
        const targetBranch = (proj.cdn_branch ?? proj.default_branch ?? 'main') as string
        if (pushBranch !== targetBranch) continue

        // Plan check
        const ws = await db.getWorkspaceById(proj.workspace_id as string, 'plan')
        if (!hasFeature(getWorkspacePlan(ws ?? {}), 'cdn.delivery')) continue

        const cdn = useCDNProvider()
        if (!cdn) continue

        const contentRoot = normalizeContentRoot(proj.content_root as string)
        const commitSha = (body.after as string) ?? 'webhook'

        // Git provider resolves BEFORE the build record is created — a
        // missing installation used to leave a row stuck in 'pending'.
        const [repoOwner = '', repoName = ''] = repoFullName.split('/')
        const wsForGit = await db.getWorkspaceById(proj.workspace_id as string, 'github_installation_id')
        if (!wsForGit?.github_installation_id || !repoOwner || !repoName) continue
        const git = useGitProvider({ installationId: wsForGit.github_installation_id as number, owner: repoOwner, repo: repoName })

        pushDiff ??= await resolvePushDiff({
          before: body.before as string | undefined,
          after: body.after as string | undefined,
          getDiff: (head, base) => git.getBranchDiff(head, base),
        })
        if (pushDiff.action === 'skip') continue

        // Claim the single in-flight slot + execute async. A null claim means
        // a build is already running for this project — skip; that build's
        // catch-up (runCDNBuild) chases this push's commit when it finishes, so
        // nothing is stranded.
        const build = await db.createCDNBuild({
          projectId: proj.id as string,
          triggerType: 'webhook',
          commitSha,
          branch: targetBranch,
        })

        if (build?.id) {
          const buildId = build.id as string
          runCDNBuild({
            db,
            projectId: proj.id as string,
            workspaceId: proj.workspace_id as string,
            buildId,
            git,
            cdn,
            contentRoot,
            commitSha,
            branch: targetBranch,
            changedPaths: pushDiff.changedPaths,
            fullRebuild: pushDiff.fullRebuild,
          }).catch(async (err: unknown) => {
            // Ensure build never stays stuck in 'building'
            const msg = err instanceof Error ? err.message : 'Build failed'
            await db.updateCDNBuild(buildId, {
              status: 'failed',
              error_message: msg,
              completed_at: new Date().toISOString(),
            })
          })
        }
      }
    }

    return { ok: true, event: 'push', repo: repoFullName }
  }

  if (eventType === 'installation') {
    const action = body.action as string
    const installationId = (body.installation as { id?: number })?.id

    if (!installationId)
      return { ok: true, event: 'installation', action }

    if (action === 'deleted') {
      // Clear installation from workspaces (also flips status to 'unbound').
      await db.clearWorkspaceGithubInstallation(installationId)
      return { ok: true, event: 'installation', action: 'deleted' }
    }

    if (action === 'suspend') {
      // User suspended the App from GitHub settings — installation token
      // calls will start failing with 403 until unsuspended. Mark workspaces
      // accordingly so the UI can render a banner ("GitHub App suspended,
      // reactivate to continue") instead of showing surprise 5xx errors.
      await db.updateWorkspaceInstallationStatus({ installationId }, 'suspended')
      return { ok: true, event: 'installation', action: 'suspend' }
    }

    if (action === 'unsuspend') {
      await db.updateWorkspaceInstallationStatus({ installationId }, 'active')
      return { ok: true, event: 'installation', action: 'unsuspend' }
    }

    if (action === 'created') {
      // The setup callback writes installation_id + status='active' directly.
      // The webhook arrives async and may race; defensively re-mark
      // status='active' for any workspace already pointing at this id.
      await db.updateWorkspaceInstallationStatus({ installationId }, 'active')
      return { ok: true, event: 'installation', action: 'created' }
    }

    return { ok: true, event: 'installation', action }
  }

  // Repo-level access changes within a single installation. Fired when
  // the installation owner edits the App's "Repository access" setting
  // (toggle "All repositories" ↔ "Only select repositories" or add/
  // remove specific repos). Without this handling, a project bound to
  // a now-revoked repo would silently 404 on every commit/branch call.
  if (eventType === 'installation_repositories') {
    const action = body.action as string
    const installationId = (body.installation as { id?: number })?.id
    if (!installationId)
      return { ok: true, event: 'installation_repositories', action }

    if (action === 'added') {
      // Repos the installation can now access. If a project for one of
      // these existed in a degraded state (previously flipped to
      // 'inaccessible' by a prior `removed` event), restore it.
      const repos = (body.repositories_added as Array<{ full_name?: string }> | undefined) ?? []
      for (const repo of repos) {
        if (repo.full_name)
          await db.updateProjectAccessStatus({ installationId, repoFullName: repo.full_name }, 'accessible')
      }
      return { ok: true, event: 'installation_repositories', action: 'added', count: repos.length }
    }

    if (action === 'removed') {
      const repos = (body.repositories_removed as Array<{ full_name?: string }> | undefined) ?? []
      for (const repo of repos) {
        if (repo.full_name)
          await db.updateProjectAccessStatus({ installationId, repoFullName: repo.full_name }, 'inaccessible')
      }
      return { ok: true, event: 'installation_repositories', action: 'removed', count: repos.length }
    }

    return { ok: true, event: 'installation_repositories', action }
  }

  // Repo lifecycle on GitHub's side (independent of App installation).
  // Fires for renames + deletes of any repo the App has access to.
  // We don't need separate `installation_id` lookups because the event
  // payload includes the installation context and the repo's full_name
  // is sufficient to identify our project — but we still scope by
  // installation_id to avoid cross-tenant collisions.
  if (eventType === 'repository') {
    const action = body.action as string
    const installationId = (body.installation as { id?: number })?.id
    if (!installationId)
      return { ok: true, event: 'repository', action }

    if (action === 'deleted') {
      const repoFullName = (body.repository as { full_name?: string })?.full_name
      if (repoFullName)
        await db.updateProjectAccessStatus({ installationId, repoFullName }, 'deleted')
      return { ok: true, event: 'repository', action: 'deleted' }
    }

    if (action === 'renamed') {
      // GitHub's `repository.renamed` payload format:
      //   { changes: { repository: { name: { from: '<old>' } } },
      //     repository: { full_name: '<new>', owner: {...} } }
      const newFullName = (body.repository as { full_name?: string })?.full_name
      const ownerLogin = ((body.repository as { owner?: { login?: string } })?.owner)?.login
      const oldName = ((body.changes as { repository?: { name?: { from?: string } } })?.repository?.name)?.from
      const oldFullName = ownerLogin && oldName ? `${ownerLogin}/${oldName}` : null
      if (newFullName && oldFullName)
        await db.renameProjectRepo({ installationId, oldFullName }, newFullName)
      return { ok: true, event: 'repository', action: 'renamed' }
    }

    return { ok: true, event: 'repository', action }
  }

  return { ok: true, event: eventType }
})
