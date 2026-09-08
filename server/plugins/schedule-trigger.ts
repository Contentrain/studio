/**
 * Scheduled publication trigger — Nitro plugin (S-03).
 *
 * Every minute: claim the publish/expire boundaries that are due
 * (`claim_due_scheduled_publications` — atomic, SKIP LOCKED, so several
 * instances never fire the same row), then per project rebuild the CDN
 * bundle (when delivery is on) and fire the deploy hook (when one is set
 * with `on_schedule`). A boundary missed during downtime is claimed on the
 * next tick. Claims expire after a crash; fired_at is set only after delivery.
 * Hook delivery is at-least-once: a crash after POST can cause a retry.
 */

import { runCDNBuild } from '../utils/cdn-build-runner'
import { triggerProjectDeploy } from '../utils/deploy-hooks'
import { emitWebhookEvent } from '../utils/webhook-engine'

const TICK_MS = 60_000
const CLAIM_LIMIT = 200

export default defineNitroPlugin((nitroApp) => {
  const interval = setInterval(() => {
    runScheduleTick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[schedule-trigger] tick failed', err)
    })
  }, TICK_MS)

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})

export async function runScheduleTick(now = new Date()): Promise<{ claimed: number, projects: number }> {
  const db = useDatabaseProvider()
  const due = await db.claimDueScheduledPublications(now, CLAIM_LIMIT)
  if (due.length === 0) return { claimed: 0, projects: 0 }

  const byProject = new Map<string, typeof due>()
  for (const row of due) {
    const list = byProject.get(String(row.project_id)) ?? []
    list.push(row)
    byProject.set(String(row.project_id), list)
  }

  for (const [projectId, rows] of byProject) {
    const workspaceId = String(rows[0]!.workspace_id)
    try {
      await rebuildIfDelivered(projectId, workspaceId)
      // Await the actual request, not an in-memory debounce timer.
      const result = await triggerProjectDeploy({ projectId, workspaceId, reason: 'schedule', immediate: true })
      if (result && !result.ok) throw new Error(`Deploy hook rejected: ${result.status}`)
      let settled = true
      for (const row of rows) {
        const accepted = await db.settleScheduledPublication(String(row.id), String(row.claim_token), true, new Date())
        settled = settled && accepted
      }
      if (settled) {
        emitWebhookEvent(projectId, workspaceId, 'schedule.fired', {
          boundaries: rows.map(r => ({ modelId: r.model_id, entryId: r.entry_id, locale: r.locale, kind: r.kind, fireAt: r.fire_at })),
        }).catch(() => {})
      }
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[schedule-trigger] delivery failed for ${projectId}`, err)
      for (const row of rows) {
        // If DB is unavailable, lease expiry still makes the row retryable.
        await db.settleScheduledPublication(String(row.id), String(row.claim_token), false, new Date()).catch(() => {})
      }
    }
  }

  return { claimed: due.length, projects: byProject.size }
}

/** Full CDN rebuild so the delivered bundle reflects the passed boundary. Skips projects without delivery. */
async function rebuildIfDelivered(projectId: string, workspaceId: string): Promise<void> {
  const db = useDatabaseProvider()
  const project = await db.getProjectById(projectId, 'id, workspace_id, repo_full_name, content_root, cdn_enabled, cdn_branch, default_branch')
  if (!project?.cdn_enabled) return

  const cdn = useCDNProvider()
  if (!cdn) throw new Error('CDN provider unavailable')

  const workspace = await db.getWorkspaceById(workspaceId, 'id, github_installation_id')
  if (!workspace?.github_installation_id) throw new Error('Git installation unavailable')

  const [owner = '', repo = ''] = String(project.repo_full_name).split('/')
  const git = useGitProvider({ installationId: workspace.github_installation_id as number, owner, repo })
  const contentRoot = normalizeContentRoot(project.content_root as string)
  const branch = String(project.cdn_branch ?? project.default_branch ?? 'main')

  let commitSha = 'schedule'
  try {
    const branches = await git.listBranches()
    commitSha = branches.find(b => b.name === branch)?.sha ?? commitSha
  }
  catch { /* keep marker */ }

  const build = await db.createCDNBuild({ projectId, triggerType: 'schedule', commitSha, branch })
  if (!build?.id) throw new Error('CDN build busy; retry schedule after it finishes')

  const result = await runCDNBuild({
    db,
    projectId,
    workspaceId,
    buildId: build.id as string,
    git,
    cdn,
    contentRoot,
    commitSha,
    branch,
    fullRebuild: true,
  })
  if (result.error) throw new Error('Scheduled CDN build failed')
}
