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
 *   branch gets a pull request with the same single file (`pr_open`, its address), a review project leaves it on its
 *   `cr/*` branch for review (`pr_open`).
 * - **Idempotent**: the claim screen's retry calls it again. A binding already on `contentrain` but not yet on the
 *   default branch (its pull request still open) is not committed twice: only the merge is asked for again.
 *
 * The outcome is recorded on the grant (`setMigrateGrantSiteBinding`, migration 049) and returned; a failure is
 * recorded too and never thrown, so connecting the project never fails because of it.
 */
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { DatabaseProvider, MigrateSiteBindingState } from '../providers/database'
import type { GitProvider } from '../providers/git'
import { effectiveWorkflow } from './branch-approval'
import { getOrBuildBrainCache, invalidateBrainCache } from './brain-cache'
import { createContentEngine } from './content-engine'
import { createFeatureBranch, openWriteSnapshot, writeBase } from './content-engine/helpers'
import { STUDIO_AUTHOR } from './content-engine/types'
import { getFormConfig } from './form-types'
import { getPlanLimit, hasFeature } from './license'
import { projectPath, readMigrationMediaManifest } from './migration-media'
import { STUDIO_BINDING_FILE, studioBindingSource } from './migration-media-apply'

/** The commit the customer's repository gets: what it does, in its own words. */
export const SITE_BINDING_MESSAGE = 'contentrain: connect this site to Contentrain Studio (forms and comments)\n\n'
  + 'studio.json binds the site to its Studio project: its forms send to Studio and its comment threads are Studio\'s.\n'
  + 'Your host rebuilds the site on this commit.'

export interface MigrateSiteBinding {
  state: MigrateSiteBindingState
  /** `pr_open` from a protected branch: the pull request to merge. */
  prUrl?: string | null
  /** `partial`: the form models beyond the plan's `forms.models`, by id. */
  overLimit?: string[]
}

export interface MigrateSiteBindingInput {
  db: Pick<DatabaseProvider, 'setMigrateGrantSiteBinding'>
  grantId: string
  projectId: string
  git: GitProvider
  contentRoot: string
  defaultBranch: string
  plan: string
  /** Studio's own origin and the project's media base (`publicMediaBase`), as the media apply writes them. */
  studio: { baseUrl: string, mediaBaseUrl?: string }
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

export async function ensureMigrateSiteBinding(input: MigrateSiteBindingInput): Promise<MigrateSiteBinding> {
  const record = async (state: MigrateSiteBindingState, detail: Record<string, unknown>, extra: Omit<MigrateSiteBinding, 'state'> = {}): Promise<MigrateSiteBinding> => {
    await input.db.setMigrateGrantSiteBinding(input.grantId, { state, detail })
    return { state, ...extra }
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

    const snapshot = await openWriteSnapshot(git)
    const { branchName } = await createFeatureBranch({ git, pathCtx: { contentRoot }, projectId, ensureContentBranch: () => Promise.resolve() }, 'studio', 'binding')
    await git.applyPlan({ branch: branchName, changes: [{ path, content: binding }], message: SITE_BINDING_MESSAGE, author: STUDIO_AUTHOR, base: writeBase(snapshot) })
    // A review project holds it like any other change: it waits on its branch for a reviewer.
    if (effectiveWorkflow(brain.config?.workflow, hasFeature(input.plan, 'workflow.review')) === 'review')
      return record('pr_open', { path, branch: branchName, review: true }, { prUrl: null })
    const merge = await engine.mergeBranch(branchName)
    invalidateBrainCache(projectId)
    if (merge.merged) return done(writtenState, { path, change: 'written' })
    if (merge.pullRequestUrl) return record('pr_open', { path, prUrl: merge.pullRequestUrl }, { prUrl: merge.pullRequestUrl })
    return record('failed', { path, code: merge.conflict ? 'merge_conflict' : 'merge_not_done', branch: branchName })
  }
  catch (error) {
    const code = (error as { code?: unknown })?.code
    // eslint-disable-next-line no-console -- ops visibility: a site whose forms are not bound yet
    console.error('[migrate-site-binding]', { grantId: input.grantId, projectId: input.projectId, message: (error as Error)?.message })
    return record('failed', { code: typeof code === 'string' ? code : 'write_failed' }).catch(() => ({ state: 'failed' as const }))
  }
}
