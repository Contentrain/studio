/**
 * MCP Cloud write reconciliation.
 *
 * MCP's remote (GitHub) write path always reports `pending-review` and
 * leaves the merge to "Studio (or whatever orchestrator is driving the
 * server)" — see `commitThroughProvider` in `@contentrain/mcp/server/http`.
 * So a content/model write issued by an external agent over MCP Cloud lands
 * as a `cr/*` branch and does NOT auto-publish, even on projects configured
 * for `workflow: auto-merge`.
 *
 * To keep MCP Cloud a first-class write path — consistent with Studio's
 * native write paths (chat / forms / content API) — this reconciler lands
 * those pending branches when, and only when, the project's effective
 * workflow is auto-merge. The effective workflow is resolved with the exact
 * same rule the native paths use:
 *
 *   review is honored ONLY when the plan grants `workflow.review` AND the
 *   project opts into it via `config.workflow`; otherwise auto-merge.
 *
 * So this both honors the project's `config.json` setting and the user's
 * plan/package permissions. On review-gated projects it is a no-op — those
 * branches stay pending for human review.
 *
 * Best-effort by contract: every step is guarded so a reconciliation failure
 * can never surface to the external caller.
 *
 * The two-step merge is split deliberately. Step 1 (`cr/* → contentrain`) is
 * awaited, because it is the half the caller can observe — an agent that
 * immediately re-reads or deletes what it just wrote is otherwise racing its
 * own merge. Step 2 (context.json regeneration + `contentrain → main`) runs
 * detached: no MCP caller reads `main`, and content reads come from the tree.
 * This mirrors the chat agent, which lands writes on `contentrain` per save
 * and flushes the finalize once at turn end.
 */
import type { ContentrainConfig } from '@contentrain/types'
import { CONTENTRAIN_BRANCH } from '@contentrain/types'
import type { Plan } from './license'
import { hasFeature } from './license'
import { createContentEngine } from './content-engine'
import { resolveConfigPath } from './content-paths'
import { invalidateBrainCache } from './brain-cache'
import { useGitProvider } from './providers'

export interface McpCloudAutoMergeParams {
  workspaceId: string
  projectId: string
  installationId: number
  repoFullName: string
  contentRoot: string
  plan: Plan
}

/**
 * Resolve the effective workflow for a project — identical rule to the
 * native chat / content-API handlers: `review` requires both the plan
 * feature and the project opt-in; everything else collapses to auto-merge.
 */
function resolveEffectiveWorkflow(plan: Plan, configWorkflow: string | undefined): 'auto-merge' | 'review' {
  if (!hasFeature(plan, 'workflow.review')) return 'auto-merge'
  return configWorkflow === 'review' ? 'review' : 'auto-merge'
}

/**
 * Land the pending `cr/*` branches an MCP Cloud write produced — but only on
 * auto-merge projects. No-op (and never throws) otherwise.
 */
export async function reconcileMcpCloudAutoMerge(params: McpCloudAutoMergeParams): Promise<void> {
  const { workspaceId: _workspaceId, projectId, installationId, repoFullName, contentRoot, plan } = params

  try {
    const [owner = '', repo = ''] = repoFullName.split('/')
    if (!owner || !repo) return

    const git = useGitProvider({ installationId, owner, repo })

    // Resolve the project workflow from config.json on the content branch.
    let configWorkflow: string | undefined
    try {
      const raw = await git.readFile(resolveConfigPath({ contentRoot }), CONTENTRAIN_BRANCH)
      configWorkflow = (JSON.parse(raw) as ContentrainConfig).workflow
    }
    catch { /* missing/unreadable config → default rule applies below */ }

    if (resolveEffectiveWorkflow(plan, configWorkflow) !== 'auto-merge') return

    const engine = createContentEngine({ git, contentRoot, projectId })
    const branches = await engine.listContentBranches()

    // Step 1 only — `cr/* → contentrain`. This is the half the caller can
    // observe: once it lands, an agent that immediately lists or deletes what
    // it just wrote sees it. The awaited path is therefore kept to it alone.
    const landed: string[] = []
    for (const branch of branches) {
      const isMerged = await git.isMerged(branch.name).catch(() => true)
      if (isMerged) continue
      try {
        const step1 = await engine.mergeToContentrain(branch.name)
        if (step1.merged) landed.push(branch.name)
      }
      catch { /* best-effort: another path may merge it, or it conflicts */ }
    }

    if (landed.length === 0) return

    // Refresh the brain cache so the next read reflects the landed content.
    invalidateBrainCache(projectId)

    // Step 2 — context.json regeneration + the `contentrain → main` advance —
    // is bookkeeping no MCP caller observes: agents read `contentrain`, never
    // `main`, and content reads come from the tree rather than `context.json`.
    // The chat agent already defers exactly this half to its turn end
    // (`flushTurnMerges`); MCP Cloud has no turn boundary, so it runs detached
    // instead of holding the agent open for ~9s of round trips it cannot see.
    //
    // Same failure contract as every other finalize call site: best-effort,
    // self-healing on the next merge. The second invalidation matters — the
    // regeneration rebuilds the brain snapshot, so dropping it again closes
    // the window where a reader could cache pre-finalize stats.
    void engine.finalizeContentrain(landed)
      .then(() => invalidateBrainCache(projectId))
      .catch(() => {})
  }
  catch { /* best-effort: MCP Cloud writes still succeeded as pending branches */ }
}
