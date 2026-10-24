/**
 * Forms work on a "Migrate with Studio" site: once the bundle's delivered repository is a Studio project
 * (`connect-project`), Studio writes `studio.json` { baseUrl, projectId } to the site. The starter reads it as
 * `siteConfig.studio` (Migrate's `packages/writer/starter/astro.config.mjs`), so its forms mount Studio's live form
 * (`StudioForm` → `/api/forms/v1`) and its comment threads Studio's (`StudioComments`). The commit is the rebuild
 * trigger: a host connected to the repository rebuilds on it, one connected later builds with it.
 *
 * - **Form models are not created here.** The delivered repository already holds them (`.contentrain/models/*.json`
 *   with a `form` config, written by Migrate), and the forms API reads exactly those. They are counted against the
 *   plan's `forms.models`: over it, the binding is still written — the forms within the limit work, the others answer
 *   "needs a plan upgrade" (`forms.upgrade`, the same first-N-by-id rule as the forms API) — and the state is `partial`.
 * - **Never over another binding.** No studio.json: one commit. The same project: nothing to do. Another project, or
 *   a file that does not read as a binding: left untouched, state `conflict`, with both values for support.
 * - **The write is Studio's own path** (`createFeatureBranch` → `applyPlan` → `mergeBranch`): a protected default
 *   branch gets a pull request with the same single file (`pr_open`, its address). On a review project the owner's
 *   Connect is the approval: it is recorded against the branch's plan (approver = the grant's user) and the branch is
 *   merged under it, with a receipt; a policy that wants more than that grant leaves it for review (`pr_open`).
 * - **Idempotent**: the claim screen's retry and the sweep call it again. A binding already on `contentrain` but not yet
 *   on the default branch (its pull request still open) is not committed twice: only the merge is asked for again. A
 *   binding branch still waiting (a review project's) is found again (`cr/studio/binding/*` holding this project's
 *   binding, the recorded `detail.branch` first), never written a second time; once it is merged, the next call finds
 *   studio.json live and answers written.
 *
 * The outcome is recorded on the grant (`setMigrateGrantSiteBinding`, migrations 049/050) and returned; a failure is
 * recorded too, with its retry time, and never thrown, so connecting the project never fails because of it. The
 * sweep (`sweepMigrateSiteBindings`) retries it and raises the ops alarm.
 */
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { DatabaseProvider, MigrateSiteBindingState } from '../providers/database'
import type { GitProvider } from '../providers/git'
import { getOrBuildBrainCache, invalidateBrainCache } from './brain-cache'
import { mergeOnClick } from './click-approval'
import { createContentEngine } from './content-engine'
import { createFeatureBranch, openWriteSnapshot, writeBase } from './content-engine/helpers'
import { STUDIO_AUTHOR } from './content-engine/types'
import { getFormConfig } from './form-types'
import { getPlanLimit } from './license'
import { SITE_BINDING_BRANCH_PREFIX } from './migrate-grant'
import { projectPath, readMigrationMediaManifest } from './migration-media'
import { STUDIO_BINDING_FILE, studioBindingSource } from './migration-media-apply'

/** The commit the customer's repository gets: what it does, in its own words. */
export const SITE_BINDING_MESSAGE = 'contentrain: connect this site to Contentrain Studio (forms and comments)\n\n'
  + 'studio.json binds the site to its Studio project: its forms send to Studio and its comment threads are Studio\'s.\n'
  + 'Your host rebuilds the site on this commit.'

/** The sweep's retries (050): a `failed` binding waits 30 min, 1 h, 2 h, 4 h…; after this many in a row it stops. */
export const SITE_BINDING_RETRY_BASE_MS = 30 * 60 * 1000
export const SITE_BINDING_MAX_ATTEMPTS = 5
/** The ops alarm goes out after this many failed attempts in a row (or on any conflict), once per grant. */
export const SITE_BINDING_ALARM_ATTEMPTS = 3

/** When a binding that failed `attempts` times in a row may be tried again; null once the cap is reached. */
export function siteBindingNextAt(attempts: number, now: Date): Date | null {
  if (attempts >= SITE_BINDING_MAX_ATTEMPTS) return null
  return new Date(now.getTime() + SITE_BINDING_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

export interface MigrateSiteBinding {
  state: MigrateSiteBindingState
  /** `pr_open` from a protected branch: the pull request to merge. */
  prUrl?: string | null
  /** `partial`: the form models beyond the plan's `forms.models`, by id. */
  overLimit?: string[]
  /** `failed`: the failed attempts in a row, this one included. */
  attempts?: number
  /** `failed`: the machine code recorded for it. */
  code?: string
}

/** The note on the approval a review project's binding is merged with. */
export const SITE_BINDING_APPROVAL_NOTE = 'connect this site to Studio'

export interface MigrateSiteBindingInput {
  db: Pick<DatabaseProvider, 'setMigrateGrantSiteBinding' | 'recordApproval'>
  grantId: string
  projectId: string
  /**
   * Whose click is the approval of the binding on a review project: the grant's owner (they connected the site as its
   * workspace's owner or admin, `connect-project`), or the owner or admin who asked again from the project's setup
   * (with their role). Without it a review project's binding waits for a reviewer.
   */
  approver?: { id: string, email: string, workspaceId: string, role?: string | null }
  /** The binding branch an earlier attempt recorded (`site_binding_detail.branch`): tried first on a retry. */
  recordedBranch?: string | null
  git: GitProvider
  contentRoot: string
  defaultBranch: string
  plan: string
  /** Studio's own origin and the project's media base (`publicMediaBase`), as the media apply writes them. */
  studio: { baseUrl: string, mediaBaseUrl?: string }
  /** Failed attempts in a row before this one (`migrate_grants.site_binding_attempts`); 0 when unknown. */
  attempts?: number
  now?: () => Date
}

/** A studio.json that reads as a binding: its two values, or null. */
function bindingOf(source: string): { baseUrl: string, projectId: string } | null {
  try {
    const value = JSON.parse(source) as { baseUrl?: unknown, projectId?: unknown }
    return typeof value.baseUrl === 'string' && typeof value.projectId === 'string' ? { baseUrl: value.baseUrl, projectId: value.projectId } : null
  }
  catch {
    return null
  }
}

const sameStudio = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * The unmerged binding branches that hold this project's binding: `branch`, the one to use (the recorded one first,
 * then the newest), or null; `others`, the duplicates earlier retries left (before a retry reused its branch).
 */
async function waitingBindingBranches(git: GitProvider, path: string, projectId: string, baseUrl: string, recorded?: string | null): Promise<{ branch: string | null, others: string[] }> {
  const listed = (await git.listBranches(SITE_BINDING_BRANCH_PREFIX)).map(b => b.name).sort().reverse()
  const names = recorded && listed.includes(recorded) ? [recorded, ...listed.filter(n => n !== recorded)] : listed
  const found: string[] = []
  for (const name of names) {
    if (await git.isMerged(name)) continue
    const there = bindingOf(await git.readFile(path, name).catch(() => ''))
    if (there && there.projectId === projectId && sameStudio(there.baseUrl, baseUrl)) found.push(name)
  }
  return { branch: found[0] ?? null, others: found.slice(1) }
}

export async function ensureMigrateSiteBinding(input: MigrateSiteBindingInput): Promise<MigrateSiteBinding> {
  const now = input.now ?? (() => new Date())
  const record = async (state: MigrateSiteBindingState, detail: Record<string, unknown>, extra: Omit<MigrateSiteBinding, 'state'> = {}): Promise<MigrateSiteBinding> => {
    // A failure counts toward the sweep's retries and alarm; anything else starts the count again.
    const attempts = state === 'failed' ? (input.attempts ?? 0) + 1 : 0
    await input.db.setMigrateGrantSiteBinding(input.grantId, { state, detail, attempts, nextAt: state === 'failed' ? siteBindingNextAt(attempts, now()) : null })
    return { state, ...extra, ...(state === 'failed' ? { attempts, code: typeof detail.code === 'string' ? detail.code : 'write_failed' } : {}) }
  }
  try {
    const { git, contentRoot, defaultBranch, projectId } = input
    // The project's root: where Migrate's handoff says the site is (the repository root for a delivered site).
    const root = (await readMigrationMediaManifest(git, contentRoot, defaultBranch).catch(() => null))?.root ?? ''
    const path = projectPath(root, STUDIO_BINDING_FILE)
    const binding = studioBindingSource({ baseUrl: input.studio.baseUrl, projectId, ...(input.studio.mediaBaseUrl ? { mediaBaseUrl: input.studio.mediaBaseUrl } : {}) })

    // The forms the plan serves: the first `forms.models` form-enabled models by id, as the forms API counts them.
    const engine = createContentEngine({ git, contentRoot, projectId })
    await engine.ensureContentBranch()
    const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
    const formIds = [...brain.models.entries()].filter(([, m]) => getFormConfig(m)?.enabled).map(([id]) => id).sort()
    const limit = getPlanLimit(input.plan, 'forms.models')
    const overLimit = formIds.slice(Math.max(0, limit))
    const done = (state: 'written' | 'partial', detail: Record<string, unknown>) =>
      record(state, { ...detail, formModels: formIds.length, limit: Number.isFinite(limit) ? limit : null, ...(state === 'partial' ? { overLimit } : {}) }, state === 'partial' ? { overLimit } : {})
    const writtenState = overLimit.length ? 'partial' as const : 'written' as const
    const writeBindingBranch = async (): Promise<string> => {
      const snapshot = await openWriteSnapshot(git)
      const { branchName } = await createFeatureBranch({ git, pathCtx: { contentRoot }, projectId, ensureContentBranch: () => Promise.resolve() }, 'studio', 'binding')
      await git.applyPlan({ branch: branchName, changes: [{ path, content: binding }], message: SITE_BINDING_MESSAGE, author: STUDIO_AUTHOR, base: writeBase(snapshot) })
      return branchName
    }

    // What the site builds from: the default branch. Another binding there is never overwritten.
    const live = await git.readFile(path, defaultBranch).catch(() => null)
    if (live !== null) {
      const there = bindingOf(live)
      if (there && there.projectId === projectId && sameStudio(there.baseUrl, input.studio.baseUrl)) return done(writtenState, { path, change: 'already' })
      return record('conflict', { path, found: there ?? { unreadable: true }, expected: { baseUrl: input.studio.baseUrl, projectId } })
    }

    // Already on `contentrain` (an earlier attempt's pull request still waits): ask for the merge again, commit nothing.
    const staged = await git.readFile(path, CONTENTRAIN_BRANCH).catch(() => null)
    if (staged !== null) {
      const there = bindingOf(staged)
      if (!there || there.projectId !== projectId || !sameStudio(there.baseUrl, input.studio.baseUrl))
        return record('conflict', { path, found: there ?? { unreadable: true }, expected: { baseUrl: input.studio.baseUrl, projectId }, branch: CONTENTRAIN_BRANCH })
      const merge = await engine.finalizeContentrain([])
      if (merge.merged) return done(writtenState, { path, change: 'merged' })
      if (merge.pullRequestUrl) return record('pr_open', { path, prUrl: merge.pullRequestUrl }, { prUrl: merge.pullRequestUrl })
      return record('failed', { path, code: 'merge_not_done' })
    }

    // An earlier attempt's binding branch still waiting (a review project's, or one whose merge did not finish): the
    // same branch again, never a second one (each retry used to open another, until branch health blocked the project).
    const waiting = await waitingBindingBranches(git, path, projectId, input.studio.baseUrl, input.recordedBranch)
    // Duplicates are only reported: they are the customer's branches, and deleting them is a person's decision.
    if (waiting.others.length) {
      // eslint-disable-next-line no-console -- ops visibility: binding branches older retries left in the customer's repository
      console.warn('[migrate-site-binding] duplicate binding branches (list only)', { grantId: input.grantId, projectId, branches: waiting.others })
    }
    const duplicates = waiting.others.length ? { duplicateBranches: waiting.others } : {}
    const branchName = waiting.branch ?? await writeBindingBranch()
    // A review project's binding is approved by the click that asked for it (Connect: the grant's owner; the setup's
    // retry: the clicker), recorded against this branch's plan and tip like any reviewer's grant, then merged under it.
    // Its one file is a site config, not content, so its plan is the lowest rung with nothing in scope for a reviewer.
    const landed = await mergeOnClick({
      db: input.db,
      git,
      contentRoot,
      projectId,
      plan: input.plan,
      branch: branchName,
      brain,
      engine,
      ...(input.approver ? { approver: { ...input.approver, role: input.approver.role ?? null } } : {}),
      note: SITE_BINDING_APPROVAL_NOTE,
    })
    if (landed.held) return record('pr_open', { path, branch: branchName, review: true, ...duplicates }, { prUrl: null })
    const merge = landed.merge
    invalidateBrainCache(projectId)
    if (merge.merged) return done(writtenState, { path, change: 'written', ...duplicates })
    if (merge.pullRequestUrl) return record('pr_open', { path, prUrl: merge.pullRequestUrl }, { prUrl: merge.pullRequestUrl })
    return record('failed', { path, code: merge.conflict ? 'merge_conflict' : 'merge_not_done', branch: branchName })
  }
  catch (error) {
    const code = (error as { code?: unknown })?.code
    // eslint-disable-next-line no-console -- ops visibility: a site whose forms are not bound yet
    console.error('[migrate-site-binding]', { grantId: input.grantId, projectId: input.projectId, message: (error as Error)?.message })
    return record('failed', { code: typeof code === 'string' ? code : 'write_failed' }).catch(() => ({ state: 'failed' as const, attempts: (input.attempts ?? 0) + 1, code: 'record_failed' }))
  }
}
