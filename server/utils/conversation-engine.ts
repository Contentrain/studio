import type { ModelDefinition } from '@contentrain/types'
import type { AIMessage, AIContentBlock, AITool } from '~~/server/providers/ai'
import type { ChatUIContext, AffectedResources, ProjectPhase } from '~~/server/utils/agent-types'
import type { AgentPermissions } from '~~/server/utils/agent-permissions'

/**
 * Conversation Engine — reusable AI conversation loop with tool execution.
 *
 * Extracted from chat.post.ts to enable reuse across:
 * - SSE chat endpoint (chat.post.ts)
 * - Conversation API (future: external AI content operations)
 * - Scheduled/batch content operations (future)
 *
 * Architecture:
 * - AsyncGenerator pattern — caller controls transport (SSE, WebSocket, collect)
 * - Provider-agnostic — uses AIProvider interface, GitProvider interface
 * - All utility functions are Nuxt auto-imported (server/utils/)
 */

// ─── Event Types ───

export interface ConversationEvent {
  type: 'conversation' | 'text' | 'tool_use' | 'tool_result' | 'done' | 'error'
  [key: string]: unknown
}

// ─── Configuration ───

export interface ConversationConfig {
  model: string
  apiKey: string
  systemPrompt: string
  messages: AIMessage[]
  tools: AITool[]
  maxToolIterations?: number
  maxToolResultLength?: number
  abortSignal?: AbortSignal
}

// ─── Tool Execution Context ───

export interface ToolExecutionContext {
  engine: ReturnType<typeof createContentEngine>
  git: ReturnType<typeof useGitProvider>
  userEmail: string
  userId: string
  contentRoot: string
  workflow: string
  permissions: AgentPermissions
  plan: string
  projectId: string
  workspaceId: string
  uiContext: ChatUIContext
  phase: ProjectPhase
}

// ─── Constants ───

const DEFAULT_MAX_TOOL_ITERATIONS = 5
const DEFAULT_MAX_TOOL_RESULT_LENGTH = 2000

// ─── Conversation Loop ───

/**
 * Run the conversation loop — streams AI responses, executes tools.
 * Yields ConversationEvent objects that the caller pipes to SSE or collects.
 *
 * The generator handles:
 * - First iteration: streaming via AIProvider.streamCompletion
 * - Subsequent iterations: non-streaming via AIProvider.createCompletion
 * - State machine checks before tool execution
 * - Tool result truncation for context window management
 * - Affected resource accumulation across tool calls
 *
 * The final event is always { type: 'done' } with usage, affected, and lastContent.
 */
export async function* runConversationLoop(
  config: ConversationConfig,
  toolCtx: ToolExecutionContext,
): AsyncGenerator<ConversationEvent> {
  const maxIterations = config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS
  const maxResultLength = config.maxToolResultLength ?? DEFAULT_MAX_TOOL_RESULT_LENGTH
  const aiProvider = useAIProvider()

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let lastAssistantContent: AIContentBlock[] = []
  let accumulatedAffected: AffectedResources = emptyAffected()

  let iteration = 0

  while (iteration < maxIterations) {
    if (config.abortSignal?.aborted) break

    iteration++
    const isFirstIteration = iteration === 1
    const currentToolCalls: Array<{ id: string, name: string, input: unknown }> = []
    let stopReason: string | undefined

    if (isFirstIteration) {
      for await (const streamEvent of aiProvider.streamCompletion(
        { model: config.model, system: config.systemPrompt, messages: config.messages, tools: config.tools, maxTokens: 4096, abortSignal: config.abortSignal },
        config.apiKey,
      )) {
        switch (streamEvent.type) {
          case 'text':
            yield { type: 'text', content: streamEvent.content }
            break
          case 'tool_use_start':
            yield { type: 'tool_use', id: streamEvent.toolId, name: streamEvent.toolName }
            break
          case 'tool_use_end':
            currentToolCalls.push({
              id: streamEvent.toolId!,
              name: streamEvent.toolName!,
              input: (typeof streamEvent.toolInput === 'object' && streamEvent.toolInput !== null) ? streamEvent.toolInput : {},
            })
            break
          case 'message_end':
            totalInputTokens += streamEvent.usage?.inputTokens ?? 0
            totalOutputTokens += streamEvent.usage?.outputTokens ?? 0
            stopReason = streamEvent.stopReason
            break
          case 'error':
            yield { type: 'error', message: streamEvent.error }
            break
        }
      }
    }
    else {
      const response = await aiProvider.createCompletion(
        { model: config.model, system: config.systemPrompt, messages: config.messages, tools: config.tools, maxTokens: 2048, abortSignal: config.abortSignal },
        config.apiKey,
      )
      totalInputTokens += response.usage.inputTokens
      totalOutputTokens += response.usage.outputTokens
      stopReason = response.stopReason

      for (const block of response.content) {
        if (block.type === 'text') {
          yield { type: 'text', content: block.text }
        }
        else if (block.type === 'tool_use') {
          yield { type: 'tool_use', id: block.id, name: block.name }
          currentToolCalls.push({
            id: block.id,
            name: block.name,
            input: (typeof block.input === 'object' && block.input !== null) ? block.input : {},
          })
        }
      }
      lastAssistantContent = response.content
    }

    if (stopReason !== 'tool_use' || currentToolCalls.length === 0) break

    // === TOOL EXECUTION with state guard + workflow-aware auto-merge ===
    const assistantBlocks: AIContentBlock[] = currentToolCalls.map(tc => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }))

    const toolResultBlocks: AIContentBlock[] = []

    for (const tc of currentToolCalls) {
      // Stop tool execution if client disconnected
      if (config.abortSignal?.aborted) {
        toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: JSON.stringify({ error: 'Request cancelled' }) })
        continue
      }

      // State machine guard
      const stateCheck = checkStateTransition(toolCtx.phase, tc.name)
      if (!stateCheck.allowed) {
        const errorResult = { error: stateCheck.reason, suggestion: stateCheck.suggestion }
        yield { type: 'tool_result', id: tc.id, name: tc.name, result: errorResult }
        toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: JSON.stringify(errorResult) })
        continue
      }

      // Execute tool
      const result = await executeToolWithAutoMerge(
        tc.name, tc.input, toolCtx.engine, toolCtx.git, toolCtx.userEmail, toolCtx.userId, toolCtx.contentRoot, toolCtx.workflow, toolCtx.permissions, toolCtx.plan, toolCtx.projectId, toolCtx.workspaceId, toolCtx.uiContext,
      )

      // Accumulate affected resources
      accumulatedAffected = mergeAffected(accumulatedAffected, result.affected)

      // Truncate for context
      let resultStr = JSON.stringify(result.result)
      if (resultStr.length > maxResultLength) {
        resultStr = resultStr.substring(0, maxResultLength) + '...(truncated)'
      }

      yield { type: 'tool_result', id: tc.id, name: tc.name, result: result.result }
      toolResultBlocks.push({ type: 'tool_result', toolUseId: tc.id, content: resultStr })
    }

    config.messages.push({ role: 'assistant', content: assistantBlocks })
    config.messages.push({ role: 'user', content: toolResultBlocks })
    lastAssistantContent = assistantBlocks
  }

  // === DONE with affected resources ===
  yield {
    type: 'done',
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    affected: accumulatedAffected,
    lastContent: lastAssistantContent,
  }
}

// ─── Tool Execution ───

/**
 * Execute tool with workflow-aware auto-merge and affected resources.
 */
export async function executeToolWithAutoMerge(
  name: string,
  input: unknown,
  engine: ReturnType<typeof createContentEngine>,
  git: ReturnType<typeof useGitProvider>,
  userEmail: string,
  userId: string,
  contentRoot: string,
  workflow: string,
  permissions: AgentPermissions,
  plan: string,
  projectId: string,
  workspaceId: string,
  uiContext: ChatUIContext,
): Promise<{ result: unknown, affected: AffectedResources }> {
  const params = (input ?? {}) as Record<string, unknown>
  const affected: AffectedResources = emptyAffected()
  // Plans without review workflow support always auto-publish on save.
  const autoPublish = !hasFeature(plan, 'workflow.review')

  try {
    let result: unknown

    switch (name) {
      case 'list_models': {
        // Read from brain cache instead of Git
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        result = { models: [...brainData.models.values()] }
        break
      }

      case 'get_content': {
        // Redirect to brain_query — reads from cache instead of Git
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? uiContext.activeLocale ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }
        const key = `${modelId}:${locale}`
        const contentData = brainData.content.get(key) ?? null
        const metaData = brainData.meta.get(key) ?? null
        const modelDef = brainData.models.get(modelId)
        if (!contentData) {
          result = { modelId, locale, kind: modelDef?.kind ?? 'collection', data: null, error: errorMessage('content.not_found') }
        }
        else {
          result = { modelId, locale, kind: modelDef?.kind ?? 'collection', data: contentData, meta: metaData }
        }
        break
      }

      case 'save_content': {
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }
        let writeResult: { branch: string, commit: { sha: string }, diff: unknown[], validation: { valid: boolean, errors: Array<{ message: string }> } }

        // Document kind: expects { slug, frontmatter/data, body }
        if (params.slug && typeof params.slug === 'string') {
          const frontmatter = (params.data ?? params.frontmatter ?? {}) as Record<string, unknown>
          const body = (params.body as string) ?? ''
          writeResult = await engine.saveDocument(modelId, locale, params.slug as string, frontmatter, body, userEmail, { autoPublish })
        }
        else {
          writeResult = await engine.saveContent(modelId, locale, params.data as Record<string, unknown>, userEmail, { autoPublish })
        }

        affected.models.push(modelId)
        affected.locales.push(locale)
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        // Role-aware auto-merge
        if (shouldAutoMerge(workflow, permissions) && writeResult.branch) {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged, workflow }
        }
        else if (writeResult.branch) {
          result = { ...summarizeWriteResult(writeResult), merged: false, workflow, reviewBranch: writeResult.branch }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, workflow }
        }
        break
      }

      case 'delete_content': {
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }
        const writeResult = await engine.deleteContent(modelId, locale, params.entryIds as string[], userEmail)
        affected.models.push(modelId)
        affected.locales.push(locale)
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'save_model': {
        const writeResult = await engine.saveModel(params as unknown as ModelDefinition, userEmail)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'validate':
      case 'validate_schema': {
        // Schema validation from brain cache — comprehensive checks
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        result = brainData.schemaValidation ?? {
          valid: true,
          warnings: [],
          healthScore: 100,
          modelCount: brainData.models.size,
          validModels: brainData.models.size,
          timestamp: new Date().toISOString(),
        }
        break
      }

      case 'list_submissions': {
        const subModelId = params.modelId as string
        const subStatus = (params.status as string) ?? 'pending'
        const subLimit = Math.min(Number(params.limit ?? 20), 100)
        const subs = await useDatabaseProvider().listFormSubmissions(workspaceId, projectId, subModelId, { status: subStatus, limit: subLimit })
        result = subs.total > 0
          ? { submissions: subs.submissions, total: subs.total, message: agentMessage('forms.submission_list', { count: subs.total, status: subStatus }) }
          : { submissions: [], total: 0, message: agentMessage('forms.no_submissions') }
        break
      }

      case 'approve_submission': {
        const approveId = params.submissionId as string
        const dbp = useDatabaseProvider()
        const sub = await dbp.getFormSubmission(approveId)
        if (!sub || sub.workspace_id !== workspaceId || sub.project_id !== projectId) {
          result = { error: errorMessage('forms.submission_not_found') }
          break
        }

        // Create content entry in Git from submission data
        const { generateEntryId } = await import('~~/server/utils/content-serialization')
        const subModelId = sub.model_id as string
        const subData = sub.data as Record<string, unknown>
        const entryId = generateEntryId()
        const writeResult = await engine.saveContent(subModelId, 'en', { [entryId]: subData }, userEmail, { autoPublish })

        if (writeResult.branch) {
          if (shouldAutoMerge(workflow, permissions)) {
            await engine.mergeBranch(writeResult.branch)
          }
          invalidateBrainCache(projectId)
        }

        await dbp.updateFormSubmissionStatus(approveId, 'approved', userId, entryId)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        affected.models.push(subModelId)
        result = { entryId, submission: { ...sub, status: 'approved', entry_id: entryId }, message: agentMessage('forms.approved') }
        break
      }

      case 'reject_submission': {
        const rejectId = params.submissionId as string
        const dbp = useDatabaseProvider()
        const sub = await dbp.getFormSubmission(rejectId)
        if (!sub || sub.workspace_id !== workspaceId || sub.project_id !== projectId) {
          result = { error: errorMessage('forms.submission_not_found') }
          break
        }
        const updated = await dbp.updateFormSubmissionStatus(rejectId, 'rejected')
        result = { submission: updated, message: agentMessage('forms.rejected') }
        break
      }

      case 'list_branches':
        result = { branches: await engine.listContentBranches() }
        break

      case 'merge_branch': {
        const branchToMerge = params.branch as string
        if (!branchToMerge.startsWith('cr/')) {
          result = { error: agentMessage('branch.contentrain_only_merge') }
          break
        }
        const mergeResult = await engine.mergeBranch(branchToMerge)
        affected.snapshotChanged = true
        affected.branchesChanged = true
        result = mergeResult
        break
      }

      case 'reject_branch': {
        const branchToReject = params.branch as string
        if (branchToReject === 'contentrain') {
          result = { error: 'Cannot reject the permanent content branch' }
          break
        }
        if (!branchToReject.startsWith('cr/')) {
          result = { error: agentMessage('branch.contentrain_only_reject') }
          break
        }
        await engine.rejectBranch(branchToReject)
        affected.branchesChanged = true
        result = { rejected: true }
        break
      }

      case 'copy_locale': {
        const copyModelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(copyModelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${copyModelId}` }
          break
        }
        const fromLocale = params.from as string
        const toLocale = params.to as string
        if (permissions.allowedLocales?.length) {
          if (!permissions.allowedLocales.includes(fromLocale)) {
            result = { error: `Locale "${fromLocale}" is not allowed for this API key` }
            break
          }
          if (!permissions.allowedLocales.includes(toLocale)) {
            result = { error: `Locale "${toLocale}" is not allowed for this API key` }
            break
          }
        }
        const writeResult = await engine.copyLocale(
          copyModelId, fromLocale, toLocale, userEmail,
        )
        if (!writeResult.validation.valid) {
          result = { error: writeResult.validation.errors.map(e => e.message).join(', ') }
          break
        }
        affected.models.push(params.model as string)
        affected.locales.push(params.to as string)
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        if (shouldAutoMerge(workflow, permissions)) {
          const mergeResult = await engine.mergeBranch(writeResult.branch)
          result = { ...summarizeWriteResult(writeResult), merged: mergeResult.merged }
        }
        else {
          result = { ...summarizeWriteResult(writeResult), merged: false, reviewBranch: writeResult.branch }
        }
        break
      }

      case 'init_project': {
        const initModels: ModelDefinition[] = []
        if (params.models && Array.isArray(params.models)) {
          for (const m of params.models as Record<string, unknown>[]) {
            initModels.push(m as unknown as ModelDefinition)
          }
        }
        const initResult = await engine.initProject(
          (params.stack as string) ?? 'other',
          (params.locales as string[]) ?? ['en'],
          (params.domains as string[]) ?? ['marketing'],
          initModels, userEmail,
        )
        affected.snapshotChanged = true
        affected.branchesChanged = true
        invalidateBrainCache(projectId)

        // Init always auto-merges
        const mergeResult = await engine.mergeBranch(initResult.branch)
        result = { ...summarizeWriteResult(initResult), merged: mergeResult.merged }
        break
      }

      case 'search_media': {
        const mediaProvider = useMediaProvider()
        if (!mediaProvider) {
          result = { error: errorMessage('media.storage_not_configured') }
          break
        }
        if (!hasFeature(plan, 'media.library')) {
          result = { error: errorMessage('media.library_upgrade') }
          break
        }
        const searchResult = await mediaProvider.listAssets(projectId, {
          search: params.query as string | undefined,
          tags: params.tags as string[] | undefined,
          contentType: params.type as string | undefined,
          limit: Math.min((params.limit as number) ?? 10, 20),
        })
        result = searchResult.assets.map(a => ({
          id: a.id,
          filename: a.filename,
          path: a.originalPath,
          alt: a.alt,
          tags: a.tags,
          dimensions: `${a.width}x${a.height}`,
          format: a.format,
          blurhash: a.blurhash,
          variants: Object.fromEntries(Object.entries(a.variants).map(([k, v]) => [k, v.path])),
        }))
        break
      }

      case 'upload_media': {
        const mediaProvider = useMediaProvider()
        if (!mediaProvider) {
          result = { error: errorMessage('media.storage_not_configured') }
          break
        }
        if (!hasFeature(plan, 'media.upload')) {
          result = { error: errorMessage('media.upload_upgrade') }
          break
        }
        const url = params.url as string
        if (!url) {
          result = { error: agentMessage('media.url_required') }
          break
        }
        let fetchResponse: Response
        try {
          fetchResponse = await fetch(url, {
            headers: { 'User-Agent': 'Contentrain-Studio/1.0' },
            signal: AbortSignal.timeout(30_000),
          })
        }
        catch {
          result = { error: agentMessage('media.fetch_failed') }
          break
        }
        if (!fetchResponse.ok) {
          result = { error: agentMessage('media.url_bad_status', { status: fetchResponse.status }) }
          break
        }
        const mimeType = (fetchResponse.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim()
        if (!isAllowedMimeType(mimeType)) {
          result = { error: agentMessage('media.type_not_allowed', { type: mimeType }) }
          break
        }
        const fileBuffer = Buffer.from(await fetchResponse.arrayBuffer())
        const urlFilename = new URL(url).pathname.split('/').pop() ?? 'uploaded-file'
        const variants = resolveVariantConfig(params.variants as string | undefined)

        const asset = await mediaProvider.upload({
          projectId,
          workspaceId,
          file: fileBuffer,
          filename: urlFilename,
          contentType: mimeType,
          alt: params.alt as string | undefined,
          tags: params.tags as string[] | undefined,
          variants,
          uploadedBy: userEmail,
          source: 'agent',
        })
        result = {
          id: asset.id,
          path: asset.originalPath,
          filename: asset.filename,
          dimensions: `${asset.width}x${asset.height}`,
          variants: Object.fromEntries(Object.entries(asset.variants).map(([k, v]) => [k, v.path])),
        }
        break
      }

      case 'get_media': {
        const mediaProvider = useMediaProvider()
        if (!mediaProvider) {
          result = { error: errorMessage('media.storage_not_configured') }
          break
        }
        if (!hasFeature(plan, 'media.library')) {
          result = { error: errorMessage('media.library_upgrade') }
          break
        }
        const asset = await mediaProvider.getAsset(params.assetId as string)
        if (!asset || asset.projectId !== projectId) {
          result = { error: agentMessage('media.asset_not_found') }
          break
        }
        result = asset
        break
      }

      case 'brain_query': {
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const modelId = params.model as string
        if (permissions.specificModels && !permissions.allowedModels.includes(modelId)) {
          result = { error: `${errorMessage('model.access_denied')}: ${modelId}` }
          break
        }
        const locale = (params.locale as string) ?? uiContext.activeLocale ?? 'en'
        if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(locale)) {
          result = { error: `Locale "${locale}" is not allowed for this API key` }
          break
        }
        const key = `${modelId}:${locale}`
        const contentData = brainData.content.get(key) ?? null
        const metaData = brainData.meta.get(key) ?? null
        const modelDef = brainData.models.get(modelId)

        if (params.entryId && contentData && typeof contentData === 'object' && !Array.isArray(contentData)) {
          const entry = (contentData as Record<string, unknown>)[params.entryId as string]
          result = { modelId, locale, kind: modelDef?.kind ?? 'collection', data: entry ?? null, entryId: params.entryId }
        }
        else {
          result = { modelId, locale, kind: modelDef?.kind ?? 'collection', data: contentData, meta: metaData }
        }
        break
      }

      case 'brain_search': {
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const searchQuery = (params.query as string).toLowerCase()
        const targetModel = params.model as string | undefined
        const searchLimit = Math.min((params.limit as number) ?? 10, 50)

        const searchResults: Array<{ modelId: string, entryId: string, locale: string, preview: string }> = []

        for (const [key, data] of brainData.content) {
          const [mId, loc] = key.split(':')
          if (!mId || !loc) continue
          if (targetModel && mId !== targetModel) continue
          if (permissions.specificModels && !permissions.allowedModels.includes(mId)) continue
          if (permissions.allowedLocales?.length && !permissions.allowedLocales.includes(loc)) continue

          const stringified = JSON.stringify(data).toLowerCase()
          if (!stringified.includes(searchQuery)) continue

          if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            for (const [entryId, entry] of Object.entries(data as Record<string, unknown>)) {
              const entryStr = JSON.stringify(entry).toLowerCase()
              if (entryStr.includes(searchQuery)) {
                const preview = JSON.stringify(entry).substring(0, 200)
                searchResults.push({ modelId: mId, entryId, locale: loc, preview })
                if (searchResults.length >= searchLimit) break
              }
            }
          }
          else if (Array.isArray(data)) {
            for (const [idx, entry] of data.entries()) {
              const entryStr = JSON.stringify(entry).toLowerCase()
              if (entryStr.includes(searchQuery)) {
                const slug = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).slug as string ?? `entry-${idx}` : `entry-${idx}`
                searchResults.push({ modelId: mId, entryId: slug, locale: loc, preview: JSON.stringify(entry).substring(0, 200) })
                if (searchResults.length >= searchLimit) break
              }
            }
          }

          if (searchResults.length >= searchLimit) break
        }

        result = { query: params.query, results: searchResults, total: searchResults.length }
        break
      }

      case 'brain_analyze': {
        const brainData = await getOrBuildBrainCache(git, contentRoot, projectId)
        const analysisType = params.type as 'seo_audit' | 'locale_parity' | 'stale_content' | 'quality_score' | 'full'
        result = analyzeBrainContent(brainData, analysisType)
        break
      }

      default:
        result = { error: `Unknown tool: ${name}` }
    }

    // Invalidate brain cache after any write operation
    if (affected.snapshotChanged || affected.models.length > 0 || affected.branchesChanged) {
      invalidateBrainCache(projectId)
    }

    return { result, affected }
  }
  catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Tool execution failed'
    return { result: { error: msg }, affected }
  }
}

// ─── Helpers ───

function summarizeWriteResult(result: { branch: string, commit: { sha: string }, diff: unknown[], validation: { valid: boolean, errors: Array<{ message: string }> } }): Record<string, unknown> {
  return {
    branch: result.branch,
    commitSha: result.commit.sha,
    filesChanged: result.diff.length,
    valid: result.validation.valid,
    errors: result.validation.errors.map(e => e.message),
  }
}

/**
 * Determine whether to auto-merge based on workflow config + user role.
 *
 * auto-merge workflow → always auto-merge
 * review workflow → Owner/Admin auto-merge (they're authorized), Editor → no merge (needs review)
 */
function shouldAutoMerge(workflow: string, permissions: AgentPermissions): boolean {
  if (workflow === 'auto-merge') return true
  // In review workflow, only Owner/Admin can auto-merge
  return permissions.workspaceRole === 'owner' || permissions.workspaceRole === 'admin'
}
