/**
 * MCP Cloud write landing.
 *
 * MCP's remote (GitHub) write path always reports `pending-review` and
 * leaves the merge to "Studio (or whatever orchestrator is driving the
 * server)" — see `commitThroughProvider` in `@contentrain/mcp/server/http`.
 * So a write issued by an external agent over MCP Cloud lands as a `cr/*`
 * branch and stays there until Studio decides.
 *
 * Studio decides it the way its own write routes do (status.patch.ts,
 * content/[modelId].post.ts): the project's effective workflow — `review`
 * only when the plan grants `workflow.review` AND `config.workflow` asks for
 * it — and then `decideMerge` with the write's real tool, scope and signals
 * against the project's approval policy. An auto-merge project lands the
 * write; on a review project the policy decides, so the default policy holds
 * every write for a person, and a write the owner's policy allows lands as it
 * would from the UI.
 *
 * Only the branch the call itself produced is judged. Other pending `cr/*`
 * branches are never swept: their tool and payload are not known here, and a
 * branch the policy held must stay held.
 *
 * The two-step merge is split deliberately. Step 1 (`cr/* → contentrain`) is
 * awaited, because it is the half the caller can observe — an agent that
 * immediately re-reads or deletes what it just wrote is otherwise racing its
 * own merge. Step 2 (context.json regeneration + `contentrain → main`) runs
 * detached: no MCP caller reads `main`, and content reads come from the tree.
 * This mirrors the chat agent, which lands writes on `contentrain` per save
 * and flushes the finalize once at turn end.
 */
import type { HeldApproval, ToolScope, WriteSignals } from './approval-gate'
import { decideMerge, toolRisk, writeSignals } from './approval-gate'
import type { Plan } from './license'
import { hasFeature } from './license'
import { createContentEngine } from './content-engine'
import { getOrBuildBrainCache, invalidateBrainCache } from './brain-cache'
import { branchWriteSignals } from './branch-approval'
import { useGitProvider } from './providers'

export interface McpCloudAutoMergeParams {
  workspaceId: string
  projectId: string
  installationId: number
  repoFullName: string
  contentRoot: string
  plan: Plan
}

/** One write tool call and the branch its result named. */
export interface McpCloudWrite {
  tool: string
  arguments: Record<string, unknown>
  branch: string
  commitSha?: string
}

export type McpCloudMergeOutcome
  = | { status: 'merged' }
    | { status: 'held', approval?: HeldApproval }
    | { status: 'pending' }

/** MCP write tool → the Studio tool the approval policy classifies. */
const POLICY_TOOL: Record<string, string> = {
  contentrain_content_save: 'save_content',
  contentrain_content_delete: 'delete_content',
  contentrain_content_status: 'update_status',
  contentrain_model_save: 'save_model',
  contentrain_model_delete: 'delete_model',
  contentrain_vocabulary_save: 'vocabulary',
  contentrain_vocabulary_delete: 'vocabulary',
}

interface BrainView {
  defaultLocale: string
  supportedLocales: string[]
  kindOf: (model: string) => string | undefined
}

const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []

/** The scope and payload signals of a write, read from its arguments. */
export function mcpWriteScope(tool: string, args: Record<string, unknown>, brain: BrainView): { scope: ToolScope, signals: WriteSignals } {
  const model = str(args.model)
  switch (tool) {
    case 'contentrain_content_save': {
      const entries = Array.isArray(args.entries) ? args.entries as Array<Record<string, unknown>> : []
      const kind = model ? brain.kindOf(model) : undefined
      const single = kind === 'singleton' || kind === 'dictionary'
      // An entry without an id gets one from MCP; it still counts as one entry.
      const ids = single && model ? [model] : entries.map((e, i) => str(e?.id) ?? str(e?.slug) ?? `new-${i + 1}`)
      const locales = [...new Set(entries.map(e => str(e?.locale) ?? brain.defaultLocale))]
      return {
        scope: { models: model ? [model] : [], locales, entries: ids },
        signals: writeSignals('save_content', { documents: entries.map(e => ({ data: e?.data, body: e?.body })) }),
      }
    }
    case 'contentrain_content_status': {
      const locale = str(args.locale)
      const ids = strings(args.entry_ids).length ? strings(args.entry_ids) : strings(args.slugs)
      return {
        scope: {
          models: model ? [model] : [],
          // No locale = every supported locale (the tool's contract).
          locales: locale ? [locale] : brain.supportedLocales,
          entries: ids.length ? ids : model ? [model] : [],
        },
        signals: writeSignals('update_status', { status: args.status }),
      }
    }
    case 'contentrain_content_delete': {
      const id = str(args.id) ?? str(args.slug) ?? model
      return { scope: { models: model ? [model] : [], locales: [str(args.locale) ?? brain.defaultLocale], entries: id ? [id] : [] }, signals: {} }
    }
    case 'contentrain_model_save': {
      const id = str(args.id)
      return { scope: { models: id ? [id] : [] }, signals: {} }
    }
    case 'contentrain_model_delete':
      return { scope: { models: model ? [model] : [] }, signals: {} }
    default:
      return { scope: {}, signals: {} }
  }
}

/**
 * Judge and land the branches these write calls produced. Never throws: a
 * failure leaves the branch pending, which is what MCP already reported.
 */
export async function reconcileMcpCloudWrites(
  params: McpCloudAutoMergeParams,
  writes: McpCloudWrite[],
): Promise<Map<string, McpCloudMergeOutcome>> {
  const outcomes = new Map<string, McpCloudMergeOutcome>()
  const { projectId, installationId, repoFullName, contentRoot, plan } = params

  try {
    const [owner = '', repo = ''] = repoFullName.split('/')
    if (!owner || !repo || writes.length === 0) return outcomes

    const git = useGitProvider({ installationId, owner, repo })
    // The write just invalidated the cache, so this reads the policy and the
    // workflow as they are now.
    const brain = await getOrBuildBrainCache(git, contentRoot, projectId)
    const workflow = hasFeature(plan, 'workflow.review') ? (brain.config?.workflow ?? 'auto-merge') : 'auto-merge'
    const config = brain.config as { locales?: { default?: string, supported?: string[] } } | null
    const defaultLocale = config?.locales?.default ?? 'en'
    const view: BrainView = {
      defaultLocale,
      supportedLocales: config?.locales?.supported?.length ? config.locales.supported : [defaultLocale],
      kindOf: model => brain.models.get(model)?.kind,
    }

    const engine = createContentEngine({ git, contentRoot, projectId })
    const landed: string[] = []

    for (const write of writes) {
      const tool = POLICY_TOOL[write.tool]
      // A write the policy cannot classify is never landed on a guess.
      if (!tool || !write.branch.startsWith('cr/')) {
        outcomes.set(write.branch, { status: 'pending' })
        continue
      }
      try {
        const { scope, signals: payloadSignals } = mcpWriteScope(write.tool, write.arguments, view)
        // Whether the write empties a field or drops list items is read off the
        // branch it wrote, as the UI save route does, when it could change the answer.
        const signals = workflow === 'review' && toolRisk(tool, scope, payloadSignals) === 'low_risk_content'
          ? { ...payloadSignals, ...await branchWriteSignals({ git, contentRoot, projectId, branch: write.branch }) }
          : payloadSignals
        const gate = await decideMerge({
          workflow,
          tool,
          scope,
          signals,
          policy: brain.approvalPolicy,
          ...(write.commitSha ? { commitSha: write.commitSha } : {}),
        })
        if (!gate.allowed) {
          outcomes.set(write.branch, { status: 'held', ...(gate.review.approval ? { approval: gate.review.approval } : {}) })
          continue
        }
        const step1 = await engine.mergeToContentrain(write.branch)
        if (step1.merged) {
          landed.push(write.branch)
          outcomes.set(write.branch, { status: 'merged' })
        }
        else {
          outcomes.set(write.branch, { status: 'pending' })
        }
      }
      catch {
        // Best-effort: another path may merge it, or it conflicts.
        outcomes.set(write.branch, { status: 'pending' })
      }
    }

    if (landed.length === 0) return outcomes

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

  return outcomes
}
