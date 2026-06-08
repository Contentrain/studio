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
 * can never surface to the external caller. The caller invokes it
 * fire-and-forget after a successful write tool call.
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

    let merged = false
    for (const branch of branches) {
      const isMerged = await git.isMerged(branch.name).catch(() => true)
      if (isMerged) continue
      try {
        await engine.mergeBranch(branch.name)
        merged = true
      }
      catch { /* best-effort: another path may merge it, or it conflicts */ }
    }

    // Refresh the brain cache so the next read reflects the landed content.
    if (merged) invalidateBrainCache(projectId)
  }
  catch { /* best-effort: MCP Cloud writes still succeeded as pending branches */ }
}
