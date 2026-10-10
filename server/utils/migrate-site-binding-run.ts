/**
 * Running a bundle grant's site binding where it is asked for (`connect-project`) and where it is retried (the sweep,
 * `server/plugins/migrate-site-binding-sweep.ts`): the workspace's installation, the project's repository and branch,
 * the workspace's plan, Studio's own origin. Both callers bind the same way through `bindMigrateGrantSite`.
 *
 * The sweep (`sweepMigrateSiteBindings`), over `listMigrateSiteBindingWork`:
 * - **binds** a connected bundle site that was never bound (no state: connected before the binding existed, or its
 *   connect answered before the binding was recorded), and **retries** a `failed` one when its time comes
 *   (`site_binding_next_at`), up to `SITE_BINDING_MAX_ATTEMPTS` in a row;
 * - leaves `conflict` alone (a person decides) and never sees `pr_open` (it waits on the customer's merge; the claim
 *   screen's retry re-checks it);
 * - raises the ops alarm once per grant (`markMigrateSiteBindingAlerted`): after `SITE_BINDING_ALARM_ATTEMPTS` failed
 *   attempts in a row, or on any conflict. The alarm carries ids, the repository, the state and a code — never a
 *   secret, never the file's content.
 */
import type { DatabaseProvider, DatabaseRow } from '../providers/database'
import { reportMigrateSiteBindingAlarm } from './alert'
import { normalizeContentRoot } from './content-paths'
import { publicMediaBase } from './media-url'
import { ensureMigrateSiteBinding, SITE_BINDING_ALARM_ATTEMPTS, SITE_BINDING_MAX_ATTEMPTS } from './migrate-site-binding'
import type { MigrateSiteBinding } from './migrate-site-binding'
import { useGitProvider } from './providers'
import { resolveWorkspaceBilling } from './workspace-billing'

type BindDb = Pick<DatabaseProvider, 'setMigrateGrantSiteBinding' | 'getProjectById' | 'getActivePaymentAccount'>

export interface BindMigrateGrantSiteInput {
  db: BindDb
  grant: DatabaseRow
  /** The grant's workspace: its installation and billing (`id, type, plan, overage_settings, github_installation_id`). */
  workspace: DatabaseRow
  projectId: string
  repo: { owner: string, name: string }
  /** Known to the caller already (connect-project): skips a read. */
  defaultBranch?: string
  plan?: string
}

/** Bind the grant's delivered site to the project; null when the workspace has no installation to write with. */
export async function bindMigrateGrantSite(input: BindMigrateGrantSiteInput): Promise<MigrateSiteBinding | null> {
  const installation = typeof input.workspace.github_installation_id === 'number' ? input.workspace.github_installation_id : null
  if (!installation) return null
  const git = useGitProvider({ installationId: installation, owner: input.repo.owner, repo: input.repo.name })
  const project = await input.db.getProjectById(input.projectId, 'id, content_root, default_branch')
  const plan = input.plan ?? (await resolveWorkspaceBilling(input.db, input.workspace as Parameters<typeof resolveWorkspaceBilling>[1])).effectivePlan
  return ensureMigrateSiteBinding({
    db: input.db,
    grantId: input.grant.id as string,
    projectId: input.projectId,
    git,
    contentRoot: normalizeContentRoot((project?.content_root as string | null) ?? ''),
    defaultBranch: input.defaultBranch ?? (project?.default_branch as string | null) ?? await git.getDefaultBranch(),
    plan,
    studio: { baseUrl: String(useRuntimeConfig().public?.siteUrl ?? ''), mediaBaseUrl: publicMediaBase(input.projectId) },
    attempts: typeof input.grant.site_binding_attempts === 'number' ? input.grant.site_binding_attempts : 0,
  })
}

export interface SiteBindingSweepSummary {
  checked: number
  bound: number
  failed: number
  /** Left as they are: a conflict, a cap reached, or not due yet. */
  waiting: number
  alarms: number
}

type SweepDb = BindDb & Pick<DatabaseProvider, 'listMigrateSiteBindingWork' | 'markMigrateSiteBindingAlerted' | 'getWorkspaceById'>

const time = (value: unknown): number | null => (value == null ? null : new Date(String(value)).getTime())

/** One pass of the sweep. `limit` bounds the work list; the oldest attempts come first. */
export async function sweepMigrateSiteBindings(input: { db: SweepDb, now?: () => Date, limit?: number, bind?: typeof bindMigrateGrantSite }): Promise<SiteBindingSweepSummary> {
  const now = input.now ?? (() => new Date())
  const bind = input.bind ?? bindMigrateGrantSite
  const rows = await input.db.listMigrateSiteBindingWork(input.limit ?? 50, SITE_BINDING_MAX_ATTEMPTS)
  const summary: SiteBindingSweepSummary = { checked: rows.length, bound: 0, failed: 0, waiting: 0, alarms: 0 }
  for (const row of rows) {
    const state = row.site_binding_state as string | null
    const attempts = typeof row.site_binding_attempts === 'number' ? row.site_binding_attempts : 0
    const repo = { owner: String(row.repo_owner), name: String(row.repo_name) }
    const alarm = async (context: { state: string, code: string, attempts: number }) => {
      if (row.site_binding_alerted_at != null || !(await input.db.markMigrateSiteBindingAlerted(row.id as string))) return
      summary.alarms++
      reportMigrateSiteBindingAlarm({ grantId: row.id as string, projectId: row.project_id as string, repo: `${repo.owner}/${repo.name}`, ...context })
    }
    const detailCode = (row.site_binding_detail as { code?: unknown } | null)?.code

    // A person decides a conflict: never written over, only told once.
    if (state === 'conflict') {
      summary.waiting++
      await alarm({ state, code: 'conflict', attempts })
      continue
    }
    const due = state === null || (state === 'failed' && attempts < SITE_BINDING_MAX_ATTEMPTS && (time(row.site_binding_next_at) ?? 0) <= now().getTime())
    if (!due) {
      summary.waiting++
      if (state === 'failed' && attempts >= SITE_BINDING_ALARM_ATTEMPTS) await alarm({ state, code: typeof detailCode === 'string' ? detailCode : 'write_failed', attempts })
      continue
    }
    const workspace = await input.db.getWorkspaceById(row.workspace_id as string, 'id, type, plan, overage_settings, github_installation_id')
    const result = workspace
      ? await bind({ db: input.db, grant: row, workspace, projectId: row.project_id as string, repo, ...(row.project_default_branch ? { defaultBranch: row.project_default_branch as string } : {}) })
      : null
    if (!result) {
      summary.waiting++
      continue
    }
    if (result.state === 'failed') {
      summary.failed++
      if ((result.attempts ?? attempts + 1) >= SITE_BINDING_ALARM_ATTEMPTS) await alarm({ state: 'failed', code: result.code ?? 'write_failed', attempts: result.attempts ?? attempts + 1 })
      continue
    }
    if (result.state === 'conflict') {
      summary.waiting++
      await alarm({ state: 'conflict', code: 'conflict', attempts: 0 })
      continue
    }
    summary.bound++
  }
  return summary
}
