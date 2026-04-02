/**
 * Branch cleanup scheduler — Nitro plugin.
 *
 * Runs every 6 hours: iterates all active projects, deletes merged cr/*
 * branches past retention period, and updates the in-memory health cache.
 *
 * Per git-architecture.md §8.3: merged branches retained for branchRetention
 * days (default 30), cleanup runs lazily during operations and periodically here.
 */
export default defineNitroPlugin((nitroApp) => {
  const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours

  const interval = setInterval(async () => {
    try {
      await runBranchCleanup()
    }
    catch {
      // eslint-disable-next-line no-console
      console.error('[branch-cleanup] Scheduled cleanup failed')
    }
  }, CLEANUP_INTERVAL)

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})

async function runBranchCleanup() {
  const db = useDatabaseProvider()
  const projects = await db.listAllActiveProjects('id, repo_full_name, workspace_id')

  for (const project of projects) {
    try {
      const workspaceId = project.workspace_id as string
      const workspace = await db.getWorkspaceById(workspaceId, 'id, github_installation_id')
      if (!workspace?.github_installation_id) continue

      const [owner = '', repo = ''] = String(project.repo_full_name).split('/')
      if (!owner || !repo) continue

      const git = useGitProvider({
        installationId: workspace.github_installation_id as number,
        owner,
        repo,
      })

      const report = await cleanupMergedBranches(git, project.id as string)
      if (report.deleted.length > 0) {
        // eslint-disable-next-line no-console
        console.info(`[branch-cleanup] ${owner}/${repo}: deleted ${report.deleted.length} merged branches, ${report.remaining} remaining`)
      }
    }
    catch {
      // Per-project failure must not stop the sweep
    }
  }
}
