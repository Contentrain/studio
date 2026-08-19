import type { FileChange } from '@contentrain/types'
import { buildContextChange } from '@contentrain/mcp/core/context'
import { bindRef, planReconcile } from '@contentrain/mcp/core/ops'
import type { Branch, EngineInternalContext, EngineMergeResult } from './types'
import { STUDIO_AUTHOR, BRANCH_PREFIX, CONTENT_BRANCH } from './types'
import { pinReaderToContentrain } from './helpers'
import { buildContextChangeFromBrain } from './context-build'
import { getOrBuildBrainCache, invalidateBrainCache } from '../brain-cache'

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
          // eslint-disable-next-line no-console
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

    // A conflict first gets the content-aware three-way merge (mcp 3.1.0's
    // planReconcile). When every difference resolves mechanically — the
    // common case: a migration PR changed schema on main while editors
    // changed content on contentrain — the divergence heals in-line and the
    // advance completes without any human. The PR below remains only for
    // what reconcile cannot decide.
    if (failure === 'conflict') {
      try {
        const reconciled = await tryReconcileAdvance(ctx, defaultBranch)
        if (reconciled) return reconciled
      }
      catch (reconcileError: unknown) {
        // Includes RECONCILE_STALE_OURS (a save landed mid-reconcile — the
        // next approve replans against the new tip) and a mid-flight main
        // move. Never fatal: the PR fallback below is always available.
        const msg = reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
        // eslint-disable-next-line no-console
        console.warn('[contentrain] reconcile attempt failed — falling back to PR:', msg)
      }
    }

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
        // eslint-disable-next-line no-console
        console.warn(`[contentrain] could not open the ${CONTENT_BRANCH} → ${defaultBranch} PR:`, prMsg)
      }
    }

    return { merged: true, sha: null, pullRequestUrl, mainAdvance: 'blocked_diverged' }
  }
}

/**
 * File extensions whose contents survive a UTF-8 string round-trip.
 *
 * `createMergeCommit` carries changes as strings, so a binary blob that
 * differs on `theirs` cannot be composed without corruption. An unknown or
 * binary extension makes the reconcile bail to the PR fallback — annoying but
 * correct, where corrupting an image would be neither. Extensionless files
 * (Dockerfile, LICENSE) pass: they are text in practice.
 */
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'json', 'jsonc', 'md', 'mdx', 'yaml', 'yml', 'toml', 'xml', 'svg',
  'css', 'scss', 'less', 'html', 'txt', 'graphql', 'sql', 'sh', 'lock',
  'env', 'example', 'gitignore', 'gitattributes', 'npmrc', 'nvmrc',
  'editorconfig', 'prettierrc', 'browserslistrc',
])

function isTextPath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return true // extensionless (Dockerfile, LICENSE) or dotfile handled below
  return TEXT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}

/**
 * Attempt the content-aware reconcile of `main` into `contentrain` and, on
 * success, complete the advance. Returns null whenever the PR fallback is the
 * right next move: capability missing, conflicts survived, or a file the
 * GitHub tree path cannot compose safely.
 */
async function tryReconcileAdvance(
  ctx: EngineInternalContext,
  defaultBranch: string,
): Promise<EngineMergeResult | null> {
  const { getMergeBase, createMergeCommit } = ctx.git
  if (!getMergeBase || !createMergeCommit) return null

  const branches = await ctx.git.listBranches()
  const oursSha = branches.find(b => b.name === CONTENT_BRANCH)?.sha
  const theirsSha = branches.find(b => b.name === defaultBranch)?.sha
  if (!oursSha || !theirsSha) return null

  const baseSha = await getMergeBase(CONTENT_BRANCH, defaultBranch)
  // No shared history, or theirs already contained — either way this is not
  // the divergence reconcile solves.
  if (!baseSha || baseSha === theirsSha) return null

  const plan = await planReconcile({
    base: bindRef(ctx.git, baseSha),
    ours: bindRef(ctx.git, oursSha),
    theirs: bindRef(ctx.git, theirsSha),
    source: 'studio-ui',
  })

  if (plan.conflicts.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[contentrain] reconcile found ${plan.conflicts.length} conflict(s) — falling back to PR`)
    return null
  }

  const codeDelta = await composeCodeDelta(ctx, oursSha, theirsSha, plan.changes)
  if (codeDelta === null) return null

  await createMergeCommit({
    branch: CONTENT_BRANCH,
    ours: oursSha,
    theirs: theirsSha,
    changes: [...plan.changes, ...codeDelta],
    message: `contentrain: reconcile ${defaultBranch} into ${CONTENT_BRANCH}`,
    author: STUDIO_AUTHOR,
  })

  // The merge commit changed contentrain's content (theirs' side landed);
  // readers must not serve the pre-reconcile snapshot.
  if (ctx.projectId) invalidateBrainCache(ctx.projectId)

  // theirs is now an ancestor of contentrain — the advance is a fast-forward.
  const advanced = await ctx.git.mergeBranch(CONTENT_BRANCH, defaultBranch)
  return { ...advanced, mainAdvance: 'advanced' }
}

/**
 * The one real trap in the GitHub tree path, named by the ecosystem's
 * Appendix C: `createMergeCommit` applies `changes` on top of the OURS tree.
 * The planner only speaks for content-owned paths — so theirs-only changes to
 * everything else (the migration commit's package.json, lockfile, source
 * files) MUST be composed in, or the merge commit's tree silently reverts
 * them and fast-forwarding main erases main's own code. The local executor
 * gets this from `git merge` for free; on the tree path the orchestrator is
 * the one who has to do it.
 *
 * Sound because of the branch model itself: nothing writes non-content paths
 * to contentrain (its code is main's code as of the last sync), so for those
 * paths ours == base and every ours↔theirs difference IS theirs' change. The
 * planner separately reports a hand-committed code change on contentrain as a
 * `file` conflict, which bails before this runs.
 */
async function composeCodeDelta(
  ctx: EngineInternalContext,
  oursSha: string,
  theirsSha: string,
  plannerChanges: FileChange[],
): Promise<FileChange[] | null> {
  const contentRoot = ctx.pathCtx.contentRoot
  const toRepoPath = (p: string) => (contentRoot ? `${contentRoot}/${p}` : p)
  const rootPrefix = contentRoot ? `${contentRoot}/` : ''

  const plannerRepoPaths = new Set(plannerChanges.map(c => toRepoPath(c.path)))

  // Content-owned prefixes: `.contentrain/` always; custom `content_path`
  // roots when the model definitions are reachable. A content path the
  // planner did NOT emit means "merged result equals ours" — taking theirs
  // for it would overrule the policy table.
  const contentPrefixes = [`${rootPrefix}.contentrain/`]
  if (ctx.projectId) {
    try {
      const brain = await getOrBuildBrainCache(ctx.git, contentRoot, ctx.projectId)
      for (const model of brain.models.values()) {
        const customPath = (model as { content_path?: string }).content_path
        if (customPath) contentPrefixes.push(`${toRepoPath(customPath)}/`)
      }
    }
    catch { /* brain unavailable — the .contentrain/ prefix still holds */ }
  }

  const [oursTree, theirsTree] = await Promise.all([
    ctx.git.getTree(oursSha),
    ctx.git.getTree(theirsSha),
  ])
  const ours = new Map(oursTree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]))
  const theirs = new Map(theirsTree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]))

  const changes: FileChange[] = []
  for (const path of new Set([...ours.keys(), ...theirs.keys()])) {
    if (ours.get(path) === theirs.get(path)) continue
    if (plannerRepoPaths.has(path)) continue
    if (contentPrefixes.some(prefix => path.startsWith(prefix))) continue

    // Provider file access is content-root-relative; a differing file outside
    // the content root cannot be read or written through it. Bail to the PR
    // rather than produce a merge commit that silently drops it.
    if (rootPrefix && !path.startsWith(rootPrefix)) {
      // eslint-disable-next-line no-console
      console.warn(`[contentrain] reconcile: "${path}" lies outside the content root — falling back to PR`)
      return null
    }
    const relPath = rootPrefix ? path.slice(rootPrefix.length) : path

    if (!theirs.has(path)) {
      changes.push({ path: relPath, content: null })
      continue
    }
    if (!isTextPath(path)) {
      // eslint-disable-next-line no-console
      console.warn(`[contentrain] reconcile: "${path}" is not safely text-composable — falling back to PR`)
      return null
    }
    changes.push({ path: relPath, content: await ctx.git.readFile(relPath, theirsSha) })
  }

  return changes
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
