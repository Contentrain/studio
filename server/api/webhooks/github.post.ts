/**
 * GitHub webhook handler.
 *
 * Validates HMAC-SHA256 signature, then processes:
 * - push → update projects.content_updated_at
 * - installation → update workspace github_installation_id
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

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
      const commits = body.commits as Array<{ added?: string[], modified?: string[], removed?: string[] }> | undefined
      const changedPaths = commits?.flatMap(c => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]) ?? []

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

        // Create build record + execute async
        const build = await db.createCDNBuild({
          projectId: proj.id as string,
          triggerType: 'webhook',
          commitSha,
          branch: targetBranch,
        })

        if (build) {
          const [repoOwner = '', repoName = ''] = repoFullName.split('/')
          const wsForGit = await db.getWorkspaceById(proj.workspace_id as string, 'github_installation_id')
          if (wsForGit?.github_installation_id && repoOwner && repoName) {
            const git = useGitProvider({ installationId: wsForGit.github_installation_id as number, owner: repoOwner, repo: repoName })
            executeCDNBuild({
              projectId: proj.id as string,
              buildId: build.id as string,
              git,
              cdn,
              contentRoot,
              commitSha,
              branch: targetBranch,
              changedPaths,
            }).then(async (result) => {
              await db.updateCDNBuild(build.id as string, {
                status: result.error ? 'failed' : 'success',
                file_count: result.filesUploaded,
                total_size_bytes: result.totalSizeBytes,
                changed_models: result.changedModels,
                build_duration_ms: result.durationMs,
                error_message: result.error ?? null,
                completed_at: new Date().toISOString(),
              })
            }).catch(async (err: unknown) => {
              // Ensure build never stays stuck in 'building'
              const msg = err instanceof Error ? err.message : 'Build failed'
              await db.updateCDNBuild(build.id as string, {
                status: 'failed',
                error_message: msg,
                completed_at: new Date().toISOString(),
              })
            })
          }
        }
      }
    }

    return { ok: true, event: 'push', repo: repoFullName }
  }

  if (eventType === 'installation') {
    const action = body.action as string
    const installationId = (body.installation as { id?: number })?.id

    if (action === 'deleted' && installationId) {
      // Clear installation from workspaces
      await db.clearWorkspaceGithubInstallation(installationId)

      return { ok: true, event: 'installation', action: 'deleted' }
    }

    return { ok: true, event: 'installation', action }
  }

  return { ok: true, event: eventType }
})
