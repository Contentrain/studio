/**
 * Scheduled publication trigger — Nitro plugin (S-03).
 *
 * Every minute: claim the publish/expire boundaries that are due
 * (`claim_due_scheduled_publications` — atomic, SKIP LOCKED, so several
 * instances never fire the same row), then per project rebuild the CDN
 * bundle (when delivery is on) and fire the deploy hook (when one is set
 * with `on_schedule`). A boundary missed during downtime is claimed on the
 * next tick: late, never lost. Idempotent per row (`fired_at`).
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
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[schedule-trigger] rebuild failed for ${projectId}`, err)
    }
    triggerProjectDeploy({ projectId, workspaceId, reason: 'schedule' }).catch(() => {})
    emitWebhookEvent(projectId, workspaceId, 'schedule.fired', {
      boundaries: rows.map(r => ({ modelId: r.model_id, entryId: r.entry_id, locale: r.locale, kind: r.kind, fireAt: r.fire_at })),
    }).catch(() => {})
  }

  return { claimed: due.length, projects: byProject.size }
}

/** Full CDN rebuild so the delivered bundle reflects the passed boundary. Skips projects without delivery. */
async function rebuildIfDelivered(projectId: string, workspaceId: string): Promise<void> {
  const db = useDatabaseProvider()
  const project = await db.getProjectById(projectId, 'id, workspace_id, repo_full_name, content_root, cdn_enabled, cdn_branch, default_branch')
  if (!project?.cdn_enabled) return

  const cdn = useCDNProvider()
  if (!cdn) return

  const workspace = await db.getWorkspaceById(workspaceId, 'id, github_installation_id')
  if (!workspace?.github_installation_id) return

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
  if (!build?.id) return // a build is in flight; its catch-up will land the change

  await runCDNBuild({
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
}
