import type { ContentEngineContext, EngineInternalContext, EngineMergeResult, SaveOptions, WriteResult } from './types'
import { classifyMergeFailure, createBranchGuard, finalizeContentrain, listContentBranches, mergeBranch, mergeToContentrain, rejectBranch } from './branch-ops'
import { deleteContent } from './delete-content'
import { initProject } from './init-project'
import { saveContent } from './save-content'
import type { DocumentInput } from './save-document'
import { saveDocument, saveDocuments } from './save-document'
import type { TextEdit } from './replace-text'
import { replaceText } from './replace-text'
import { saveModel } from './save-model'
import { deleteModel } from './delete-model'
import { addLocale, saveVocabulary } from './config-ops'
import { copyLocale, updateEntryStatus } from './update-status'
import { triggerProjectDeploy } from '../deploy-hooks'
import { clearEntrySchedules, registerEntrySchedules } from '../schedule-registry'

/**
 * Side effects that ride on a successful write but must never fail it:
 * scheduled-boundary registration (S-03) and the deploy hook after content
 * lands on `contentrain` (S-02). Both are best-effort and fire-and-forget.
 */
function afterSave(projectId: string | undefined, modelId: string, locale: string, entryIds: string[], options?: SaveOptions): void {
  if (!projectId || !options?.schedule || entryIds.length === 0) return
  Promise.resolve()
    .then(() => registerEntrySchedules({ projectId, modelId, locale, entryIds, schedule: options.schedule! }))
    .catch(() => {})
}

function afterMerge(projectId: string | undefined): void {
  if (!projectId) return
  Promise.resolve()
    .then(() => triggerProjectDeploy({ projectId, reason: 'content_published' }))
    .catch(() => {})
}

/**
 * Content Engine — Studio's write path for content operations.
 *
 * Thin orchestration layer over `@contentrain/mcp/core/ops`. Responsibilities:
 *
 * - Validate inputs (Studio-owned; unified with MCP's validator in Faz S3).
 * - Maintain the `contentrain` tracking branch invariant.
 * - Run branch-health gates before creating new `cr/*` feature branches.
 * - Fuse MCP's per-op FileChange plan with Studio's meta + context
 *   overrides and commit atomically via `provider.applyPlan`.
 * - Two-step merge (`cr/*` → `contentrain` → default branch) with PR
 *   fallback on protected branches — Studio-specific lifecycle.
 */
export function createContentEngine(ctx: ContentEngineContext) {
  const { git, contentRoot, projectId } = ctx
  const pathCtx = { contentRoot }

  const internal: EngineInternalContext = {
    git,
    pathCtx,
    projectId,
    ensureContentBranch: () => Promise.resolve(),
  }

  internal.ensureContentBranch = createBranchGuard(internal)

  // Content writes made through THIS engine, keyed by the branch they wrote,
  // with a way to redo them. Each write forks from the `contentrain` commit it
  // read (openWriteSnapshot), so a colleague's change that lands in between
  // turns the merge into a real conflict instead of a silent revert (#285). An
  // auto-merge in the same request may then redo the write once on top of the
  // new head — plans are deterministic from their inputs. A branch merged later
  // by a person (review workflow) is merged by another engine and never redone.
  const redoByBranch = new Map<string, () => Promise<WriteResult>>()
  const remember = <T extends WriteResult>(result: T, redo: () => Promise<T>): T => {
    if (result.branch) redoByBranch.set(result.branch, redo)
    return result
  }

  /**
   * Merge a write branch; on a conflict, redo the write once and merge that.
   * A second conflict is returned as `conflict: true` — never forced through.
   */
  async function landWithRedo<R extends { merged: boolean, conflict?: boolean }>(
    branch: string,
    land: (branch: string) => Promise<R>,
  ): Promise<R & { branch: string, redone?: boolean }> {
    const first = await land(branch)
    const redo = redoByBranch.get(branch)
    redoByBranch.delete(branch)
    if (!first.conflict || !redo) return { ...first, branch }

    await git.deleteBranch(branch).catch(() => {})
    const rewritten = await redo()
    // Re-planned against the new head, the write is already live — the
    // concurrent change made the same edit. Nothing left to merge.
    if (rewritten.unchanged) return { ...first, merged: true, conflict: false, branch, redone: true }
    if (!rewritten.branch) return { ...first, branch }
    redoByBranch.delete(rewritten.branch)
    const second = await land(rewritten.branch)
    return { ...second, branch: rewritten.branch, redone: true }
  }

  /** Step 1 only (`cr/*` → `contentrain`), reporting a conflict instead of throwing it. */
  async function landOnContentrain(branch: string): Promise<{ merged: boolean, sha: string | null, conflict?: boolean }> {
    try {
      return await mergeToContentrain(internal, branch)
    }
    catch (e: unknown) {
      if (classifyMergeFailure(e) === 'conflict') return { merged: false, sha: null, conflict: true }
      throw e
    }
  }

  return {
    ensureContentBranch: internal.ensureContentBranch,
    saveContent: async (modelId: string, locale: string, data: Record<string, unknown>, userEmail: string, options?: SaveOptions) => {
      const write = () => saveContent(internal, modelId, locale, data, userEmail, options)
      const result = remember(await write(), write)
      if (result.validation.valid) afterSave(projectId, modelId, locale, Object.keys(data), options)
      return result
    },
    deleteContent: async (modelId: string, locale: string, entryIds: string[], userEmail: string) => {
      const write = () => deleteContent(internal, modelId, locale, entryIds, userEmail)
      const result = remember(await write(), write)
      if (projectId) clearEntrySchedules(projectId, modelId, entryIds, locale).catch(() => {})
      return result
    },
    saveDocument: async (modelId: string, locale: string, slug: string, frontmatter: Record<string, unknown>, body: string, userEmail: string, options?: SaveOptions) => {
      const write = () => saveDocument(internal, modelId, locale, slug, frontmatter, body, userEmail, options)
      const result = remember(await write(), write)
      if (result.validation.valid) afterSave(projectId, modelId, locale, [slug], options)
      return result
    },
    // Several documents in one commit (#292) — redone as a whole on a merge
    // conflict, like any other write this engine made.
    saveDocuments: async (modelId: string, locale: string, documents: DocumentInput[], userEmail: string, options?: SaveOptions) => {
      const write = () => saveDocuments(internal, modelId, locale, documents, userEmail, options)
      const result = remember(await write(), write)
      if (result.validation.valid) afterSave(projectId, modelId, locale, documents.map(d => d.slug), options)
      return result
    },
    // Exact find/replace in text fields (#282). A redo re-reads the newer head
    // and applies the same edit there — the edit, not a stale copy of the field.
    replaceText: async (modelId: string, locale: string, edits: TextEdit[], userEmail: string, options?: SaveOptions) => {
      const write = () => replaceText(internal, modelId, locale, edits, userEmail, options)
      return remember(await write(), write)
    },
    saveModel: (definition: Parameters<typeof saveModel>[1], userEmail: string, options?: Parameters<typeof saveModel>[3]) =>
      saveModel(internal, definition, userEmail, options),
    deleteModel: (modelId: string, userEmail: string) =>
      deleteModel(internal, modelId, userEmail),
    addLocale: (locale: string, userEmail: string) =>
      addLocale(internal, locale, userEmail),
    saveVocabulary: (terms: Parameters<typeof saveVocabulary>[1], userEmail: string, options?: { replace?: boolean }) =>
      saveVocabulary(internal, terms, userEmail, options),
    updateEntryStatus: async (modelId: string, locale: string, entryIds: string[], status: 'draft' | 'published' | 'archived', userEmail: string) => {
      const write = () => updateEntryStatus(internal, modelId, locale, entryIds, status, userEmail)
      return remember(await write(), write)
    },
    listContentBranches: () => listContentBranches(internal),
    mergeBranch: async (branch: string): Promise<EngineMergeResult & { branch: string, redone?: boolean }> => {
      const result = await landWithRedo(branch, b => mergeBranch(internal, b))
      if (result.merged) afterMerge(projectId)
      return result
    },
    // Split halves of mergeBranch — the agent tool loop lands each write
    // on contentrain immediately and finalizes (context regen + main
    // advance) once per turn. The returned `branch` is the one that landed:
    // a redone write lands under a new name, and that is what finalize needs.
    mergeToContentrain: (branch: string) => landWithRedo(branch, landOnContentrain),
    finalizeContentrain: async (mergedBranches: string[]) => {
      const result = await finalizeContentrain(internal, mergedBranches)
      if (mergedBranches.length > 0) afterMerge(projectId)
      return result
    },
    rejectBranch: (branch: string) => rejectBranch(internal, branch),
    copyLocale: async (modelId: string, fromLocale: string, toLocale: string, userEmail: string) => {
      const write = () => copyLocale(internal, modelId, fromLocale, toLocale, userEmail)
      return remember(await write(), write)
    },
    initProject: (stack: string, locales: string[], domains: string[], models: Parameters<typeof initProject>[4], userEmail: string) =>
      initProject(internal, stack, locales, domains, models, userEmail),
  }
}
