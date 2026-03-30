import type { ContentEngineContext, EngineInternalContext } from './types'
import { createBranchGuard, listContentBranches, mergeBranch, rejectBranch } from './branch-ops'
import { deleteContent } from './delete-content'
import { getProjectInfo } from './helpers'
import { initProject } from './init-project'
import { saveContent } from './save-content'
import { saveDocument } from './save-document'
import { saveModel } from './save-model'
import { copyLocale, updateEntryStatus } from './update-status'

/**
 * Content Engine — Studio's write path for content operations.
 *
 * Orchestrates: validate -> serialize -> branch -> commit -> diff
 * Uses @contentrain/types for validation and serialization contracts.
 * Uses GitProvider for all Git operations (no disk, no clone).
 *
 * Not MCP — implements the same standard independently.
 */
export function createContentEngine(ctx: ContentEngineContext) {
  const { git, contentRoot } = ctx
  const pathCtx = { contentRoot }

  // Build internal context shared by all operations
  const internal: EngineInternalContext = {
    git,
    pathCtx,
    ensureContentBranch: () => Promise.resolve(), // replaced below
    getProjectInfo: fallbackLocale => getProjectInfo(internal, fallbackLocale),
  }

  // Wire up branch guard (has internal cache flag)
  internal.ensureContentBranch = createBranchGuard(internal)

  return {
    ensureContentBranch: internal.ensureContentBranch,
    saveContent: (modelId: string, locale: string, data: Record<string, unknown>, userEmail: string, options?: { autoPublish?: boolean }) =>
      saveContent(internal, modelId, locale, data, userEmail, options),
    deleteContent: (modelId: string, locale: string, entryIds: string[], userEmail: string) =>
      deleteContent(internal, modelId, locale, entryIds, userEmail),
    saveDocument: (modelId: string, locale: string, slug: string, frontmatter: Record<string, unknown>, body: string, userEmail: string, options?: { autoPublish?: boolean }) =>
      saveDocument(internal, modelId, locale, slug, frontmatter, body, userEmail, options),
    saveModel: (definition: Parameters<typeof saveModel>[1], userEmail: string) =>
      saveModel(internal, definition, userEmail),
    updateEntryStatus: (modelId: string, locale: string, entryIds: string[], status: 'draft' | 'published' | 'archived', userEmail: string) =>
      updateEntryStatus(internal, modelId, locale, entryIds, status, userEmail),
    listContentBranches: () => listContentBranches(internal),
    mergeBranch: (branch: string) => mergeBranch(internal, branch),
    rejectBranch: (branch: string) => rejectBranch(internal, branch),
    copyLocale: (modelId: string, fromLocale: string, toLocale: string, userEmail: string) =>
      copyLocale(internal, modelId, fromLocale, toLocale, userEmail),
    initProject: (stack: string, locales: string[], domains: string[], models: Parameters<typeof initProject>[4], userEmail: string) =>
      initProject(internal, stack, locales, domains, models, userEmail),
  }
}
