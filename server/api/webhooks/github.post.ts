/**
 * GitHub webhook handler.
 *
 * Validates HMAC-SHA256 signature, then processes:
 * - push → update projects.content_updated_at
 * - installation → update workspace github_installation_id
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export default defineEventHandler(async (event) => {
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

  const admin = useSupabaseAdmin()

  if (eventType === 'push') {
    const repoFullName = (body.repository as { full_name?: string })?.full_name
    if (!repoFullName) return { ok: true }

    await admin
      .from('projects')
      .update({ content_updated_at: new Date().toISOString() })
      .eq('repo_full_name', repoFullName)

    // CDN build trigger — check if any project has CDN enabled
    const { data: cdnProjects } = await admin
      .from('projects')
      .select('id, workspace_id, content_root, cdn_enabled, cdn_branch, default_branch')
      .eq('repo_full_name', repoFullName)
      .eq('cdn_enabled', true)

    if (cdnProjects?.length) {
      const ref = body.ref as string | undefined
      const pushBranch = ref?.replace('refs/heads/', '')
      const commits = body.commits as Array<{ added?: string[], modified?: string[], removed?: string[] }> | undefined
      const changedPaths = commits?.flatMap(c => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]) ?? []

      for (const proj of cdnProjects) {
        const targetBranch = proj.cdn_branch ?? proj.default_branch ?? 'main'
        if (pushBranch !== targetBranch) continue

        // Plan check
        const { data: ws } = await admin.from('workspaces').select('plan').eq('id', proj.workspace_id).single()
        if (!hasFeature(getWorkspacePlan(ws ?? {}), 'cdn.delivery')) continue

        const cdn = useCDNProvider()
        if (!cdn) continue

        const contentRoot = normalizeContentRoot(proj.content_root)
        const commitSha = (body.after as string) ?? 'webhook'

        // Create build record + execute async
        const { data: build } = await admin
          .from('cdn_builds')
          .insert({
            project_id: proj.id,
            trigger_type: 'webhook',
            commit_sha: commitSha,
            branch: targetBranch,
            status: 'building',
          })
          .select('id')
          .single()

        if (build) {
          const [repoOwner = '', repoName = ''] = repoFullName.split('/')
          const { data: wsForGit } = await admin.from('workspaces').select('github_installation_id').eq('id', proj.workspace_id).single()
          if (wsForGit?.github_installation_id && repoOwner && repoName) {
            const git = useGitProvider({ installationId: wsForGit.github_installation_id, owner: repoOwner, repo: repoName })
            executeCDNBuild({
              projectId: proj.id,
              buildId: build.id,
              git,
              cdn,
              contentRoot,
              commitSha,
              branch: targetBranch,
              changedPaths,
            }).then(async (result) => {
              await admin.from('cdn_builds').update({
                status: result.error ? 'failed' : 'success',
                file_count: result.filesUploaded,
                total_size_bytes: result.totalSizeBytes,
                changed_models: result.changedModels,
                build_duration_ms: result.durationMs,
                error_message: result.error ?? null,
                completed_at: new Date().toISOString(),
              }).eq('id', build.id)
            }).catch(async (err: unknown) => {
              // Ensure build never stays stuck in 'building'
              const msg = err instanceof Error ? err.message : 'Build failed'
              await admin.from('cdn_builds').update({
                status: 'failed',
                error_message: msg,
                completed_at: new Date().toISOString(),
              }).eq('id', build.id)
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
      await admin
        .from('workspaces')
        .update({ github_installation_id: null })
        .eq('github_installation_id', installationId)

      return { ok: true, event: 'installation', action: 'deleted' }
    }

    return { ok: true, event: 'installation', action }
  }

  return { ok: true, event: eventType }
})
