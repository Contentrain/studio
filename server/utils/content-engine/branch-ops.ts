import type { FileChange } from '@contentrain/types'
import { buildContextChange } from '@contentrain/mcp/core/context'
import type { Branch, EngineInternalContext, EngineMergeResult } from './types'
import { STUDIO_AUTHOR, BRANCH_PREFIX, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain } from './helpers'
import { buildContextChangeFromBrain } from './context-build'
import { getOrBuildBrainCache } from '../brain-cache'

/**
 * Ensure the dedicated `contentrain` branch exists and is synced with main.
 *
 * Per git-architecture.md §3.1 Step 2:
 * - If contentrain doesn't exist: create from default branch
 * - If contentrain exists: merge main -> contentrain (sync, ensures fast-forward later)
 *
 * Returns a guard function that can be called repeatedly (no-op after first run).
 */
export function createBranchGuard(ctx: EngineInternalContext) {
  let ensured = false

  return async function ensureContentBranch(): Promise<void> {
    if (ensured) return

    const branches = await ctx.git.listBranches()
    const hasContentBranch = branches.some(b => b.name === CONTENT_BRANCH)

    if (!hasContentBranch) {
      const defaultBranch = await ctx.git.getDefaultBranch()
      await ctx.git.createBranch(CONTENT_BRANCH, defaultBranch)

      // Migration: merge then delete old contentrain/* branches (ref namespace collision)
      const oldBranches = branches.filter(b => b.name.startsWith('contentrain/'))
      for (const old of oldBranches) {
        try {
          await ctx.git.mergeBranch(old.name, CONTENT_BRANCH)
        }
        catch {
          // eslint-disable-next-line no-console
          console.warn(`[contentrain] Migration: could not merge old branch ${old.name} — content may be lost`)
        }
        try {
          await ctx.git.deleteBranch(old.name)
        }
        catch { /* best-effort cleanup */ }
      }

      // Advance main to include any migrated content
      if (oldBranches.length > 0) {
        try {
          await ctx.git.mergeBranch(CONTENT_BRANCH, defaultBranch)
        }
        catch { /* branch protection may block — acceptable */ }
      }
    }
    else {
      // Sync: merge main -> contentrain (spec Step 2)
      const defaultBranch = await ctx.git.getDefaultBranch()
      try {
        await ctx.git.mergeBranch(defaultBranch, CONTENT_BRANCH)
      }
      catch (e: unknown) {
        // A conflict here means the branches have DIVERGED: something touched
        // `.contentrain/` on main outside the content pipeline (a dependency
        // migration, a hand edit). That is a legitimate, recoverable state —
        // writes keep landing on contentrain and the advance opens a PR — but
        // it never self-heals, so swallowing it silently (as this catch did,
        // under a comment claiming the two branches held "different
        // directories") turned a recoverable state into an invisible one.
        if (classifyMergeFailure(e) === 'conflict') {
          console.warn(
            `[contentrain] main → contentrain sync conflict — branches have diverged`
            + `${ctx.projectId ? ` (project=${ctx.projectId})` : ''}. `
            + `Content writes continue on contentrain; the next advance will open a PR.`,
          )
        }
        // Everything else stays best-effort, as before.
      }
    }

    ensured = true
  }
}

/**
 * Sort a merge failure into the classes the flow can act on. GitHub's merge
 * API speaks in status codes and message prefixes; both are checked because
 * the error may arrive as a raw Octokit HttpError or wrapped.
 */
function classifyMergeFailure(e: unknown): 'conflict' | 'missing_head' | 'blocked' | 'unknown' {
  const status = (e as { status?: number }).status ?? (e as { statusCode?: number }).statusCode
  const msg = e instanceof Error ? e.message : String(e)
  if (status === 409 || msg.includes('Merge conflict')) return 'conflict'
  if (msg.includes('Head does not exist')) return 'missing_head'
  if (msg.includes('protected') || msg.includes('403') || msg.includes('not allowed')) return 'blocked'
  return 'unknown'
}

/**
 * List contentrain/* branches (pending changes).
 */
export async function listContentBranches(ctx: EngineInternalContext): Promise<Branch[]> {
  return ctx.git.listBranches(BRANCH_PREFIX)
}

/**
 * Step 1 of the two-step merge: land a `cr/*` branch on `contentrain`
 * (the content SSOT) and clean the feature branch up. Durability is
 * unchanged — every write still reaches `contentrain` immediately.
 */
export async function mergeToContentrain(
  ctx: EngineInternalContext,
  branch: string,
): Promise<{ merged: boolean, sha: string | null }> {
  const step1 = await ctx.git.mergeBranch(branch, CONTENT_BRANCH)
  if (!step1.merged) {
    return { merged: false, sha: null }
  }

  // Clean up feature branch after successful merge to contentrain
  try {
    await ctx.git.deleteBranch(branch)
  }
  catch {
    // Branch may have been auto-deleted
  }

  return { merged: true, sha: step1.sha }
}

/**
 * Finalize `contentrain` after one or more branches landed on it:
 * regenerate context.json once, then advance contentrain -> main
 * (step 2, with PR fallback on protected branches).
 *
 * `mergedBranches` carries the branches landed since the last finalize;
 * the LAST one wins `lastOperation` in context.json — identical to the
 * sequential per-save behavior, where the final merge's regeneration
 * was the survivor.
 */
export async function finalizeContentrain(
  ctx: EngineInternalContext,
  mergedBranches: string[],
): Promise<EngineMergeResult> {
  const lastBranch = mergedBranches.at(-1)
  if (lastBranch) {
    // Regenerate context.json on contentrain now that the content has
    // landed — feature branches no longer carry it (MCP 1.5.0 model), so
    // it is rebuilt here from the merged tree before main is advanced.
    await regenerateContextOnContentrain(ctx, lastBranch)
  }

  // Step 2: advance contentrain -> main
  const defaultBranch = await ctx.git.getDefaultBranch()
  try {
    const advanced = await ctx.git.mergeBranch(CONTENT_BRANCH, defaultBranch)
    return { ...advanced, mainAdvance: 'advanced' }
  }
  catch (e: unknown) {
    // By the time this runs, the content is on `contentrain` — the branch
    // every reader (brain, CDN, MCP) uses. So an advance failure is NOT a
    // failed merge, and reporting it as one is what made an Approve on a
    // diverged repo read as a lost save. Two failure classes fall back to a
    // PR — the place a developer resolves either one:
    //  - blocked: main is protected, the merge API is not allowed to touch it
    //  - conflict: main has commits contentrain does not (out-of-Studio
    //    `.contentrain/` changes — a migration PR, a hand edit). This never
    //    self-heals; the PR is where a human reconciles it.
    const failure = classifyMergeFailure(e)
    if (failure !== 'blocked' && failure !== 'conflict') throw e

    let pullRequestUrl: string | null = null
    try {
      const pr = await ctx.git.createPR(
        CONTENT_BRANCH,
        defaultBranch,
        `contentrain: advance content to ${defaultBranch}`,
        failure === 'conflict'
          ? `The \`${CONTENT_BRANCH}\` branch and \`${defaultBranch}\` have diverged — `
          + `\`${defaultBranch}\` carries changes made outside the content pipeline. `
          + `Content edits live on the \`${CONTENT_BRANCH}\` side; resolve the conflicts here `
          + `to bring \`${defaultBranch}\` back in step.\n\nOpened by Contentrain Studio.`
          : 'Auto-generated by Contentrain Studio.',
      )
      pullRequestUrl = pr.url
    }
    catch (prError: unknown) {
      // GitHub answers 422 when a PR for this head/base already exists — the
      // previous blocked advance opened it. Any other PR failure is logged,
      // not thrown: the content landed, and turning a bookkeeping failure
      // into a 500 would repeat the exact lie this function stopped telling.
      const prMsg = prError instanceof Error ? prError.message : String(prError)
      if (!prMsg.includes('already exists')) {
        console.warn(`[contentrain] could not open the ${CONTENT_BRANCH} → ${defaultBranch} PR:`, prMsg)
      }
    }

    return { merged: true, sha: null, pullRequestUrl, mainAdvance: 'blocked_diverged' }
  }
}

/**
 * Two-step merge per git-architecture.md §3:
 * Step 1: cr/* -> contentrain (always immediate)
 * Step 2: contentrain -> main (may fallback to PR if branch-protected)
 *
 * Pure composition of `mergeToContentrain` + `finalizeContentrain` —
 * single-write callers (UI routes, forms, MCP-cloud reconcile) keep
 * exactly this behavior. The agent tool loop calls the two halves
 * separately so a multi-save turn finalizes once at turn end.
 */
export async function mergeBranch(ctx: EngineInternalContext, branch: string): Promise<EngineMergeResult> {
  let step1: { merged: boolean, sha: string | null }
  try {
    step1 = await mergeToContentrain(ctx, branch)
  }
  catch (e: unknown) {
    switch (classifyMergeFailure(e)) {
      case 'missing_head':
        // The branch is gone, and in this flow the only thing that deletes a
        // cr/* branch is our own post-merge cleanup. So this is a RETRY after
        // an advance failure: step 1 landed last time, the user clicked
        // Approve again, and the old behavior answered the second click with
        // an unhandled "Head does not exist" 500. Finish the half that
        // actually failed instead.
        return finalizeContentrain(ctx, [branch])
      case 'conflict':
        // A real cr/* vs contentrain conflict — contentrain moved against
        // this branch since it forked. The one case where "resolve manually"
        // is the honest answer.
        return { merged: false, sha: null, pullRequestUrl: null }
      default:
        throw e
    }
  }
  if (!step1.merged) {
    return { merged: false, sha: null, pullRequestUrl: null }
  }
  return finalizeContentrain(ctx, [branch])
}

/**
 * Reject (delete) a content branch.
 */
export async function rejectBranch(ctx: EngineInternalContext, branch: string): Promise<void> {
  await ctx.git.deleteBranch(branch)
}

/**
 * Regenerate `context.json` deterministically on the `contentrain` branch
 * after a feature branch lands (MCP 1.5.0 model).
 *
 * Feature branches no longer carry `context.json`, which removes the
 * merge-conflict surface when parallel `cr/*` saves land. Instead the file
 * is rebuilt here from the merged `contentrain` tree so its stats
 * (model / entry counts) reflect post-merge reality. The brain cache and
 * external readers only ever read `context.json` from `contentrain`, so
 * this is the single point where it needs to be accurate.
 *
 * Best-effort: a failure (transient git error, or a concurrent
 * regeneration losing the non-fast-forward ref update) is swallowed — the
 * next merge regenerates it correctly.
 */
async function regenerateContextOnContentrain(
  ctx: EngineInternalContext,
  mergedBranch: string,
): Promise<void> {
  try {
    const operation = parseMergeOperation(mergedBranch)

    // Preferred path: derive stats from the brain snapshot. Running
    // AFTER the cr→contentrain merge, the brain's tree compare (or its
    // stale flag) picks up the merged content — an incremental refresh
    // of ~1-3 calls instead of MCP's O(models × locales) repo walk.
    // Also emits the contentRoot-aware context path, fixing the latent
    // bug where the MCP fallback (provider built without contentRoot in
    // resolveProjectContext) writes context.json at the repo root for
    // contentRoot projects.
    let contextChange: FileChange | null = null
    if (ctx.projectId) {
      try {
        const brain = await getOrBuildBrainCache(ctx.git, ctx.pathCtx.contentRoot, ctx.projectId)
        contextChange = buildContextChangeFromBrain(brain, ctx.pathCtx, operation)
      }
      catch { /* brain unavailable — fall back to the MCP walk */ }
    }

    const reader = pinReaderToContentrain(ctx.git)
    if (!contextChange) {
      contextChange = await buildContextChange(reader, operation, 'mcp-studio')
    }

    // Skip an empty commit when the merged tree already carries an
    // identical context.json.
    try {
      const current = await reader.readFile(contextChange.path)
      if (current === contextChange.content) return
    }
    catch { /* no existing context.json — fall through and write it */ }

    await ctx.git.applyPlan({
      branch: CONTENT_BRANCH,
      changes: [contextChange],
      message: 'contentrain: regenerate context.json',
      author: STUDIO_AUTHOR,
      base: CONTENT_BRANCH,
    })
  }
  catch {
    // Best-effort: context.json self-heals on the next merge.
  }
}

/**
 * Derive the `context.json` lastOperation from a merged `cr/*` branch name.
 * Format: `cr/{scope}/{target}[/{locale}]/{timestamp}-{suffix}`.
 */
function parseMergeOperation(branch: string): { tool: string, model: string, locale?: string } {
  const parts = branch.split('/')
  // cr / scope / target / [locale] / timestamp-suffix
  const model = parts[2] ?? ''
  const locale = parts.length >= 5 ? parts[3] : undefined
  return { tool: 'merge', model, locale }
}
