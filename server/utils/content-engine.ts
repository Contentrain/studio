import type { ModelDefinition, ContentrainConfig, ValidationResult } from '@contentrain/types'
import type { GitProvider, Commit, Branch, FileDiff, MergeResult, CommitAuthor } from '../providers/git'

/**
 * Content Engine — Studio's write path for content operations.
 *
 * Orchestrates: validate → serialize → branch → commit → diff
 * Uses @contentrain/types for validation and serialization contracts.
 * Uses GitProvider for all Git operations (no disk, no clone).
 *
 * Not MCP — implements the same standard independently.
 */

export interface WriteResult {
  branch: string
  commit: Commit
  diff: FileDiff[]
  validation: ValidationResult
}

export interface ContentEngineContext {
  git: GitProvider
  contentRoot: string
}

const BOT_AUTHOR: CommitAuthor = {
  name: 'Contentrain Studio[bot]',
  email: 'bot@contentrain.io',
}

function generateBranchId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export function createContentEngine(ctx: ContentEngineContext) {
  const { git, contentRoot } = ctx
  const pathCtx = { contentRoot }

  return {
    /**
     * Save content for a model (create or update entries).
     * Creates a branch, commits changes, returns diff.
     */
    async saveContent(
      modelId: string,
      locale: string,
      data: Record<string, unknown>,
      userEmail: string,
    ): Promise<WriteResult> {
      // 1. Load model definition
      const modelPath = resolveModelPath(pathCtx, modelId)
      const modelDef = JSON.parse(await git.readFile(modelPath)) as ModelDefinition

      // 2. Validate
      const fields = modelDef.fields ?? {}
      let validation: ValidationResult = { valid: true, errors: [] }

      if (modelDef.kind === 'collection') {
        // data is object-map: { entryId: { fields } }
        for (const [entryId, entry] of Object.entries(data)) {
          const entryValidation = validateContent(
            entry as Record<string, unknown>,
            fields,
            modelId,
            locale,
            entryId,
          )
          validation.errors.push(...entryValidation.errors)
          if (!entryValidation.valid) validation.valid = false
        }
      }
      else if (modelDef.kind === 'singleton') {
        validation = validateContent(data, fields, modelId, locale)
      }
      // Dictionary: no field-level validation (free-form key-value)

      if (!validation.valid) {
        return {
          branch: '',
          commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
          diff: [],
          validation,
        }
      }

      // 3. Read existing content (merge for collections)
      const contentPath = resolveContentPath(pathCtx, modelDef, locale)
      let existingContent: Record<string, unknown> = {}
      try {
        existingContent = JSON.parse(await git.readFile(contentPath))
      }
      catch {
        // File doesn't exist yet — creating new
      }

      // 4. Merge data
      let finalContent: unknown
      if (modelDef.kind === 'collection') {
        // Merge entries into existing object-map
        finalContent = { ...existingContent, ...data }
      }
      else {
        // Singleton/dictionary: replace entirely
        finalContent = data
      }

      // 5. Serialize to canonical JSON
      const serialized = serializeCanonical(
        finalContent,
        modelDef.kind !== 'dictionary' ? fields : undefined,
      )

      // 6. Create branch
      const branchName = `contentrain/save-${generateBranchId()}`
      await git.createBranch(branchName)

      // 7. Commit
      const message = `contentrain: save ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`
      const commit = await git.commitFiles(
        branchName,
        [{ path: contentPath, content: serialized }],
        message,
        BOT_AUTHOR,
      )

      // 8. Get diff
      const diff = await git.getBranchDiff(branchName)

      return { branch: branchName, commit, diff, validation }
    },

    /**
     * Delete content entries from a collection.
     */
    async deleteContent(
      modelId: string,
      locale: string,
      entryIds: string[],
      userEmail: string,
    ): Promise<WriteResult> {
      const modelPath = resolveModelPath(pathCtx, modelId)
      const modelDef = JSON.parse(await git.readFile(modelPath)) as ModelDefinition
      const contentPath = resolveContentPath(pathCtx, modelDef, locale)

      // Read existing
      const existing = JSON.parse(await git.readFile(contentPath)) as Record<string, unknown>

      // Remove entries by rebuilding without deleted IDs
      const filtered = Object.fromEntries(
        Object.entries(existing).filter(([key]) => !entryIds.includes(key)),
      )

      const serialized = serializeCanonical(filtered)
      const branchName = `contentrain/delete-${generateBranchId()}`
      await git.createBranch(branchName)

      const message = `contentrain: delete ${entryIds.length} entries from ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`
      const commit = await git.commitFiles(
        branchName,
        [{ path: contentPath, content: serialized }],
        message,
        BOT_AUTHOR,
      )

      const diff = await git.getBranchDiff(branchName)

      return {
        branch: branchName,
        commit,
        diff,
        validation: { valid: true, errors: [] },
      }
    },

    /**
     * Save a model definition.
     */
    async saveModel(
      definition: ModelDefinition,
      userEmail: string,
    ): Promise<WriteResult> {
      const modelPath = resolveModelPath(pathCtx, definition.id)
      const serialized = serializeCanonical(definition)

      const branchName = `contentrain/model-${generateBranchId()}`
      await git.createBranch(branchName)

      const message = `contentrain: save model ${definition.id}\n\nCo-Authored-By: ${userEmail}`
      const commit = await git.commitFiles(
        branchName,
        [{ path: modelPath, content: serialized }],
        message,
        BOT_AUTHOR,
      )

      const diff = await git.getBranchDiff(branchName)
      return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
    },

    /**
     * List contentrain/* branches (pending changes).
     */
    async listContentBranches(): Promise<Branch[]> {
      return git.listBranches('contentrain/')
    },

    /**
     * Merge a content branch into the default branch.
     */
    async mergeBranch(branch: string): Promise<MergeResult> {
      const defaultBranch = await git.getDefaultBranch()
      const result = await git.mergeBranch(branch, defaultBranch)

      // Clean up branch after merge
      if (result.merged) {
        try {
          await git.deleteBranch(branch)
        }
        catch {
          // Branch may have been auto-deleted by merge
        }
      }

      return result
    },

    /**
     * Reject (delete) a content branch.
     */
    async rejectBranch(branch: string): Promise<void> {
      await git.deleteBranch(branch)
    },

    /**
     * Initialize .contentrain/ structure in a repo that doesn't have one.
     * Creates config, context, vocabulary, and empty directories.
     */
    async initProject(
      stack: string,
      locales: string[],
      domains: string[],
      models: ModelDefinition[],
      userEmail: string,
    ): Promise<WriteResult> {
      const prefix = contentRoot ? `${contentRoot}/` : ''

      // Build config
      const config: ContentrainConfig = {
        version: 1,
        stack: stack as ContentrainConfig['stack'],
        workflow: 'auto-merge',
        locales: {
          default: locales[0] ?? 'en',
          supported: locales,
        },
        domains,
      }

      // Build context
      const context = {
        version: '1',
        lastOperation: {
          tool: 'init_project',
          model: '',
          locale: locales[0] ?? 'en',
          timestamp: new Date().toISOString(),
          source: 'mcp-studio',
        },
        stats: {
          models: models.length,
          entries: 0,
          locales,
          lastSync: new Date().toISOString(),
        },
      }

      // Build vocabulary
      const vocabulary = { version: 1, terms: {} }

      // Collect all files to commit
      const files: Array<{ path: string, content: string }> = [
        { path: `${prefix}.contentrain/config.json`, content: serializeCanonical(config) },
        { path: `${prefix}.contentrain/context.json`, content: serializeCanonical(context) },
        { path: `${prefix}.contentrain/vocabulary.json`, content: serializeCanonical(vocabulary) },
      ]

      // Add model files
      for (const model of models) {
        files.push({
          path: `${prefix}.contentrain/models/${model.id}.json`,
          content: serializeCanonical(model),
        })

        // Create empty content file for each locale (collections/singletons)
        if (model.kind !== 'document') {
          for (const locale of locales) {
            const contentPath = resolveContentPath(pathCtx, model, locale)
            const emptyContent = model.kind === 'singleton' ? {} : {}
            files.push({
              path: contentPath,
              content: serializeCanonical(emptyContent),
            })
          }
        }

        // Create empty meta file
        for (const locale of locales) {
          const metaPath = resolveMetaPath(pathCtx, model, locale)
          files.push({
            path: metaPath,
            content: serializeCanonical({}),
          })
        }
      }

      // Create branch and commit
      const branchName = `contentrain/init-${generateBranchId()}`
      await git.createBranch(branchName)

      const message = `contentrain: initialize project\n\nStack: ${stack}\nLocales: ${locales.join(', ')}\nDomains: ${domains.join(', ')}\nModels: ${models.map(m => m.id).join(', ')}\n\nCo-Authored-By: ${userEmail}`

      const commit = await git.commitFiles(
        branchName,
        files.map(f => ({ path: f.path, content: f.content })),
        message,
        BOT_AUTHOR,
      )

      const diff = await git.getBranchDiff(branchName)

      return {
        branch: branchName,
        commit,
        diff,
        validation: { valid: true, errors: [] },
      }
    },
  }
}
