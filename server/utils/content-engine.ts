import type { ModelDefinition, ContentrainConfig, ValidationResult, EntryMeta } from '@contentrain/types'
import type { GitProvider, Commit, Branch, FileDiff, MergeResult, CommitAuthor } from '../providers/git'
import type { ValidationContext } from './content-validation'

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

/**
 * Normalize content data to object-map format.
 * Contentrain MCP stores collections as arrays: [{id: "abc", ...}, ...]
 * Studio uses object-maps: { "abc": { ... } }
 * This function converts arrays to object-maps for consistent handling.
 */
function toObjectMap(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    const map: Record<string, unknown> = {}
    for (let i = 0; i < data.length; i++) {
      const entry = data[i]
      if (typeof entry === 'object' && entry !== null) {
        const id = (entry as Record<string, unknown>).id
          ?? (entry as Record<string, unknown>).ID
          ?? `entry-${i}`
        // Remove id from entry fields (it's the key now)
        const { id: _id, ID: _ID, ...fields } = entry as Record<string, unknown>
        map[String(id)] = fields
      }
    }
    return map
  }
  if (typeof data === 'object' && data !== null) {
    return data as Record<string, unknown>
  }
  return {}
}

/**
 * Build updated context.json content for a write operation.
 * Reads existing context, merges with new operation data.
 */
async function buildContextUpdate(
  git: GitProvider,
  contextPath: string,
  operation: { tool: string, model: string, locale: string, entries?: string[] },
  modelCount: number,
  locales: string[],
): Promise<string> {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await git.readFile(contextPath)) as Record<string, unknown>
  }
  catch { /* no existing context */ }

  const now = new Date().toISOString()
  const existingStats = existing.stats as { entries?: number } | undefined

  const updated = {
    version: '1',
    lastOperation: {
      tool: operation.tool,
      model: operation.model,
      locale: operation.locale,
      entries: operation.entries,
      timestamp: now,
      source: 'mcp-studio',
    },
    stats: {
      models: modelCount,
      entries: existingStats?.entries ?? 0,
      locales,
      lastSync: now,
    },
  }

  return serializeCanonical(updated)
}

export function createContentEngine(ctx: ContentEngineContext) {
  const { git, contentRoot } = ctx
  const pathCtx = { contentRoot }

  /** Helper: get current model count + supported locales for context.json */
  async function getProjectInfo(fallbackLocale: string): Promise<{ modelCount: number, locales: string[] }> {
    let modelCount = 0
    try {
      const files = await git.listDirectory(resolveModelsDir(pathCtx))
      modelCount = files.filter(f => f.endsWith('.json')).length
    }
    catch { /* no models dir */ }

    let locales = [fallbackLocale]
    try {
      const cfg = JSON.parse(await git.readFile(resolveConfigPath(pathCtx))) as ContentrainConfig
      locales = cfg.locales?.supported ?? [fallbackLocale]
    }
    catch { /* no config */ }

    return { modelCount, locales }
  }

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
      options?: { autoPublish?: boolean },
    ): Promise<WriteResult> {
      // 1. Load model definition
      const modelPath = resolveModelPath(pathCtx, modelId)
      const modelDef = JSON.parse(await git.readFile(modelPath)) as ModelDefinition

      // 2. Read existing content for validation context (unique checks)
      const fields = modelDef.fields ?? {}
      let existingForValidation: Record<string, Record<string, unknown>> = {}
      if (modelDef.kind === 'collection') {
        try {
          const rawExisting = JSON.parse(await git.readFile(resolveContentPath(pathCtx, modelDef, locale)))
          existingForValidation = toObjectMap(rawExisting) as Record<string, Record<string, unknown>>
        }
        catch { /* no existing content */ }
      }

      // 3. Validate
      let validation: ValidationResult = { valid: true, errors: [] }

      if (modelDef.kind === 'collection') {
        const normalizedData = toObjectMap(data)
        // Build merged entries map for unique validation
        const mergedEntries = { ...existingForValidation }
        for (const [eid, edata] of Object.entries(normalizedData)) {
          mergedEntries[eid] = { ...(mergedEntries[eid] as Record<string, unknown> ?? {}), ...(edata as Record<string, unknown>) }
        }

        for (const entryId of Object.keys(normalizedData)) {
          const valCtx: ValidationContext = {
            allEntries: mergedEntries,
            currentEntryId: entryId,
          }
          // Validate the merged entry (not partial) so required fields from existing content pass
          const entryValidation = validateContent(
            mergedEntries[entryId] as Record<string, unknown>,
            fields,
            modelId,
            locale,
            entryId,
            valCtx,
          )
          validation.errors.push(...entryValidation.errors)
          if (!entryValidation.valid) validation.valid = false
        }
      }
      else if (modelDef.kind === 'singleton') {
        // Merge with existing before validating singleton too
        let existingSingleton: Record<string, unknown> = {}
        try {
          existingSingleton = JSON.parse(await git.readFile(resolveContentPath(pathCtx, modelDef, locale))) as Record<string, unknown>
        }
        catch { /* no existing */ }
        const mergedSingleton = { ...existingSingleton, ...data }
        validation = validateContent(mergedSingleton, fields, modelId, locale)
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

      // 3. Read existing content
      const contentPath = resolveContentPath(pathCtx, modelDef, locale)
      let existingContent: Record<string, unknown> = {}
      try {
        const raw = JSON.parse(await git.readFile(contentPath))
        existingContent = modelDef.kind === 'collection' ? toObjectMap(raw) : (raw as Record<string, unknown>)
      }
      catch {
        // File doesn't exist yet — creating new
      }

      // 4. Merge data (always merge — never replace)
      let finalContent: unknown
      if (modelDef.kind === 'collection') {
        // Normalize incoming data (agent might send array or object-map)
        const normalizedData = toObjectMap(data)
        // Deep merge: for each entry, merge fields (preserves unchanged fields)
        const merged = { ...existingContent }
        for (const [entryId, entryData] of Object.entries(normalizedData)) {
          const existing = merged[entryId]
          if (existing && typeof existing === 'object' && typeof entryData === 'object') {
            // Merge fields within the entry (update only changed fields)
            merged[entryId] = { ...(existing as Record<string, unknown>), ...(entryData as Record<string, unknown>) }
          }
          else {
            merged[entryId] = entryData
          }
        }
        finalContent = merged
      }
      else if (modelDef.kind === 'dictionary') {
        // Dictionary: all values must be strings
        for (const [key, val] of Object.entries(data)) {
          if (typeof val !== 'string') {
            return {
              branch: '',
              commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
              diff: [],
              validation: { valid: false, errors: [{ field: key, message: `Dictionary value for "${key}" must be a string, got ${typeof val}`, severity: 'error' as const }] },
            }
          }
        }
        finalContent = { ...existingContent, ...data }
      }
      else {
        // Singleton: merge fields
        finalContent = { ...existingContent, ...data }
      }

      // 5. Serialize to canonical JSON
      const serialized = serializeCanonical(
        finalContent,
        modelDef.kind !== 'dictionary' ? fields : undefined,
      )

      // 6. Build meta file
      const metaPath = resolveMetaPath(pathCtx, modelDef, locale)
      let existingMeta: Record<string, unknown> = {}
      try {
        existingMeta = JSON.parse(await git.readFile(metaPath)) as Record<string, unknown>
      }
      catch { /* no existing meta */ }

      const defaultStatus = options?.autoPublish ? 'published' : 'draft'

      let updatedMeta: unknown
      if (modelDef.kind === 'collection') {
        // Per-entry meta
        const metaMap = { ...existingMeta } as Record<string, EntryMeta>
        const normalizedData = toObjectMap(data)
        for (const entryId of Object.keys(normalizedData)) {
          const existingStatus = metaMap[entryId]?.status
          metaMap[entryId] = {
            ...(metaMap[entryId] ?? {}),
            status: options?.autoPublish ? 'published' : (existingStatus ?? defaultStatus),
            source: 'agent',
            updated_by: userEmail,
          } as EntryMeta
        }
        updatedMeta = metaMap
      }
      else {
        // Single meta for singleton/dictionary
        const existingStatus = (existingMeta as unknown as EntryMeta).status
        updatedMeta = {
          ...existingMeta,
          status: options?.autoPublish ? 'published' : (existingStatus ?? defaultStatus),
          source: 'agent' as const,
          updated_by: userEmail,
        }
      }

      // 7. Build context.json update
      const contextPath = resolveContextPath(pathCtx)
      const entryIds = modelDef.kind === 'collection' ? Object.keys(toObjectMap(data)) : undefined
      const projectInfo = await getProjectInfo(locale)
      const contextJson = await buildContextUpdate(git, contextPath, { tool: 'save_content', model: modelId, locale, entries: entryIds }, projectInfo.modelCount, projectInfo.locales)

      // 8. Create branch
      const branchName = `contentrain/save-${generateBranchId()}`
      await git.createBranch(branchName)

      // 9. Commit content + meta + context
      const message = `contentrain: save ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`
      const commit = await git.commitFiles(
        branchName,
        [
          { path: contentPath, content: serialized },
          { path: metaPath, content: serializeCanonical(updatedMeta) },
          { path: contextPath, content: contextJson },
        ],
        message,
        BOT_AUTHOR,
      )

      // 10. Get diff
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

      // Read existing (normalize array → object-map)
      const raw = JSON.parse(await git.readFile(contentPath))
      const existing = toObjectMap(raw)

      // Remove entries by rebuilding without deleted IDs
      const filtered = Object.fromEntries(
        Object.entries(existing).filter(([key]) => !entryIds.includes(key)),
      )

      const serialized = serializeCanonical(filtered)

      // Clean meta entries too
      const metaPath = resolveMetaPath(pathCtx, modelDef, locale)
      let existingMeta: Record<string, unknown> = {}
      try {
        existingMeta = JSON.parse(await git.readFile(metaPath)) as Record<string, unknown>
      }
      catch { /* no meta */ }
      const filteredMeta = Object.fromEntries(
        Object.entries(existingMeta).filter(([key]) => !entryIds.includes(key)),
      )

      // Context.json update
      const contextPath = resolveContextPath(pathCtx)
      const projectInfo = await getProjectInfo(locale)
      const contextJson = await buildContextUpdate(git, contextPath, { tool: 'delete_content', model: modelId, locale, entries: entryIds }, projectInfo.modelCount, projectInfo.locales)

      const branchName = `contentrain/delete-${generateBranchId()}`
      await git.createBranch(branchName)

      const message = `contentrain: delete ${entryIds.length} entries from ${modelId} [${locale}]\n\nCo-Authored-By: ${userEmail}`
      const commit = await git.commitFiles(
        branchName,
        [
          { path: contentPath, content: serialized },
          { path: metaPath, content: serializeCanonical(filteredMeta) },
          { path: contextPath, content: contextJson },
        ],
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
     * Save a document (markdown with frontmatter).
     * Creates or updates a markdown file at the document path.
     */
    async saveDocument(
      modelId: string,
      locale: string,
      slug: string,
      frontmatter: Record<string, unknown>,
      body: string,
      userEmail: string,
      options?: { autoPublish?: boolean },
    ): Promise<WriteResult> {
      // Sanitize slug — prevent path traversal
      const safeSlug = slug.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
      if (!safeSlug || safeSlug.includes('..') || safeSlug.startsWith('/')) {
        return {
          branch: '',
          commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
          diff: [],
          validation: { valid: false, errors: [{ field: 'slug', message: `Invalid slug: "${slug}"`, severity: 'error' as const }] },
        }
      }

      const modelPath = resolveModelPath(pathCtx, modelId)
      const modelDef = JSON.parse(await git.readFile(modelPath)) as ModelDefinition

      // Validate frontmatter against model fields
      const fields = modelDef.fields ?? {}
      const validation = validateContent(frontmatter, fields, modelId, locale, safeSlug)
      if (!validation.valid) {
        return {
          branch: '',
          commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
          diff: [],
          validation,
        }
      }

      // Resolve document path (uses sanitized slug)
      const docPath = resolveContentPath(pathCtx, modelDef, locale, safeSlug)
      const serialized = serializeMarkdownFrontmatter({ ...frontmatter, slug: safeSlug }, body)

      // Meta
      const metaPath = resolveMetaPath(pathCtx, modelDef, locale, safeSlug)
      let existingMeta: Record<string, unknown> = {}
      try {
        existingMeta = JSON.parse(await git.readFile(metaPath)) as Record<string, unknown>
      }
      catch { /* no existing meta */ }
      const docDefaultStatus = options?.autoPublish ? 'published' : 'draft'
      const existingDocStatus = (existingMeta as unknown as EntryMeta).status
      const updatedMeta = {
        ...existingMeta,
        status: options?.autoPublish ? 'published' : (existingDocStatus ?? docDefaultStatus),
        source: 'agent' as const,
        updated_by: userEmail,
      }

      // Context.json
      const contextPath = resolveContextPath(pathCtx)
      const projectInfo = await getProjectInfo(locale)
      const contextJson = await buildContextUpdate(git, contextPath, { tool: 'save_content', model: modelId, locale, entries: [slug] }, projectInfo.modelCount, projectInfo.locales)

      const branchName = `contentrain/save-${generateBranchId()}`
      await git.createBranch(branchName)

      const message = `contentrain: save document ${modelId}/${safeSlug} [${locale}]\n\nCo-Authored-By: ${userEmail}`
      const commit = await git.commitFiles(
        branchName,
        [
          { path: docPath, content: serialized },
          { path: metaPath, content: serializeCanonical(updatedMeta) },
          { path: contextPath, content: contextJson },
        ],
        message,
        BOT_AUTHOR,
      )

      const diff = await git.getBranchDiff(branchName)
      return { branch: branchName, commit, diff, validation }
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

      // Context.json update
      const contextPath = resolveContextPath(pathCtx)
      const projectInfo = await getProjectInfo('en')
      // +1 if this is a new model
      let isNew = false
      try {
        await git.readFile(modelPath)
      }
      catch {
        isNew = true
      }
      const contextJson = await buildContextUpdate(git, contextPath, { tool: 'save_model', model: definition.id, locale: '' }, projectInfo.modelCount + (isNew ? 1 : 0), projectInfo.locales)

      const branchName = `contentrain/model-${generateBranchId()}`
      await git.createBranch(branchName)

      const message = `contentrain: save model ${definition.id}\n\nCo-Authored-By: ${userEmail}`
      const commit = await git.commitFiles(
        branchName,
        [
          { path: modelPath, content: serialized },
          { path: contextPath, content: contextJson },
        ],
        message,
        BOT_AUTHOR,
      )

      const diff = await git.getBranchDiff(branchName)
      return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
    },

    /**
     * Update entry status (publish/unpublish/archive).
     * Only modifies meta, not content.
     */
    async updateEntryStatus(
      modelId: string,
      locale: string,
      entryIds: string[],
      status: 'draft' | 'published' | 'archived',
      userEmail: string,
    ): Promise<WriteResult> {
      const modelPath = resolveModelPath(pathCtx, modelId)
      const modelDef = JSON.parse(await git.readFile(modelPath)) as ModelDefinition
      const metaPath = resolveMetaPath(pathCtx, modelDef, locale)

      let existingMeta: Record<string, EntryMeta> = {}
      try {
        existingMeta = JSON.parse(await git.readFile(metaPath)) as Record<string, EntryMeta>
      }
      catch { /* no meta */ }

      for (const entryId of entryIds) {
        existingMeta[entryId] = {
          ...(existingMeta[entryId] ?? {}),
          status,
          updated_by: userEmail,
        } as EntryMeta
      }

      const branchName = `contentrain/status-${generateBranchId()}`
      await git.createBranch(branchName)

      const commit = await git.commitFiles(
        branchName,
        [{ path: metaPath, content: serializeCanonical(existingMeta) }],
        `contentrain: ${status} ${entryIds.length} entries in ${modelId}\n\nCo-Authored-By: ${userEmail}`,
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
     * Falls back to PR creation if direct merge is blocked by branch protection.
     */
    async mergeBranch(branch: string): Promise<MergeResult> {
      const defaultBranch = await git.getDefaultBranch()

      try {
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
      }
      catch (e: unknown) {
        // If direct merge fails (branch protection), try PR
        const msg = e instanceof Error ? e.message : ''
        if (msg.includes('protected') || msg.includes('403') || msg.includes('not allowed')) {
          const pr = await git.createPR(
            branch,
            defaultBranch,
            `contentrain: ${branch.replace('contentrain/', '')}`,
            'Auto-generated by Contentrain Studio.',
          )
          return { merged: false, sha: null, pullRequestUrl: pr.url }
        }
        throw e
      }
    },

    /**
     * Reject (delete) a content branch.
     */
    async rejectBranch(branch: string): Promise<void> {
      await git.deleteBranch(branch)
    },

    /**
     * Copy content from one locale to another for a model.
     * Does NOT overwrite existing target content.
     */
    async copyLocale(
      modelId: string,
      fromLocale: string,
      toLocale: string,
      userEmail: string,
    ): Promise<WriteResult> {
      const modelPath = resolveModelPath(pathCtx, modelId)
      const modelDef = JSON.parse(await git.readFile(modelPath)) as ModelDefinition

      if (!modelDef.i18n) {
        return {
          branch: '',
          commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
          diff: [],
          validation: { valid: false, errors: [{ field: '', message: 'Model does not support i18n', severity: 'error' as const }] },
        }
      }

      // Read source content
      const sourcePath = resolveContentPath(pathCtx, modelDef, fromLocale)
      let sourceContent: string
      try {
        sourceContent = await git.readFile(sourcePath)
      }
      catch {
        return {
          branch: '',
          commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
          diff: [],
          validation: { valid: false, errors: [{ field: '', message: `Source locale "${fromLocale}" not found`, severity: 'error' as const }] },
        }
      }

      // Check if target already exists
      const targetPath = resolveContentPath(pathCtx, modelDef, toLocale)
      try {
        const existing = await git.readFile(targetPath)
        // If target exists and has content, don't overwrite
        if (existing && existing.trim().length > 2) {
          return {
            branch: '',
            commit: { sha: '', message: '', author: BOT_AUTHOR, timestamp: '' },
            diff: [],
            validation: { valid: false, errors: [{ field: '', message: `Target locale "${toLocale}" already has content. Delete it first to overwrite.`, severity: 'error' as const }] },
          }
        }
      }
      catch { /* target doesn't exist — good */ }

      // Copy source meta too
      const sourceMetaPath = resolveMetaPath(pathCtx, modelDef, fromLocale)
      let metaContent = '{}\n'
      try {
        metaContent = await git.readFile(sourceMetaPath)
      }
      catch { /* no meta */ }
      const targetMetaPath = resolveMetaPath(pathCtx, modelDef, toLocale)

      // Context update
      const contextPath = resolveContextPath(pathCtx)
      const projectInfo = await getProjectInfo(toLocale)
      const contextJson = await buildContextUpdate(git, contextPath, { tool: 'copy_locale', model: modelId, locale: toLocale }, projectInfo.modelCount, projectInfo.locales)

      const branchName = `contentrain/copy-locale-${generateBranchId()}`
      await git.createBranch(branchName)

      const message = `contentrain: copy ${modelId} from ${fromLocale} to ${toLocale}\n\nCo-Authored-By: ${userEmail}`
      const commit = await git.commitFiles(
        branchName,
        [
          { path: targetPath, content: sourceContent },
          { path: targetMetaPath, content: metaContent },
          { path: contextPath, content: contextJson },
        ],
        message,
        BOT_AUTHOR,
      )

      const diff = await git.getBranchDiff(branchName)
      return { branch: branchName, commit, diff, validation: { valid: true, errors: [] } }
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

        // Create empty content file (non-i18n: single data.json, i18n: per locale)
        if (model.kind !== 'document') {
          const contentLocales = model.i18n ? locales : [locales[0] ?? 'en']
          for (const locale of contentLocales) {
            const effectiveLocale = model.i18n ? locale : 'data'
            const contentPath = resolveContentPath(pathCtx, model, effectiveLocale)
            files.push({
              path: contentPath,
              content: serializeCanonical({}),
            })
          }
        }

        // Create empty meta file (skip document kind — meta is per-slug)
        if (model.kind !== 'document') {
          for (const locale of locales) {
            const metaPath = resolveMetaPath(pathCtx, model, locale)
            files.push({
              path: metaPath,
              content: serializeCanonical({}),
            })
          }
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
