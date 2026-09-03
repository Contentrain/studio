import type { ContentEngineContext, EngineInternalContext, SaveOptions } from './types'
import { createBranchGuard, finalizeContentrain, listContentBranches, mergeBranch, mergeToContentrain, rejectBranch } from './branch-ops'
import { deleteContent } from './delete-content'
import { initProject } from './init-project'
import { saveContent } from './save-content'
import { saveDocument } from './save-document'
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

  return {
    ensureContentBranch: internal.ensureContentBranch,
    saveContent: async (modelId: string, locale: string, data: Record<string, unknown>, userEmail: string, options?: SaveOptions) => {
      const result = await saveContent(internal, modelId, locale, data, userEmail, options)
      if (result.validation.valid) afterSave(projectId, modelId, locale, Object.keys(data), options)
      return result
    },
    deleteContent: async (modelId: string, locale: string, entryIds: string[], userEmail: string) => {
      const result = await deleteContent(internal, modelId, locale, entryIds, userEmail)
      if (projectId) clearEntrySchedules(projectId, modelId, entryIds, locale).catch(() => {})
      return result
    },
    saveDocument: async (modelId: string, locale: string, slug: string, frontmatter: Record<string, unknown>, body: string, userEmail: string, options?: SaveOptions) => {
      const result = await saveDocument(internal, modelId, locale, slug, frontmatter, body, userEmail, options)
      if (result.validation.valid) afterSave(projectId, modelId, locale, [slug], options)
      return result
    },
    saveModel: (definition: Parameters<typeof saveModel>[1], userEmail: string, options?: Parameters<typeof saveModel>[3]) =>
      saveModel(internal, definition, userEmail, options),
    deleteModel: (modelId: string, userEmail: string) =>
      deleteModel(internal, modelId, userEmail),
    addLocale: (locale: string, userEmail: string) =>
      addLocale(internal, locale, userEmail),
    saveVocabulary: (terms: Parameters<typeof saveVocabulary>[1], userEmail: string, options?: { replace?: boolean }) =>
      saveVocabulary(internal, terms, userEmail, options),
    updateEntryStatus: (modelId: string, locale: string, entryIds: string[], status: 'draft' | 'published' | 'archived', userEmail: string) =>
      updateEntryStatus(internal, modelId, locale, entryIds, status, userEmail),
    listContentBranches: () => listContentBranches(internal),
    mergeBranch: async (branch: string) => {
      const result = await mergeBranch(internal, branch)
      if (result.merged) afterMerge(projectId)
      return result
    },
    // Split halves of mergeBranch — the agent tool loop lands each write
    // on contentrain immediately and finalizes (context regen + main
    // advance) once per turn.
    mergeToContentrain: (branch: string) => mergeToContentrain(internal, branch),
    finalizeContentrain: async (mergedBranches: string[]) => {
      const result = await finalizeContentrain(internal, mergedBranches)
      if (mergedBranches.length > 0) afterMerge(projectId)
      return result
    },
    rejectBranch: (branch: string) => rejectBranch(internal, branch),
    copyLocale: (modelId: string, fromLocale: string, toLocale: string, userEmail: string) =>
      copyLocale(internal, modelId, fromLocale, toLocale, userEmail),
    initProject: (stack: string, locales: string[], domains: string[], models: Parameters<typeof initProject>[4], userEmail: string) =>
      initProject(internal, stack, locales, domains, models, userEmail),
  }
}
